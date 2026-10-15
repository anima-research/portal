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
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
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
  /** Directories a `path` item must resolve inside. Unset or empty ⇒ `path`
   *  items are refused: reading local files is opt-in (PORTAL_FILE_ROOTS),
   *  because a send that reads the file itself bypasses whatever fences the
   *  host puts on file access, and any channel message can ask for one. */
  allowedRoots?: string[];
  /** Files never attachable whatever the roots, by resolved path — the
   *  configured credentials, identity roster and state files, which can have
   *  any name (the NEVER_ATTACH patterns only catch the default names). */
  denyPaths?: string[];
  /** Directories nothing is attachable from (the credentials directory): a
   *  path inside one is refused, and so is any file that IS one of their files
   *  under another name (a hard link elsewhere — same device and inode). */
  denyDirs?: string[];
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

/** Where `abs` would be on disk: its realpath, or — when it doesn't exist —
 *  the realpath of its deepest existing ancestor plus the rest. Fencing this
 *  rather than the raw path keeps a missing file under a symlinked root (e.g.
 *  macOS /var → /private/var) inside that root, so it reads "no such file",
 *  while a path outside the roots still reads "outside" whether or not it exists. */
async function onDiskPath(abs: string, depth = 0): Promise<string> {
  // A dangling symlink is fenced by where it POINTS, not where it sits — else
  // one inside a root aimed outside reads "no such file" instead of "outside".
  if (depth < 40) {
    const link = await lstat(abs).catch(() => undefined);
    if (link?.isSymbolicLink()) {
      const target = await readlink(abs).catch(() => undefined);
      if (target !== undefined) return onDiskPath(resolve(dirname(abs), target), depth + 1);
    }
  }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const real = await realpath(cur).catch(() => undefined);
    if (real !== undefined) return rest.length ? join(real, ...rest.reverse()) : real;
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.push(basename(cur));
    cur = parent;
  }
}

/** The configured credential files and the credentials directory: refused by
 *  path, and by (device, inode) so a hard link under another name is too. */
async function isDenied(real: string, opts: ResolveFilesOptions): Promise<boolean> {
  if (!opts.denyPaths?.length && !opts.denyDirs?.length) return false;
  const resolveReal = (p: string) => realpath(expandHome(p)).catch(() => resolve(expandHome(p)));
  const dirs = await Promise.all((opts.denyDirs ?? []).map(resolveReal));
  if (dirs.some((d) => insideRoot(real, d))) return true;
  const files = await Promise.all((opts.denyPaths ?? []).map(resolveReal));
  if (files.includes(real)) return true;
  for (const d of dirs) {
    for (const name of await readdir(d).catch(() => [] as string[])) files.push(join(d, name));
  }
  const target = await stat(real).catch(() => undefined);
  if (!target) return false;
  for (const f of files) {
    const st = await stat(f).catch(() => undefined);
    if (st && st.isFile() && st.dev === target.dev && st.ino === target.ino) return true;
  }
  return false;
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
 * Addresses a fetch from the resident's host must never reach on a model's
 * say-so: loopback, RFC1918 / CGNAT private, link-local (cloud metadata lives
 * there), multicast, unspecified — v4 and v6. v4-mapped (`::ffff:0:0/96`) and
 * NAT64 (`64:ff9b::/96`) forms are checked as the v4 address they carry: the
 * URL parser serialises `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so a
 * dotted-quad regex never sees them (the first version of this guard didn't).
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  // v4-compatible (::a.b.c.d, deprecated), v4-translated (::ffff:0:a.b.c.d)
  // and local-use NAT64 (RFC 8215): no public fetch needs them.
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b:1::', 48],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** The v4 address a v4-mapped or NAT64 v6 address carries, else undefined. */
function embeddedV4(v6: string): string | undefined {
  const groups = expandV6(v6);
  if (!groups) return undefined;
  const prefix = groups.slice(0, 6).join(':');
  if (prefix !== '0:0:0:0:0:ffff' && prefix !== '64:ff9b:0:0:0:0') return undefined;
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Eight hex groups (no leading zeros) for any textual IPv6 form, else null. */
function expandV6(addr: string): string[] | null {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [, head, o1, o2, o3, o4] = dotted;
    a = `${head}${((+o1 << 8) | +o2).toString(16)}:${((+o3 << 8) | +o4).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || left.length + right.length + fill !== 8) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

export function isPrivateAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return PRIVATE.check(addr, 'ipv4');
  if (kind !== 6) return true; // not an address at all → refuse
  const inner = embeddedV4(addr);
  if (inner) return PRIVATE.check(inner, 'ipv4');
  return PRIVATE.check(addr, 'ipv6');
}

