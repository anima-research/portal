// Inline mirror grants (invite `grant` with a mirrorRole/mirrorRoles scope)
// materialize as shared content-addressed access roles at enroll/claim time,
// so they resolve LIVE against Discord visibility. Pins the regression that
// motivated this: a channel created AFTER enrollment must become visible to
// the persona without any re-enroll or policy hand-edit (the old snapshot
// behavior froze the channel list at enroll time and new rooms stayed
// invisible until an operator noticed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const CHAN_A = 'chan-a';
const CHAN_NEW = 'chan-new'; // created "after enrollment" in the live test
const DISCORD_ROLE = 'dr-everyone';
const EXISTING = 'existing-1';
const RW = ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL'] as const;

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-mirror-'));
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify({ personas: [{ id: EXISTING, displayName: 'Existing', avatar: '', token: 'tok-e' }] }),
  );
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({
      personas: {
        [EXISTING]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN_A]: ['VIEW_CHANNEL'] } } } },
      },
    }),
  );
  writeFileSync(
    join(dir, 'invites.json'),
    JSON.stringify({
      invites: [
        { code: 'mirror-mint', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-aug', mode: 'augment', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-noguild', mode: 'both', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } } },
      ],
    }),
  );

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: join(dir, 'identity.json'),
    permissionsPath: join(dir, 'permissions.json'),
    invitesPath: join(dir, 'invites.json'),
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // What the mirrored Discord role can currently see, per channel: the fake
  // mirror lookup reads this map live, mimicking MirrorCache over a real bot.
  const visible = new Map<string, string[]>([[CHAN_A, [...RW]]]);
  relay.mirror = { lookup: (g: string, r: string) => (g === GUILD && r === DISCORD_ROLE ? visible : new Map()), invalidateGuild: () => {}, invalidateRole: () => {}, flush: () => {} };

  // Discord-side perms wide open so effective caps = pure policy resolution.
  relay.bot = {
    channelForPerms: (cid: string) =>
      cid === CHAN_A || cid === CHAN_NEW
        ? { guildId: GUILD, permissionsFor: () => ({ has: () => true }) }
        : undefined,
    channelMetaFromCache: () => null, // no thread is cached: every id is checked as itself
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    memberNameMatches: () => false,
    membersComplete: () => true,
    listChannelMetas: () => [],
    isGuildAllowed: (gid: string) => gid === GUILD,
  };
  relay.roles = {
    getRoleFor: () => 'role', roleByGuildFor: () => ({}),
    bind: async () => 'role', unbind: async () => {},
  };
  relay.gateway = {
    activePersonas: () => [], streamPersonas: () => [], hasStream: () => false,
    sessionsOf: () => [], personaSubscribed: () => false, dispatch: () => {}, seqOf: () => 0,
  };

  const caps = (pid: string, cid: string) => [...relay.capsFor(pid, cid, GUILD)].sort();
  return { relay, visible, caps, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('enroll with a mirror grant materializes a live access role, not a snapshot', async () => {
  const t = makeRelay();
  try {
    const enrolled = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'newbie' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const pid = enrolled.personaId;

    // Assigned a content-addressed role, no frozen inline channel list.
    const roles = t.relay.permissions.getRoleNames(pid) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], new RegExp(`^mirror-${GUILD}-[0-9a-f]{32}$`));
    const role = t.relay.permissions.getRole(roles[0]);
    assert.deepEqual(role, { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE }, guildId: GUILD });
    assert.equal(t.relay.permissions.getPolicy(pid), undefined);

    // Resolves through the live mirror on the channel visible today...
    assert.deepEqual(t.caps(pid, CHAN_A), [...RW]);

    // ...and — the regression this exists to pin — on a channel created
    // AFTER enrollment, with no re-enroll and no policy edit.
    assert.deepEqual(t.caps(pid, CHAN_NEW), []);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(pid, CHAN_NEW), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('identical mirror grants share one catalog role across enrollments', async () => {
  const t = makeRelay();
  try {
    const a = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    const b = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
    assert.ok(!('error' in a) && !('error' in b));
    const [ra] = t.relay.permissions.getRoleNames(a.personaId) as string[];
    const [rb] = t.relay.permissions.getRoleNames(b.personaId) as string[];
    assert.equal(ra, rb);
  } finally {
    t.cleanup();
  }
});

test('augment claim adds the live role and leaves the existing inline policy intact', () => {
  const t = makeRelay();
  try {
    t.relay.applyInviteAugment(EXISTING, 'mirror-aug');
    const roles = t.relay.permissions.getRoleNames(EXISTING) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], new RegExp(`^mirror-${GUILD}-[0-9a-f]{32}$`));
    // Union semantics: mirror caps arrive, the pre-existing channel grant survives.
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(EXISTING, CHAN_NEW), [...RW]);
    const pol = t.relay.permissions.getPolicy(EXISTING);
    assert.deepEqual(pol?.guilds?.[GUILD]?.channels?.[CHAN_A], ['VIEW_CHANNEL']);
  } finally {
    t.cleanup();
  }
});

