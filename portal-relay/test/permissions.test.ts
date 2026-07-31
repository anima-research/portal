import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsStore } from '../src/permissions.js';
import type { Capability } from '@animalabs/portal-protocol';
import type { PermissionsFile } from '../src/config.js';

/** Visibility-only mirror entry: channels in scope, per-channel caps unused. */
const chans = (...ids: string[]): Map<string, Set<Capability>> =>
  new Map(ids.map((id) => [id, new Set<Capability>()]));

function tmpFile(contents: PermissionsFile): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-perms-'));
  const path = join(dir, 'permissions.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] as const;
const sorted = (s: Set<string>) => [...s].sort();

test('legacy inline PersonaPolicy still resolves (backward compat)', () => {
  // No `roles`/`policy` wrapper — the old on-disk shape.
  const path = tmpFile({
    personas: {
      lena: { default: ['VIEW_CHANNEL'], guilds: { g1: { channels: { c1: [...RW] } } } },
    },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('lena', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('lena', 'g1', 'other')), ['VIEW_CHANNEL']); // guild has no default → persona default
  assert.deepEqual(sorted(store.resolve('unknown', 'g1', 'c1')), []); // file default deny
  rmSync(path, { force: true });
});

test('scoped grant (channels) is default-deny outside scope', () => {
  // Shape an enrollment would stamp for grant{ scope:{channels:[pub]} }.
  const path = tmpFile({
    personas: {
      guest: { policy: { default: [], guilds: { g1: { default: [], channels: { pub: [...RW] } } } } },
    },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'pub')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'private')), []); // outside scope → deny
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'anything')), []);
  rmSync(path, { force: true });
});

test('access roles: channels scope + union (most-permissive) across roles', () => {
  const path = tmpFile({
    roles: {
      reader: { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { channels: ['c1', 'c2'] }, guildId: 'g1' },
      poster: { caps: ['SEND_MESSAGES'], scope: { channels: ['c2'] }, guildId: 'g1' },
    },
    personas: { bot: { roles: ['reader', 'poster'] } },
  });
  const store = new PermissionsStore(path);
  // c1: only reader applies
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c1')), ['READ_HISTORY', 'VIEW_CHANNEL']);
  // c2: union of both
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c2')), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
  // c3: neither → deny
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c3')), []);
  rmSync(path, { force: true });
});

test('scope:{all} grants all channels of ITS guild only; unknown/unbound roles are ignored', () => {
  const path = tmpFile({
    roles: {
      admin: { caps: [...RW], scope: { all: true }, guildId: 'g1' },
      // Legacy unbound role: dropped at load (roles are guild-scoped, PERIOD).
      relic: { caps: [...RW], scope: { all: true } },
    },
    personas: { a: { roles: ['admin', 'ghost', 'relic'] } },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('a', 'g1', 'anywhere')), [...RW].sort());
  // Same role resolves NOTHING in another guild or DM context.
  assert.deepEqual(sorted(store.resolve('a', 'g2', 'anywhere')), []);
  assert.deepEqual(sorted(store.resolve('a', null, 'dm')), []);
  assert.equal(store.getRole('relic'), undefined);
  rmSync(path, { force: true });
});

test('mirrorRole scope: fail-closed without lookup, then gated by visibility', () => {
  const path = tmpFile({
    roles: { staff: { caps: [...RW], scope: { mirrorRole: 'role-staff' }, guildId: 'g1' } },
    personas: { s: { roles: ['staff'] } },
  });
  const store = new PermissionsStore(path);

  // No mirror lookup injected yet → deny everything (fail-closed).
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c1')), []);

  // Inject a fake visibility: role-staff sees c1, c2 (but not c3).
  const visible = new Map([['g1:role-staff', chans('c1', 'c2')]]);
  store.setMirrorLookup((g, r) => visible.get(`${g}:${r}`) ?? new Map());

  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c2')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c3')), []); // not visible → deny
  // Cross-guild: mirror is per-guild → deny.
  assert.deepEqual(sorted(store.resolve('s', 'g2', 'c1')), []);
  rmSync(path, { force: true });
});

test('mirrorRoles scope: union of several roles; fail-closed without lookup', () => {
  const path = tmpFile({
    roles: { team: { caps: [...RW], scope: { mirrorRoles: ['r-a', 'r-b'] }, guildId: 'g1' } },
    personas: { t: { roles: ['team'] } },
  });
  const store = new PermissionsStore(path);

  // No lookup → deny (fail-closed).
  assert.deepEqual(sorted(store.resolve('t', 'g1', 'c1')), []);

  // r-a sees c1,c2; r-b sees c2,c3 → union = c1,c2,c3 (not c4).
  const vis = new Map([
    ['g1:r-a', chans('c1', 'c2')],
    ['g1:r-b', chans('c2', 'c3')],
  ]);
  store.setMirrorLookup((g, r) => vis.get(`${g}:${r}`) ?? new Map());

  assert.deepEqual(sorted(store.resolve('t', 'g1', 'c1')), [...RW].sort()); // via r-a
  assert.deepEqual(sorted(store.resolve('t', 'g1', 'c3')), [...RW].sort()); // via r-b
  assert.deepEqual(sorted(store.resolve('t', 'g1', 'c2')), [...RW].sort()); // both
  assert.deepEqual(sorted(store.resolve('t', 'g1', 'c4')), []); // neither
  assert.deepEqual(sorted(store.resolve('t', 'g2', 'c1')), []); // per-guild → cross-guild deny
  rmSync(path, { force: true });
});

