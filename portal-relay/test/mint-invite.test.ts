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
import { nameKey, nameKeys } from '../src/name-policy.js';

const GUILD = 'g1';
const OTHER_GUILD = 'g2';
const CHAN_A = 'chan-a';
const CHAN_B = 'chan-b';
const FOREIGN_CHAN = 'chan-foreign';
const SPAWNER = 'cc-spawner-1';
const RANDO = 'rando-1';
const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] as const;

function makeRelay(opts: { minters?: string[]; realRateLimit?: boolean } = {}) {
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
  // Most tests make many attempts; the token bucket is exercised explicitly
  // in its own test (realRateLimit) and bypassed elsewhere.
  if (!opts.realRateLimit) relay.takeMintToken = () => true;

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
    channelMetaFromCache: () => null, // no thread is cached: every id is checked as itself
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    listChannelMetas: () => [],
    isGuildAllowed: (gid: string) => gid === GUILD,
    // Guild members, for the enrollment name check: a human and a bot.
    membersComplete: () => true,
    memberNameMatches: (gid: string, keys: ReadonlySet<string>, o: { bots: boolean }) => {
      const reads = (n: string) => nameKeys(n).some((k) => keys.has(k));
      return gid === GUILD && (reads('Antra') || (o.bots && reads('MythosBot')));
    },
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
    assert.equal(ok.target, `${res.code.slice(0, 12)}…`); // redacted bearer code
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
    assert.match(rejected.error, /could not be re-verified on channel chan-a/);
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

// ── Review-round regressions (PR #15) ──

test('rate limit: burst of 5, then FORBIDDEN; rejections consume tokens too', () => {
  const t = makeRelay({ realRateLimit: true });
  try {
    for (let i = 0; i < 5; i++) t.mint(SPAWNER, t.goodParams());
    assert.throws(() => t.mint(SPAWNER, t.goodParams()), /rate limit/);
  } finally {
    t.cleanup();
  }
});

test('outstanding-mint cap: at most 20 live unclaimed codes per minter', () => {
  const t = makeRelay();
  try {
    for (let i = 0; i < 20; i++) t.mint(SPAWNER, t.goodParams());
    assert.throws(() => t.mint(SPAWNER, t.goodParams()), /too many outstanding/);
  } finally {
    t.cleanup();
  }
});

test('param pathologies reject as INVALID_PARAMS and are audited — never raw throws', () => {
  const t = makeRelay();
  try {
    const cases: Array<[any, RegExp]> = [
      [null, /params object required/],
      [{ ...t.goodParams(), expiresInMinutes: 'abc' }, /finite number/],
      [{ ...t.goodParams(), expiresInMinutes: {} }, /finite number/],
      [{ grant: { caps: { 0: 'VIEW_CHANNEL' }, scope: { channels: [CHAN_A] } }, guildId: GUILD }, /must be an array/],
      [{ grant: { caps: [...RW], scope: { channels: [[CHAN_A]] } }, guildId: GUILD }, /channel-id strings/],
      [{ ...t.goodParams(), label: { a: 1 } }, /label must be a string/],
      [{ ...t.goodParams(), label: 'x'.repeat(200) }, /at most 120/],
    ];
    for (const [params, re] of cases) {
      const before = t.auditLines().length;
      assert.throws(() => t.mint(SPAWNER, params), re);
      const rec = t.auditLines().at(-1);
      assert.equal(t.auditLines().length, before + 1, 'attempt audited');
      assert.equal(rec.ok, false);
      assert.match(rec.detail.reason, re);
    }
  } finally {
    t.cleanup();
  }
});

test('audit redacts the code (bearer credential); invites.json keeps it', () => {
  const t = makeRelay();
  try {
    const { code } = t.mint(SPAWNER, t.goodParams());
    const rec = t.auditLines().at(-1);
    assert.equal(rec.ok, true);
    assert.ok(rec.target.endsWith('…'), 'redacted');
    assert.equal(rec.target.length, 13);
    assert.ok(code.startsWith(rec.target.slice(0, 12)), 'prefix correlates');
    assert.notEqual(rec.target, code);
    assert.ok(t.relay.invites.get(code), 'full code lives in the store');
  } finally {
    t.cleanup();
  }
});

test('unparseable expiresAt fails CLOSED (expired), and pruning drops long-expired invites on persist', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'inv_badexpiry', expiresAt: 'tomorrow', grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD });
    // Unparseable expiry fails closed twice over: check() treats it as
    // expired, and the very first persist prunes it (so it may already be
    // 'unknown' by claim time). Either way the code is dead.
    const res = await t.relay.enroll({ invite: 'inv_badexpiry', desiredName: 'x' });
    assert.match(res.error, /expired|unknown/);

    t.relay.invites.mint({
      code: 'inv_ancient',
      expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD,
    });
    // Any subsequent persist prunes it.
    t.mint(SPAWNER, t.goodParams());
    assert.equal(t.relay.invites.get('inv_ancient'), undefined, 'pruned from store');
    const onDisk = JSON.parse(readFileSync(join(t.dir, 'invites.json'), 'utf8'));
    assert.ok(!onDisk.invites.some((i: any) => i.code === 'inv_ancient'), 'pruned from disk');
  } finally {
    t.cleanup();
  }
});