test('mirror grant without guildId: enroll denies, augment rejects loudly', async () => {
  const t = makeRelay();
  try {
    const before = t.relay.identity.all().length;
    const enrolled = await t.relay.enroll({ invite: 'mirror-noguild', desiredName: 'lost' });
    assert.ok('error' in enrolled, 'refused up front, not a persona with no access');
    assert.match(enrolled.error, /names no guild/);
    assert.equal(t.relay.identity.all().length, before, 'no persona created');
    assert.equal(t.relay.invites.get('mirror-noguild').uses ?? 0, 0, 'no use consumed');

    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-noguild'), /names no guild/);
  } finally {
    t.cleanup();
  }
});

test('a rejected augment changes nothing: no roles granted, invite not consumed', () => {
  const t = makeRelay();
  try {
    // Roles plus a mirror grant missing its guild: the whole claim is invalid.
    t.relay.invites.mint({
      code: 'roles-and-bad-mirror', label: 'x', mode: 'augment', maxUses: 1, roles: ['some-role'],
      grant: { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'r1' } },
    });
    t.relay.permissions.setRole('some-role', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD });
    const before = t.relay.permissions.getRoleNames(EXISTING);
    for (let i = 0; i < 2; i++) {
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'roles-and-bad-mirror'), /names no guild/);
    }
    assert.deepEqual(t.relay.permissions.getRoleNames(EXISTING), before, 'no roles granted by a rejected claim');
    assert.equal(t.relay.invites.get('roles-and-bad-mirror').uses ?? 0, 0, 'no use consumed');
  } finally {
    t.cleanup();
  }
});

test('a mirror grant reuses only an IDENTICAL access role; a name hit on anything else is refused before any change', async () => {
  const t = makeRelay();
  try {
    // Find the name this grant materializes to, then plant a DIFFERENT role under it.
    const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'probe' });
    const name = t.relay.permissions.getRoleNames(first.personaId)[0];
    t.relay.permissions.setRole(name, { caps: ['MANAGE_MESSAGES'], scope: { all: true }, guildId: 'some-other-guild' });
    t.relay.invites.mint({ code: 'mirror-again', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD } as any);
    const count = t.relay.identity.all().length;
    const res = await t.relay.enroll({ invite: 'mirror-again', desiredName: 'collider' });
    assert.ok('error' in res && /conflicts with an existing access role/.test(res.error));
    assert.equal(t.relay.identity.all().length, count, 'no persona created');
    assert.equal(t.relay.invites.get('mirror-again').uses ?? 0, 0, 'no use consumed');
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), /conflicts with an existing access role/);
    assert.ok(!t.relay.permissions.getRoleNames(EXISTING).includes(name), 'the foreign role was not handed out');
  } finally {
    t.cleanup();
  }
});

