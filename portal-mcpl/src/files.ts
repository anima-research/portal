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
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
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
  /** Allow `url` items that resolve to loopback / private / link-local
   *  addresses (default false — see `assertPublicUrl`). */
  allowPrivateUrls?: boolean;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  /** Injectable DNS lookup (tests). */
  lookup?: (host: string) => Promise<string[]>;
}

const MAX_REDIRECTS = 5;

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

/** Strict base64: the alphabet, proper padding, a length that decodes. Node's
 *  decoder silently skips junk, so a mistyped payload would otherwise become a
 *  truncated attachment instead of an error. */
function decodeBase64Strict(b64: string, label: string): Buffer {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error(`${label}: \`bytes\` is not valid base64`);
  }
  return Buffer.from(clean, 'base64');
}

/**
 * Is this address one a fetch from the resident's host must never reach on a
 * model's say-so: loopback, RFC1918 / CGNAT private, link-local (cloud
 * metadata lives there), multicast, unspecified — v4, v6, and v4-mapped v6.
 */
export function isPrivateAddress(addr: string): boolean {
  const v4 = (a: string): boolean => {
    const o = a.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return (
      o[0] === 0 || o[0] === 10 || o[0] === 127 ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
      (o[0] === 169 && o[1] === 254) ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      o[0] >= 224
    );
  };
  const kind = isIP(addr);
  if (kind === 4) return v4(addr);
  if (kind !== 6) return true; // not an address at all → refuse
  const a = addr.toLowerCase();
  const mapped = a.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4(mapped[1]);
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Refuse a URL whose host is, or resolves to, a private address. Checked at
 *  every redirect hop. (DNS is looked up here and again inside fetch, so a
 *  rebinding server can still race it — this is a guard, not a sandbox.) */
async function assertPublicUrl(url: URL, lookup: (host: string) => Promise<string[]>, label: string): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`${label}: refusing to fetch a local address: ${url.host}`);
  }
  const addrs = isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  if (addrs.length === 0) throw new Error(`${label}: could not resolve ${url.host}`);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Error(`${label}: refusing to fetch a private/loopback address: ${url.host} (${bad})`);
}

async function defaultLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((r) => r.address);
}

/** Read a response body with a hard byte cap, aborting the transfer the moment
 *  it is exceeded — no Content-Length required, nothing buffered past the cap. */
async function readCapped(res: Response, cap: number, ctrl: AbortController, label: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > cap) {
      ctrl.abort();
      throw new Error(`${label}: attachments exceed the per-message budget (more than ${cap} bytes remaining) while downloading`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
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
      const decoded = decodeBase64Strict(spec.bytes, `files[${i}] (${spec.name})`);
      account(decoded.length, `files[${i}] (${spec.name})`);
      out.push({
        name: spec.name,
        bytes: decoded.toString('base64'),
        ...(spec.contentType ? { contentType: spec.contentType } : mimeFromName(spec.name) ? { contentType: mimeFromName(spec.name) } : {}),
        ...extra,
      });
      continue;
    }

    if (spec.path != null) {
      const raw = expandHome(spec.path);
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
      let st;
      try {
        st = await stat(abs);
      } catch {
        throw new Error(`files[${i}]: no such file: ${abs}`);
      }
      if (opts.allowedRoots?.length) {
        // Fence the file the OS will actually open, not the name it was asked
        // by: a symlink inside a root pointing outside it must not pass.
        const [real, roots] = await Promise.all([
          realpath(abs),
          Promise.all(opts.allowedRoots.map((r) => realpath(expandHome(r)).catch(() => resolve(expandHome(r))))),
        ]);
        if (!roots.some((r) => insideRoot(real, r))) {
          throw new Error(`files[${i}]: path is outside the allowed roots: ${abs}${real !== abs ? ` (→ ${real})` : ''}`);
        }
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
    const label = `files[${i}] (${url})`;
    const lookup = opts.lookup ?? defaultLookup;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.fetchTimeoutMs ?? 20000);
    let res: Response;
    try {
      // Redirects are followed by hand so every hop is checked: a public URL
      // that 302s to 169.254.169.254 is the classic way in.
      let current = new URL(url);
      for (let hop = 0; ; hop++) {
        if (opts.allowPrivateUrls !== true) await assertPublicUrl(current, lookup, `files[${i}]`);
        res = await doFetch(current.toString(), { signal: ctrl.signal, redirect: 'manual' });
        const location = res.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects`);
        current = new URL(location, current);
        if (!isUrl(current.toString())) throw new Error(`redirected to a non-http(s) URL: ${current}`);
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).message;
      throw new Error(msg.startsWith(`files[${i}]`) ? msg : `files[${i}]: fetch failed for ${url}: ${msg}`);
    }
    try {
      if (!res.ok) throw new Error(`files[${i}]: HTTP ${res.status} fetching ${url}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > 0) account(declared, label);
      // Stream under the REMAINING budget: a body with no (or a lying)
      // Content-Length is cut off at the cap instead of buffered whole.
      const buf = await readCapped(res, budget - total + (declared > 0 ? declared : 0), ctrl, label);
      if (!(declared > 0)) account(buf.length, label);
      else if (buf.length > declared) account(buf.length - declared, label);
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
 *  - PORTAL_ALLOW_URL_FILES "false" to refuse `url` items
 *  - PORTAL_ALLOW_PRIVATE_URLS "true" to let `url` reach loopback/private addresses */
export function fileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ResolveFilesOptions {
  const roots = (env.PORTAL_FILE_ROOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const max = Number(env.PORTAL_MAX_FILE_BYTES);
  return {
    ...(roots.length ? { allowedRoots: roots } : {}),
    ...(Number.isFinite(max) && max > 0 ? { maxTotalBytes: max } : {}),
    ...(env.PORTAL_ALLOW_URL_FILES === 'false' ? { allowUrls: false } : {}),
    ...(env.PORTAL_ALLOW_PRIVATE_URLS === 'true' ? { allowPrivateUrls: true } : {}),
  };
}
