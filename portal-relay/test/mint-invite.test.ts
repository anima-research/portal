// mint_invite RPC — the daemon/spawner door. Pins the five authorization
// rules (allowlist, subset-of-own-effective-rights, channels-only scope,
// forced single-use + clamped expiry, guild containment), the claim-time
// re-verification (revoking the minter revokes its outstanding codes), and
// the full mint → enroll → policy round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import { AuditLog } from '../src/admin/audit.js';

const GUILD = 'g1';
const OTHER_GUILD = 'g2';
const CHAN_A = 'chan-a';
const CHAN_B = 'chan-b';
const FOREIGN_CHAN = 'chan-foreign';
const SPAWNER = 'cc-spawner-1';
const RANDO = 'rando-1';
const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] as const;

function makeRelay(opts: { minters?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-mint-'));
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify({
      personas: [
        { id: SPAWNER, displayName: 'Spawner', avatar: '', token: 'tok-s' },
        { id: RANDO, displayName: 'Rando', avatar: '', token: 'tok-r' },
      ],
    }),
  );
  // Spawner holds RW on CHAN_A and read-only on CHAN_B.
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({
      personas: {
        [SPAWNER]: {
          default: [],
          guilds: {
            [GUILD]: {
              default: [],
              channels: { [CHAN_A]: RW, [CHAN_B]: ['VIEW_CHANNEL', 'READ_HISTORY'] },
            },
          },
        },
        [RANDO]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN_A]: RW } } } },
      },
    }),
  );
  writeFileSync(join(dir, 'invites.json'), JSON.stringify({ invites: [] }));
  writeFileSync(join(dir, 'audit.jsonl'), '');

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: join(dir, 'identity.json'),
    permissionsPath: join(dir, 'permissions.json'),
    invitesPath: join(dir, 'invites.json'),
    inviteMinters: opts.minters ?? [SPAWNER],
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  relay.audit = new AuditLog(join(dir, 'audit.jsonl'));

  // Fake bot: CHAN_A/CHAN_B live in GUILD, FOREIGN_CHAN in OTHER_GUILD;
  // Discord-side perms wide open so effective caps = pure policy.
  const channelGuild: Record<string, string> = {
    [CHAN_A]: GUILD, [CHAN_B]: GUILD, [FOREIGN_CHAN]: OTHER_GUILD,
  };
  relay.bot = {
    channelForPerms: (cid: string) =>
      channelGuild[cid]
        ? { guildId: channelGuild[cid], permissionsFor: () => ({ has: () => true }) }
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

  const mint = (personaId: string, params: any) => relay.mintInviteRpc(personaId, params);
  const goodParams = () => ({
    grant: { caps: [...RW], scope: { channels: [CHAN_A] } },
    guildId: GUILD,
  });
  const auditLines = () =>
    readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  return { relay, mint, goodParams, auditLines, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('allowlist: non-minters are rejected and audited; empty allowlist disables the RPC', () => {
  const t = makeRelay();
  try {
    assert.throws(() => t.mint(RANDO, t.goodParams()), /not an authorized invite minter/);
    const denied = t.auditLines().at(-1);
    assert.equal(denied.action, 'invite.mint');
    assert.equal(denied.ok, false);
    assert.equal(denied.actor.kind, 'persona');
    assert.equal(denied.actor.id, RANDO);
  } finally {
    t.cleanup();
  }
  const off = makeRelay({ minters: [] });
  try {
    assert.throws(() => off.mint(SPAWNER, off.goodParams()), /not an authorized invite minter/);
  } finally {
    off.cleanup();
  }
});

test('happy path: single-use, mintedBy-stamped, expiry-clamped, audited', () => {
  const t = makeRelay();
  try {
    const res = t.mint(SPAWNER, { ...t.goodParams(), label: 'hand-7', expiresInMinutes: 999 });
    assert.match(res.code, /^inv_/);
    const minted = t.relay.invites.get(res.code);
    assert.equal(minted.maxUses, 1);
    assert.equal(minted.mintedBy, SPAWNER);
    assert.equal(minted.mode, 'mint');
    assert.deepEqual(minted.grant, { caps: [...RW], scope: { channels: [CHAN_A] } });
    // 999 minutes clamps to 60.
    const ttlMs = Date.parse(minted.expiresAt) - Date.now();
    assert.ok(ttlMs > 55 * 60_000 && ttlMs <= 60 * 60_000, `clamped ttl, got ${ttlMs}`);
    const ok = t.auditLines().at(-1);
    assert.equal(ok.ok, true);
    assert.equal(ok.target, res.code);
    assert.equal(ok.actor.kind, 'persona');
  } finally {
    t.cleanup();
  }
});

test('subset rule: cannot delegate caps the minter does not effectively hold on that channel', () => {
  const t = makeRelay();
  try {
    // SEND_MESSAGES on CHAN_B — spawner only has read there.
    assert.throws(
      () => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: [CHAN_A, CHAN_B] } }, guildId: GUILD }),
      /cannot delegate SEND_MESSAGES on channel chan-b/,
    );
    // MANAGE_MESSAGES anywhere — spawner holds it nowhere.
    assert.throws(
      () => t.mint(SPAWNER, { grant: { caps: ['VIEW_CHANNEL', 'MANAGE_MESSAGES'], scope: { channels: [CHAN_A] } }, guildId: GUILD }),
      /cannot delegate MANAGE_MESSAGES/,
    );
    // Read-only on CHAN_B is fine — subset per channel.
    const res = t.mint(SPAWNER, { grant: { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { channels: [CHAN_A, CHAN_B] } }, guildId: GUILD });
    assert.match(res.code, /^inv_/);
  } finally {
    t.cleanup();
  }
});

