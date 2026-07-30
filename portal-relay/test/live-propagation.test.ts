// Live rights propagation (issue #5): a rights or channel change reaches
// connected personas as wire events instead of waiting for the next identify.
//
// Pins the three relay-side behaviors:
//   1) A new/changed Discord channel dispatches channel_create/channel_update
//      (thread_* for threads) with per-persona capabilities — the event that
//      lets a client MATERIALIZE a channel it has never seen.
//   2) A permission change dispatches capabilities_update, deduplicated against
//      the last-delivered caps so no-op repushes don't churn persona streams.
//   3) A deleted channel dispatches channel_delete and clears the dedup
//      baseline so a later re-appearance is announced fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { ChannelMeta } from '../src/discord-bot.js';

const GUILD = 'g1';
const CHAN_A = 'chan-a';
const CHAN_B = 'chan-b';
const ALICE = 'alice';
const BOB = 'bob';
const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'];
const RO = ['VIEW_CHANNEL', 'READ_HISTORY'];

function meta(id: string, isThread = false): ChannelMeta {
  return { id, name: id, type: isThread ? 'thread' : 'text', guildId: GUILD, isThread };
}

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-i5-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(
    identityPath,
    JSON.stringify({
      personas: [
        { id: ALICE, displayName: 'Alice', avatar: '', token: 'tok-a' },
        { id: BOB, displayName: 'Bob', avatar: '', token: 'tok-b' },
      ],
    }),
  );
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      personas: {
        [ALICE]: { default: [], guilds: { [GUILD]: { default: RW, channels: {} } } },
        [BOB]: { default: [], guilds: { [GUILD]: { default: RO, channels: {} } } },
      },
    }),
  );

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // Fake bot: full Discord-side permissions so effective caps = pure policy;
  // the test owns the channel list via the mutable `metas` array.
  const metas: ChannelMeta[] = [meta(CHAN_A)];
  relay.bot = {
    channelForPerms: (_channelId: string) => ({
      guildId: GUILD,
      permissionsFor: () => ({ has: () => true }),
    }),
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    listChannelMetas: (gid: string) => (gid === GUILD ? metas : []),
    channelMetaFromCache: (id: string) => metas.find((m) => m.id === id),
    isGuildAllowed: () => true,
  };
  // Addressing-role reconcile is out of scope here — stub it inert (bound
  // state always matches access so reconcilePersonaGuild is a no-op).
  relay.roles = {
    getRoleFor: () => 'role',
    roleByGuildFor: () => ({}),
    bind: async () => 'role',
    unbind: async () => {},
  };

  const dispatched: Array<{ personaId: string; event: any }> = [];
  // Streams outlive live sessions: structural events go to stream-retained
  // personas (buffered for resume), so the fakes model both sets.
  const active = new Set<string>([ALICE, BOB]);
  const streams = new Set<string>([ALICE, BOB]);
  relay.gateway = {
    activePersonas: () => [...active],
    streamPersonas: () => [...streams],
    hasStream: (pid: string) => streams.has(pid),
    sessionsOf: (pid: string) => (active.has(pid) ? [{}] : []),
    personaSubscribed: () => false,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
  };

  // Baseline: both personas have received ready with CHAN_A's current caps.
  for (const pid of [ALICE, BOB]) {
    relay.rememberCaps(pid, CHAN_A, relay.capsFor(pid, CHAN_A, GUILD));
  }
  dispatched.length = 0;

  return {
    relay,
    dispatched,
    metas,
    active,
    streams,
    ofType: (type: string) => dispatched.filter((d) => d.event.type === type),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('new channel → channel_create with per-persona caps; no sibling caps spam', () => {
  const t = makeRelay();
  try {
    t.metas.push(meta(CHAN_B));
    t.relay.onBotChannelChange(meta(CHAN_B), 'create');

    const creates = t.ofType('channel_create');
    assert.equal(creates.length, 2, 'one channel_create per active persona');
    const byPersona = new Map(creates.map((d) => [d.personaId, d.event.channel]));
    assert.deepEqual(new Set(byPersona.get(ALICE).capabilities), new Set(RW));
    assert.deepEqual(new Set(byPersona.get(BOB).capabilities), new Set(RO));
    // CHAN_A's caps did not change — the guild-wide repush must be silent.
    assert.equal(t.ofType('capabilities_update').length, 0);
  } finally {
    t.cleanup();
  }
});

test('thread create/update map to thread_* events', () => {
  const t = makeRelay();
  try {
    const th = meta('thread-1', true);
    t.metas.push(th);
    t.relay.onBotChannelChange(th, 'create');
    assert.equal(t.ofType('thread_create').length, 2);
    t.dispatched.length = 0;
    t.relay.onBotChannelChange(th, 'update');
    assert.equal(t.ofType('thread_update').length, 2);
    assert.equal(t.ofType('channel_create').length, 0);
  } finally {
    t.cleanup();
  }
});

test('permission change → capabilities_update once; identical repush is deduped', () => {
  const t = makeRelay();
  try {
    // Grant changed relay-side (e.g. permissions.json hot-reload for alice).
    t.relay.permissions.setChannel(ALICE, GUILD, CHAN_A, ['VIEW_CHANNEL']);
    t.relay.onPermissionChange({ personaId: ALICE, scope: 'channel', guildId: GUILD, channelId: CHAN_A });

    let updates = t.ofType('capabilities_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].personaId, ALICE);
    // Channel-specific policy REPLACES the guild default (channel ?? guild ??
    // default), so alice's resolved caps narrow to exactly the new grant.
    assert.deepEqual(new Set(updates[0].event.capabilities), new Set(['VIEW_CHANNEL']));

    // Same state re-announced (e.g. a second reload) → nothing new on the wire.
    t.relay.onPermissionChange({ personaId: ALICE, scope: 'channel', guildId: GUILD, channelId: CHAN_A });
    updates = t.ofType('capabilities_update');
    assert.equal(updates.length, 1, 'dedup suppressed the identical repush');
  } finally {
    t.cleanup();
  }
});

test('permission change for a persona with NO retained stream dispatches nothing', () => {
  const t = makeRelay();
  try {
    t.active.delete(ALICE);
    t.streams.delete(ALICE);
    t.relay.permissions.setChannel(ALICE, GUILD, CHAN_A, ['VIEW_CHANNEL']);
    t.relay.onPermissionChange({ personaId: ALICE, scope: 'channel', guildId: GUILD, channelId: CHAN_A });
    assert.equal(t.dispatched.length, 0);
  } finally {
    t.cleanup();
  }
});

test('a briefly-dropped persona (stream retained, no live session) still gets structural events buffered', () => {
  const t = makeRelay();
  try {
    t.active.delete(ALICE); // dropped, will resume
    t.metas.push(meta(CHAN_B));
    t.relay.onBotChannelChange(meta(CHAN_B), 'create');

    const creates = t.ofType('channel_create');
    assert.deepEqual(new Set(creates.map((d) => d.personaId)), new Set([ALICE, BOB]),
      'dispatch targets stream-retained personas, not just live ones');
  } finally {
    t.cleanup();
  }
});

test('channel delete → channel_delete, and the dedup baseline forgets it', () => {
  const t = makeRelay();
  try {
    t.metas.length = 0; // Discord already removed it from the cache
    t.relay.onBotChannelDelete(CHAN_A, GUILD);

    const deletes = t.ofType('channel_delete');
    assert.equal(deletes.length, 2, 'one channel_delete per active persona');
    assert.equal(deletes[0].event.channelId, CHAN_A);

    // The baseline was forgotten: a re-push for the same caps dispatches again
    // (a re-created channel must be announced, not swallowed by stale dedup).
    t.dispatched.length = 0;
    t.relay.pushCaps(ALICE, CHAN_A, GUILD);
    assert.equal(t.ofType('capabilities_update').length, 1);
  } finally {
    t.cleanup();
  }
});
