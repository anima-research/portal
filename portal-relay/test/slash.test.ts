// Slash-command handler: in-Discord relay administration over real stores.
// Covers authorization (Manage-Server OR superadmin), every command's store
// mutation + reply semantics, and the target-narrowing autocomplete rules
// (channel-access for remove/caps, guild-access for ban/resync/remove-role).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capability } from '@animalabs/portal-protocol';
import { IdentityStore } from '../src/identity.js';
import { PermissionsStore } from '../src/permissions.js';
import { InviteStore } from '../src/invites.js';
import { SlashHandler, LEVEL_CAPS, slashTarget, type SlashInvocation } from '../src/slash.js';

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
        'g2-role': { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'g2' },
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
    guildAdmins: { [GUILD]: ['delegate-1'] },
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

  return { handler, identity, permissions, invites, resyncs, inv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('authorization: Manage-Server, superadmin, or guild delegate pass; others are denied', () => {
  const t = makeHandler();
  try {
    assert.match(t.handler.handle(t.inv('list', {}, RANDO)), /Not authorized/);
    assert.doesNotMatch(t.handler.handle(t.inv('list', {}, ADMIN)), /Not authorized/);
    assert.doesNotMatch(t.handler.handle(t.inv('list', {}, SUPER)), /Not authorized/);
    const delegate = { id: 'delegate-1', name: 'Delegate', hasManageGuild: false };
    assert.doesNotMatch(t.handler.handle(t.inv('list', {}, delegate)), /Not authorized/);
  } finally {
    t.cleanup();
  }
});

test('/add defaults to full and reports effective caps; level=read narrows', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('add', { persona: 'evander-1' }));
    assert.match(reply, /Granted \*\*Evander\*\*.*full access/);
    assert.deepEqual(
      [...t.permissions.resolve('evander-1', GUILD, CHAN)].sort(),
      [...LEVEL_CAPS.full].sort(),
    );

    t.handler.handle(t.inv('add', { persona: 'evander-1', level: 'read' }));
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
    assert.match(t.handler.handle(t.inv('add', { persona: 'nobody' })), /No such persona/);
  } finally {
    t.cleanup();
  }
});

test('/remove clears the direct grant; warns when access persists via a role', () => {
  const t = makeHandler();
  try {
    // rhys: inline grant only → clean removal.
    const clean = t.handler.handle(t.inv('remove', { persona: 'rhys-1' }));
    assert.match(clean, /No remaining access/);
    assert.equal(t.permissions.resolve('rhys-1', GUILD, CHAN).size, 0);

    // ash: role-based access → clearChannel can't take it, reply must say so.
    const warned = t.handler.handle(t.inv('remove', { persona: 'ash-1' }));
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
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'guild-role' })), /now holds `guild-role`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), ['guild-role']);

    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'guild-role' })), /Removed `guild-role`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), []);

    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'guild-role' })), /doesn’t hold/);
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'nope' })), /No such access role/);
  } finally {
    t.cleanup();
  }
});

