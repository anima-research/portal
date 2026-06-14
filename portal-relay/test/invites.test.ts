import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InviteStore } from '../src/invites.js';

function tmpFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-invites-'));
  const path = join(dir, 'invites.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const NOW = Date.parse('2026-06-14T00:00:00.000Z');

test('check: unknown / valid / expired / exhausted', () => {
  const path = tmpFile({
    invites: [
      { code: 'open', caps: ['VIEW_CHANNEL'] },
      { code: 'capped', caps: ['VIEW_CHANNEL'], maxUses: 2, uses: 2 },
      { code: 'expired', caps: ['VIEW_CHANNEL'], expiresAt: '2020-01-01T00:00:00.000Z' },
      { code: 'fresh', caps: ['SEND_MESSAGES'], maxUses: 5, uses: 1, expiresAt: '2099-01-01T00:00:00.000Z' },
    ],
  });
  const store = new InviteStore(path);

  assert.equal(store.check('nope', NOW), 'unknown');
  assert.equal(store.check('capped', NOW), 'exhausted');
  assert.equal(store.check('expired', NOW), 'expired');

  const open = store.check('open', NOW);
  assert.ok(typeof open !== 'string');
  assert.deepEqual((open as { caps: string[] }).caps, ['VIEW_CHANNEL']);

  const fresh = store.check('fresh', NOW);
  assert.ok(typeof fresh !== 'string');

  rmSync(path, { force: true });
});

test('consume: bumps uses, persists, and eventually exhausts', () => {
  const path = tmpFile({ invites: [{ code: 'c', caps: ['VIEW_CHANNEL'], maxUses: 2, uses: 0 }] });
  const store = new InviteStore(path);

  assert.ok(typeof store.check('c', NOW) !== 'string');
  store.consume('c');
  assert.ok(typeof store.check('c', NOW) !== 'string'); // 1/2 still ok
  store.consume('c');
  assert.equal(store.check('c', NOW), 'exhausted'); // 2/2

  // persisted to disk
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { invites: Array<{ uses: number }> };
  assert.equal(onDisk.invites[0].uses, 2);

  rmSync(path, { force: true });
});

test('rejects duplicate codes / non-array invites', () => {
  const dup = tmpFile({ invites: [{ code: 'x', caps: [] }, { code: 'x', caps: [] }] });
  assert.throws(() => new InviteStore(dup), /duplicate invite code/);
  rmSync(dup, { force: true });

  const bad = tmpFile({ invites: {} });
  assert.throws(() => new InviteStore(bad), /must be an array/);
  rmSync(bad, { force: true });
});