test('augmenting a persona never narrows what it already had', () => {
  const t = makeRelay();
  try {
    const merge = (base: any, add: any) => t.relay.mergePolicy(base, add);
    // Guild default [VIEW, READ]; a channel augment adds SEND on chan-x: that
    // channel keeps VIEW+READ (it would have resolved to the guild default).
    const ch = merge({ default: [], guilds: { G: { default: ['VIEW_CHANNEL', 'READ_HISTORY'] } } },
      { default: [], guilds: { G: { channels: { x: ['SEND_MESSAGES'] } } } });
    assert.deepEqual(ch.guilds.G.channels.x.sort(), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
    assert.deepEqual(ch.guilds.G.default, ['VIEW_CHANNEL', 'READ_HISTORY'], 'guild default untouched');
    // A persona-wide default [VIEW, READ, SEND]; an {all} augment for G with [VIEW]
    // must not narrow G to [VIEW].
    const all = merge({ default: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] },
      { default: [], guilds: { G: { default: ['VIEW_CHANNEL'] } } });
    assert.deepEqual(all.guilds.G.default.sort(), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
    // An {all} augment reaches a narrower existing channel override; an explicit deny stays.
    const reach = merge({ default: [], guilds: { G: { channels: { narrow: ['VIEW_CHANNEL'], denied: [] } } } },
      { default: [], guilds: { G: { default: ['VIEW_CHANNEL', 'SEND_MESSAGES'] } } });
    assert.deepEqual(reach.guilds.G.channels.narrow.sort(), ['SEND_MESSAGES', 'VIEW_CHANNEL']);
    assert.deepEqual(reach.guilds.G.channels.denied, []);
    // A channel-only augment does not pin the guild default (undefined stays transparent).
    const pin = merge({ default: ['VIEW_CHANNEL'] }, { default: [], guilds: { G: { channels: { y: ['SEND_MESSAGES'] } } } });
    assert.equal(pin.guilds.G.default, undefined);
  } finally {
    t.cleanup();
  }
});

test('a persona banned from a guild cannot give itself access there again; an admin can', () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('g1-staff', { caps: [...RW], scope: { all: true }, guildId: GUILD });
    t.relay.invites.mint({ code: 'all-aug', mode: 'both', maxUses: 5, guildId: GUILD, grant: { caps: [...RW], scope: { all: true } } } as any);
    t.relay.invites.mint({ code: 'role-aug', mode: 'augment', maxUses: 5, roles: ['g1-staff'] } as any);
    t.relay.invites.mint({ code: 'chan-aug', mode: 'augment', maxUses: 5, guildId: GUILD, grant: { caps: [...RW], scope: { channels: [CHAN_A] } } } as any);
    t.relay.applyInviteAugment(EXISTING, 'all-aug');
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);

    t.relay.permissions.removePersonaRole(EXISTING, 'g1-staff');
    t.relay.permissions.clearGuild(EXISTING, GUILD); // what /ban does
    assert.deepEqual(t.caps(EXISTING, CHAN_A), []);
    for (const code of ['all-aug', 'role-aug', 'chan-aug']) {
      const uses = t.relay.invites.get(code).uses ?? 0;
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, code), /banned from that server/, code);
      assert.equal(t.relay.invites.get(code).uses ?? 0, uses, `${code}: no use consumed`);
    }
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [], 'still nothing');
    // Nothing granted around the ban counts until an admin acts: a role added
    // behind its back resolves to nothing in the banned guild.
    t.relay.permissions.addPersonaRoles(EXISTING, ['g1-staff']);
    assert.deepEqual(t.caps(EXISTING, CHAN_A), []);
    t.relay.permissions.removePersonaRole(EXISTING, 'g1-staff');

    // An admin-initiated claim is the admin's decision: it lifts the ban.
    t.relay.applyInviteAugment(EXISTING, 'chan-aug', { byAdmin: true });
    assert.equal(t.relay.permissions.isBanned(EXISTING, GUILD), false);
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('a ban survives a restart (it is written to permissions.json)', () => {
  const t = makeRelay();
  try {
    t.relay.permissions.clearGuild(EXISTING, GUILD);
    const reread = new (t.relay.permissions.constructor as any)(t.relay.config.permissionsPath);
    assert.equal(reread.isBanned(EXISTING, GUILD), true);
    assert.equal(reread.resolve(EXISTING, GUILD, CHAN_A).size, 0);
  } finally {
    t.cleanup();
  }
});

