import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';

const channel: PortalChannel = {
  id: '1526659685036331058',
  guildId: 'g1',
  name: 'portables',
  type: 'text',
  capabilities: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'ADD_REACTIONS'],
};

function message(id: string, createdAt: string): PortalMessage {
  return {
    id,
    nativeId: id,
    channelId: channel.id,
    guildId: channel.guildId,
    author: {
      kind: 'user',
      userId: 'u1',
      username: 'bob',
      displayName: 'Bob',
      bot: false,
    },
    content: `message ${id}`,
    cleanContent: `message ${id}`,
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt,
  };
}

function clientWithChannel(): PortalClient {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's1',
    persona: { id: 'p', displayName: 'Test', avatarUrl: 'https://example.test/a.png' },
    guilds: [{ id: 'g1', name: 'Guild' }],
    channels: [channel],
    seq: 0,
  });
  return client;
}

test('initial registration migrates legacy subscriptions and advertises capabilities', async () => {
  const client = clientWithChannel();
  const state = new AgentState();
  state.subscribe(channel.id);
  const agent = new PortalAgent(client, { state, hostOwnsChannelLifecycle: true });
  const server = new PortalMcplServer(client, agent);
  const requests: Array<{ method: string; params: unknown }> = [];
  const internal = server as unknown as {
    conn: {
      sendRequest(method: string, params: unknown): Promise<unknown>;
      sendNotification(method: string, params: unknown): void;
    };
    mcplEnabled: boolean;
    registerChannels(): Promise<void>;
  };
  internal.conn = {
    async sendRequest(method, params) {
      requests.push({ method, params });
      return { registered: [`portal:${channel.id}`] };
    },
    sendNotification() {},
  };
  internal.mcplEnabled = true;

  await internal.registerChannels();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'channels/register');
  const params = requests[0].params as {
    channels: Array<{
      id: string;
      initiallyOpen?: boolean;
      capabilities?: { history?: unknown; acknowledgment?: unknown };
    }>;
  };
  assert.equal(params.channels[0].id, `portal:${channel.id}`);
  assert.equal(params.channels[0].initiallyOpen, true);
  assert.ok(params.channels[0].capabilities?.history);
  assert.ok(params.channels[0].capabilities?.acknowledgment);
  assert.deepEqual(state.subscriptionList(), []);
});

test('open fetches requested backscroll then subscribes; close unsubscribes', async () => {
  const client = clientWithChannel();
  const calls: string[] = [];
  const older = message('m1', '2026-01-01T00:00:00Z');
  const newer = message('m2', '2026-01-01T00:01:00Z');
  client.fetchHistory = async (params) => {
    calls.push(`history:${params.before}:${params.limit}`);
    return { messages: [newer, older] };
  };
  client.subscribe = async (channelId) => {
    calls.push(`subscribe:${channelId}`);
    return {};
  };
  client.unsubscribe = async (channelId) => {
    calls.push(`unsubscribe:${channelId}`);
    return {};
  };
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { hostOwnsChannelLifecycle: true }),
  );
  const internal = server as unknown as {
    handleChannelOpen(params: {
      channelId: string;
      type: string;
      address: unknown;
      history: { limit: number; beforeMessageId: string };
    }): Promise<{ history?: Array<{ messageId: string }> }>;
    handleChannelClose(params: { channelId: string }): Promise<{ closed: boolean }>;
  };

  const opened = await internal.handleChannelOpen({
    channelId: `portal:${channel.id}`,
    type: 'portal',
    address: {},
    history: { limit: 20, beforeMessageId: 'anchor' },
  });
  assert.deepEqual(opened.history?.map((item) => item.messageId), ['m1', 'm2']);
  assert.deepEqual(calls, [`history:anchor:20`, `subscribe:${channel.id}`]);

  assert.deepEqual(
    await internal.handleChannelClose({ channelId: `portal:${channel.id}` }),
    { closed: true },
  );
  assert.equal(calls.at(-1), `unsubscribe:${channel.id}`);
});

test('acknowledgment posts a visible persona reaction', async () => {
  const client = clientWithChannel();
  const reactions: unknown[][] = [];
  client.react = async (...args) => {
    reactions.push(args);
    return {};
  };
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { hostOwnsChannelLifecycle: true }),
  );
  const internal = server as unknown as {
    handleChannelAcknowledge(params: {
      channelId: string;
      messageId: string;
      intent: string;
      value?: string;
    }): Promise<{ acknowledged: boolean; representation?: string }>;
  };

  assert.deepEqual(
    await internal.handleChannelAcknowledge({
      channelId: `portal:${channel.id}`,
      messageId: 'm1',
      intent: 'seen-not-opening',
      value: '✅',
    }),
    { acknowledged: true, representation: '✅' },
  );
  assert.deepEqual(reactions, [['m1', '✅', true, false]]);
});

test('host-owned agent hides legacy lifecycle tools and does not auto-subscribe on ping', () => {
  const client = clientWithChannel();
  let subscriptions = 0;
  client.subscribe = async () => {
    subscriptions++;
    return {};
  };
  const state = new AgentState();
  const agent = new PortalAgent(client, { state, hostOwnsChannelLifecycle: true });
  const names = new Set(agent.tools.map((tool) => tool.name));
  for (const retired of [
    'subscribe_channel',
    'unsubscribe_channel',
    'list_subscriptions',
    'set_reaction_visibility',
  ]) {
    assert.equal(names.has(retired), false);
  }

  client.emit('message', {
    message: message('m1', '2026-01-01T00:00:00Z'),
    addressedToMe: true,
    reasons: ['role_mention'],
  });
  assert.equal(subscriptions, 0);
  assert.equal(state.isSubscribed(channel.id), false);
  assert.equal(state.pendingPings().length, 1);
});

test('a ping in a closed channel carries its exact MCPL channel id', async () => {
  const client = clientWithChannel();
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { hostOwnsChannelLifecycle: true }),
  );
  const requests: Array<{ method: string; params: unknown }> = [];
  const internal = server as unknown as {
    conn: { sendRequest(method: string, params: unknown): Promise<unknown> };
    mcplEnabled: boolean;
    pushMessage(message: PortalMessage, addressed: boolean, reasons: ['role_mention']): void;
  };
  internal.conn = {
    async sendRequest(method, params) {
      requests.push({ method, params });
      return {};
    },
  };
  internal.mcplEnabled = true;

  internal.pushMessage(message('m1', '2026-01-01T00:00:00Z'), true, ['role_mention']);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(requests[0].method, 'push/event');
  const params = requests[0].params as {
    origin: { channelId?: string; mcplChannelId?: string; isExplicitMention?: boolean };
  };
  assert.equal(params.origin.channelId, `portal:${channel.id}`);
  assert.equal(params.origin.mcplChannelId, `portal:${channel.id}`);
  assert.equal(params.origin.isExplicitMention, true);
});

test('relay resume reasserts channels that the host still has open', async () => {
  const client = clientWithChannel();
  const restored: string[] = [];
  client.subscribe = async (channelId) => {
    restored.push(channelId);
    return {};
  };
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { hostOwnsChannelLifecycle: true }),
  );
  const internal = server as unknown as {
    openChannels: Set<string>;
    wireClient(): void;
  };
  internal.openChannels.add(channel.id);
  internal.wireClient();

  client.emit('resumed', 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(restored, [channel.id]);
});
