// Regressions for the thread-targeting facade (portal#17) and the
// echo-attribution race (portal#18).
//
// The protocol documents `threadId` on send_message and fetch_history, and
// promises PortalMessage.threadId "when the message lives in a thread" — but
// the relay never read the param: sends silently landed in the parent channel
// (which is why deliveries carried no threadId — the messages honestly weren't
// in threads), thread history was unreadable, and passing a thread id as
// channelId tripped SEND_IN_THREADS because capability rows live on the
// parent. Separately, the gateway echo of an owned webhook post could arrive
// before the send RPC recorded attribution, delivering the persona's own
// message as the per-channel webhook pseudo-user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const PARENT = 'chan-parent';
const THREAD = 'thread-under-parent';
const OTHER_CHANNEL = 'chan-other';
const PERSONA = 'alice';
const WEBHOOK = 'wh-1';
// Full send/read rights on PARENT only — threads must inherit from it.
const CAPS = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS'];

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-thread-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(
    identityPath,
    JSON.stringify({
      personas: [
        { id: PERSONA, displayName: 'Alice', avatar: '', token: 'tok' },
        { id: 'twin-1', displayName: 'Twin', avatar: '', token: 't1' },
        { id: 'twin-2', displayName: 'Twin', avatar: '', token: 't2' },
      ],
    }),
  );
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      personas: {
        [PERSONA]: { default: [], guilds: { [GUILD]: { default: [], channels: { [PARENT]: CAPS } } } },
      },
    }),
  );

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 60_000, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  const metas: Record<string, { id: string; parentId?: string; isThread: boolean; guildId: string }> = {
    [PARENT]: { id: PARENT, isThread: false, guildId: GUILD },
    [THREAD]: { id: THREAD, parentId: PARENT, isThread: true, guildId: GUILD },
    [OTHER_CHANNEL]: { id: OTHER_CHANNEL, isThread: false, guildId: GUILD },
  };

  const fetched: string[] = []; // container ids handed to bot.fetchHistory
  relay.bot = {
    getChannelMeta: async (id: string) => metas[id] ?? null,
    resolveTarget: async (id: string) => {
      const meta = metas[id];
      if (!meta) return null;
      return meta.isThread && meta.parentId
        ? { parentChannelId: meta.parentId, threadId: meta.id }
        : { parentChannelId: meta.id };
    },
    channelForPerms: (_id: string) => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 1 }],
    isGuildAllowed: () => true,
    ownsWebhook: (id: string) => id === WEBHOOK,
    resolveOutgoingMentions: (_g: string | null, content: string) => content,
    fetchHistory: async (containerId: string) => {
      fetched.push(containerId);
      return [incoming({ id: `m-${containerId}`, content: `history of ${containerId}` })];
    },
  };

  const sent: any[] = [];
  relay.webhooks = {
    send: async (channelId: string, personaId: string, opts: any) => {
      sent.push({ channelId, personaId, ...opts });
      return { messageId: `dm-${sent.length}`, webhookId: WEBHOOK };
    },
  };

  const rpc = (method: string, params: unknown, personaId = PERSONA) =>
    relay.dispatchRpc({ personaId, send: () => {} }, method, params);

  function incoming(over: Record<string, unknown> = {}) {
    return {
      id: 'dm-x', content: 'hi', cleanContent: 'hi',
      authorId: 'u1', authorName: 'someone', authorDisplayName: 'someone',
      isBot: false, webhookId: undefined,
      channelId: PARENT, parentChannelId: PARENT, threadId: undefined,
      guildId: GUILD, channelName: 'chan',
      mentionUserIds: [], mentionRoleIds: [], mentionsEveryone: false,
      replyToId: undefined, replyToUserId: null,
      attachments: [], reactions: [], timestamp: new Date(),
      ...over,
    };
  }

  return { relay, rpc, sent, fetched, incoming, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── send_message thread targeting ──

test('send_message {channelId, threadId} posts into the thread, not the parent', async () => {
  const { rpc, sent, cleanup } = makeRelay();
  try {
    await rpc('send_message', { channelId: PARENT, threadId: THREAD, content: 'to the thread' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, PARENT); // webhook lives on the parent
    assert.equal(sent[0].threadId, THREAD); // ...and posts into the thread
  } finally {
    cleanup();
  }
});

test('send_message with a threadId that is not a thread under channelId is NOT_FOUND, never a silent parent post', async () => {
  const { rpc, sent, cleanup } = makeRelay();
  try {
    await assert.rejects(
      rpc('send_message', { channelId: PARENT, threadId: OTHER_CHANNEL, content: 'nope' }),
      /channel not found/,
    );
    await assert.rejects(
      rpc('send_message', { channelId: OTHER_CHANNEL, threadId: THREAD, content: 'nope' }),
      /channel not found/,
    );
    assert.equal(sent.length, 0);
  } finally {
    cleanup();
  }
});

test('send_message with a bare thread id as channelId checks caps on the PARENT channel', async () => {
  const { rpc, sent, cleanup } = makeRelay();
  try {
    // Persona's grants live on PARENT only; pre-fix this refused with
    // SEND_IN_THREADS because caps were looked up on the thread id itself.
    await rpc('send_message', { channelId: THREAD, content: 'via bare thread id' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].threadId, THREAD);
  } finally {
    cleanup();
  }
});

// ── fetch_history thread targeting ──

test('fetch_history {channelId, threadId} reads the thread container, cached separately from the parent', async () => {
  const { rpc, fetched, cleanup } = makeRelay();
  try {
    const thread = await rpc('fetch_history', { channelId: PARENT, threadId: THREAD, limit: 5 });
    const parent = await rpc('fetch_history', { channelId: PARENT, limit: 5 });
    assert.deepEqual(fetched, [THREAD, PARENT]); // two distinct fetches — no shared cache slot
    assert.equal(thread.messages[0].content, `history of ${THREAD}`);
    assert.equal(parent.messages[0].content, `history of ${PARENT}`);
    // Same page again → served from cache, no third bot fetch.
    await rpc('fetch_history', { channelId: PARENT, threadId: THREAD, limit: 5 });
    assert.equal(fetched.length, 2);
  } finally {
    cleanup();
  }
});

test('fetch_history with a mismatched threadId is NOT_FOUND', async () => {
  const { rpc, cleanup } = makeRelay();
  try {
    await assert.rejects(
      rpc('fetch_history', { channelId: PARENT, threadId: OTHER_CHANNEL }),
      /channel not found/,
    );
  } finally {
    cleanup();
  }
});

// ── delivered messages carry threadId ──

test('a thread message delivers with parent channelId + threadId', async () => {
  const { relay, incoming, cleanup } = makeRelay();
  try {
    const inc = incoming({ channelId: THREAD, parentChannelId: PARENT, threadId: THREAD });
    const { message } = relay.buildPortalMessage(inc);
    assert.equal(message.channelId, PARENT);
    assert.equal(message.threadId, THREAD);
  } finally {
    cleanup();
  }
});

// ── echo attribution race (portal#18) ──

test('an owned-webhook echo with no recorded attribution resolves the persona by unique displayName', async () => {
  const { relay, incoming, cleanup } = makeRelay();
  try {
    // No prior store ref: the echo beat the send RPC's REST response.
    const inc = incoming({ id: 'dm-race', webhookId: WEBHOOK, authorName: 'Alice', isBot: true });
    const { message, authorPersonaId } = relay.buildPortalMessage(inc);
    assert.equal(message.author.kind, 'persona');
    assert.equal(message.author.personaId, PERSONA);
    assert.equal(authorPersonaId, PERSONA); // self-echo suppression sees the author too
    // Attribution is recorded, so the later send-path record() merges into it.
    assert.equal(relay.store.getByDiscordId('dm-race')?.personaId, PERSONA);
  } finally {
    cleanup();
  }
});

test('an ambiguous displayName falls back to the honest webhook-user shape', async () => {
  const { relay, incoming, cleanup } = makeRelay();
  try {
    const inc = incoming({ id: 'dm-twin', webhookId: WEBHOOK, authorName: 'Twin', isBot: true });
    const { message, authorPersonaId } = relay.buildPortalMessage(inc);
    assert.equal(message.author.kind, 'user');
    assert.equal(authorPersonaId, undefined);
    assert.equal(relay.store.getByDiscordId('dm-twin')?.personaId, undefined);
  } finally {
    cleanup();
  }
});

test('a foreign-webhook message is never attributed to a persona, whatever its name', async () => {
  const { relay, incoming, cleanup } = makeRelay();
  try {
    const inc = incoming({ id: 'dm-foreign', webhookId: 'wh-not-ours', authorName: 'Alice', isBot: true });
    const { message } = relay.buildPortalMessage(inc);
    assert.equal(message.author.kind, 'user');
  } finally {
    cleanup();
  }
});

test('echo recovery is age-gated: an OLD unattributed owned-webhook post stays webhook-shaped', async () => {
  const { relay, incoming, cleanup } = makeRelay();
  try {
    const old = incoming({
      id: 'dm-ancient', webhookId: WEBHOOK, authorName: 'Alice', isBot: true,
      timestamp: new Date(Date.now() - 60 * 60_000), // an hour old — history, not the race
    });
    const { message } = relay.buildPortalMessage(old);
    assert.equal(message.author.kind, 'user');
    assert.equal(relay.store.getByDiscordId('dm-ancient')?.personaId, undefined);
  } finally {
    cleanup();
  }
});