test('shape gates: channels-only scope, known caps, single-use, guild containment', () => {
  const t = makeRelay();
  try {
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { all: true } }, guildId: GUILD }), /channels-scoped only/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: [CHAN_A], mirrorRole: 'x' } }, guildId: GUILD }), /channels-scoped only/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: [] } }, guildId: GUILD }), /1–32 channels/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [], scope: { channels: [CHAN_A] } }, guildId: GUILD }), /non-empty/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: ['NUKE'], scope: { channels: [CHAN_A] } }, guildId: GUILD }), /unknown caps: NUKE/);
    assert.throws(() => t.mint(SPAWNER, { ...t.goodParams(), maxUses: 5 }), /single-use/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: [FOREIGN_CHAN] } }, guildId: GUILD }), /not in guild/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: [CHAN_A] } }, guildId: OTHER_GUILD }), /not on the relay allow-list|not in guild/);
    assert.throws(() => t.mint(SPAWNER, { grant: { caps: [...RW], scope: { channels: ['no-such-chan'] } }, guildId: GUILD }), /not in guild/);
  } finally {
    t.cleanup();
  }
});

test('mint → enroll round-trip: persona gets exactly the delegated channel caps', async () => {
  const t = makeRelay();
  try {
    const { code } = t.mint(SPAWNER, t.goodParams());
    const enrolled = await t.relay.enroll({ invite: code, desiredName: 'hand-7' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const pid = enrolled.personaId;
    assert.deepEqual([...t.relay.permissions.resolve(pid, GUILD, CHAN_A)].sort(), [...RW].sort());
    assert.equal(t.relay.permissions.resolve(pid, GUILD, CHAN_B).size, 0, 'no caps outside the grant');
    assert.equal(t.relay.permissions.resolve(pid, OTHER_GUILD, CHAN_A).size, 0);
    // Single-use: a second enroll on the same code is rejected.
    const again = await t.relay.enroll({ invite: code, desiredName: 'hand-8' });
    assert.match(again.error, /exhausted/);
  } finally {
    t.cleanup();
  }
});

test('claim-time recheck: demoting or de-listing the minter kills outstanding codes', async () => {
  const t = makeRelay();
  try {
    const { code } = t.mint(SPAWNER, t.goodParams());
    // Spawner loses SEND_MESSAGES on CHAN_A between mint and claim.
    t.relay.permissions.setChannel(SPAWNER, GUILD, CHAN_A, ['VIEW_CHANNEL', 'READ_HISTORY']);
    const rejected = await t.relay.enroll({ invite: code, desiredName: 'hand-9' });
    assert.match(rejected.error, /no longer holds the delegated rights/);
    // Restore → the same (unconsumed) code claims fine.
    t.relay.permissions.setChannel(SPAWNER, GUILD, CHAN_A, [...RW]);
    const ok = await t.relay.enroll({ invite: code, desiredName: 'hand-9' });
    assert.ok(!('error' in ok), JSON.stringify(ok));

    // De-listing the minter kills codes too.
    const { code: code2 } = t.mint(SPAWNER, t.goodParams());
    t.relay.config.inviteMinters = [];
    const delisted = await t.relay.enroll({ invite: code2, desiredName: 'hand-10' });
    assert.match(delisted.error, /no longer authorized/);
  } finally {
    t.cleanup();
  }
});

test('expired machine mints are rejected like any invite', async () => {
  const t = makeRelay();
  try {
    const { code } = t.mint(SPAWNER, { ...t.goodParams(), expiresInMinutes: 1 });
    const inv = t.relay.invites.get(code);
    inv.expiresAt = new Date(Date.now() - 1000).toISOString(); // force-expire
    const res = await t.relay.enroll({ invite: code, desiredName: 'late-hand' });
    assert.match(res.error, /expired/);
  } finally {
    t.cleanup();
  }
});

test('human-minted invites are untouched by the recheck (no mintedBy)', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({
      code: 'inv_human', label: 'hand-made',
      grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD,
    });
    const ok = await t.relay.enroll({ invite: 'inv_human', desiredName: 'classic' });
    assert.ok(!('error' in ok), JSON.stringify(ok));
  } finally {
    t.cleanup();
  }
});
