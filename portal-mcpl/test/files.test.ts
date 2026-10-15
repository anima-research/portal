import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutgoingFiles, fileOptionsFromEnv, isPrivateAddress, readFileCapped } from '../src/files.js';

/** DNS double: everything public unless the host says otherwise. */
const publicDns = async (host: string) => (host.startsWith('internal') ? ['10.0.0.5'] : ['93.184.216.34']);

const dir = mkdtempSync(join(tmpdir(), 'portal-files-'));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
writeFileSync(join(dir, 'dot.png'), png);
writeFileSync(join(dir, 'notes.txt'), 'hello');

/** Local paths are opt-in: these tests allow the fixture dir. */
const inDir = { allowedRoots: [dir] };

test('the resolver itself refuses local paths with no roots (before touching the filesystem)', async () => {
  await assert.rejects(resolveOutgoingFiles([join(dir, 'dot.png')]), /local file paths are off/);
  await assert.rejects(resolveOutgoingFiles([{ path: '/etc/definitely-not-a-file-xyz' }]), /local file paths are off/);
  await assert.rejects(resolveOutgoingFiles([join(dir, 'dot.png')], { allowedRoots: [] }), /local file paths are off/);
});

test('default roots: the working dir, the Claude Code project and scratchpads — never ~ or /', () => {
  const where = { cwd: '/work/resident', home: '/Users/me', uid: 501 };
  assert.deepEqual(fileOptionsFromEnv({}, where).allowedRoots, ['/work/resident', '/private/tmp/claude-501', '/tmp/claude-501']);
  assert.deepEqual(
    fileOptionsFromEnv({ CLAUDE_PROJECT_DIR: '/code/project' }, where).allowedRoots,
    ['/code/project', '/work/resident', '/private/tmp/claude-501', '/tmp/claude-501'],
  );
  // Started from home (launchd) or /: that default is dropped, not widened to everything.
  assert.deepEqual(fileOptionsFromEnv({}, { ...where, cwd: '/Users/me' }).allowedRoots, ['/private/tmp/claude-501', '/tmp/claude-501']);
  assert.deepEqual(fileOptionsFromEnv({}, { ...where, cwd: '/', uid: null }).allowedRoots ?? [], []);
  // Explicit settings win; "off" refuses local paths.
  assert.deepEqual(fileOptionsFromEnv({ PORTAL_FILE_ROOTS: '/only/here' }, where).allowedRoots, ['/only/here']);
  assert.deepEqual(fileOptionsFromEnv({ PORTAL_FILE_ROOTS: 'off' }, where).allowedRoots ?? [], [], 'off: no roots, so local paths are refused');
});

test('with the default roots, a file in the working directory attaches', async () => {
  const out = await resolveOutgoingFiles([join(dir, 'dot.png')], fileOptionsFromEnv({}, { cwd: dir, home: '/nowhere', uid: null }));
  assert.equal(out![0].name, 'dot.png');
});

test('bare path string → bytes with inferred name + mime', async () => {
  const out = await resolveOutgoingFiles([join(dir, 'dot.png')], inDir);
  assert.equal(out!.length, 1);
  assert.equal(out![0].name, 'dot.png');
  assert.equal(out![0].contentType, 'image/png');
  assert.equal(out![0].path, undefined);
  assert.deepEqual(Buffer.from(out![0].bytes!, 'base64'), png);
});

test('object path, relative to cwd, with override name', async () => {
  const out = await resolveOutgoingFiles([{ path: 'notes.txt', name: 'renamed.md' }], { cwd: dir, ...inDir });
  assert.equal(out![0].name, 'renamed.md');
  assert.equal(out![0].contentType, 'text/markdown');
  assert.equal(Buffer.from(out![0].bytes!, 'base64').toString(), 'hello');
});

test('missing file gives a legible error', async () => {
  await assert.rejects(resolveOutgoingFiles([join(dir, 'nope.bin')], inDir), /no such file/);
});

test('allowedRoots fences paths', async () => {
  await assert.rejects(
    resolveOutgoingFiles([join(dir, 'dot.png')], { allowedRoots: ['/definitely/elsewhere'] }),
    /outside the allowed roots/,
  );
  const ok = await resolveOutgoingFiles([join(dir, 'dot.png')], { allowedRoots: [dir] });
  assert.equal(ok!.length, 1);
});

