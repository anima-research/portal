// Slash-command handler: in-Discord relay administration over real stores.
// Covers authorization (Manage-Server OR superadmin), every command's store
// mutation + reply semantics, and the target-narrowing autocomplete rules
// (channel-access for remove/caps, guild-access for ban/resync/remove-role).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capability } from '@animalabs/portal-protocol';
import { IdentityStore } from '../src/identity.js';
import { PermissionsStore } from '../src/permissions.js';
import { InviteStore } from '../src/invites.js';
import { SlashHandler, LEVEL_CAPS, type SlashInvocation } from '../src/slash.js';

const GUILD = 'g1';
const CHAN = 'chan-1';
const OTHER_CHAN = 'chan-2';
const ADMIN = { id: 'admin-1', name: 'Admin', hasManageGuild: true };
const RANDO = { id: 'rando-1', name: 'Rando', hasManageGuild: false };
const SUPER = { id: 'super-1', name: 'Antra', hasManageGuild: false };

function makeHandler() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-slash-'));
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify({
      personas: [
        { id: 'ash-1', displayName: 'Ash', avatar: '', token: 't1' },
        { id: 'rhys-1', displayName: 'Rhys', avatar: '', token: 't2' },
        { id: 'evander-1', displayName: 'Evander', avatar: '', token: 't3' },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({
      roles: {
        'chan-role': { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { channels: [CHAN] }, guildId: GUILD },
        'guild-role': { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD },
        unbound: { caps: ['VIEW_CHANNEL'], scope: { all: true } },
      },
      personas: {
        'ash-1': { roles: ['chan-role'] },
        'rhys-1': {
          default: [],
          guilds: { [GUILD]: { default: [], channels: { [CHAN]: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] } } },
        },
        'evander-1': { default: [] },
      },
    }),
  );
  writeFileSync(join(dir, 'invites.json'), JSON.stringify({ invites: [] }));

  const identity = new IdentityStore(join(dir, 'identity.json'), '');
  const permissions = new PermissionsStore(join(dir, 'permissions.json'));
  const invites = new InviteStore(join(dir, 'invites.json'));
  const resyncs: string[] = [];
  const handler = new SlashHandler({
    identity,
    permissions,
    invites,
    superadmins: [SUPER.id],
    // Discord side wide open in tests: effective caps = pure policy resolve.
    capsFor: (pid, ch, gid) => [...permissions.resolve(pid, gid, ch)] as Capability[],
    canAccessGuild: (pid, gid) => permissions.couldAccessGuild(pid, gid, () => true),
    resync: (pid) => (resyncs.push(pid), 7),
    newInviteCode: () => 'inv_TESTCODE',
  });

  const inv = (command: string, options: Record<string, string | undefined> = {}, invoker = ADMIN): SlashInvocation => ({
    command,
    guildId: GUILD,
    channelId: CHAN,
    channelName: 'general',
    invoker,
    options,
  });

  return { handler, permissions, invites, resyncs, inv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('authorization: Manage-Server or superadmin pass; others are denied', () => {
  const t = makeHandler();
  try {
    assert.match(t.handler.handle(t.inv('list', {}, RANDO)), /Not authorized/);
    assert.doesNotMatch(t.handler.handle(t.inv('list', {}, ADMIN)), /Not authorized/);
    assert.doesNotMatch(t.handler.handle(t.inv('list', {}, SUPER)), /Not authorized/);
  } finally {
    t.cleanup();
  }
});

test('/add defaults to full and reports effective caps; level=read narrows', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('add', { identity: 'evander-1' }));
    assert.match(reply, /Granted \*\*Evander\*\*.*full access/);
    assert.deepEqual(
      [...t.permissions.resolve('evander-1', GUILD, CHAN)].sort(),
      [...LEVEL_CAPS.full].sort(),
    );

    t.handler.handle(t.inv('add', { identity: 'evander-1', level: 'read' }));
    assert.deepEqual(
      [...t.permissions.resolve('evander-1', GUILD, CHAN)].sort(),
      [...LEVEL_CAPS.read].sort(),
    );
  } finally {
    t.cleanup();
  }
});

test('/add rejects unknown identities', () => {
  const t = makeHandler();
  try {
    assert.match(t.handler.handle(t.inv('add', { identity: 'nobody' })), /No such identity/);
  } finally {
    t.cleanup();
  }
});

test('/remove clears the direct grant; warns when access persists via a role', () => {
  const t = makeHandler();
  try {
    // rhys: inline grant only → clean removal.
    const clean = t.handler.handle(t.inv('remove', { identity: 'rhys-1' }));
    assert.match(clean, /No remaining access/);
    assert.equal(t.permissions.resolve('rhys-1', GUILD, CHAN).size, 0);

    // ash: role-based access → clearChannel can't take it, reply must say so.
    const warned = t.handler.handle(t.inv('remove', { identity: 'ash-1' }));
    assert.match(warned, /still\s+have/);
    assert.match(warned, /`chan-role`/);
  } finally {
    t.cleanup();
  }
});

test('/list shows access holders with their sources', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('list'));
    assert.match(reply, /\*\*Ash\*\*.*via roles: chan-role/);
    assert.match(reply, /\*\*Rhys\*\*.*direct grant/);
    assert.doesNotMatch(reply, /Evander/);
  } finally {
    t.cleanup();
  }
});

