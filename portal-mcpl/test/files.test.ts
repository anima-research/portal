import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutgoingFiles, fileOptionsFromEnv, isPrivateAddress } from '../src/files.js';

/** DNS double: everything public unless the host says otherwise. */
const publicDns = async (host: string) => (host.startsWith('internal') ? ['10.0.0.5'] : ['93.184.216.34']);

const dir = mkdtempSync(join(tmpdir(), 'portal-files-'));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
writeFileSync(join(dir, 'dot.png'), png);
writeFileSync(join(dir, 'notes.txt'), 'hello');

test('bare path string → bytes with inferred name + mime', async () => {
  const out = await resolveOutgoingFiles([join(dir, 'dot.png')]);
  assert.equal(out!.length, 1);
  assert.equal(out![0].name, 'dot.png');
  assert.equal(out![0].contentType, 'image/png');
  assert.equal(out![0].path, undefined);
  assert.deepEqual(Buffer.from(out![0].bytes!, 'base64'), png);
});

test('object path, relative to cwd, with override name', async () => {
  const out = await resolveOutgoingFiles([{ path: 'notes.txt', name: 'renamed.md' }], { cwd: dir });
  assert.equal(out![0].name, 'renamed.md');
  assert.equal(out![0].contentType, 'text/markdown');
  assert.equal(Buffer.from(out![0].bytes!, 'base64').toString(), 'hello');
});

test('missing file gives a legible error', async () => {
  await assert.rejects(resolveOutgoingFiles([join(dir, 'nope.bin')]), /no such file/);
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
  await assert.rejects(resolveOutgoingFiles([join(dir, 'dot.png')], { maxTotalBytes: 3 }), /exceed the per-message budget/);
  await assert.rejects(resolveOutgoingFiles(new Array(11).fill(join(dir, 'dot.png'))), /too many files/);
});

test('empty/null files → undefined', async () => {
  assert.equal(await resolveOutgoingFiles(undefined), undefined);
  assert.equal(await resolveOutgoingFiles([]), undefined);
});

test('fileOptionsFromEnv', () => {
  assert.deepEqual(fileOptionsFromEnv({}), {});
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
    /outside the allowed roots.*→/,
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
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPrivateAddress(a), false, a);
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
  assert.deepEqual(fileOptionsFromEnv({ PORTAL_ALLOW_PRIVATE_URLS: 'true' }), { allowPrivateUrls: true });
});