test('bytes passthrough requires name; mime inferred', async () => {
  await assert.rejects(resolveOutgoingFiles([{ bytes: 'aGk=' }]), /`name` is required/);
  const out = await resolveOutgoingFiles([{ bytes: 'aGk=', name: 'a.json' }]);
  assert.equal(out![0].contentType, 'application/json');
});

test('exactly one source', async () => {
  await assert.rejects(resolveOutgoingFiles([{ path: 'x', bytes: 'aGk=', name: 'x' }]), /exactly one/);
  await assert.rejects(resolveOutgoingFiles([{ name: 'x' }]), /exactly one/);
});

test('url is fetched (name from URL, mime from header)', async () => {
  const fakeFetch = (async (u: string) =>
    new Response(png, { status: 200, headers: { 'content-type': 'image/png; charset=binary' } })) as unknown as typeof fetch;
  const out = await resolveOutgoingFiles(['https://example.com/pics/cat%20one.png?x=1'], { fetch: fakeFetch, lookup: publicDns });
  assert.equal(out![0].name, 'cat one.png');
  assert.equal(out![0].contentType, 'image/png');
  assert.deepEqual(Buffer.from(out![0].bytes!, 'base64'), png);
});

test('url in `path` slot is treated as a url; http error is legible', async () => {
  const fakeFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(resolveOutgoingFiles([{ path: 'https://example.com/x' }], { fetch: fakeFetch, lookup: publicDns }), /HTTP 404/);
  await assert.rejects(resolveOutgoingFiles(['https://example.com/x'], { allowUrls: false }), /disabled/);
});

test('per-message budget and file count are enforced', async () => {
  await assert.rejects(resolveOutgoingFiles([join(dir, 'dot.png')], { maxTotalBytes: 3, ...inDir }), /exceed the per-message budget/);
  await assert.rejects(resolveOutgoingFiles(new Array(11).fill(join(dir, 'dot.png')), inDir), /too many files/);
});

test('empty/null files → undefined', async () => {
  assert.equal(await resolveOutgoingFiles(undefined), undefined);
  assert.equal(await resolveOutgoingFiles([]), undefined);
});

test('fileOptionsFromEnv', () => {
  assert.deepEqual(fileOptionsFromEnv({}, { cwd: '/', home: '/', uid: null }), {});
  assert.deepEqual(
    fileOptionsFromEnv({ PORTAL_FILE_ROOTS: '/a, /b', PORTAL_MAX_FILE_BYTES: '1024', PORTAL_ALLOW_URL_FILES: 'false' }),
    { allowedRoots: ['/a', '/b'], maxTotalBytes: 1024, allowUrls: false },
  );
});

test('bytes must be strict base64', async () => {
  await assert.rejects(resolveOutgoingFiles([{ bytes: 'not base64!!', name: 'a.txt' }]), /not valid base64/);
  await assert.rejects(resolveOutgoingFiles([{ bytes: 'aGk', name: 'a.txt' }]), /not valid base64/);
  const out = await resolveOutgoingFiles([{ bytes: 'aG\nk=', name: 'a.txt' }]);
  assert.equal(Buffer.from(out![0].bytes!, 'base64').toString(), 'hi');
});

test('allowedRoots fences the real file, not the symlink name', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'portal-files-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'shh');
  const inside = join(dir, 'fenced');
  mkdirSync(inside);
  symlinkSync(join(outside, 'secret.txt'), join(inside, 'innocent.txt'));
  await assert.rejects(
    resolveOutgoingFiles([join(inside, 'innocent.txt')], { allowedRoots: [inside] }),
    (err: Error) => /outside the allowed roots/.test(err.message) && !err.message.includes('secret.txt'),
  );
  writeFileSync(join(inside, 'real.txt'), 'ok');
  assert.equal((await resolveOutgoingFiles([join(inside, 'real.txt')], { allowedRoots: [inside] }))!.length, 1);
});

