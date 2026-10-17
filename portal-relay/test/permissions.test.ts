import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsStore, roleGrantsAccess } from '../src/permissions.js';
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

test('unsetGuildDefault: removes the guild-wide setting, so channels fall back to the persona default', () => {
  const path = tmpFile({
    personas: {
      nyx: { policy: { default: ['VIEW_CHANNEL'], guilds: { g1: { default: [], channels: { c1: [...RW] } } } } },
      sol: { policy: { default: ['VIEW_CHANNEL'], guilds: { g1: { default: ['READ_HISTORY'] } } } },
    },
  });
  const store = new PermissionsStore(path);
  const changes: string[] = [];
  store.onChange((c) => changes.push(`${c.personaId}:${c.scope}:${c.guildId}`));
  assert.deepEqual(sorted(store.resolve('nyx', 'g1', 'c2')), [], 'denied guild-wide');
  assert.equal(store.unsetGuildDefault('nyx', 'g1'), true);
  assert.deepEqual(sorted(store.resolve('nyx', 'g1', 'c2')), ['VIEW_CHANNEL'], 'the persona default again');
  assert.deepEqual(sorted(store.resolve('nyx', 'g1', 'c1')), [...RW].sort(), 'direct grants untouched');
  assert.deepEqual(store.getEntry('nyx')?.policy?.guilds?.g1, { channels: { c1: [...RW] } });
  assert.equal(store.unsetGuildDefault('nyx', 'g1'), false, 'nothing left to unset');
  assert.equal(store.unsetGuildDefault('nobody', 'g1'), false);
  assert.deepEqual(changes, ['nyx:guild:g1'], 'one change, announced once');

  // A guild entry left with nothing in it is removed, and the guilds map with it.
  assert.equal(store.unsetGuildDefault('sol', 'g1'), true);
  assert.deepEqual(store.getEntry('sol')?.policy, { default: ['VIEW_CHANNEL'] });
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(onDisk.personas.sol, { default: ['VIEW_CHANNEL'] }, 'persisted');
  rmSync(path, { force: true });
});

test('clearChannel: an emptied channel map and guild entry are removed', () => {
  const path = tmpFile({
    personas: {
      quill: { policy: { default: [], guilds: { g1: { channels: { c1: ['VIEW_CHANNEL'], c2: [] } }, g2: { default: ['VIEW_CHANNEL'] } } } },
    },
  });
  const store = new PermissionsStore(path);
  store.clearChannel('quill', 'g1', 'c1');
  assert.deepEqual(store.getEntry('quill')?.policy?.guilds?.g1, { channels: { c2: [] } });
  store.clearChannel('quill', 'g1', 'c2');
  assert.deepEqual(store.getEntry('quill')?.policy?.guilds, { g2: { default: ['VIEW_CHANNEL'] } }, 'g1 is gone, g2 untouched');
  store.setChannel('quill', 'g2', 'c9', ['VIEW_CHANNEL']);
  store.clearChannel('quill', 'g2', 'c9');
  assert.deepEqual(store.getEntry('quill')?.policy?.guilds, { g2: { default: ['VIEW_CHANNEL'] } }, 'a guild with a guild-wide setting stays');
  rmSync(path, { force: true });
});