test('mirrorCaps: caps act as a mask over what the mirrored role can do per channel', () => {
  const path = tmpFile({
    roles: {
      everyone: {
        caps: [...RW, 'ADD_REACTIONS'],
        scope: { mirrorRole: 'r-everyone' },
        guildId: 'g1',
        mirrorCaps: true,
      },
    },
    personas: { m: { roles: ['everyone'] } },
  });
  const store = new PermissionsStore(path);

  // No lookup → deny (fail-closed), same as visibility-only mirrors.
  assert.deepEqual(sorted(store.resolve('m', 'g1', 'open')), []);

  // open: role can do everything incl. MANAGE_MESSAGES; readonly: view/history only.
  const caps = new Map<string, Map<string, Set<Capability>>>([
    [
      'g1:r-everyone',
      new Map([
        ['open', new Set<Capability>([...RW, 'ADD_REACTIONS', 'MANAGE_MESSAGES'])],
        ['readonly', new Set<Capability>(['VIEW_CHANNEL', 'READ_HISTORY'])],
      ]),
    ],
  ]);
  store.setMirrorLookup((g, r) => caps.get(`${g}:${r}`) ?? new Map());

  // open: full mask granted — but NOT MANAGE_MESSAGES (outside the mask).
  assert.deepEqual(sorted(store.resolve('m', 'g1', 'open')), [...RW, 'ADD_REACTIONS'].sort());
  // readonly: visible, but caps clamp to what the mirrored role can do there.
  assert.deepEqual(sorted(store.resolve('m', 'g1', 'readonly')), ['READ_HISTORY', 'VIEW_CHANNEL']);
  // invisible channel: deny.
  assert.deepEqual(sorted(store.resolve('m', 'g1', 'hidden')), []);
  // cross-guild: deny.
  assert.deepEqual(sorted(store.resolve('m', 'g2', 'open')), []);
  rmSync(path, { force: true });
});

test('couldAccessGuild: gates addressing-role minting per guild', () => {
  // channelInGuild is guild-specific in the relay (closure over the queried
  // guild); model that with a channel→guild owner map.
  const OWNER = { 'c-in-gB': 'gB', cA: 'gA' };
  const inGuild = (guild) => (cid) => OWNER[cid] === guild;
  const path = tmpFile({
    roles: {
      gA: { caps: [...RW], scope: { mirrorRoles: ['rA'] }, guildId: 'gA' },
      chans: { caps: [...RW], scope: { channels: ['c-in-gB'] }, guildId: 'gB' },
      everywhere: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'gA' },
      empty: { caps: [], scope: { all: true }, guildId: 'gA' }, // no caps → grants nothing
    },
    personas: {
      mirror: { roles: ['gA'] },
      chan: { roles: ['chans'] },
      admin: { roles: ['everywhere'] },
      none: { roles: ['empty'] },
      legacy: { policy: { default: [], guilds: { gB: { default: [...RW] } } } },
    },
  });
  const store = new PermissionsStore(path);
  // mirror role rA can see a channel only in gA
  store.setMirrorLookup((g, r) => (g === 'gA' && r === 'rA' ? chans('cA') : new Map()));

  // mirror persona: access in gA, not gB
  assert.equal(store.couldAccessGuild('mirror', 'gA', inGuild('gA')), true);
  assert.equal(store.couldAccessGuild('mirror', 'gB', inGuild('gB')), false);
  // channels-scope persona: access only in the guild that owns the channel
  assert.equal(store.couldAccessGuild('chan', 'gB', inGuild('gB')), true);
  assert.equal(store.couldAccessGuild('chan', 'gA', inGuild('gA')), false);
  // all-scope: access in the role's own guild only (guild-scoped, PERIOD)
  assert.equal(store.couldAccessGuild('admin', 'gA', inGuild('gA')), true);
  assert.equal(store.couldAccessGuild('admin', 'anyGuild', inGuild('anyGuild')), false);
  // empty-caps role: no access anywhere
  assert.equal(store.couldAccessGuild('none', 'gA', inGuild('gA')), false);
  // legacy per-guild policy
  assert.equal(store.couldAccessGuild('legacy', 'gB', inGuild('gB')), true);
  assert.equal(store.couldAccessGuild('legacy', 'gA', inGuild('gA')), false);
  // unknown persona, file default deny
  assert.equal(store.couldAccessGuild('ghost', 'gA', inGuild('gA')), false);
  rmSync(path, { force: true });
});

