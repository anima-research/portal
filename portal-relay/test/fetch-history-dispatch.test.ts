// The fetch_history RPC end to end through Relay.dispatchRpc (#98, review
// R1-3): cursor decoding in both forms (a returned relay id and a raw
// Discord snowflake), the `direction: 'forward'` gate and its
// `forward: true` echo, and the HistoryCache keying the walk direction so
// the two contracts never serve each other's pages. The earlier paging
// tests pin DiscordBot.fetchHistory itself; this file pins what a CLIENT
// actually reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';
import type { IncomingMessage } from '../src/discord-bot.js';

const G1 = 'guild-1';
const CHAN = 'chan-open';
const ALICE = 'alice';
const RW = ['VIEW_CHANNEL', 'READ_HISTORY'];

// Real-width snowflakes (19 digits), one second apart.
const snow = (n: number) => String(1_000_000_000_000_000_000n + BigInt(n) * (1n << 22n));
const inc = (n: number): IncomingMessage => ({
  id: snow(n), content: `m${n}`, cleanContent: `m${n}`,
  authorId: 'u1', authorName: 'bob', authorDisplayName: 'Bob', isBot: false,
  channelId: CHAN, parentChannelId: CHAN, guildId: G1, channelName: 'open',
  mentionUserIds: [], mentionRoleIds: [], mentionsEveryone: false,
  attachments: [], reactions: [], timestamp: new Date(1_700_000_000_000 + n * 1000),
});

function makeRelay(opts: { cacheTtlMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-98-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: [
    { id: ALICE, displayName: 'Alice', avatar: '', token: 'tok-a' },
  ] }));
  writeFileSync(permissionsPath, JSON.stringify({ personas: {
    [ALICE]: { default: [], guilds: { [G1]: { default: [], channels: { [CHAN]: RW } } } },
  } }));

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [G1],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: opts.cacheTtlMs ?? 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // 40 messages, ascending. The fake bot serves the documented pages and
  // records each call's forward flag so the tests can see what the dispatch
  // asked for (and how often, for the cache cases).
  const history = Array.from({ length: 40 }, (_, i) => inc(i + 1));
  const botCalls: Array<{ limit: number; before?: string; after?: string; forward?: boolean }> = [];
  const chanMeta = { id: CHAN, name: 'open', type: 'text', guildId: G1, isThread: false };
  relay.bot = {
    channelForPerms: () => ({ guildId: G1, permissionsFor: () => ({ has: () => true }) }),
    meIn: () => ({}),
    isGuildAllowed: (g: string) => g === G1,
    channelMetaFromCache: (id: string) => (id === CHAN ? chanMeta : null),
    getChannelMeta: async (id: string) => (id === CHAN ? chanMeta : null),
    resolveTarget: async (id: string) => (id === CHAN ? { parentChannelId: CHAN } : null),
    fetchHistory: async (_chan: string, limit: number, before?: string, after?: string, forward?: boolean) => {
      botCalls.push({ limit, before, after, forward });
      let pool = history;
      if (before) pool = pool.filter((m) => BigInt(m.id) < BigInt(before));
      if (after) pool = pool.filter((m) => BigInt(m.id) > BigInt(after));
      const slice = forward && after && !before ? pool.slice(0, limit) : pool.slice(-limit);
      return [...slice].reverse(); // newest-first, like the real bot
    },
  };

  const session = { id: 'sess-a', personaId: ALICE, subscriptions: new Set<string>() } as unknown as Session;
  const rpc = (method: string, params: unknown) => relay.dispatchRpc(session, method, params);
  return { relay, rpc, botCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const contents = (r: { messages: Array<{ content: string }> }) => r.messages.map((m) => m.content);

test('after-only with direction: forward serves the oldest page above the cursor and echoes forward', async () => {
  const h = makeRelay();
  try {
    const got = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 5, direction: 'forward' });
    assert.deepEqual(contents(got), ['m15', 'm14', 'm13', 'm12', 'm11'], 'oldest five above the cursor, newest-first');
    assert.equal(got.forward, true, 'the walk is echoed');
    assert.equal(h.botCalls[0]?.forward, true, 'the bot was asked for the forward walk');
  } finally { h.cleanup(); }
});