test('a persona on the file default keeps it everywhere when it is first given something', () => {
  const t = makeRelay();
  try {
    (t.relay.permissions as any).fileDefault = [...RW];
    for (const id of ['legacy', 'legacy2', 'legacy3']) {
      t.relay.identity.upsert({ id, displayName: id, avatar: '', token: `tok-${id}` });
    }
    t.relay.invites.mint({ code: 'chan-view', mode: 'augment', guildId: GUILD, grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_NEW] } } } as any);
    t.relay.permissions.setRole('g1-view', { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_NEW] }, guildId: GUILD });
    t.relay.invites.mint({ code: 'role-view', mode: 'augment', roles: ['g1-view'] } as any);
    const everywhere = (pid: string) => [...t.relay.permissions.resolve(pid, 'some-other-guild', 'x')].sort();

    t.relay.applyInviteAugment('legacy', 'chan-view');
    assert.deepEqual(t.caps('legacy', CHAN_A), [...RW], 'the rest of the guild unchanged');
    assert.deepEqual(everywhere('legacy'), [...RW], 'other guilds unchanged');
    assert.deepEqual(t.caps('legacy', CHAN_NEW), [...RW], 'and nothing narrowed where it was granted');

    t.relay.applyInviteAugment('legacy2', 'role-view');
    assert.deepEqual(everywhere('legacy2'), [...RW]);

    t.relay.permissions.setChannel('legacy3', GUILD, CHAN_NEW, ['VIEW_CHANNEL']); // an admin grant
    assert.deepEqual(everywhere('legacy3'), [...RW]);
    assert.deepEqual(t.caps('legacy3', CHAN_A), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('an enrolled persona gets exactly what its invite grants, not the file default', async () => {
  const t = makeRelay();
  try {
    (t.relay.permissions as any).fileDefault = [...RW];
    t.relay.permissions.setRole('g1-view', { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] }, guildId: GUILD });
    t.relay.invites.mint({ code: 'roles-only', roles: ['g1-view'] } as any);
    const res = await t.relay.enroll({ invite: 'roles-only', desiredName: 'fresh' });
    assert.ok(!('error' in res), JSON.stringify(res));
    assert.equal(t.relay.permissions.resolve(res.personaId, 'some-other-guild', 'x').size, 0);
    assert.deepEqual(t.caps(res.personaId, CHAN_A), ['VIEW_CHANNEL']);
  } finally {
    t.cleanup();
  }
});

test('an invite whose grant is malformed is refused before anything is created or consumed', async () => {
  const t = makeRelay();
  try {
    const bad: Array<[string, unknown]> = [
      ['all-false', { caps: [...RW], scope: { all: false } }],
      ['empty-scope', { caps: [...RW], scope: {} }],
      ['two-keys', { caps: [...RW], scope: { all: true, channels: [CHAN_A] } }],
      ['no-caps', { caps: [], scope: { all: true } }],
      ['empty-channels', { caps: [...RW], scope: { channels: [] } }],
    ];
    for (const [code, grant] of bad) t.relay.invites.mint({ code, mode: 'both', guildId: GUILD, grant } as any);
    const count = t.relay.identity.all().length;
    for (const [code] of bad) {
      const res = await t.relay.enroll({ invite: code, desiredName: `n-${code}` });
      assert.ok('error' in res && /invite grant/.test(res.error), `${code}: ${JSON.stringify(res)}`);
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, code), /invite grant/, code);
      assert.equal(t.relay.invites.get(code).uses ?? 0, 0, `${code}: no use consumed`);
    }
    assert.equal(t.relay.identity.all().length, count, 'no persona created');
  } finally {
    t.cleanup();
  }
});

test('enrolling through a mirror-only invite sets exactly the mirror role, not the file default', async () => {
  const t = makeRelay();
  try {
    (t.relay.permissions as any).fileDefault = ['VIEW_CHANNEL'];
    const res = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'mirror-only' });
    assert.ok(!('error' in res), JSON.stringify(res));
    assert.equal(t.relay.permissions.getPolicy(res.personaId), undefined, 'no inline policy');
    assert.equal(t.relay.permissions.resolve(res.personaId, 'some-other-guild', 'x').size, 0);
    assert.deepEqual(t.caps(res.personaId, CHAN_A), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('an invite naming an access role that no longer exists is refused, so the name is never stored', async () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('h-staff', { caps: [...RW], scope: { all: true }, guildId: 'H' });
    t.relay.invites.mint({ code: 'dangling', mode: 'both', maxUses: 5, guildId: GUILD, roles: ['h-staff'] } as any);
    t.relay.permissions.removeRole('h-staff');
    const count = t.relay.identity.all().length;
    const res = await t.relay.enroll({ invite: 'dangling', desiredName: 'dangler' });
    // ...and says who can mend it: the role is gone, so only a new invite can
    const remedy = /no longer exist: h-staff — whoever minted it must mint a new one/;
    assert.ok('error' in res && remedy.test(res.error), JSON.stringify(res));
    assert.equal(t.relay.identity.all().length, count);
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'dangling', { byAdmin: true }), remedy);
    assert.ok(!t.relay.permissions.getRoleNames(EXISTING).includes('h-staff'));
    assert.equal(t.relay.invites.get('dangling').uses ?? 0, 0);
  } finally {
    t.cleanup();
  }
});