test('a persona on the file default keeps it elsewhere when one guild is changed; enrollment does not seed it', () => {
  const path = tmpFile({ default: ['VIEW_CHANNEL'], personas: {} });
  const store = new PermissionsStore(path);
  store.setChannel('cass', 'g1', 'c1', [...RW]);
  assert.deepEqual(sorted(store.resolve('cass', 'g2', 'cZ')), ['VIEW_CHANNEL'], 'a grant in g1');
  store.setGuildDefault('juniper', 'g1', []);
  assert.deepEqual(sorted(store.resolve('juniper', 'g2', 'cZ')), ['VIEW_CHANNEL'], 'a deny in g1');
  assert.deepEqual(sorted(store.resolve('juniper', 'g1', 'c1')), []);
  store.removePersonaRole('aria', 'nothing-held');
  assert.deepEqual(sorted(store.resolve('aria', 'g2', 'cZ')), ['VIEW_CHANNEL'], 'a role change');
  // Enrollment sets the whole entry from an invite: no copy of the file default.
  store.setPersonaRoles('fresh', []);
  assert.deepEqual(sorted(store.resolve('fresh', 'g2', 'cZ')), []);
  store.setPersonaPolicy('fresh2', { default: [], guilds: { g1: { default: ['VIEW_CHANNEL'] } } });
  assert.deepEqual(sorted(store.resolve('fresh2', 'g2', 'cZ')), []);
  rmSync(path, { force: true });
});

