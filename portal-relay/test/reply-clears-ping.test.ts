import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const CHANNEL = 'chan-1';
const READ_ONLY = 'chan-ro';
const ALICE = 'alice';
const TWIN = 'twin';
const WEBHOOK = 'wh-1';
const FULL = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'];
const ROLES: Record<string, string> = { 'role-alice': ALICE, 'role-twin': TWIN };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-reply-ping-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  const readStatePath = join(dir, 'read-state.json');
  writeFileSync(
    identityPath,
    JSON.stringify({
      personas: [
        { id: ALICE, displayName: 'Alice', avatar: '', token: 'ta' },
        { id: TWIN, displayName: 'Twin', avatar: '', token: 'tt' },
      ],
    }),
  );
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      personas: {
        [ALICE]: {
          default: [],
          guilds: { [GUILD]: { default: [], channels: { [CHANNEL]: FULL, [READ_ONLY]: ['VIEW_CHANNEL', 'READ_HISTORY'] } } },
        },
        [TWIN]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHANNEL]: FULL } } } },
      },
    }),
  );
  return { dir, identityPath, permissionsPath, readStatePath, relays: [] as Array<{ readState: { flush(): void } }> };
}

function teardown(paths: ReturnType<typeof setup>) {
  for (const relay of paths.relays) relay.readState.flush();
  rmSync(paths.dir, { recursive: true, force: true });
}

function makeRelay(paths: ReturnType<typeof setup>, opts: { replyLink?: boolean } = {}) {
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: paths.identityPath, permissionsPath: paths.permissionsPath,
    readStatePath: paths.readStatePath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: opts.replyLink ?? false,
  };
  const relay = new Relay(config) as any;
  paths.relays.push(relay);
  const metas: Record<string, { id: string; isThread: boolean; guildId: string }> = {
    [CHANNEL]: { id: CHANNEL, isThread: false, guildId: GUILD },
    [READ_ONLY]: { id: READ_ONLY, isThread: false, guildId: GUILD },
  };
  relay.bot = {
    getChannelMeta: async (id: string) => metas[id] ?? null,
    resolveTarget: async (id: string) => (metas[id] ? { parentChannelId: id } : null),
    channelForPerms: () => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    channelMetaFromCache: (id: string) => metas[id] ?? null,
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 1 }],
    isGuildAllowed: () => true,
    ownsWebhook: (id: string) => id === WEBHOOK,
    resolveOutgoingMentions: (_g: string | null, content: string) => content,
  };
  relay.roles = { resolveRole: (_g: string, roleId: string) => ROLES[roleId] };
  const sent: { content: string }[] = [];
  relay.webhooks = {
    send: async (_channelId: string, _personaId: string, o: { content: string }) => {
      sent.push(o);
      return { messageId: `dm-sent-${sent.length}`, webhookId: WEBHOOK };
    },
  };
  const rpc = (method: string, params: unknown, personaId = ALICE) =>
    relay.dispatchRpc({ personaId, send: () => {} }, method, params);
  return { relay, rpc, sent };
}

let clock = Date.now() - 600_000;
function arrive(relay: any, discordId: string, channelId: string, roles: string[]): void {
  clock += 1000;
  relay.onDiscordMessage({
    id: discordId, content: `hi ${discordId}`, cleanContent: `hi ${discordId}`,
    authorId: 'u1', authorName: 'someone', authorDisplayName: 'someone',
    isBot: false, webhookId: undefined,
    channelId, parentChannelId: channelId, threadId: undefined,
    guildId: GUILD, channelName: 'chan',
    mentionUserIds: [], mentionRoleIds: roles, mentionsEveryone: false,
    replyToId: undefined, replyToUserId: null,
    attachments: [], reactions: [], timestamp: new Date(clock),
  });
}

async function pendingIds(rpc: (m: string, p: unknown, who?: string) => Promise<any>, who = ALICE): Promise<string[]> {
  const { pings } = await rpc('get_pending_pings', {}, who);
  return pings.map((p: { message: { id: string } }) => p.message.id);
}