test('an admin claim lifts a ban only where the invite grants something', () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('g1-marker', { caps: [], scope: { all: true }, guildId: GUILD });
    t.relay.permissions.setRole('g1-staff', { caps: [...RW], scope: { all: true }, guildId: GUILD });
    t.relay.invites.mint({ code: 'marker', mode: 'augment', maxUses: 5, roles: ['g1-marker'] } as any);
    t.relay.invites.mint({ code: 'staff', mode: 'augment', maxUses: 5, roles: ['g1-staff'] } as any);
    t.relay.permissions.clearGuild(EXISTING, GUILD);
    const r = t.relay.applyInviteAugment(EXISTING, 'marker', { byAdmin: true });
    assert.equal(r.liftedBans, undefined);
    assert.equal(t.relay.permissions.isBanned(EXISTING, GUILD), true, 'a claim that grants nothing leaves the ban');
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'staff'), /banned/);
    const r2 = t.relay.applyInviteAugment(EXISTING, 'staff', { byAdmin: true });
    assert.deepEqual(r2.liftedBans, [GUILD]);
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('a role whose scope names nothing grants nothing, so an admin claim of it leaves a ban', () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('g1-empty', { caps: [...RW], scope: { channels: [] }, guildId: GUILD });
    t.relay.invites.mint({ code: 'empty', mode: 'augment', maxUses: 5, roles: ['g1-empty'] } as any);
    t.relay.permissions.clearGuild(EXISTING, GUILD);
    t.relay.applyInviteAugment(EXISTING, 'empty', { byAdmin: true });
    assert.equal(t.relay.permissions.isBanned(EXISTING, GUILD), true);
  } finally {
    t.cleanup();
  }
});

/** What a call did, for an assertion's message: its answer, or what it threw. */
async function outcome(call: () => unknown): Promise<any> {
  try { return await call(); } catch (e) { return { threw: (e as Error).message }; }
}

const MIRROR_GRANT = { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } };
const MALFORMED_FIELDS: Array<[string, Record<string, unknown>, RegExp]> = [
  ['roles-string', { roles: 'reader' }, /invite roles must be a list of access role names/],
  ['guildId-number', { guildId: 7, grant: { caps: [...RW], scope: { channels: [CHAN_A] } } }, /invite guildId must be a string/],
  ['maxUses-word', { maxUses: 'one' }, /invite maxUses must be a finite number above 0/],
  ['maxUses-text', { maxUses: '5' }, /invite maxUses must be a finite number above 0/],
  ['uses-word', { uses: 'x', maxUses: 1 }, /invite uses must be a finite number/],
  ['prefix-number', { namePrefix: 7 }, /invite namePrefix must be a string/],
  ['subs-mixed', { subscriptions: [CHAN_A, 42] }, /invite subscriptions must be a list of channel ids/],
  ['caps-mixed', { grant: undefined, caps: ['SEND_MESSAGES', 5] }, /invite caps must be a list of capabilities/],
  ['roles-mixed', { roles: ['reader', 5] }, /invite roles must be a list of access role names/],
  // A grant that isn't one: enroll read a falsy one as absent and fell back to the caps, a claim kept it and granted nothing.
  ['grant-zero', { grant: 0 }, /invite grant must be an object/],
  ['grant-blank', { grant: '' }, /invite grant must be an object/],
  ['grant-false', { grant: false, caps: [...RW] }, /invite grant must be an object/],
  ['grant-list', { grant: [] }, /invite grant must be an object/],
  // The legacy blanket grant: read as no grant when it has no length, which spent the invite for nothing.
  ['caps-number', { grant: undefined, caps: 5 }, /invite caps must be a list of capabilities/],
  ['caps-true', { grant: undefined, caps: true }, /invite caps must be a list of capabilities/],
  ['caps-object', { grant: undefined, caps: { SEND_MESSAGES: true } }, /invite caps must be a list of capabilities/],
  // A machine mint's recheck reads the grant, so the shape comes first.
  ['mint-scope-null', { mintedBy: EXISTING, grant: { caps: [...RW], scope: null } }, /invite grant scope must be exactly one/],
];
for (const [code, fields, why] of MALFORMED_FIELDS) {
  test(`invite ${code}: enroll and claim refuse it by name, before anything is created or spent`, async () => {
    const t = makeRelay();
    try {
      t.relay.invites.mint({ code, mode: 'both', guildId: GUILD, grant: MIRROR_GRANT, ...fields } as any);
      const count = t.relay.identity.all().length;
      const enrolled = await outcome(() => t.relay.enroll({ invite: code, desiredName: `n-${code}` }));
      const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, code));
      const seen = {
        enrolled, claimed,
        caps: enrolled?.personaId ? t.caps(enrolled.personaId, CHAN_A) : null,
        personasAdded: t.relay.identity.all().length - count,
        uses: t.relay.invites.get(code)?.uses,
      };
      assert.ok(why.test(enrolled?.error ?? '') && why.test(claimed?.threw ?? ''), JSON.stringify(seen));
      // The claimant can't change a stored invite, so each says who can.
      assert.ok(/ — whoever minted it must mint a new one$/.test(enrolled?.error ?? '') && / — whoever minted it must mint a new one$/.test(claimed?.threw ?? ''), JSON.stringify(seen));
      assert.equal(seen.personasAdded, 0, 'no persona created');
      assert.equal(seen.uses, fields.uses ?? 0, 'no use spent');
    } finally {
      t.cleanup();
    }
  });
}