test('url: private, loopback and link-local targets are refused, including via redirect', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (u: string) => {
    calls.push(u);
    if (u.startsWith('https://example.com/bounce')) return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    return new Response(png, { status: 200 });
  }) as unknown as typeof fetch;
  const o = { fetch: fakeFetch, lookup: publicDns };
  await assert.rejects(resolveOutgoingFiles(['http://127.0.0.1:8810/health'], o), /private\/loopback/);
  await assert.rejects(resolveOutgoingFiles(['http://localhost:8790/'], o), /local address/);
  await assert.rejects(resolveOutgoingFiles(['http://[::1]/'], o), /private\/loopback/);
  await assert.rejects(resolveOutgoingFiles(['http://internal.corp/x'], o), /private\/loopback.*10\.0\.0\.5/);
  await assert.rejects(resolveOutgoingFiles(['https://example.com/bounce'], o), /169\.254\.169\.254/);
  assert.deepEqual(calls, ['https://example.com/bounce'], 'the redirect target was never fetched');
  // Explicit override for deliberately-internal deployments.
  const ok = await resolveOutgoingFiles(['http://127.0.0.1:8810/health'], { ...o, allowPrivateUrls: true });
  assert.equal(ok!.length, 1);
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '::ffff:a00:1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:808:808', '64:ff9b::808:808']) assert.equal(isPrivateAddress(a), false, a);
});

test('url: v4-mapped and NAT64 v6 literals are refused THROUGH the URL path (the parser rewrites them to hex)', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (u: string) => { calls.push(u); return new Response(png, { status: 200 }); }) as unknown as typeof fetch;
  const o = { fetch: fakeFetch, lookup: publicDns };
  for (const u of ['http://[::ffff:127.0.0.1]:8810/a.txt', 'http://[::ffff:7f00:1]:8810/a.txt', 'http://[64:ff9b::7f00:1]/a.txt', 'http://[::ffff:169.254.169.254]/latest/meta-data/']) {
    await assert.rejects(resolveOutgoingFiles([u], o), /private\/loopback/, u);
  }
  assert.deepEqual(calls, [], 'nothing was fetched');
  // A public v4-mapped literal still works.
  assert.equal((await resolveOutgoingFiles(['http://[::ffff:8.8.8.8]/x.png'], o))!.length, 1);
});

test('credentials and identity files are never attachable, whatever the roots', async () => {
  for (const name of ['lena46.creds.json', 'root.identities.json', 'p1.state.json']) {
    writeFileSync(join(dir, name), '{"token":"SECRET"}');
    await assert.rejects(resolveOutgoingFiles([join(dir, name)], inDir), /refusing to attach a credentials/, name);
    await assert.rejects(resolveOutgoingFiles([join(dir, name)], { allowedRoots: ['/'] }), /refusing to attach/, name);
    await assert.rejects(resolveOutgoingFiles([{ path: join(dir, name), name: 'innocent.txt' }], inDir), /refusing to attach/, name);
  }
  // Via a symlink with an innocent name, too.
  symlinkSync(join(dir, 'lena46.creds.json'), join(dir, 'readme.txt'));
  await assert.rejects(resolveOutgoingFiles([join(dir, 'readme.txt')], inDir), /refusing to attach/);
});

test('a path outside the roots learns nothing about whether it exists', async () => {
  const o = { allowedRoots: [dir] };
  await assert.rejects(resolveOutgoingFiles(['/etc/hosts'], o), /outside the allowed roots/);
  await assert.rejects(resolveOutgoingFiles(['/etc/definitely-not-a-file-xyz'], o), /outside the allowed roots/);
});

test('url: a body with no Content-Length is cut off at the budget, not buffered whole', async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); },
  });
  const fakeFetch = (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    resolveOutgoingFiles(['https://example.com/endless.bin'], { fetch: fakeFetch, lookup: publicDns, maxTotalBytes: 4096 }),
    /exceed the per-message budget/,
  );
  assert.ok(pulled < 20, `stopped reading early (pulled ${pulled} chunks)`);
});

test('fileOptionsFromEnv: private URLs opt-in', () => {
  assert.deepEqual(fileOptionsFromEnv({ PORTAL_ALLOW_PRIVATE_URLS: 'true', PORTAL_FILE_ROOTS: 'off' }), { allowPrivateUrls: true });
});