test('recheck rejects hand-edited machine mints carrying roles (what is APPLIED is what is verified)', async () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('sneaky', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD });
    t.relay.invites.mint({
      code: 'inv_sneaky', mintedBy: SPAWNER, roles: ['sneaky'],
      grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } },
      guildId: GUILD, maxUses: 1, mode: 'mint',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const res = await t.relay.enroll({ invite: 'inv_sneaky', desiredName: 'sneak' });
    assert.match(res.error, /roles.*not permitted/);
  } finally {
    t.cleanup();
  }
});

test('augment path: machine mints get a flat "not claimable" (mode gate before recheck)', () => {
  const t = makeRelay();
  try {
    const { code } = t.mint(SPAWNER, t.goodParams());
    assert.throws(
      () => t.relay.applyInviteAugment(RANDO, code),
      /not claimable \(mint-only\)/,
      'no minter-state oracle for code holders',
    );
  } finally {
    t.cleanup();
  }
});

test('an invite carrying roles AND a channel grant enrolls with the union (/invite pins its channel)', async () => {
  const t = makeRelay();
  try {
    // A role that covers CHAN_B only; the grant covers CHAN_A — the channel
    // /invite was run in — which the role does not.
    t.relay.permissions.setRole('b-reader', {
      caps: ['VIEW_CHANNEL', 'READ_HISTORY'],
      scope: { channels: [CHAN_B] },
      guildId: GUILD,
    });
    t.relay.invites.mint({
      code: 'inv_slash',
      roles: ['b-reader'],
      grant: { caps: [...RW], scope: { channels: [CHAN_A] } },
      guildId: GUILD,
      maxUses: 1,
    });
    const enrolled = await t.relay.enroll({ invite: 'inv_slash', desiredName: 'newcomer' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const pid = enrolled.personaId;
    assert.deepEqual(t.relay.permissions.getRoleNames(pid), ['b-reader']);
    assert.deepEqual([...t.relay.permissions.resolve(pid, GUILD, CHAN_A)].sort(), [...RW].sort(), 'channel grant applies');
    assert.deepEqual(
      [...t.relay.permissions.resolve(pid, GUILD, CHAN_B)].sort(),
      ['READ_HISTORY', 'VIEW_CHANNEL'],
      'role still applies',
    );
    assert.equal(t.relay.permissions.resolve(pid, GUILD, FOREIGN_CHAN).size, 0);

    // Augment path unions both too.
    t.relay.invites.mint({
      code: 'inv_more',
      roles: ['b-reader'],
      grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_B] } },
      guildId: GUILD,
      mode: 'augment',
      maxUses: 1,
    });
    t.relay.applyInviteAugment(RANDO, 'inv_more');
    assert.deepEqual(t.relay.permissions.getRoleNames(RANDO), ['b-reader']);
    assert.deepEqual([...t.relay.permissions.resolve(RANDO, GUILD, CHAN_A)].sort(), [...RW].sort(), 'existing grant kept');
    assert.ok(t.relay.permissions.resolve(RANDO, GUILD, CHAN_B).has('VIEW_CHANNEL'));
  } finally {
    t.cleanup();
  }
});