// JSON reads 1e400 as Infinity, which a save would write as null. Loaded from a hand edit, such an invite is refused
// by name until the relay's next save drops it; a mint's own save would drop it, so the invite is written to the file
// and reloaded.
for (const [code, field, why] of [
  ['count-infinite', '"maxUses":1e400', /^invite maxUses must be a finite number above 0 — whoever minted it must mint a new one$/],
  ['uses-infinite', '"uses":1e400', /^invite uses must be a finite number — whoever minted it must mint a new one$/],
] as const) {
  test(`invite ${code}, loaded from the file: enroll and claim refuse it by name, before anything is created or spent`, async () => {
    const t = makeRelay();
    try {
      const invite = `{"code":"${code}","label":"${code}","mode":"both","guildId":"${GUILD}","grant":${JSON.stringify(MIRROR_GRANT)},${field}}`;
      writeFileSync(join(t.dir, 'invites.json'), `{"invites":[${invite}]}`);
      (t.relay.invites as any).reload();
      const count = t.relay.identity.all().length;
      const enrolled = await outcome(() => t.relay.enroll({ invite: code, desiredName: `n-${code}` }));
      const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, code));
      assert.ok(why.test(enrolled?.error ?? '') && why.test(claimed?.threw ?? ''), JSON.stringify({ enrolled, claimed }));
      assert.equal(t.relay.identity.all().length - count, 0, 'no persona created');
      // A use saves, and the save drops this invite, so one still held shows no use was spent.
      assert.ok(t.relay.invites.get(code), 'nothing saved, so no use spent');
      assert.equal(t.relay.invites.get(code)?.uses, code === 'uses-infinite' ? Infinity : undefined, 'its uses as loaded');
    } finally {
      t.cleanup();
    }
  });
}

test('a misspelled mode is refused by name, at enroll and at a claim, since "mint-only" would be false for it', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'mode-typo', mode: 'augmnet', guildId: GUILD, grant: MIRROR_GRANT } as any);
    const count = t.relay.identity.all().length;
    const enrolled = await outcome(() => t.relay.enroll({ invite: 'mode-typo', desiredName: 'n-typo' }));
    const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, 'mode-typo'));
    const why = /^invite mode must be "mint", "augment" or "both" — whoever minted it must mint a new one$/;
    assert.ok(why.test(enrolled?.error ?? '') && why.test(claimed?.threw ?? ''), JSON.stringify({ enrolled, claimed }));
    assert.equal(t.relay.identity.all().length, count, 'no persona created');
    assert.equal(t.relay.invites.get('mode-typo').uses ?? 0, 0, 'no use spent');
  } finally {
    t.cleanup();
  }
});

test('a claim of a mint invite is still not claimable, with nothing more said about it', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'mint-only', mode: 'mint', guildId: GUILD, grant: MIRROR_GRANT, uses: 'x' } as any);
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mint-only'), /invite is not claimable \(mint-only\)$/);
  } finally {
    t.cleanup();
  }
});

for (const blank of ['', false, 0]) {
  test(`an invite whose mode, caps and subscriptions are ${JSON.stringify(blank)} reads them as none, at enroll and at a claim`, async () => {
    const t = makeRelay();
    try {
      t.relay.invites.mint({ code: 'blank-mint', mode: blank, caps: blank, subscriptions: blank, guildId: GUILD, grant: MIRROR_GRANT } as any);
      t.relay.invites.mint({ code: 'blank-both', mode: 'both', caps: blank, subscriptions: blank, guildId: GUILD, grant: MIRROR_GRANT } as any);
      const enrolled = await outcome(() => t.relay.enroll({ invite: 'blank-mint', desiredName: 'n-blank' }));
      assert.ok(enrolled?.personaId, JSON.stringify(enrolled));
      // A blank mode reads as mint, so a claim of it is as a mint invite's.
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'blank-mint'), /not claimable \(mint-only\)/);
      const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, 'blank-both'));
      assert.ok(!claimed?.threw, JSON.stringify(claimed));
    } finally {
      t.cleanup();
    }
  });
}