test('setPersonaPolicy / setPersonaRoles persist and round-trip', () => {
  const path = tmpFile({ roles: { r: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' } }, personas: {} });
  const store = new PermissionsStore(path);

  store.setPersonaPolicy('p1', { default: [], guilds: { g1: { default: [], channels: { c1: [...RW] } } } });
  store.setPersonaRoles('p2', ['r']);

  // Reload from disk into a fresh store and re-resolve.
  const reloaded = new PermissionsStore(path);
  assert.deepEqual(sorted(reloaded.resolve('p1', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(reloaded.resolve('p1', 'g1', 'c2')), []);
  assert.deepEqual(sorted(reloaded.resolve('p2', 'g1', 'anywhere')), ['VIEW_CHANNEL']);

  // policy-only persona persists in legacy inline shape (no `policy` wrapper).
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as PermissionsFile;
  assert.ok('default' in (onDisk.personas.p1 as Record<string, unknown>));
  assert.deepEqual((onDisk.personas.p2 as { roles: string[] }).roles, ['r']);
  rmSync(path, { force: true });
});

// ── Guild-scoped roles hardening: review regressions (PR #9) ──

test('couldAccessGuild mirrors resolvePolicy transparency: undefined guild default falls through; explicit [] shadows', () => {
  const path = tmpFile({
    personas: {
      // Canonical legacy shape: nonempty persona default + channel-only guild entry.
      lena: { policy: { default: ['VIEW_CHANNEL'], guilds: { g1: { channels: { c1: ['VIEW_CHANNEL'] } } } } },
      // /ban shape: explicit guild deny must SHADOW the nonempty default.
      banned: { policy: { default: ['VIEW_CHANNEL'], guilds: { g1: { default: [] } } } },
    },
  });
  const store = new PermissionsStore(path);
  // resolve grants via fall-through — couldAccessGuild must agree (a mismatch
  // unbinds addressing roles and silences ambient dispatch while the persona
  // can still act: deaf-but-speaking).
  assert.deepEqual(sorted(store.resolve('lena', 'g1', 'other-chan')), ['VIEW_CHANNEL']);
  assert.equal(store.couldAccessGuild('lena', 'g1', () => false), true);
  // Explicit deny: both sides deny in g1, default still applies elsewhere.
  assert.deepEqual(sorted(store.resolve('banned', 'g1', 'any')), []);
  assert.equal(store.couldAccessGuild('banned', 'g1', () => false), false);
  assert.equal(store.couldAccessGuild('banned', 'g2', () => false), true);
  rmSync(path, { force: true });
});

test('clearGuild creates the entry for entry-less personas and contains the side effect to one guild', () => {
  const path = tmpFile({ default: ['VIEW_CHANNEL'], personas: {} });
  const store = new PermissionsStore(path);
  // Entry-less persona rides the FILE default everywhere.
  assert.deepEqual(sorted(store.resolve('ghost', 'g1', 'c')), ['VIEW_CHANNEL']);
  assert.deepEqual(sorted(store.resolve('ghost', 'g2', 'c')), ['VIEW_CHANNEL']);

  store.clearGuild('ghost', 'g1');

  // Denied in the banned guild — but NOT fleet-wide: the entry creation
  // seeded the persona default from the file default, so other guilds keep
  // working (a guild-scoped /ban must not have fleet-wide collateral).
  assert.deepEqual(sorted(store.resolve('ghost', 'g1', 'c')), []);
  assert.equal(store.couldAccessGuild('ghost', 'g1', () => false), false);
  assert.deepEqual(sorted(store.resolve('ghost', 'g2', 'c')), ['VIEW_CHANNEL']);
  assert.equal(store.couldAccessGuild('ghost', 'g2', () => false), true);
  rmSync(path, { force: true });
});

test('unbound/malformed catalog entries are quarantined: inert in resolution, preserved across persist', () => {
  const path = tmpFile({
    roles: {
      good: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' },
      relic: { caps: ['VIEW_CHANNEL'], scope: { all: true } }, // no guildId
      broken: null, // hand-edit damage — must not crash load
    },
    personas: { p: { roles: ['good', 'relic'] } },
  });
  const store = new PermissionsStore(path);
  assert.equal(store.getRole('relic'), undefined, 'quarantined roles resolve to nothing');
  assert.deepEqual(sorted(store.resolve('p', 'g1', 'c')), ['VIEW_CHANNEL'], 'good role unaffected');

  // A mutation persists — quarantined entries must survive the write.
  store.setPersonaRoles('p2', ['good']);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok('relic' in onDisk.roles, 'quarantined entry preserved on save');
  assert.ok('broken' in onDisk.roles, 'malformed entry preserved on save');
  assert.ok('good' in onDisk.roles);
  rmSync(path, { force: true });
});

test('setRole rejects unbound roles', () => {
  const path = tmpFile({ personas: {} });
  const store = new PermissionsStore(path);
  assert.throws(
    () => store.setRole('nowhere', { caps: ['VIEW_CHANNEL'], scope: { all: true } } as never),
    /guild-scoped/,
  );
  rmSync(path, { force: true });
});