test('/add-role and /remove-role mutate the persona role list', () => {
  const t = makeHandler();
  try {
    assert.match(t.handler.handle(t.inv('add-role', { identity: 'evander-1', role: 'guild-role' })), /now holds `guild-role`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), ['guild-role']);

    assert.match(t.handler.handle(t.inv('remove-role', { identity: 'evander-1', role: 'guild-role' })), /Removed `guild-role`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), []);

    assert.match(t.handler.handle(t.inv('remove-role', { identity: 'evander-1', role: 'guild-role' })), /doesn’t hold/);
    assert.match(t.handler.handle(t.inv('add-role', { identity: 'evander-1', role: 'nope' })), /No such access role/);
  } finally {
    t.cleanup();
  }
});

test('/invite mints a single-use invite carrying the given roles', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('invite', { role: 'chan-role', role2: 'guild-role', label: 'for tavy' }));
    assert.match(reply, /`inv_TESTCODE`/);
    const minted = t.invites.get('inv_TESTCODE')!;
    assert.deepEqual(minted.roles, ['chan-role', 'guild-role']);
    assert.equal(minted.maxUses, 1);
    assert.equal(minted.label, 'for tavy');

    assert.match(t.handler.handle(t.inv('invite', { role: 'nope' })), /No such access role/);
  } finally {
    t.cleanup();
  }
});

test('/ban strips guild-scoped roles and denies direct grants; flags unbound roles', () => {
  const t = makeHandler();
  try {
    t.permissions.addPersonaRoles('ash-1', ['unbound']);
    const reply = t.handler.handle(t.inv('ban', { identity: 'ash-1' }));
    assert.match(reply, /removed role.*`chan-role`/);
    assert.match(reply, /Still holds guild-unbound role.*`unbound`/);
    assert.deepEqual(t.permissions.getRoleNames('ash-1'), ['unbound']);
    // Inline policy pinned to deny — but the unbound role still resolves.
    assert.deepEqual([...t.permissions.resolveForRoles(['unbound'], GUILD, CHAN)], ['VIEW_CHANNEL']);

    // rhys (inline only): after ban, nothing resolves anywhere in the guild.
    t.handler.handle(t.inv('ban', { identity: 'rhys-1' }));
    assert.equal(t.permissions.resolve('rhys-1', GUILD, CHAN).size, 0);
    assert.equal(t.permissions.resolve('rhys-1', GUILD, OTHER_CHAN).size, 0);
  } finally {
    t.cleanup();
  }
});

test('/caps explains effective capabilities and their sources', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('caps', { identity: 'ash-1' }));
    assert.match(reply, /Effective: read/);
    assert.match(reply, /Via: roles: `chan-role`/);

    const none = t.handler.handle(t.inv('caps', { identity: 'evander-1' }));
    assert.match(none, /nothing \(no access\)/);
  } finally {
    t.cleanup();
  }
});

test('/resync passes through to the relay and reports the push count', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('resync', { identity: 'rhys-1' }));
    assert.match(reply, /Re-pushed 7 channels/);
    assert.deepEqual(t.resyncs, ['rhys-1']);
  } finally {
    t.cleanup();
  }
});

test('autocomplete narrows identity targets per command', () => {
  const t = makeHandler();
  try {
    const req = (command: string, option = 'identity', partial = '', options = {}) => ({
      command, guildId: GUILD, channelId: CHAN, option, partial, options,
    });
    // remove/caps: channel-access holders only (ash via role, rhys via grant).
    assert.deepEqual(
      t.handler.autocomplete(req('remove')).map((c) => c.value).sort(),
      ['ash-1', 'rhys-1'],
    );
    // ban/resync: guild-access holders.
    assert.deepEqual(
      t.handler.autocomplete(req('ban')).map((c) => c.value).sort(),
      ['ash-1', 'rhys-1'],
    );
    // add: everyone (the target usually lacks access).
    assert.equal(t.handler.autocomplete(req('add')).length, 3);
    // Prefix filter matches id and display name, case-insensitive.
    assert.deepEqual(t.handler.autocomplete(req('add', 'identity', 'EVA')).map((c) => c.value), ['evander-1']);
  } finally {
    t.cleanup();
  }
});

test('autocomplete narrows roles to the guild, and to held roles for remove-role', () => {
  const t = makeHandler();
  try {
    const all = t.handler.autocomplete({
      command: 'add-role', guildId: GUILD, channelId: CHAN, option: 'role', partial: '', options: {},
    });
    assert.deepEqual(all.map((c) => c.value).sort(), ['chan-role', 'guild-role', 'unbound']);

    const otherGuild = t.handler.autocomplete({
      command: 'add-role', guildId: 'g2', channelId: 'x', option: 'role', partial: '', options: {},
    });
    assert.deepEqual(otherGuild.map((c) => c.value), ['unbound']);

    const held = t.handler.autocomplete({
      command: 'remove-role', guildId: GUILD, channelId: CHAN, option: 'role', partial: '', options: { identity: 'ash-1' },
    });
    assert.deepEqual(held.map((c) => c.value), ['chan-role']);
  } finally {
    t.cleanup();
  }
});

test('denied invocations do not mutate anything', () => {
  const t = makeHandler();
  try {
    t.handler.handle(t.inv('ban', { identity: 'ash-1' }, RANDO));
    assert.deepEqual(t.permissions.getRoleNames('ash-1'), ['chan-role']);
    t.handler.handle(t.inv('add', { identity: 'evander-1' }, RANDO));
    assert.equal(t.permissions.resolve('evander-1', GUILD, CHAN).size, 0);
  } finally {
    t.cleanup();
  }
});