test('an invite whose grant is null reads it as absent, at enroll and at a claim', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'grant-null-mint', grant: null, caps: [...RW], guildId: GUILD } as any);
    t.relay.invites.mint({ code: 'grant-null-both', mode: 'both', grant: null, caps: [...RW], guildId: GUILD } as any);
    const enrolled = await outcome(() => t.relay.enroll({ invite: 'grant-null-mint', desiredName: 'n-null' }));
    assert.ok(enrolled?.personaId, JSON.stringify(enrolled));
    // Read as absent, the grant falls back to the invite's legacy caps, across the guild.
    const held = (pid: string) => t.relay.permissions.resolve(pid, GUILD, CHAN_A);
    assert.ok(RW.every((c) => held(enrolled.personaId).has(c)), JSON.stringify([...held(enrolled.personaId)]));
    assert.ok(!held(EXISTING).has('SEND_MESSAGES'), 'EXISTING starts with VIEW_CHANNEL alone');
    const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, 'grant-null-both'));
    assert.ok(!claimed?.threw, JSON.stringify(claimed));
    assert.ok(RW.every((c) => held(EXISTING).has(c)), JSON.stringify([...held(EXISTING)]));
  } finally {
    t.cleanup();
  }
});

const MALFORMED_REGISTER: Array<[Record<string, unknown>, RegExp]> = [
  [{ desiredName: 42 }, /register desiredName must be a string/],
  [{ desiredName: { first: 'a' } }, /register desiredName must be a string/],
  [{ desiredName: ['a'] }, /register desiredName must be a string/],
  [{ avatar: 42 }, /register avatar must be a string/],
  [{ avatar: { url: 'x' } }, /register avatar must be a string/],
  [{ subscriptions: 42 }, /register subscriptions must be a list of channel ids/],
  [{ subscriptions: CHAN_A }, /register subscriptions must be a list of channel ids/],
  [{ subscriptions: [CHAN_A, 42] }, /register subscriptions must be a list of channel ids/],
];
for (const [fields, why] of MALFORMED_REGISTER) {
  test(`register ${JSON.stringify(fields)}: refused by name before anything is created`, async () => {
    const t = makeRelay();
    try {
      const count = t.relay.identity.all().length;
      const enrolled = await outcome(() => t.relay.enroll({ invite: 'mirror-mint', desiredName: 'x', ...fields }));
      const stored = enrolled?.personaId ? t.relay.identity.get(enrolled.personaId) : null;
      assert.ok(why.test(enrolled?.error ?? ''), JSON.stringify({ enrolled, stored }));
      assert.equal(t.relay.identity.all().length, count, 'no persona created');
      assert.equal(t.relay.invites.get('mirror-mint').uses ?? 0, 0, 'no use spent');
    } finally {
      t.cleanup();
    }
  });
}

test('an empty or false register name, avatar or subscriptions means none, and a false avatar is stored as none', async () => {
  const t = makeRelay();
  try {
    for (const fields of [{ desiredName: '' }, { desiredName: false }, { desiredName: null }, { avatar: false }, { avatar: '' }, { subscriptions: null }, { subscriptions: '' }, { subscriptions: 0 }, { subscriptions: false }]) {
      const res = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'x', ...fields });
      assert.ok(!('error' in res), `${JSON.stringify(fields)}: ${JSON.stringify(res)}`);
      const p = t.relay.identity.get(res.personaId);
      assert.equal(typeof p.displayName, 'string', JSON.stringify(fields));
      assert.equal(typeof p.avatar, 'string', `${JSON.stringify(fields)}: stored avatar ${JSON.stringify(p.avatar)}`);
    }
  } finally {
    t.cleanup();
  }
});

// Enroll adds an invite's default subscriptions to the frame's after the
// persona is made and the invite spent, so the frame's empty forms are read
// there too.
for (const subs of ['', 0, false, null]) {
  test(`register subscriptions of ${JSON.stringify(subs)} beside an invite's default subscriptions: enroll carries the invite's`, async () => {
    const t = makeRelay();
    try {
      t.relay.invites.mint({ code: 'subs-mint', subscriptions: [CHAN_A], guildId: GUILD, grant: MIRROR_GRANT } as any);
      const d = { invite: 'subs-mint', desiredName: 'x', subscriptions: subs } as any;
      const res = await outcome(() => t.relay.enroll(d));
      assert.ok(res?.personaId, JSON.stringify(res));
      assert.deepEqual(d.subscriptions, [CHAN_A]);
    } finally {
      t.cleanup();
    }
  });
}