// ── Display-name collisions at enrollment ──

test('nameKey folds case, accents, invisibles, separators and look-alike letters', () => {
  const k = nameKey('antra');
  for (const v of ['Antra', 'ANTRA', 'antra.', 'an tra', 'an_tra', 'ántra', 'an\u200btra', 'ａｎｔｒａ', '\u0430ntra' /* Cyrillic а */, 'аntrа']) {
    assert.equal(nameKey(v), k, JSON.stringify(v));
  }
  assert.notEqual(nameKey('antra2'), k);
  // Round-3 forms: small capitals, Cherokee, capital I for l, rn for m.
  assert.equal(nameKey('ᴀɴᴛʀᴀ'), k);
  assert.equal(nameKey(String.fromCodePoint(0xab7a) + 'ntra' /* Cherokee small GO */), k);
  const alike = (a: string, b: string) => nameKeys(a).some((k) => nameKeys(b).includes(k));
  assert.ok(alike('Iinn', 'linn'), 'capital I read as l');
  assert.ok(alike('iris', 'Iris') && alike('IRIS', 'iris'), 'and plain case-insensitivity still holds');
  assert.ok(!alike('lris', 'iris'));
  assert.equal(nameKey('rnara'), nameKey('mara'));
  assert.equal(nameKey('aqent1'), nameKey('aqentl'));
  assert.equal(nameKey('🙂 —'), '', 'no letters or digits → empty key (not checked)');
});

test('enroll refuses a name that reads like a human member\'s — always, without saying who', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'inv_n1', label: 'n', grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD });
    for (const name of ['antra', 'Аntra' /* Cyrillic А */, 'an.tra']) {
      const res = await t.relay.enroll({ invite: 'inv_n1', desiredName: name });
      assert.ok('error' in res, name);
      assert.match(res.error, /reads like a server member's name/);
      // Echoes the requested name, never the member's own spelling or the guild.
      assert.doesNotMatch(res.error, /Antra/, 'member not named');
      assert.doesNotMatch(res.error, /guild|\bG\b/i, 'guild not named');
    }
    assert.equal(t.relay.invites.get('inv_n1').uses ?? 0, 0, 'a refused name consumes no use');
    assert.equal(t.relay.identity.all().length, 2, 'no persona minted');
  } finally {
    t.cleanup();
  }
});

test('enroll: persona and bot-name clashes are refused only when uniqueName is asked', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'inv_n2', label: 'n', grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD, maxUses: 10 });
    // An existing persona ("Spawner") and a bot member ("MythosBot").
    for (const name of ['spawner', 'Mythos Bot']) {
      const strict = await t.relay.enroll({ invite: 'inv_n2', desiredName: name, uniqueName: true });
      assert.ok('error' in strict, name);
      assert.match(strict.error, /reads like an existing persona's name|reads like a server member's name/);
      // Plain self-enrollment (an agent re-enrolling under its own name, or
      // sharing its bot's name) still works.
      const plain = await t.relay.enroll({ invite: 'inv_n2', desiredName: name });
      assert.ok(!('error' in plain), JSON.stringify(plain));
    }
    const fresh = await t.relay.enroll({ invite: 'inv_n2', desiredName: 'brand-new-name', uniqueName: true });
    assert.ok(!('error' in fresh), JSON.stringify(fresh));
  } finally {
    t.cleanup();
  }
});