test("roles set aside at load: /invite and add-role say they can't be read, and removing one keeps to the guild its entry names, or to a superadmin when it names none", () => {
  const t = makeHandler();
  try {
    const path = (t.permissions as any).path as string;
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.roles['aside-here'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: [CHAN] }, guildId: GUILD };
    file.roles['aside-g2'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: [CHAN] }, guildId: 'g2' };
    // An entry naming its guild as a number, as a hand edit might: no guild the relay can read.
    file.roles['aside-noguild'] = { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 5 };
    file.personas['evander-1'] = { policy: { default: [] }, roles: ['aside-here', 'aside-g2', 'aside-noguild'] };
    writeFileSync(path, JSON.stringify(file));
    (t.permissions as any).reload();
    const unreadable = /Access role `aside-here` can't be read \(set aside when the relay loaded it\), so the relay's operator must fix it first\./;
    assert.match(t.handler.handle(t.inv('invite', { role: 'aside-here' })), unreadable);
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'ash-1', role: 'aside-here' })), unreadable);
    const both = t.handler.handle(t.inv('invite', { role: 'nope', role2: 'aside-here' }));
    assert.match(both, /No such access role: `nope`\./);
    assert.match(both, unreadable);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'aside-g2' })), /scoped to another guild/);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'aside-here' })), /Removed `aside-here`/);
    // One whose entry names no guild the relay can read is a superadmin's to remove, as in the panel.
    const audited: any[] = [];
    (t.handler as any).deps.audit = { append: (r: unknown) => audited.push(r) };
    assert.equal(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'aside-noguild' })),
      "`aside-noguild` can't be read (set aside when the relay loaded it) and names no guild the relay can read, so only a portal superadmin can remove it.");
    assert.ok(audited.some((a) => a.action === 'slash.remove-role' && a.ok === false && a.target === 'evander-1'
      && a.detail?.role === 'aside-noguild' && a.detail?.reason === 'guild-unreadable'), JSON.stringify(audited));
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), ['aside-g2', 'aside-noguild']);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'aside-noguild' }, SUPER)), /Removed `aside-noguild`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), ['aside-g2']);
    // A superadmin removes one naming another guild too.
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'aside-g2' }, SUPER)), /Removed `aside-g2`/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), []);
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
    // The channel it was run in rides along as a direct grant (default: write).
    assert.match(reply, /plus write access to #general/);
    assert.deepEqual(minted.grant, { caps: LEVEL_CAPS.write, scope: { channels: [CHAN] } });
    assert.equal(minted.guildId, GUILD);

    t.invites.revoke('inv_TESTCODE');
    const ro = t.handler.handle(t.inv('invite', { role: 'guild-role', level: 'read' }));
    assert.match(ro, /plus read access/);
    assert.deepEqual(t.invites.get('inv_TESTCODE')!.grant!.caps, LEVEL_CAPS.read);

    assert.match(t.handler.handle(t.inv('invite', { role: 'nope' })), /No such access role/);
  } finally {
    t.cleanup();
  }
});

test("/ban takes off a role set aside at load that names this guild, and leaves one naming another guild or none", () => {
  const t = makeHandler();
  try {
    const path = (t.permissions as any).path as string;
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.roles['aside-here'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: [CHAN] }, guildId: GUILD };
    file.roles['aside-g2'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: [CHAN] }, guildId: 'g2' };
    file.roles['aside-noguild'] = { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 5 };
    file.personas['evander-1'] = { policy: { default: [] }, roles: ['aside-here', 'aside-g2', 'aside-noguild'] };
    writeFileSync(path, JSON.stringify(file));
    (t.permissions as any).reload();
    const audited: any[] = [];
    (t.handler as any).deps.audit = { append: (r: unknown) => audited.push(r) };
    const reply = t.handler.handle(t.inv('ban', { persona: 'evander-1' }));
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), ['aside-g2', 'aside-noguild']);
    // What the ban says and records names the role it took off.
    assert.match(reply, /Removed guild role `aside-here`/, reply);
    const rec = audited.find((a) => a.action === 'slash.ban');
    assert.deepEqual(rec?.detail?.rolesRemoved, ['aside-here'], JSON.stringify(audited));
  } finally {
    t.cleanup();
  }
});

test('/remove-role of a name the catalog has never had removes it from the persona, as before', () => {
  const t = makeHandler();
  try {
    t.permissions.addPersonaRoles('ash-1', ['never-was']);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'ash-1', role: 'never-was' })), /Removed `never-was`/);
    assert.ok(!t.permissions.getRoleNames('ash-1').includes('never-was'), JSON.stringify(t.permissions.getRoleNames('ash-1')));
  } finally {
    t.cleanup();
  }
});

test('/ban fully revokes in this guild; cross-guild roles survive untouched (and grant nothing here)', () => {
  const t = makeHandler();
  try {
    t.permissions.addPersonaRoles('ash-1', ['g2-role']);
    const reply = t.handler.handle(t.inv('ban', { persona: 'ash-1' }));
    assert.match(reply, /Removed guild role.*`chan-role`/);
    assert.match(reply, /No remaining access in this guild/);
    // The g2 role is outside this admin's authority — kept, but inert here.
    assert.deepEqual(t.permissions.getRoleNames('ash-1'), ['g2-role']);
    assert.equal(t.permissions.resolve('ash-1', GUILD, CHAN).size, 0);
    assert.deepEqual([...t.permissions.resolveForRoles(['g2-role'], 'g2', 'any-g2-chan')], ['VIEW_CHANNEL']);

    // rhys (inline only): after ban, nothing resolves anywhere in the guild.
    const clean = t.handler.handle(t.inv('ban', { persona: 'rhys-1' }));
    assert.match(clean, /No remaining access in this guild/);
    assert.equal(t.permissions.resolve('rhys-1', GUILD, CHAN).size, 0);
    assert.equal(t.permissions.resolve('rhys-1', GUILD, OTHER_CHAN).size, 0);
  } finally {
    t.cleanup();
  }
});