test('a reply clears the ping it answers, and only that one; the channel stays unread', async () => {
  const paths = setup();
  try {
    const { relay, rpc } = makeRelay(paths);
    arrive(relay, 'd0', CHANNEL, []);
    await rpc('mark_read', { channelId: CHANNEL, uptoCreatedAt: new Date(clock).toISOString() });
    arrive(relay, 'd1', CHANNEL, ['role-alice']);
    arrive(relay, 'd2', CHANNEL, ['role-alice']);
    const [first, second] = await pendingIds(rpc);
    const unreadBefore = await rpc('list_unread', {});
    const missedBefore = await rpc('channel_missed', { channelId: CHANNEL });
    assert.equal(missedBefore.since, new Date(clock - 2000).toISOString(), 'the channel has a read position before the reply');

    const result = await rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: first });

    assert.equal(result.pingCleared, true);
    assert.deepEqual(await pendingIds(rpc), [second]);
    assert.deepEqual(await rpc('list_unread', {}), unreadBefore);
    assert.deepEqual(await rpc('channel_missed', { channelId: CHANNEL }), missedBefore);
  } finally {
    teardown(paths);
  }
});

test('a reply to a message that is no pending ping of the sender changes nothing and says nothing', async () => {
  const paths = setup();
  try {
    const { relay, rpc } = makeRelay(paths);
    arrive(relay, 'd1', CHANNEL, ['role-alice']);
    arrive(relay, 'd2', CHANNEL, []);
    const before = await pendingIds(rpc);
    assert.equal(before.length, 1);
    const ambient = `rm_${CHANNEL}_d2`;

    const result = await rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: ambient });

    assert.equal('pingCleared' in result, false);
    assert.deepEqual(await pendingIds(rpc), before);
  } finally {
    teardown(paths);
  }
});

test('a refused or failed send leaves the ping pending', async () => {
  const paths = setup();
  try {
    const { relay, rpc } = makeRelay(paths);
    arrive(relay, 'd1', READ_ONLY, ['role-alice']);
    const [ping] = await pendingIds(rpc);
    await assert.rejects(rpc('send_message', { channelId: READ_ONLY, content: 'answer', replyToId: ping }));
    assert.deepEqual(await pendingIds(rpc), [ping]);

    arrive(relay, 'd2', CHANNEL, ['role-alice']);
    const pings = await pendingIds(rpc);
    assert.equal(pings.length, 2);
    let posts = 0;
    relay.webhooks = { send: async () => { posts++; throw new Error('Discord refused the webhook post'); } };
    await assert.rejects(
      rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: pings[1] }),
      /Discord refused the webhook post/,
    );
    assert.equal(posts, 1);
    assert.deepEqual(await pendingIds(rpc), pings);
  } finally {
    teardown(paths);
  }
});

test('the reply clears its ping with the quoted reply link on too', async () => {
  const paths = setup();
  try {
    const { relay, rpc, sent } = makeRelay(paths, { replyLink: true });
    arrive(relay, 'd1', CHANNEL, ['role-alice']);
    const [ping] = await pendingIds(rpc);

    const result = await rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: ping });

    assert.match(sent[0].content, /^> ↪ https:\/\/discord\.com\/channels\/g1\/chan-1\/d1\n/);
    assert.equal(result.pingCleared, true);
    assert.deepEqual(await pendingIds(rpc), []);
  } finally {
    teardown(paths);
  }
});

async function fileHolds(path: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  let last: unknown = 'no file yet';
  while (Date.now() < deadline) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      last = saved[ALICE]?.pings?.map((p: { message: { id: string } }) => p.message.id);
      if (JSON.stringify(last) === JSON.stringify(ids)) return;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`the read-state file never listed ${JSON.stringify(ids)}; last read ${JSON.stringify(last)}`);
}

test('a cleared ping is written to the read-state file, and stays cleared when the relay restarts', async () => {
  const paths = setup();
  try {
    const before = makeRelay(paths);
    arrive(before.relay, 'd1', CHANNEL, ['role-alice']);
    arrive(before.relay, 'd2', CHANNEL, ['role-alice']);
    const [first, second] = await pendingIds(before.rpc);
    await fileHolds(paths.readStatePath, [first, second]);
    await before.rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: first });
    await fileHolds(paths.readStatePath, [second]);

    const after = makeRelay(paths);
    assert.deepEqual(await pendingIds(after.rpc), [second]);
  } finally {
    teardown(paths);
  }
});

test("a reply clears the sender's ping and leaves another persona's ping for the same message", async () => {
  const paths = setup();
  try {
    const { relay, rpc } = makeRelay(paths);
    arrive(relay, 'd1', CHANNEL, ['role-alice', 'role-twin']);
    const [ping] = await pendingIds(rpc);
    assert.deepEqual(await pendingIds(rpc, TWIN), [ping]);

    await rpc('send_message', { channelId: CHANNEL, content: 'answer', replyToId: ping });

    assert.deepEqual(await pendingIds(rpc), []);
    assert.deepEqual(await pendingIds(rpc, TWIN), [ping]);
  } finally {
    teardown(paths);
  }
});