test('a runtime mint waits for a complete member list; plain enrollment goes ahead best-effort', async () => {
  const t = makeRelay();
  try {
    t.relay.bot.membersComplete = () => false;
    t.relay.invites.mint({ code: 'inv_n3', label: 'n', grant: { caps: ['VIEW_CHANNEL'], scope: { channels: [CHAN_A] } }, guildId: GUILD, maxUses: 10 });
    const minted = await t.relay.enroll({ invite: 'inv_n3', desiredName: 'fresh-name', uniqueName: true });
    assert.ok('error' in minted);
    assert.match(minted.error, /member list is still loading/);
    const plain = await t.relay.enroll({ invite: 'inv_n3', desiredName: 'fresh-name' });
    assert.ok(!('error' in plain), JSON.stringify(plain));
    // The human check still runs on what IS cached.
    const human = await t.relay.enroll({ invite: 'inv_n3', desiredName: 'antra' });
    assert.ok('error' in human);
  } finally {
    t.cleanup();
  }
});

test('mark_read passes count, since and keepPings through to the read-state store', async () => {
  const t = makeRelay();
  try {
    const calls: unknown[] = [];
    t.relay.readState.markRead = (...args: unknown[]) => void calls.push(args);
    await t.relay.dispatchRpc({ personaId: RANDO }, 'mark_read', {
      channelId: CHAN_A, uptoCreatedAt: '2026-01-01T00:00:00.000Z', count: 3, since: '2025-12-31T00:00:00.000Z', keepPings: true,
    });
    assert.deepEqual(calls, [[RANDO, CHAN_A, '2026-01-01T00:00:00.000Z', { count: 3, since: '2025-12-31T00:00:00.000Z', keepPings: true }]]);
  } finally {
    t.cleanup();
  }
});

test('an invite granting scope:{all} covers every channel of ITS guild only — never every guild', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({ code: 'inv_all', label: 'all', grant: { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { all: true } }, guildId: GUILD });
    const res = await t.relay.enroll({ invite: 'inv_all', desiredName: 'whole-guild' });
    assert.ok(!('error' in res), JSON.stringify(res));
    const policy = t.relay.permissions.getPolicy(res.personaId);
    assert.deepEqual(policy.default, [], 'no persona-wide default');
    assert.deepEqual(policy.guilds?.[GUILD]?.default, ['VIEW_CHANNEL', 'READ_HISTORY']);
    assert.deepEqual(t.relay.capsFor(res.personaId, FOREIGN_CHAN, OTHER_GUILD), [], 'nothing in another guild');
    // No guild on the invite: refused before anything is created or used up.
    t.relay.invites.mint({ code: 'inv_all_noguild', label: 'x', grant: { caps: ['VIEW_CHANNEL'], scope: { all: true } } });
    const count = t.relay.identity.all().length;
    const bare = await t.relay.enroll({ invite: 'inv_all_noguild', desiredName: 'nowhere' });
    assert.ok('error' in bare && /names no guild/.test(bare.error));
    assert.equal(t.relay.identity.all().length, count);
    assert.equal(t.relay.invites.get('inv_all_noguild').uses ?? 0, 0);
    // Legacy blanket caps without a guild: the same.
    t.relay.invites.mint({ code: 'inv_blanket', label: 'old', caps: ['VIEW_CHANNEL'] } as any);
    const blanket = await t.relay.enroll({ invite: 'inv_blanket', desiredName: 'old-style' });
    assert.ok('error' in blanket && /names no guild/.test(blanket.error));
  } finally {
    t.cleanup();
  }
});

test('outstanding-mint cap counts what a claim finds live: a hand-edited numeric expiry is expired', () => {
  const t = makeRelay();
  try {
    const dead = Array.from({ length: 20 }, (_, i) => ({
      code: `inv_dead${i}`, mintedBy: SPAWNER, maxUses: 1, uses: 0, expiresAt: 0, mode: 'mint',
      grant: { caps: [...RW], scope: { channels: [CHAN_A] } }, guildId: GUILD,
    }));
    writeFileSync(join(t.dir, 'invites.json'), JSON.stringify({ invites: dead }));
    t.relay.invites.reload();
    assert.doesNotThrow(() => t.mint(SPAWNER, t.goodParams()));
  } finally {
    t.cleanup();
  }
});
