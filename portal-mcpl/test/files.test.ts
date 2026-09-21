import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutgoingFiles, fileOptionsFromEnv } from '../src/files.js';

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
  const out = await resolveOutgoingFiles(['https://example.com/pics/cat%20one.png?x=1'], { fetch: fakeFetch });
  assert.equal(out![0].name, 'cat one.png');
  assert.equal(out![0].contentType, 'image/png');
  assert.deepEqual(Buffer.from(out![0].bytes!, 'base64'), png);
});

test('url in `path` slot is treated as a url; http error is legible', async () => {
  const fakeFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(resolveOutgoingFiles([{ path: 'https://example.com/x' }], { fetch: fakeFetch }), /HTTP 404/);
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