const STORED_SCOPES: Array<[string, unknown]> = [
  ['both mirror keys naming different roles', { mirrorRole: DISCORD_ROLE, mirrorRoles: ['dr-other'] }],
  ['all: false beside a mirror role', { all: false, mirrorRole: DISCORD_ROLE }],
  ['both mirror keys naming one role', { mirrorRole: DISCORD_ROLE, mirrorRoles: [DISCORD_ROLE] }],
];
for (const [what, scope] of STORED_SCOPES) {
  test(`a stored mirror role hand-edited to ${what} is quarantined, and the next claim of its grant writes the grant's role in its place, logging what it replaced`, async (tc) => {
    const warned: string[] = [];
    tc.mock.method(console, 'warn', (...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    const t = makeRelay();
    try {
      const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'probe' });
      const name = t.relay.permissions.getRoleNames(first.personaId)[0];
      // The hand edit, then a reload, as the file watcher does.
      const path = (t.relay.permissions as any).path as string;
      const file = JSON.parse(readFileSync(path, 'utf8'));
      file.roles[name] = { caps: [...RW].sort(), scope, guildId: GUILD };
      writeFileSync(path, JSON.stringify(file));
      (t.relay.permissions as any).reload();
      assert.equal(t.relay.permissions.isQuarantined(name), true, 'quarantined at load');
      const enrolled = await outcome(() => t.relay.enroll({ invite: 'mirror-mint', desiredName: 'again' }));
      const seen = { enrolled, role: t.relay.permissions.getRole(name), caps: enrolled?.personaId ? t.caps(enrolled.personaId, CHAN_A) : null };
      // The name is a digest of the grant's guild, roles and caps, so the role written is the one this grant made.
      assert.deepEqual(seen.role, { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE }, guildId: GUILD }, JSON.stringify(seen));
      assert.deepEqual(seen.caps, [...RW].sort(), JSON.stringify(seen));
      assert.equal(t.relay.permissions.isQuarantined(name), false, 'replaced');
      assert.ok(warned.some((l) => l.includes(`mirror grant ${name}: replacing the entry set aside at load, which was ${JSON.stringify({ caps: [...RW].sort(), scope, guildId: GUILD })}`)), warned.join('\n'));
    } finally {
      t.cleanup();
    }
  });
}

test('an invite naming a role quarantined at load is refused as unreadable, for the operator to fix, before anything is created or spent', async () => {
  const t = makeRelay();
  try {
    const path = (t.relay.permissions as any).path as string;
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.roles = { broken: { caps: ['VIEW_CHANNEL'], scope: { channels: CHAN_A }, guildId: GUILD } };
    writeFileSync(path, JSON.stringify(file));
    (t.relay.permissions as any).reload();
    t.relay.invites.mint({ code: 'names-broken', mode: 'both', guildId: GUILD, roles: ['broken'] } as any);
    const count = t.relay.identity.all().length;
    const enrolled = await outcome(() => t.relay.enroll({ invite: 'names-broken', desiredName: 'n-broken' }));
    const claimed = await outcome(() => t.relay.applyInviteAugment(EXISTING, 'names-broken'));
    const why = /^invite names access role\(s\) that can't be read: broken — the relay's operator must fix them$/;
    assert.ok(why.test(enrolled?.error ?? '') && why.test(claimed?.threw ?? ''), JSON.stringify({ enrolled, claimed }));
    assert.equal(t.relay.identity.all().length, count, 'no persona created');
    assert.equal(t.relay.invites.get('names-broken').uses ?? 0, 0, 'no use spent');
    // With a role that's gone as well, both are named, each with who fixes it.
    t.relay.invites.mint({ code: 'names-both', mode: 'both', guildId: GUILD, roles: ['broken', 'gone'] } as any);
    const both = await outcome(() => t.relay.applyInviteAugment(EXISTING, 'names-both'));
    assert.equal(both?.threw, "invite names access role(s) that can't be read: broken, which the relay's operator must fix, and that no longer exist: gone, so whoever minted it must mint a new one");
  } finally {
    t.cleanup();
  }
});
