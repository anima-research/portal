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
import type { AccessRole, RelayConfig } from '../src/config.js';

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
        { code: 'mirror-noguild', mode: 'both', maxUses: 1, grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } } },
        { code: 'mirror-emptyguild', mode: 'both', maxUses: 1, guildId: '', grant: { caps: [...RW], scope: { mirrorRoles: [DISCORD_ROLE] } } },
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
  const changes: unknown[] = [];
  relay.identity.onChange((change: unknown) => changes.push(change));
  relay.permissions.onChange((change: unknown) => changes.push(change));
  const snapshot = () => structuredClone({
    identities: relay.identity.all(),
    permissions: [...relay.permissions.personas],
    roles: relay.permissions.allRoles(),
    invites: relay.invites.all(),
    files: ['identity.json', 'permissions.json', 'invites.json'].map((file) => readFileSync(join(dir, file), 'utf8')),
    changes,
  });
  return { relay, visible, caps, snapshot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

for (const code of ['mirror-noguild', 'mirror-emptyguild']) {
  test(`${code}: enroll and augment reject without mutations or invite consumption`, async () => {
    const t = makeRelay();
    try {
      const before = t.snapshot();
      const request = { invite: code, desiredName: 'lost', subscriptions: [CHAN_A] };
      const enrolled = await t.relay.enroll(request);
      assert.match(enrolled.error, /invite mirror grant is missing guildId/);
      assert.deepEqual(t.snapshot(), before);
      assert.deepEqual(request.subscriptions, [CHAN_A]);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, code), {
        code: 'INVALID_PARAMS', message: /invite mirror grant is missing guildId/,
      });
      assert.deepEqual(t.snapshot(), before);
      assert.equal(t.relay.invites.check(code, Date.now()).code, code);
    } finally {
      t.cleanup();
    }
  });
}

const mismatches: [string, Partial<AccessRole>][] = [
  ['guild', { guildId: 'other-guild' }],
  ['cap set', { caps: ['VIEW_CHANNEL'] }],
  ['role-id set', { scope: { mirrorRoles: [DISCORD_ROLE, 'another-role'] } }],
  ['all scope', { scope: { all: true } }],
  ['channel scope', { scope: { channels: [CHAN_A] } }],
  ['mixed all/mirror scope', { scope: { all: true, mirrorRole: DISCORD_ROLE } }],
  ['mixed channel/mirror scope', { scope: { channels: [CHAN_A], mirrorRole: DISCORD_ROLE } }],
  ['mirrorCaps', { mirrorCaps: true }],
];

for (const [dimension, replacement] of mismatches) {
  test(`colliding mirror role (${dimension}): both claims reject before any mutation`, async () => {
    const t = makeRelay();
    try {
      const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
      assert.ok(!('error' in first));
      const [name] = t.relay.permissions.getRoleNames(first.personaId);
      t.relay.permissions.setRole(name, { ...t.relay.permissions.getRole(name), ...replacement });
      const before = t.snapshot();

      const second = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
      assert.match(second.error, /invite mirror grant conflicts with existing role/);
      assert.ok(second.error.includes(name));
      assert.deepEqual(t.snapshot(), before);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), {
        code: 'INVALID_PARAMS', message: /invite mirror grant conflicts with existing role/,
      });
      assert.deepEqual(t.snapshot(), before);
    } finally {
      t.cleanup();
    }
  });
}

test('equivalent single/plural mirror scopes and duplicate caps reuse the existing role unchanged', async () => {
  const t = makeRelay();
  try {
    const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    assert.ok(!('error' in first));
    const [name] = t.relay.permissions.getRoleNames(first.personaId);
    const equivalent: AccessRole = {
      guildId: GUILD, caps: ['VIEW_CHANNEL', ...RW].reverse(),
      scope: { mirrorRoles: [DISCORD_ROLE, DISCORD_ROLE] }, mirrorCaps: false,
    };
    t.relay.permissions.setRole(name, equivalent);
    t.relay.invites.mint({
      code: 'equivalent', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW, 'VIEW_CHANNEL'].reverse(), scope: { mirrorRoles: [DISCORD_ROLE] } },
    });
    const second = await t.relay.enroll({ invite: 'equivalent', desiredName: 'second' });
    assert.ok(!('error' in second), JSON.stringify(second));
    const claimed = t.relay.applyInviteAugment(EXISTING, 'equivalent');
    assert.deepEqual(t.relay.permissions.getRoleNames(second.personaId), [name]);
    assert.deepEqual(claimed.roles, [name]);
    assert.deepEqual(t.relay.permissions.allRoles(), { [name]: equivalent });
    assert.deepEqual(t.caps(second.personaId, CHAN_A), [...RW]);
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
    assert.equal(t.relay.invites.get('equivalent').uses, 2);
  } finally {
    t.cleanup();
  }
});

test('multi-role grants normalize role order and duplicates for both naming and reuse', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({
      code: 'multi', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW], scope: { mirrorRoles: ['other-role', DISCORD_ROLE] } },
    });
    const first = await t.relay.enroll({ invite: 'multi', desiredName: 'first' });
    assert.ok(!('error' in first));
    const [name] = t.relay.permissions.getRoleNames(first.personaId);
    const equivalent: AccessRole = {
      guildId: GUILD, caps: [...RW],
      scope: { mirrorRoles: ['other-role', DISCORD_ROLE, 'other-role'] },
    };
    t.relay.permissions.setRole(name, equivalent);
    t.relay.invites.mint({
      code: 'multi-reordered', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW].reverse(), scope: { mirrorRoles: [DISCORD_ROLE, 'other-role', DISCORD_ROLE] } },
    });
    const second = await t.relay.enroll({ invite: 'multi-reordered', desiredName: 'second' });
    assert.ok(!('error' in second), JSON.stringify(second));
    const claimed = t.relay.applyInviteAugment(EXISTING, 'multi-reordered');
    assert.deepEqual(t.relay.permissions.getRoleNames(second.personaId), [name]);
    assert.deepEqual(claimed.roles, [name]);
    assert.deepEqual(t.relay.permissions.allRoles(), { [name]: equivalent });
    assert.equal(t.relay.invites.get('multi-reordered').uses, 2);
  } finally {
    t.cleanup();
  }
});
