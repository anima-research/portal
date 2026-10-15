import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InviteStore, codePrefix, inviteShapeError } from '../src/invites.js';

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

test('an expiresAt that is neither absent nor a timestamp counts as expired, and is pruned', () => {
  const path = tmpFile({
    invites: [
      { code: 'zero', caps: ['VIEW_CHANNEL'], expiresAt: 0 },
      { code: 'empty', caps: ['VIEW_CHANNEL'], expiresAt: '' },
      { code: 'false', caps: ['VIEW_CHANNEL'], expiresAt: false },
      { code: 'null', caps: ['VIEW_CHANNEL'], expiresAt: null },
      { code: 'none', caps: ['VIEW_CHANNEL'], maxUses: 5, uses: 0 },
    ],
  });
  const store = new InviteStore(path);
  for (const code of ['zero', 'empty', 'false']) assert.equal(store.check(code, NOW), 'expired', code);
  for (const code of ['null', 'none']) assert.ok(typeof store.check(code, NOW) !== 'string', code);
  store.consume('none'); // persisting prunes
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { invites: Array<{ code: string }> };
  assert.deepEqual(onDisk.invites.map((inv) => inv.code).sort(), ['none', 'null']);
  rmSync(path, { force: true });
});

test('a reload names each invite no claim can use, without its whole code', () => {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const path = tmpFile({
      invites: [
        { code: 'inv_secretcode123', caps: ['VIEW_CHANNEL'], maxUses: 'two' },
        { code: 'labelled-code', label: 'onboarding', roles: ['r'], grant: { caps: ['VIEW_CHANNEL'], scope: { all: true } } },
        { code: 'fine', caps: ['VIEW_CHANNEL'] },
      ],
    });
    new InviteStore(path);
    rmSync(path, { force: true });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(logged, [
    '[portal-relay] invite "inv_secr…" can\'t be claimed: invite maxUses must be a non-negative integer',
    '[portal-relay] invite "onboarding" can\'t be claimed: invite gives both roles and grant; it must give one of them',
  ]);
});

test('an invite gives roles or a grant, not both', () => {
  const grant = { caps: ['VIEW_CHANNEL'], scope: { all: true as const } };
  assert.equal(inviteShapeError({ code: 'a', roles: ['r'], grant } as never), 'invite gives both roles and grant; it must give one of them');
  assert.equal(inviteShapeError({ code: 'b', roles: ['r'] } as never), null);
  assert.equal(inviteShapeError({ code: 'c', grant } as never), null);
  // Null reads as absent, as for every optional field.
  assert.equal(inviteShapeError({ code: 'd', roles: null, grant } as never), null);
});

test('a code prefix is at most half the code and at most 12 characters', () => {
  assert.equal(codePrefix('inv_0123456789abcdef0123'), 'inv_01234567…');
  assert.equal(codePrefix('aug-g1'), 'aug…');
  assert.equal(codePrefix('x'), '…');
});