test('guild containment: cross-guild roles are superadmin-only in /add-role, /remove-role, /invite', () => {
  const t = makeHandler();
  try {
    // A guild-A Manage-Server holder must not assign another guild's roles.
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'g2-role' })), /scoped to another guild/);
    assert.deepEqual(t.permissions.getRoleNames('evander-1'), []);

    // Nor mint invites carrying them.
    assert.match(t.handler.handle(t.inv('invite', { role: 'g2-role' })), /not scoped to this guild/);
    assert.match(t.handler.handle(t.inv('invite', { role: 'chan-role', role2: 'g2-role' })), /not scoped to this guild/);
    assert.equal(t.invites.get('inv_TESTCODE'), undefined);

    // Nor strip them (removal changes access outside this guild).
    t.permissions.addPersonaRoles('ash-1', ['g2-role']);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'ash-1', role: 'g2-role' })), /only a portal superadmin/);
    assert.deepEqual(t.permissions.getRoleNames('ash-1'), ['chan-role', 'g2-role']);

    // Superadmins are exempt on all three.
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'g2-role' }, SUPER)), /now holds `g2-role`/);
    assert.match(t.handler.handle(t.inv('remove-role', { persona: 'ash-1', role: 'g2-role' }, SUPER)), /Removed `g2-role`/);
    assert.match(t.handler.handle(t.inv('invite', { role: 'g2-role' }, SUPER)), /`inv_TESTCODE`/);
  } finally {
    t.cleanup();
  }
});

test('/caps explains effective capabilities and their sources', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('caps', { persona: 'ash-1' }));
    assert.match(reply, /Effective: read/);
    assert.match(reply, /Via: roles: `chan-role`/);

    const none = t.handler.handle(t.inv('caps', { persona: 'evander-1' }));
    assert.match(none, /nothing \(no access\)/);
  } finally {
    t.cleanup();
  }
});

test('/resync passes through to the relay and reports the push count', () => {
  const t = makeHandler();
  try {
    const reply = t.handler.handle(t.inv('resync', { persona: 'rhys-1' }));
    assert.match(reply, /Re-pushed 7 channels/);
    assert.deepEqual(t.resyncs, ['rhys-1']);
  } finally {
    t.cleanup();
  }
});

