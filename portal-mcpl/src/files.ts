/**
 * Outgoing-attachment resolution for the portal MCPL surface.
 *
 * The relay only accepts inline base64 `bytes` (RFC-003: it refuses to read
 * paths off its own disk). That is the right contract for the wire, but a
 * hopeless one for an LLM tool call — a model cannot produce the base64 of a
 * file it has on disk or a URL it just saw. So this module does the conversion
 * ON THE MCPL SIDE, where we run with the resident's own privileges: a `path`
 * is read locally, a `url` is fetched, and both become `bytes` before the
 * message reaches the client. The relay never sees a path.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import type { OutgoingFile } from '@animalabs/portal-protocol';

/** What the tool schema accepts per item: a bare path/URL string, or an object. */
export type FileSpec =
  | string
  | {
      bytes?: string;
      path?: string;
      url?: string;
      name?: string;
      contentType?: string;
      description?: string;
    };

export interface ResolveFilesOptions {
  /** Per-message decoded-byte budget (matches the relay's default of 8 MiB). */
  maxTotalBytes?: number;
  /** Max attachments per message (relay cap is 10). */
  maxFiles?: number;
  /** Base directory for relative paths (default: process.cwd()). */
  cwd?: string;
  /** If set, `path` must resolve inside one of these directories. */
  allowedRoots?: string[];
  /** Allow `url` fetches (default true). */
  allowUrls?: boolean;
  /** Fetch timeout for `url` items, ms. */
  fetchTimeoutMs?: number;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 10;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

export function mimeFromName(name: string): string | undefined {
  return MIME_BY_EXT[extname(name).toLowerCase()];
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function insideRoot(file: string, root: string): boolean {
  const r = resolve(root);
  return file === r || file.startsWith(r.endsWith(sep) ? r : r + sep);
}

function normalizeSpec(spec: FileSpec, i: number): Exclude<FileSpec, string> {
  if (typeof spec === 'string') {
    const s = spec.trim();
    if (!s) throw new Error(`files[${i}]: empty string`);
    return isUrl(s) ? { url: s } : { path: s };
  }
  if (!spec || typeof spec !== 'object') throw new Error(`files[${i}]: expected a string or object`);
  // Be forgiving: a `path` that is really a URL is a URL.
  if (spec.path && !spec.url && !spec.bytes && isUrl(spec.path)) {
    return { ...spec, url: spec.path, path: undefined };
  }
  return spec;
}

/** Filename from a URL's last path segment, or a Content-Disposition header. */
function nameFromUrl(url: string, disposition: string | null): string | undefined {
  const m = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m?.[1]) {
    try {
      return basename(decodeURIComponent(m[1]));
    } catch {
      return basename(m[1]);
    }
  }
  try {
    const seg = basename(new URL(url).pathname);
    return seg && seg !== '/' ? decodeURIComponent(seg) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn tool-call `files` into relay-ready `OutgoingFile[]` (all `bytes`).
 * Throws with a caller-legible message on any invalid item, so the model gets
 * a fixable error instead of an opaque relay rejection.
 */
export async function resolveOutgoingFiles(
  files: unknown,
  opts: ResolveFilesOptions = {},
): Promise<OutgoingFile[] | undefined> {
  if (files == null) return undefined;
  if (!Array.isArray(files)) throw new Error('files must be an array');
  if (files.length === 0) return undefined;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  if (files.length > maxFiles) throw new Error(`too many files (${files.length} > ${maxFiles})`);
  const budget = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const doFetch = opts.fetch ?? fetch;
  const cwd = opts.cwd ?? process.cwd();
  let total = 0;
  const out: OutgoingFile[] = [];

  const account = (n: number, label: string) => {
    total += n;
    if (total > budget) {
      throw new Error(
        `attachments exceed the per-message budget (${total} > ${budget} bytes decoded) at ${label}`,
      );
    }
  };

  for (let i = 0; i < files.length; i++) {
    const spec = normalizeSpec(files[i] as FileSpec, i);
    const sources = [spec.bytes != null, spec.path != null, spec.url != null].filter(Boolean).length;
    if (sources !== 1) {
      throw new Error(`files[${i}]: provide exactly one of \`path\`, \`url\`, or \`bytes\``);
    }
    const extra = {
      ...(spec.description ? { description: spec.description } : {}),
    };

    if (spec.bytes != null) {
      if (!spec.name) throw new Error(`files[${i}]: \`name\` is required with \`bytes\``);
      const decoded = Buffer.from(spec.bytes, 'base64');
      account(decoded.length, `files[${i}] (${spec.name})`);
      out.push({
        name: spec.name,
        bytes: spec.bytes,
        ...(spec.contentType ? { contentType: spec.contentType } : mimeFromName(spec.name) ? { contentType: mimeFromName(spec.name) } : {}),
        ...extra,
      });
      continue;
    }

    if (spec.path != null) {
      const raw = expandHome(spec.path);
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
      if (opts.allowedRoots?.length && !opts.allowedRoots.some((r) => insideRoot(abs, expandHome(r)))) {
        throw new Error(`files[${i}]: path is outside the allowed roots: ${abs}`);
      }
      let st;
      try {
        st = await stat(abs);
      } catch {
        throw new Error(`files[${i}]: no such file: ${abs}`);
      }
      if (!st.isFile()) throw new Error(`files[${i}]: not a regular file: ${abs}`);
      account(st.size, `files[${i}] (${abs})`);
      const data = await readFile(abs);
      const name = spec.name || basename(abs);
      out.push({
        name,
        bytes: data.toString('base64'),
        ...(spec.contentType ? { contentType: spec.contentType } : mimeFromName(name) ? { contentType: mimeFromName(name) } : {}),
        ...extra,
      });
      continue;
    }

    // url
    if (opts.allowUrls === false) throw new Error(`files[${i}]: url attachments are disabled`);
    const url = spec.url!;
    if (!isUrl(url)) throw new Error(`files[${i}]: only http(s) URLs are supported: ${url}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.fetchTimeoutMs ?? 20000);
    let res: Response;
    try {
      res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`files[${i}]: fetch failed for ${url}: ${(err as Error).message}`);
    }
    try {
      if (!res.ok) throw new Error(`files[${i}]: HTTP ${res.status} fetching ${url}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > 0) account(declared, `files[${i}] (${url})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!(declared > 0)) account(buf.length, `files[${i}] (${url})`);
      else if (buf.length > declared) account(buf.length - declared, `files[${i}] (${url})`);
      const name = spec.name || nameFromUrl(url, res.headers.get('content-disposition')) || `file-${i + 1}`;
      const headerCt = res.headers.get('content-type')?.split(';')[0].trim();
      const contentType =
        spec.contentType ?? (headerCt && headerCt !== 'application/octet-stream' ? headerCt : mimeFromName(name));
      out.push({
        name,
        bytes: buf.toString('base64'),
        ...(contentType ? { contentType } : {}),
        ...extra,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** Build resolver options from the standard PORTAL_* env knobs:
 *  - PORTAL_FILE_ROOTS      comma-separated dirs `path` must live under (default: unrestricted —
 *                           the server runs with the resident's own privileges anyway)
 *  - PORTAL_MAX_FILE_BYTES  per-message decoded budget (default 8 MiB; match the relay's cap)
 *  - PORTAL_ALLOW_URL_FILES "false" to refuse `url` items */
export function fileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ResolveFilesOptions {
  const roots = (env.PORTAL_FILE_ROOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const max = Number(env.PORTAL_MAX_FILE_BYTES);
  return {
    ...(roots.length ? { allowedRoots: roots } : {}),
    ...(Number.isFinite(max) && max > 0 ? { maxTotalBytes: max } : {}),
    ...(env.PORTAL_ALLOW_URL_FILES === 'false' ? { allowUrls: false } : {}),
  };
}