/** Files that are never attachable, whatever the roots: other residents' (and
 *  this one's) portal credentials and identity rosters. A hard floor —
 *  identity.ts refuses to load these on a model's say-so for the same reason. */
/** Credentials / roster / state files by name — copies like `x.creds.json.bak`
 *  included. (Configured paths and the creds directory are refused separately,
 *  by path and inode: see denyPaths / denyDirs.) */
const NEVER_ATTACH = [/\.creds\.json(\.|$)/i, /\.identities\.json(\.|$)/i, /\.state\.json(\.|$)/i];

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

/** Read a local file, refusing once it passes `cap` bytes (it may be growing).
 *  @internal exported for tests. */
export async function readFileCapped(path: string, cap: number, label: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(64 * 1024, Math.max(1, cap - size + 1)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > cap) {
        throw new Error(`${label}: attachments exceed the per-message budget (the file grew past ${cap} bytes while being read)`);
      }
      chunks.push(buf.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await fh.close();
  }
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
      // Fail closed, before touching the filesystem (no existence oracle).
      if (!opts.allowedRoots?.length) {
        throw new Error(
          `files[${i}]: local file paths are off on this server (PORTAL_FILE_ROOTS) — attach a url ` +
            'or bytes instead, or ask the operator to set PORTAL_FILE_ROOTS',
        );
      }
      const raw = expandHome(spec.path);
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
      // Resolve what the OS will actually open (a symlink inside a root pointing
      // outside it must not pass), then fence, then stat — in that order, so a
      // path outside the roots learns nothing about whether it exists.
      const real = await realpath(abs).catch(() => undefined);
      const roots = await Promise.all(
        opts.allowedRoots.map((r) => realpath(expandHome(r)).catch(() => resolve(expandHome(r)))),
      );
      const target = real ?? (await onDiskPath(abs));
      if (!roots.some((r) => insideRoot(target, r))) {
        // Never echo where a denied path resolves: that would tell the caller
        // a link outside the roots exists and where it points.
        throw new Error(`files[${i}]: path is outside the allowed roots: ${abs}`);
      }
      if (real === undefined) throw new Error(`files[${i}]: no such file: ${abs}`);
      if (NEVER_ATTACH.some((re) => re.test(basename(real)) || re.test(basename(abs)))) {
        throw new Error(`files[${i}]: refusing to attach a credentials/identity file: ${abs}`);
      }
      if (await isDenied(real, opts)) {
        throw new Error(`files[${i}]: refusing to attach a credentials/identity file: ${abs}`);
      }
      const st = await stat(real);
      if (!st.isFile()) throw new Error(`files[${i}]: not a regular file: ${abs}`);
      account(st.size, `files[${i}] (${abs})`);
      // Read under what the budget has left (the stat size is already charged),
      // and charge what was actually read: a file that grows between the stat
      // and the read can't slip past the cap.
      const data = await readFileCapped(real, budget - total + st.size, `files[${i}] (${abs})`);
      account(data.length - st.size, `files[${i}] (${abs})`);
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
        // A redirect's own body is never read: release it before the next hop.
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects`);
        current = new URL(location, current);
        if (!isUrl(current.toString())) throw new Error(`redirected to a non-http(s) URL: ${current}`);
      }
    } catch (err) {
      clearTimeout(timer);
      ctrl.abort(); // nothing in flight may outlive the refusal
      const msg = (err as Error).message;
      throw new Error(msg.startsWith(`files[${i}]`) ? msg : `files[${i}]: fetch failed for ${url}: ${msg}`);
    }
    try {
      if (!res.ok) throw new Error(`files[${i}]: HTTP ${res.status} fetching ${url}`);
      // Content-Length is the WIRE size; with a content-encoding (gzip, br…)
      // the body is decoded on read and can be far smaller — or larger — than
      // that, so only an unencoded length is charged up front. Either way the
      // stream is capped and the decoded bytes charged.
      const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
      const declared = encoding === 'identity' ? Number(res.headers.get('content-length') ?? '0') : 0;
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
    } catch (err) {
      // Refused (status, budget…): stop the download and release the socket.
      ctrl.abort();
      await res.body?.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/**
 * Where `path` items may come from when PORTAL_FILE_ROOTS is unset — the same
 * places the mcpl-bridge reads `$file:` arguments from: the working directory,
 * the Claude Code project (CLAUDE_PROJECT_DIR) and its per-session scratchpads.
 * A default that would be the home directory or the filesystem root is dropped:
 * a process started by launchd (or from ~) would otherwise fence nothing, and
 * any channel message can ask for a file.
 */
export function defaultFileRoots(
  env: NodeJS.ProcessEnv = process.env,
  where: { cwd?: string; home?: string; uid?: number | null } = {},
): string[] {
  const cwd = where.cwd ?? process.cwd();
  const home = resolve(where.home ?? homedir());
  const uid = where.uid !== undefined ? where.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const roots = new Set<string>();
  if (env.CLAUDE_PROJECT_DIR) roots.add(resolve(env.CLAUDE_PROJECT_DIR));
  roots.add(resolve(cwd));
  if (uid !== null) {
    roots.add(`/private/tmp/claude-${uid}`);
    roots.add(`/tmp/claude-${uid}`);
  }
  return [...roots].filter((r) => r !== home && r !== resolve('/'));
}

/** Build resolver options from the standard PORTAL_* env knobs:
 *  - PORTAL_FILE_ROOTS      comma-separated dirs `path` items must live under. Unset ⇒ the
 *                           defaults (defaultFileRoots: working dir, Claude Code project and
 *                           scratchpads — never ~ or /). "off" ⇒ local paths are refused.
 *                           Credentials/identity/state files stay refused under any setting.
 *  - PORTAL_CREDENTIALS, PORTAL_IDENTITIES, PORTAL_STATE  — the configured credentials,
 *                           roster and state files are never attachable, whatever their names
 *  - PORTAL_MAX_FILE_BYTES  per-message decoded budget (default 8 MiB; match the relay's cap)
 *  - PORTAL_ALLOW_URL_FILES "false" to refuse `url` items
 *  - PORTAL_ALLOW_PRIVATE_URLS "true" to let `url` reach loopback/private addresses */
export function fileOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  where: { cwd?: string; home?: string; uid?: number | null } = {},
): ResolveFilesOptions {
  const configured = (env.PORTAL_FILE_ROOTS ?? '').trim();
  const roots =
    configured === ''
      ? defaultFileRoots(env, where)
      : /^(off|none|false|0)$/i.test(configured)
        ? []
        : configured.split(',').map((s) => s.trim()).filter(Boolean);
  const max = Number(env.PORTAL_MAX_FILE_BYTES);
  const deny = [env.PORTAL_CREDENTIALS, env.PORTAL_IDENTITIES, env.PORTAL_STATE]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return {
    ...(roots.length ? { allowedRoots: roots } : {}),
    ...(deny.length ? { denyPaths: deny } : {}),
    ...(Number.isFinite(max) && max > 0 ? { maxTotalBytes: max } : {}),
    ...(env.PORTAL_ALLOW_URL_FILES === 'false' ? { allowUrls: false } : {}),
    ...(env.PORTAL_ALLOW_PRIVATE_URLS === 'true' ? { allowPrivateUrls: true } : {}),
  };
}