const MALFORMED_ROLES: Array<[string, unknown]> = [
  ['caps-number', { caps: 5, scope: { all: true }, guildId: 'g1' }],
  // A caps string with something in it is read a character at a time.
  ['caps-text', { caps: 'SEND_MESSAGES', scope: { all: true }, guildId: 'g1' }],
  ['scope-null', { caps: ['SEND_MESSAGES'], scope: null, guildId: 'g1' }],
  ['all-string', { caps: ['SEND_MESSAGES'], scope: { all: 'yes' }, guildId: 'g1' }],
  ['channels-string', { caps: ['SEND_MESSAGES'], scope: { channels: 'c1' }, guildId: 'g1' }],
  ['mirror-number', { caps: ['SEND_MESSAGES'], scope: { mirrorRole: 7 }, guildId: 'g1' }],
  ['mirrors-number', { caps: ['SEND_MESSAGES'], scope: { mirrorRoles: 5 }, guildId: 'g1' }],
  // couldAccessGuild takes `all` by its truth, and every other reader wants true.
  ['all-one', { caps: ['SEND_MESSAGES'], scope: { all: 1 }, guildId: 'g1' }],
  ['guild-number', { caps: ['SEND_MESSAGES'], scope: { all: true }, guildId: 123 }],
  // A scope names one kind at most, as every relay writer makes it, so every reader reads it alike.
  ['second-key', { caps: ['SEND_MESSAGES'], scope: { all: true, channels: 'c1' }, guildId: 'g1' }],
  ['two-kinds', { caps: ['SEND_MESSAGES'], scope: { all: true, mirrorRoles: ['r1'] }, guildId: 'g1' }],
  ['both-mirror-keys', { caps: ['SEND_MESSAGES'], scope: { mirrorRole: 'r1', mirrorRoles: ['r1'] }, guildId: 'g1' }],
  ['unknown-kind', { caps: ['SEND_MESSAGES'], scope: { everywhere: true }, guildId: 'g1' }],
  // Names an object inherits are no kind of scope.
  ['scope-constructor', { caps: ['SEND_MESSAGES'], scope: { constructor: true }, guildId: 'g1' }],
  ['scope-tostring', { caps: ['SEND_MESSAGES'], scope: { toString: true }, guildId: 'g1' }],
  ['scope-proto', { caps: ['SEND_MESSAGES'], scope: { ['__proto__']: true }, guildId: 'g1' }],
  // Every reader takes a string mirrorCaps as on, "false" included, and a list or an object too.
  ['mirrorcaps-string', { caps: ['SEND_MESSAGES'], scope: { mirrorRole: 'r1' }, mirrorCaps: 'false', guildId: 'g1' }],
  ['mirrorcaps-list', { caps: ['SEND_MESSAGES'], scope: { mirrorRole: 'r1' }, mirrorCaps: [], guildId: 'g1' }],
  ['mirrorcaps-object', { caps: ['SEND_MESSAGES'], scope: { mirrorRole: 'r1' }, mirrorCaps: {}, guildId: 'g1' }],
  // Each capability is named by a string.
  ['caps-mixed', { caps: ['SEND_MESSAGES', 5], scope: { all: true }, guildId: 'g1' }],
];
for (const [name, role] of MALFORMED_ROLES) {
  test(`role ${name}: quarantined at load, inert, warned about and kept on disk`, (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const good = { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' };
    const path = tmpFile({ roles: { good, [name]: role }, personas: { p: { roles: ['good', name] } } } as any);
    try {
      const store = new PermissionsStore(path);
      // Only role r1 sees c1, as a live mirror lookup would answer.
      store.setMirrorLookup((_g, r) => (r === 'r1' ? chans('c1') : new Map()));
      let caps: unknown;
      try { caps = sorted(store.resolve('p', 'g1', 'c1')); } catch (e) { caps = `threw: ${(e as Error).message}`; }
      assert.deepEqual(caps, ['VIEW_CHANNEL']);
      assert.equal(store.getRole(name), undefined, 'not loaded');
      assert.ok(errors.some((l) => l.includes(`role "${name}" can't be read`)), errors.join('\n'));
      // A save keeps the entry as written, for the operator to repair.
      store.setRole('another', { caps: ['VIEW_CHANNEL'], scope: { channels: ['c2'] }, guildId: 'g1' });
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { roles: Record<string, unknown> };
      assert.deepEqual(onDisk.roles[name], role);
    } finally {
      rmSync(path, { force: true });
    }
  });
}

test('each kind of scope, and mirrorCaps of 0, load and resolve', () => {
  const path = tmpFile({
    roles: {
      everywhere: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' },
      listed: { caps: ['SEND_MESSAGES'], scope: { channels: ['c1'] }, guildId: 'g1' },
      several: { caps: ['ADD_REACTIONS'], scope: { mirrorRoles: ['r1', 'r2'] }, guildId: 'g1' },
      zero: { caps: ['READ_HISTORY'], scope: { mirrorRole: 'r1' }, mirrorCaps: 0, guildId: 'g1' },
    },
    personas: { q: { roles: ['everywhere', 'listed', 'several', 'zero'] } },
  } as any);
  const store = new PermissionsStore(path);
  store.setMirrorLookup((_g, r) => (r === 'r1' ? chans('c1') : new Map()));
  assert.deepEqual(sorted(store.resolve('q', 'g1', 'c1')), ['ADD_REACTIONS', 'READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
  for (const name of ['everywhere', 'listed', 'several', 'zero']) assert.notEqual(store.getRole(name), undefined, name);
  rmSync(path, { force: true });
});

test('mirrorCaps of true, false, null, \'\', 0 and 1 load and read by their truth', () => {
  const forms: Array<[string, unknown]> = [['on', true], ['off', false], ['nulled', null], ['empty', ''], ['zero', 0], ['one', 1]];
  const path = tmpFile({
    roles: Object.fromEntries(forms.map(([name, mc]) =>
      [name, { caps: ['READ_HISTORY', 'SEND_MESSAGES'], scope: { mirrorRole: 'r1' }, mirrorCaps: mc, guildId: 'g1' }])),
    personas: {},
  } as any);
  try {
    const store = new PermissionsStore(path);
    // Discord role r1 sees c1 and may only read its history there.
    store.setMirrorLookup((_g, r) => (r === 'r1' ? new Map([['c1', new Set<Capability>(['READ_HISTORY'])]]) : new Map()));
    for (const [name, mc] of forms) {
      assert.notEqual(store.getRole(name), undefined, name);
      // On, a role grants its caps only as far as r1's own caps go; off, all of them wherever r1 sees.
      const want = mc ? ['READ_HISTORY'] : ['READ_HISTORY', 'SEND_MESSAGES'];
      assert.deepEqual(sorted(store.resolveForRoles([name], 'g1', 'c1')), want, `${name}: ${JSON.stringify(mc)}`);
    }
  } finally {
    rmSync(path, { force: true });
  }
});

test('a role that names nothing loads and grants nothing: a scope of {}, an `all` that is off, a list of \'\' alone, a mirrorRole of \'\', and caps of \'\'', () => {
  const nothing: Record<string, unknown> = {
    'scope-empty': { caps: ['SEND_MESSAGES'], scope: {}, guildId: 'g1' },
    'all-false': { caps: ['SEND_MESSAGES'], scope: { all: false }, guildId: 'g1' },
    'all-zero': { caps: ['SEND_MESSAGES'], scope: { all: 0 }, guildId: 'g1' },
    'all-blank': { caps: ['SEND_MESSAGES'], scope: { all: '' }, guildId: 'g1' },
    'all-null': { caps: ['SEND_MESSAGES'], scope: { all: null }, guildId: 'g1' },
    'channels-blank': { caps: ['SEND_MESSAGES'], scope: { channels: [''] }, guildId: 'g1' },
    'mirrors-blank': { caps: ['SEND_MESSAGES'], scope: { mirrorRoles: [''] }, guildId: 'g1' },
    'mirror-blank': { caps: ['SEND_MESSAGES'], scope: { mirrorRole: '' }, guildId: 'g1' },
    'caps-blank': { caps: '', scope: { all: true }, guildId: 'g1' },
  };
  const path = tmpFile({ roles: nothing, personas: { p: { roles: Object.keys(nothing) } } } as any);
  try {
    const store = new PermissionsStore(path);
    // As Discord answers: role r1 sees c1, and an id that names no role sees nothing.
    store.setMirrorLookup((_g, r) => (r === 'r1' ? chans('c1') : new Map()));
    for (const name of Object.keys(nothing)) {
      assert.notEqual(store.getRole(name), undefined, `${name} is loaded`);
      assert.deepEqual(sorted(store.resolveForRoles([name], 'g1', 'c1')), [], `${name} grants nothing`);
      assert.equal(roleGrantsAccess(store.getRole(name)), false, `${name} doesn't count as granting access`);
    }
    assert.deepEqual(sorted(store.resolve('p', 'g1', 'c1')), []);
    // As the relay's lookups answer: g1 holds c1, and no channel's id is ''.
    assert.equal(store.couldAccessGuild('p', 'g1', (c) => c === 'c1'), false);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the load warning says why a scope is set aside: two or three kinds, or a key that is no kind', (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const path = tmpFile({
    roles: {
      'two-kinds': { caps: ['SEND_MESSAGES'], scope: { all: true, mirrorRoles: ['r1'] }, guildId: 'g1' },
      'no-kind': { caps: ['SEND_MESSAGES'], scope: { constructor: true }, guildId: 'g1' },
      'three-kinds': { caps: ['SEND_MESSAGES'], scope: { all: true, channels: ['c1'], mirrorRole: 'r1' }, guildId: 'g1' },
    },
    personas: {},
  } as any);
  try {
    new PermissionsStore(path);
    const said = (line: string) => assert.ok(errors.some((l) => l.includes(line)), `${line}\n${errors.join('\n')}`);
    said(`role "two-kinds" can't be read (scope names "all" and "mirrorRoles", but may name only one of all, channels, mirrorRoles and mirrorRole)`);
    said(`role "no-kind" can't be read (scope names "constructor", which is none of all, channels, mirrorRoles and mirrorRole)`);
    said(`role "three-kinds" can't be read (scope names "all", "channels" and "mirrorRole", but may name only one of all, channels, mirrorRoles and mirrorRole)`);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a role named __proto__ set aside at load is kept on disk through a save, and removeRole removes it', () => {
  const path = tmpFile({ roles: { ['__proto__']: { caps: 5, scope: { all: true }, guildId: 'g1' } }, personas: {} } as any);
  try {
    const store = new PermissionsStore(path);
    assert.equal(store.isQuarantined('__proto__'), true);
    store.setRole('another', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' });
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { roles: Record<string, unknown> };
    assert.ok(Object.hasOwn(saved.roles, '__proto__'), JSON.stringify(saved.roles));
    assert.equal(store.removeRole('__proto__'), true);
    const after = JSON.parse(readFileSync(path, 'utf8')) as { roles: Record<string, unknown> };
    assert.ok(!Object.hasOwn(after.roles, '__proto__'), JSON.stringify(after.roles));
  } finally {
    rmSync(path, { force: true });
  }
});

test('a role written under a quarantined name replaces it, so removing that role later leaves nothing on disk', () => {
  const path = tmpFile({ roles: { r: { caps: 5, scope: { all: true }, guildId: 'g1' } }, personas: {} } as any);
  try {
    const store = new PermissionsStore(path);
    assert.equal(store.isQuarantined('r'), true);
    store.setRole('r', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' });
    assert.equal(store.isQuarantined('r'), false);
    assert.ok(store.removeRole('r'));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { roles?: Record<string, unknown> };
    assert.equal(onDisk.roles?.r, undefined, JSON.stringify(onDisk.roles));
  } finally {
    rmSync(path, { force: true });
  }
});

test('removeRole removes a quarantined entry, from the store and from disk', () => {
  const path = tmpFile({ roles: { r: { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'g1' } }, personas: {} } as any);
  try {
    const store = new PermissionsStore(path);
    assert.equal(store.isQuarantined('r'), true);
    assert.equal(store.removeRole('r'), true);
    assert.equal(store.isQuarantined('r'), false);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { roles?: Record<string, unknown> };
    assert.equal(onDisk.roles?.r, undefined, JSON.stringify(onDisk.roles));
    assert.equal(store.removeRole('r'), false, 'nothing left to remove');
  } finally {
    rmSync(path, { force: true });
  }
});

test('a mirror key behind `all` is read when mirrorCaps is set, so a malformed one is quarantined rather than thrown on', () => {
  const path = tmpFile({
    roles: {
      good: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g1' },
      masked: { caps: ['SEND_MESSAGES'], scope: { all: true, mirrorRoles: 5 }, mirrorCaps: true, guildId: 'g1' },
    },
    personas: { p: { roles: ['good', 'masked'] } },
  } as any);
  const store = new PermissionsStore(path);
  store.setMirrorLookup(() => chans('c1'));
  let caps: unknown;
  try { caps = sorted(store.resolve('p', 'g1', 'c1')); } catch (e) { caps = `threw: ${(e as Error).message}`; }
  assert.deepEqual(caps, ['VIEW_CHANNEL']);
  assert.equal(store.getRole('masked'), undefined);
  rmSync(path, { force: true });
});

test('setRole refuses a role a reader could not read, as loading quarantines one', () => {
  const path = tmpFile({ personas: {} });
  const store = new PermissionsStore(path);
  assert.throws(() => store.setRole('bad', { caps: 5, scope: { all: true }, guildId: 'g1' } as never), /can't be read: caps must be a list/);
  assert.throws(() => store.setRole('bad', { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'g1' } as never), /can't be read: scope names "all" and "channels", but may name only one of all, channels, mirrorRoles and mirrorRole/);
  assert.throws(() => store.setRole('bad', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 7 } as never), /can't be read: guildId must be a string/);
  assert.throws(() => store.setRole('bad', { caps: ['VIEW_CHANNEL'], scope: { constructor: true }, guildId: 'g1' } as never), /can't be read: scope names "constructor", which is none of all, channels, mirrorRoles and mirrorRole/);
  assert.throws(() => store.setRole('bad', { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'r1' }, mirrorCaps: 'false', guildId: 'g1' } as never), /can't be read: mirrorCaps must be true or false/);
  assert.equal(store.getRole('bad'), undefined);
  rmSync(path, { force: true });
});