test('after-only WITHOUT direction keeps the pre-v6 page (newest above the cursor) and does not echo', async () => {
  const h = makeRelay();
  try {
    const got = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 5 });
    assert.deepEqual(contents(got), ['m40', 'm39', 'm38', 'm37', 'm36'], 'newest five above the cursor');
    assert.equal('forward' in got, false, 'no echo on the default contract');
    assert.equal(h.botCalls[0]?.forward, false, 'the bot was not asked for the forward walk');
  } finally { h.cleanup(); }
});

test('direction is ignored when before is present (the bounded window never echoes)', async () => {
  const h = makeRelay();
  try {
    const got = await h.rpc('fetch_history', {
      channelId: CHAN, before: snow(20), after: snow(10), limit: 5, direction: 'forward',
    });
    assert.deepEqual(contents(got), ['m19', 'm18', 'm17', 'm16', 'm15'], 'newest inside the window, from the top');
    assert.equal('forward' in got, false);
    assert.equal(h.botCalls[0]?.forward, false);
  } finally { h.cleanup(); }
});

test('direction with NO after serves the plain newest page and does not echo (the gate needs a cursor)', async () => {
  const h = makeRelay();
  try {
    const got = await h.rpc('fetch_history', { channelId: CHAN, limit: 5, direction: 'forward' });
    assert.deepEqual(contents(got), ['m40', 'm39', 'm38', 'm37', 'm36']);
    assert.equal('forward' in got, false, 'no echo without a cursor to walk from');
    assert.equal(h.botCalls[0]?.forward, false);
  } finally { h.cleanup(); }
});

test('direction with an undecodable after serves the bare newest page and does not echo', async () => {
  // cursorToSnowflake answers undefined for a cursor that is neither a known
  // relay id nor digits; the gate's !!after must then refuse the forward
  // walk rather than echo a walk it cannot anchor (second-read finding 1).
  const h = makeRelay();
  try {
    const got = await h.rpc('fetch_history', { channelId: CHAN, after: 'not-a-cursor', limit: 5, direction: 'forward' });
    assert.deepEqual(contents(got), ['m40', 'm39', 'm38', 'm37', 'm36']);
    assert.equal('forward' in got, false, 'no echo on an unanchored walk');
    assert.equal(h.botCalls[0]?.forward, false);
  } finally { h.cleanup(); }
});

test('a relay id handed back by one call decodes as the cursor of the next (both cursor forms)', async () => {
  const h = makeRelay();
  try {
    // First page by raw snowflake (the migrating-bot form)...
    const first = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 3, direction: 'forward' });
    assert.deepEqual(contents(first), ['m13', 'm12', 'm11']);
    // ...then continue the walk from the relay id of its newest message
    // (the id every client actually holds), exactly as pageWindow does.
    const cursor = first.messages[0].id as string;
    assert.ok(!/^\d+$/.test(cursor), `the relay id is not a bare snowflake (${cursor})`);
    const second = await h.rpc('fetch_history', { channelId: CHAN, after: cursor, limit: 3, direction: 'forward' });
    assert.deepEqual(contents(second), ['m16', 'm15', 'm14'], 'the walk continues where the first page ended');
    assert.equal(second.forward, true);
  } finally { h.cleanup(); }
});

test('the HistoryCache keys the direction: the two contracts never serve each other\'s pages', async () => {
  const h = makeRelay({ cacheTtlMs: 60_000 });
  try {
    const fwd1 = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 5, direction: 'forward' });
    const plain = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 5 });
    const fwd2 = await h.rpc('fetch_history', { channelId: CHAN, after: snow(10), limit: 5, direction: 'forward' });
    assert.deepEqual(contents(fwd1), ['m15', 'm14', 'm13', 'm12', 'm11']);
    assert.deepEqual(contents(plain), ['m40', 'm39', 'm38', 'm37', 'm36'], 'the cached forward page is NOT served to the default contract');
    assert.deepEqual(contents(fwd2), contents(fwd1));
    assert.equal(fwd2.forward, true, 'a cache hit still carries the echo');
    assert.equal(h.botCalls.length, 2, 'two distinct pages, three calls: the third was the cache');
  } finally { h.cleanup(); }
});
