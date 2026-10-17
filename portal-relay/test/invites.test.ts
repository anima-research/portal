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

test('a uses of false reads as 0: a claim is allowed, and a use makes it 1', () => {
  const path = tmpFile({ invites: [{ code: 'c', caps: ['VIEW_CHANNEL'], maxUses: 1, uses: false }] });
  try {
    const store = new InviteStore(path);
    assert.ok(typeof store.check('c', NOW) !== 'string', String(store.check('c', NOW)));
    store.consume('c');
    assert.equal(store.check('c', NOW), 'exhausted');
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { invites: Array<{ uses: unknown }> };
    assert.equal(onDisk.invites[0].uses, 1);
  } finally {
    rmSync(path, { force: true });
  }
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

// Date.parse reads a number as a date string: 2030 as 2030-01-01, 99999 as the year 99999.
const EXPIRIES: Array<[string, unknown, 'expired' | 'none']> = [
  ['zero', 0, 'expired'],
  ['a year', 2030, 'expired'],
  ['a far year', 99999, 'expired'],
  ['a boxed number', [99999], 'expired'],
  ['null', null, 'none'],
  ['empty', '', 'none'],
  ['false', false, 'none'],
];
for (const [what, expiresAt, reads] of EXPIRIES) {
  test(`expiry: ${what} (${JSON.stringify(expiresAt)}) reads as ${reads}, since only a string names an expiry`, () => {
    const path = tmpFile({ invites: [{ code: 'c', guildId: 'g1', roles: ['r'], expiresAt }] } as any);
    const got = new InviteStore(path).check('c', NOW);
    rmSync(path, { force: true });
    if (reads === 'expired') assert.equal(got, 'expired', `check gave ${JSON.stringify(got)}`);
    else assert.ok(typeof got !== 'string', `check gave ${JSON.stringify(got)}`);
  });
}

test('pruning drops an invite whose expiry is not a string, as check() reads it', () => {
  const base = { guildId: 'g1', roles: ['r'] };
  const path = tmpFile({
    invites: [
      { code: 'zero', ...base, expiresAt: 0 },
      { code: 'year', ...base, expiresAt: 2030 },
      { code: 'keep', ...base, maxUses: 5, uses: 0 },
    ],
  } as any);
  const store = new InviteStore(path);
  store.consume('keep'); // every persist prunes
  assert.equal(store.get('zero'), undefined);
  assert.equal(store.get('year'), undefined);
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { invites: Array<{ code: string }> };
  assert.deepEqual(onDisk.invites.map((i) => i.code), ['keep']);
  rmSync(path, { force: true });
});

test('loading names each invite a claim would refuse, with the field; null reads as absent except in a count', (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const base = { guildId: 'g1', roles: ['r'] };
  const refused: Array<[string, Record<string, unknown>, string]> = [
    ['guild-number', { guildId: 7 }, 'invite guildId must be a string'],
    ['minter-number', { mintedBy: 7 }, 'invite mintedBy must be a string'],
    ['prefix-number', { namePrefix: 7 }, 'invite namePrefix must be a string'],
    ['mode-typo', { mode: 'augmnet' }, 'invite mode must be "mint", "augment" or "both"'],
    ['roles-string', { roles: 'r' }, 'invite roles must be a list of access role names'],
    ['roles-mixed', { roles: ['r', 7] }, 'invite roles must be a list of access role names'],
    // Unchecked, a role list of '', 0 or false would throw where enroll and a claim read it, '' in uses
    // would grow as text, and '' in a count would exhaust the invite.
    ['roles-blank', { roles: '' }, 'invite roles must be a list of access role names'],
    ['roles-zero', { roles: 0 }, 'invite roles must be a list of access role names'],
    ['roles-false', { roles: false }, 'invite roles must be a list of access role names'],
    ['uses-blank', { uses: '' }, 'invite uses must be a finite number'],
    ['count-blank', { maxUses: '' }, 'invite maxUses must be a finite number above 0'],
    ['subs-mixed', { subscriptions: ['c1', 5] }, 'invite subscriptions must be a list of channel ids'],
    ['caps-mixed', { caps: ['SEND_MESSAGES', 5] }, 'invite caps must be a list of capabilities'],
    ['grant-zero', { grant: 0 }, 'invite grant must be an object, { caps, scope }'],
    ['grant-blank', { grant: '' }, 'invite grant must be an object, { caps, scope }'],
    ['caps-number', { roles: undefined, caps: 5 }, 'invite caps must be a list of capabilities'],
    ['caps-text', { roles: undefined, caps: 'VIEW_CHANNEL' }, 'invite caps must be a list of capabilities'],
    ['uses-word', { uses: 'x' }, 'invite uses must be a finite number'],
    ['count-word', { maxUses: 'one' }, 'invite maxUses must be a finite number above 0'],
    ['count-text', { maxUses: '5' }, 'invite maxUses must be a finite number above 0'],
    ['count-zero', { maxUses: 0 }, 'invite maxUses must be a finite number above 0'],
    ['count-negative', { maxUses: -1 }, 'invite maxUses must be a finite number above 0'],
    ['count-null', { maxUses: null }, 'invite maxUses must be a finite number above 0'],
    ['expiry-number', { expiresAt: 2030 }, "invite expiresAt isn't a date, so it reads as expired and the relay's next save drops it"],
    ['expiry-word', { expiresAt: 'tomorrow' }, "invite expiresAt isn't a date, so it reads as expired and the relay's next save drops it"],
  ];
  const kept: Array<[string, Record<string, unknown>]> = [
    ['plain', {}],
    ['nulls', { mintedBy: null, namePrefix: null, mode: null, subscriptions: null, uses: null, expiresAt: null }],
    ['expiry-empty', { expiresAt: '' }],
    // Their readers read '', false and 0 as none.
    ['blanks', { mode: '', caps: '', subscriptions: '' }],
    ['falses', { mode: false, caps: false, subscriptions: false }],
    ['zeros', { mode: 0, caps: 0, subscriptions: 0 }],
    ['grant-null', { grant: null }],
    ['expiry-false', { expiresAt: false }],
    ['expiry-date', { expiresAt: '2099-01-01T00:00:00.000Z' }],
    ['roles-null', { roles: null, grant: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }],
    ['caps-null', { caps: null }],
    ['caps-empty', { caps: [] }],
    ['fraction', { maxUses: 2.5, uses: 0.5 }],
    ['negative-uses', { uses: -1 }],
    // A claim reads a uses of false as 0, and consume makes it 1.
    ['uses-false', { uses: false }],
    ['empty-minter', { mintedBy: '' }],
  ];
  const path = tmpFile({
    invites: [...refused, ...kept].map(([code, fields]) => ({ code, label: code, ...base, ...fields })),
  } as any);
  new InviteStore(path);
  const line = errors.find((l) => /will be refused/.test(l)) ?? '';
  assert.match(line, new RegExp(`\\b${refused.length} invite\\(s\\) will be refused`), line);
  for (const [code, , why] of refused) assert.ok(line.includes(`${code} (${why})`), `${code}: ${line}`);
  for (const [code] of kept) assert.ok(!line.includes(`${code} (`), `${code}: ${line}`);
  rmSync(path, { force: true });
});

test('loading names a count or uses that JSON reads as infinite, and says the relay\'s next save drops it', (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const dir = mkdtempSync(join(tmpdir(), 'portal-invites-'));
  const path = join(dir, 'invites.json');
  // Written as text, since JSON.stringify would write Infinity as null.
  const invite = (code: string, field: string) => `{"code":"${code}","label":"${code}","guildId":"g1","roles":["r"],${field}}`;
  writeFileSync(path, `{"invites":[${[
    invite('count-infinite', '"maxUses":1e400'),
    invite('uses-infinite', '"uses":1e400'),
    invite('uses-minus-infinite', '"uses":-1e400'),
  ].join(',')}]}`);
  new InviteStore(path);
  const line = errors.find((l) => /will be refused/.test(l)) ?? '';
  assert.ok(line.includes("count-infinite (invite maxUses must be a finite number above 0, and the relay's next save drops it)"), line);
  assert.ok(line.includes("uses-infinite (invite uses must be a finite number, and the relay's next save drops it)"), line);
  assert.ok(line.includes("uses-minus-infinite (invite uses must be a finite number, and the relay's next save drops it)"), line);
  rmSync(dir, { recursive: true, force: true });
});

test('loading names a refused invite that has no label by its code\'s first 12 characters, a code that isn\'t a string included', (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const path = tmpFile({
    invites: [
      { code: 42, guildId: 'g1', roles: ['r'], maxUses: 'x' },
      { code: 'abcdefghijklmnop', guildId: 'g1', roles: ['r'], maxUses: 'x' },
    ],
  });
  new InviteStore(path);
  const line = errors.find((l) => /will be refused/.test(l)) ?? '';
  assert.ok(line.includes('42 (invite maxUses must be a finite number above 0)'), line);
  assert.ok(line.includes('abcdefghijkl (invite maxUses must be a finite number above 0)'), line);
  rmSync(path, { force: true });
});

test('a save drops an invite whose count or uses JSON read as infinite, since JSON would write it as null', (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'portal-invites-'));
  const path = join(dir, 'invites.json');
  // Written as text, since JSON.stringify would write Infinity as null.
  const invite = (code: string, field: string) => `{"code":"${code}","label":"${code}","guildId":"g1","roles":["r"],${field}}`;
  writeFileSync(path, `{"invites":[${[
    invite('count-infinite', '"maxUses":1e400'),
    invite('count-minus-infinite', '"maxUses":-1e400'),
    invite('uses-infinite', '"maxUses":5,"uses":1e400'),
    invite('uses-minus-infinite', '"uses":-1e400'),
    invite('plain', '"maxUses":5,"uses":1'),
  ].join(',')}]}`);
  const store = new InviteStore(path);
  store.mint({ code: 'fresh', label: 'fresh', guildId: 'g1', roles: ['r'] } as any);
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(JSON.parse(text).invites.map((i: { code: string }) => i.code).sort(), ['fresh', 'plain'], text);
  assert.deepEqual(new InviteStore(path).all().map((i) => i.code).sort(), ['fresh', 'plain']);
  rmSync(dir, { recursive: true, force: true });
});