test('autocomplete narrows persona targets per command', () => {
  const t = makeHandler();
  try {
    const req = (command: string, option = 'persona', partial = '', options = {}) => ({
      command, guildId: GUILD, channelId: CHAN, invoker: ADMIN, option, partial, options,
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
    assert.deepEqual(t.handler.autocomplete(req('add', 'persona', 'EVA')).map((c) => c.value), ['evander-1']);
  } finally {
    t.cleanup();
  }
});

test('autocomplete narrows roles to the guild, and to held roles for remove-role', () => {
  const t = makeHandler();
  try {
    for (const invoker of [ADMIN, SUPER]) {
      const choices = t.handler.autocomplete({
        command: 'add-role', guildId: GUILD, channelId: CHAN, invoker, option: 'role', partial: '', options: {},
      });
      assert.deepEqual(choices.map((c) => c.value).sort(), ['chan-role', 'guild-role']);
    }

    const held = t.handler.autocomplete({
      command: 'remove-role', guildId: GUILD, channelId: CHAN, invoker: ADMIN, option: 'role', partial: '', options: { persona: 'ash-1' },
    });
    assert.deepEqual(held.map((c) => c.value), ['chan-role']);
  } finally {
    t.cleanup();
  }
});

test('autocomplete is gated: unauthorized invokers enumerate nothing', () => {
  const t = makeHandler();
  try {
    for (const option of ['persona', 'role']) {
      const choices = t.handler.autocomplete({
        command: option === 'persona' ? 'remove' : 'add-role',
        guildId: GUILD, channelId: CHAN, invoker: RANDO, option, partial: '', options: {},
      });
      assert.deepEqual(choices, []);
    }
  } finally {
    t.cleanup();
  }
});

test('denied invocations do not mutate anything', () => {
  const t = makeHandler();
  try {
    t.handler.handle(t.inv('ban', { persona: 'ash-1' }, RANDO));
    assert.deepEqual(t.permissions.getRoleNames('ash-1'), ['chan-role']);
    t.handler.handle(t.inv('add', { persona: 'evander-1' }, RANDO));
    assert.equal(t.permissions.resolve('evander-1', GUILD, CHAN).size, 0);
  } finally {
    t.cleanup();
  }
});

test('run in a thread, a slash command acts on the thread\'s parent channel', () => {
  assert.deepEqual(
    slashTarget({ channelId: 'th1', name: 'design', isThread: true, parentId: CHAN, parentName: 'general' }),
    { channelId: CHAN, channelName: 'general', thread: { id: 'th1', name: 'design' } },
  );
  assert.deepEqual(slashTarget({ channelId: CHAN, name: 'general', isThread: false }), { channelId: CHAN, channelName: 'general' });

  // /invite from a thread: the grant lands on the parent, where Portal checks
  // a thread's access — and the reply says so.
  const t = makeHandler();
  try {
    const inThread: SlashInvocation = {
      ...t.inv('invite', { role: 'guild-role' }),
      ...slashTarget({ channelId: 'th1', name: 'design', isThread: true, parentId: CHAN, parentName: 'general' }),
    };
    const reply = t.handler.handle(inThread);
    assert.deepEqual(t.invites.get('inv_TESTCODE')!.grant!.scope, { channels: [CHAN] });
    assert.match(reply, /write access to #general \(the channel thread "design" is in/);
  } finally {
    t.cleanup();
  }
});

test("every slash command fits Discord's limits (a violation fails the whole registration)", async () => {
  const { SLASH_COMMANDS } = await import('../src/slash.js');
  const NAME = /^[-_\p{Ll}\p{N}]{1,32}$/u;
  for (const cmd of SLASH_COMMANDS) {
    assert.match(cmd.name, NAME, `command name ${cmd.name}`);
    assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100, `/${cmd.name} description is ${cmd.description.length} chars`);
    const options = cmd.options ?? [];
    assert.ok(options.length <= 25, `/${cmd.name} has ${options.length} options`);
    let seenOptional = false;
    for (const o of options) {
      assert.match(o.name, NAME, `/${cmd.name} option ${o.name}`);
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `/${cmd.name} ${o.name}: description is ${o.description.length} chars`);
      if (o.required) assert.ok(!seenOptional, `/${cmd.name}: required option ${o.name} after an optional one`);
      else seenOptional = true;
      for (const c of (o as { choices?: string[] }).choices ?? []) assert.ok(c.length >= 1 && c.length <= 100, `/${cmd.name} ${o.name} choice ${c}`);
    }
  }
});

test('nothing runs in a guild the relay does not serve (commands can linger there)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-slash-unserved-'));
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ personas: [{ id: 'p1', displayName: 'P', avatar: '', token: 't' }] }));
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ roles: {}, personas: {} }));
  writeFileSync(join(dir, 'invites.json'), JSON.stringify({ invites: [] }));
  const permissions = new PermissionsStore(join(dir, 'permissions.json'));
  const handler = new SlashHandler({
    identity: new IdentityStore(join(dir, 'identity.json'), ''),
    permissions,
    invites: new InviteStore(join(dir, 'invites.json')),
    superadmins: [], guildAdmins: {},
    capsFor: () => [], canAccessGuild: () => false, resync: () => 0, newInviteCode: () => 'inv_X',
    isGuildServed: () => false,
  });
  const admin = { id: 'a1', name: 'A', hasManageGuild: true };
  try {
    assert.match(handler.handle({ command: 'invite', guildId: 'G', channelId: 'c', channelName: 'c', invoker: admin, options: { role: 'x' } }), /not enabled in this server/);
    assert.deepEqual(handler.autocomplete({ command: 'add', guildId: 'G', channelId: 'c', invoker: admin, option: 'persona', partial: '', options: {} }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/add-role and /remove-role replies list only this guild's roles to a guild admin", () => {
  const t = makeHandler();
  try {
    t.permissions.addPersonaRoles('evander-1', ['g2-role']);
    const added = t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'guild-role' }));
    assert.match(added, /`guild-role`/);
    assert.doesNotMatch(added, /g2-role/);
    const removed = t.handler.handle(t.inv('remove-role', { persona: 'evander-1', role: 'guild-role' }));
    assert.doesNotMatch(removed, /g2-role/);
    assert.match(t.handler.handle(t.inv('add-role', { persona: 'evander-1', role: 'guild-role' }, SUPER)), /g2-role/, 'a superadmin sees them all');
  } finally {
    t.cleanup();
  }
});

