// Inline mirror grants (invite `grant` with a mirrorRole/mirrorRoles scope)
// materialize as shared content-addressed access roles at enroll/claim time,
// so they resolve LIVE against Discord visibility. Pins the regression that
// motivated this: a channel created AFTER enrollment must become visible to
// the persona without any re-enroll or policy hand-edit (the old snapshot
// behavior froze the channel list at enroll time and new rooms stayed
// invisible until an operator noticed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
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
  return { relay, visible, caps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    assert.match(roles[0], /^mirror-[0-9a-f]{8}$/);
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
    assert.match(roles[0], /^mirror-[0-9a-f]{8}$/);
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
    const enrolled = await t.relay.enroll({ invite: 'mirror-noguild', desiredName: 'lost' });
    assert.ok(!('error' in enrolled));
    assert.deepEqual(t.relay.permissions.getRoleNames(enrolled.personaId), []);
    assert.deepEqual(t.caps(enrolled.personaId, CHAN_A), []);

    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-noguild'), /missing guildId/);
  } finally {
    t.cleanup();
  }
});