test('a denied path never says where it resolves', async () => {
  const inside = mkdtempSync(join(tmpdir(), 'portal-files-in-'));
  const outside = mkdtempSync(join(tmpdir(), 'portal-files-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(join(outside, 'secret.txt'), join(outside, 'link.txt'));
  await assert.rejects(
    resolveOutgoingFiles([join(outside, 'link.txt')], { allowedRoots: [inside] }),
    (err: Error) => /outside the allowed roots/.test(err.message) && !err.message.includes('secret.txt') && !err.message.includes('→'),
  );
});

test('local files are read under the cap (a file larger than what is left is refused while reading)', async () => {
  const p = join(dir, 'big.bin');
  writeFileSync(p, Buffer.alloc(1000, 7));
  assert.equal((await readFileCapped(p, 1000, 'x')).length, 1000);
  await assert.rejects(readFileCapped(p, 999, 'x'), /grew past 999 bytes/);
});

test('configured credential/roster/state files are refused by resolved path, whatever their names', async () => {
  const p = join(dir, 'cc-creds.json');
  writeFileSync(p, '{"token":"SECRET"}');
  const o = fileOptionsFromEnv({ PORTAL_FILE_ROOTS: dir, PORTAL_CREDENTIALS: p });
  await assert.rejects(resolveOutgoingFiles([p], o), /refusing to attach a credentials/);
  // …also through a symlink with an innocent name.
  symlinkSync(p, join(dir, 'notes-link.txt'));
  await assert.rejects(resolveOutgoingFiles([join(dir, 'notes-link.txt')], o), /refusing to attach a credentials/);
});

test('a compressed response is charged its decoded size, not its Content-Length', async () => {
  const fakeFetch = (async () =>
    new Response('hello', { status: 200, headers: { 'content-length': '25', 'content-encoding': 'gzip', 'content-type': 'text/plain' } })) as unknown as typeof fetch;
  const out = await resolveOutgoingFiles(['https://example.com/h.txt'], { fetch: fakeFetch, lookup: publicDns, maxTotalBytes: 5 });
  assert.equal(Buffer.from(out![0].bytes!, 'base64').toString(), 'hello');
});

test('a refused download is cancelled, redirects included', async () => {
  const cancelled: string[] = [];
  const body = (tag: string) =>
    new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled.push(tag); },
    });
  const fakeFetch = (async (url: string) =>
    url.endsWith('/start')
      ? new Response(body('redirect'), { status: 302, headers: { location: 'https://example.com/gone' } })
      : new Response(body('404'), { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(resolveOutgoingFiles(['https://example.com/start'], { fetch: fakeFetch, lookup: publicDns }), /HTTP 404/);
  assert.deepEqual(cancelled.sort(), ['404', 'redirect']);
});

test('a dangling symlink inside a root that points outside reads "outside", not "no such file"', async () => {
  const inside = mkdtempSync(join(tmpdir(), 'portal-files-dangle-'));
  symlinkSync('/definitely/elsewhere/missing.txt', join(inside, 'dangling.txt'));
  await assert.rejects(resolveOutgoingFiles([join(inside, 'dangling.txt')], { allowedRoots: [inside] }), /outside the allowed roots/);
  symlinkSync(join(inside, 'not-yet.txt'), join(inside, 'dangling-inside.txt'));
  await assert.rejects(resolveOutgoingFiles([join(inside, 'dangling-inside.txt')], { allowedRoots: [inside] }), /no such file/);
});

test('nothing from the credentials directory, and no hard link to its files, is attachable', async () => {
  const credsDir = mkdtempSync(join(tmpdir(), 'portal-files-creds-'));
  const work = mkdtempSync(join(tmpdir(), 'portal-files-work-'));
  writeFileSync(join(credsDir, 'token-store'), 'SECRET');
  writeFileSync(join(credsDir, 'notes.txt'), 'x');
  const o = { allowedRoots: [work, credsDir], denyDirs: [credsDir] };
  await assert.rejects(resolveOutgoingFiles([join(credsDir, 'notes.txt')], o), /refusing to attach a credentials/);
  linkSync(join(credsDir, 'token-store'), join(work, 'innocent.bin'));
  await assert.rejects(resolveOutgoingFiles([join(work, 'innocent.bin')], o), /refusing to attach a credentials/, 'same inode, other name');
  writeFileSync(join(work, 'x.creds.json.bak'), 'SECRET');
  await assert.rejects(resolveOutgoingFiles([join(work, 'x.creds.json.bak')], o), /refusing to attach a credentials/, 'a copy by name');
  writeFileSync(join(work, 'fine.txt'), 'ok');
  assert.equal((await resolveOutgoingFiles([join(work, 'fine.txt')], o))!.length, 1);
});

test('v4-compatible, v4-translated and local-use NAT64 v6 forms are private', () => {
  for (const a of ['::7f00:1', '::ffff:0:7f00:1', '64:ff9b:1::7f00:1']) assert.equal(isPrivateAddress(a), true, a);
  assert.equal(isPrivateAddress('2606:4700::6810:85e5'), false);
});