test('/ban holds until an admin grants access again; /add or /add-role lifts it', () => {
  const t = makeHandler();
  try {
    t.handler.handle(t.inv('ban', { persona: 'rhys-1' }));
    assert.equal(t.permissions.isBanned('rhys-1', GUILD), true);
    t.handler.handle(t.inv('add', { persona: 'rhys-1', level: 'read' }));
    assert.equal(t.permissions.isBanned('rhys-1', GUILD), false);
    assert.ok(t.permissions.resolve('rhys-1', GUILD, CHAN).has('READ_HISTORY'));
    assert.equal(t.permissions.resolve('rhys-1', GUILD, OTHER_CHAN).size, 0, 'only what was granted');

    t.handler.handle(t.inv('ban', { persona: 'ash-1' }));
    t.handler.handle(t.inv('add-role', { persona: 'ash-1', role: 'guild-role' }));
    assert.equal(t.permissions.isBanned('ash-1', GUILD), false);
    assert.ok(t.permissions.resolve('ash-1', GUILD, OTHER_CHAN).has('VIEW_CHANNEL'));
  } finally {
    t.cleanup();
  }
});


test('a persona on the file default keeps it in other guilds after /add, /add-role, /remove and /remove-role here', () => {
  const t = makeHandler();
  try {
    (t.permissions as any).fileDefault = ['VIEW_CHANNEL'];
    const ids = ['nyx-1', 'quill-1', 'juniper-1', 'sol-1'];
    for (const id of ids) t.identity.upsert({ id, displayName: id, avatar: '', token: `tok-${id}` });
    const elsewhere = (pid: string) => [...t.permissions.resolve(pid, 'g2', 'chan-z')];
    for (const id of ids) assert.deepEqual(elsewhere(id), ['VIEW_CHANNEL'], 'no entry: the file default everywhere');
    t.handler.handle(t.inv('add', { persona: 'nyx-1', level: 'write' }));
    assert.deepEqual(elsewhere('nyx-1'), ['VIEW_CHANNEL'], '/add');
    t.handler.handle(t.inv('add-role', { persona: 'quill-1', role: 'chan-role' }));
    assert.deepEqual(elsewhere('quill-1'), ['VIEW_CHANNEL'], '/add-role');
    t.handler.handle(t.inv('remove', { persona: 'juniper-1' }));
    assert.deepEqual(elsewhere('juniper-1'), ['VIEW_CHANNEL'], '/remove');
    t.handler.handle(t.inv('add-role', { persona: 'sol-1', role: 'guild-role' }));
    t.handler.handle(t.inv('remove-role', { persona: 'sol-1', role: 'guild-role' }));
    assert.deepEqual(elsewhere('sol-1'), ['VIEW_CHANNEL'], '/remove-role');
  } finally {
    t.cleanup();
  }
});

test('/add-role of a role that grants nothing does not lift a ban', () => {
  const t = makeHandler();
  try {
    t.permissions.setRole('nothing-role', { caps: ['VIEW_CHANNEL'], scope: { channels: [] }, guildId: GUILD });
    t.permissions.setRole('capless-role', { caps: [], scope: { all: true }, guildId: GUILD });
    t.handler.handle(t.inv('ban', { persona: 'rhys-1' }));
    t.handler.handle(t.inv('add-role', { persona: 'rhys-1', role: 'nothing-role' }));
    t.handler.handle(t.inv('add-role', { persona: 'rhys-1', role: 'capless-role' }));
    assert.equal(t.permissions.isBanned('rhys-1', GUILD), true);
  } finally {
    t.cleanup();
  }
});

