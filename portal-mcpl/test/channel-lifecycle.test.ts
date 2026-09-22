import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';

/**
 * Stand in for the host's §5.3 initial policy Request with a full grant.
 *
 * Every server→host channel and push path is capability-gated now (§5.4), so a
 * harness that skips this is exercising a server that has correctly refused to
 * do anything. `grant()` is what a conforming host does before any of it runs.
 */
function grant(server: PortalMcplServer, effectiveCapabilities?: string[]): void {
  const internal = server as unknown as {
    mcplEnabled: boolean;
    policy: { applyRequest(params: unknown): unknown };
  };
  internal.mcplEnabled = true;
  internal.policy.applyRequest({
    effectiveCapabilities:
      effectiveCapabilities ??
      [...new Set(Object.values(featureSets).flatMap((set) => set.uses as string[]))],
  });
}

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
  grant(server);

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
  grant(server);

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

// ── Live rights propagation (issue #5) ──

/** Harness with a captured conn + wired client events (post-initial-registration). */
async function registeredServer() {
  const client = clientWithChannel();
  const state = new AgentState();
  const agent = new PortalAgent(client, { state, hostOwnsChannelLifecycle: true });
  const server = new PortalMcplServer(client, agent);
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const internal = server as unknown as {
    conn: {
      sendRequest(method: string, params: unknown): Promise<unknown>;
      sendNotification(method: string, params: unknown): void;
    };
    mcplEnabled: boolean;
    openChannels: Set<string>;
    registerChannels(): Promise<void>;
    wireClient(): void;
  };
  internal.conn = {
    async sendRequest(method, params) {
      requests.push({ method, params });
      return { registered: [`portal:${channel.id}`] };
    },
    sendNotification(method, params) {
      notifications.push({ method, params });
    },
  };
  grant(server);
  internal.wireClient();
  await internal.registerChannels();
  requests.length = 0;
  return { client, state, server, internal, requests, notifications };
}

test('a live capability change re-advertises the channel as updated', async () => {
  const t = await registeredServer();

  // Relay pushed new caps; the client cache merged them and (in production)
  // channelChange re-triggers registration — call it directly here.
  t.client.cache.apply({
    type: 'capabilities_update',
    channelId: channel.id,
    capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'],
  });
  await t.internal.registerChannels();

  assert.equal(t.notifications.length, 1);
  assert.equal(t.notifications[0].method, 'channels/changed');
  const params = t.notifications[0].params as {
    added?: unknown[];
    updated?: Array<{ id: string; metadata: { capabilities: string[] } }>;
  };
  assert.equal(params.added, undefined, 'known channel must not re-add');
  assert.equal(params.updated?.length, 1);
  assert.equal(params.updated?.[0].id, `portal:${channel.id}`);
  assert.deepEqual(params.updated?.[0].metadata.capabilities, ['VIEW_CHANNEL', 'READ_HISTORY']);

  // Same state again → no further notification (content key caught up).
  await t.internal.registerChannels();
  assert.equal(t.notifications.length, 1);
});

test('an unchanged cache produces no channels/changed traffic', async () => {
  const t = await registeredServer();
  // Regression guard: initial registration retires the legacy subscription,
  // flipping initiallyOpen for the next enumeration. Open-state is excluded
  // from the descriptor content key, so this must NOT read as a change.
  await t.internal.registerChannels();
  await t.internal.registerChannels();
  assert.equal(t.notifications.length, 0);
  assert.equal(t.requests.length, 0);
});

test('channelRemove retracts an advertised channel and cleans local state', async () => {
  const t = await registeredServer();
  t.internal.openChannels.add(channel.id);

  (t.client as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'channel_delete',
    channelId: channel.id,
    guildId: channel.guildId,
  });

  assert.equal(t.notifications.length, 1);
  assert.equal(t.notifications[0].method, 'channels/changed');
  assert.deepEqual(t.notifications[0].params, { removed: [`portal:${channel.id}`] });
  assert.equal(t.internal.openChannels.has(channel.id), false);

  // Never-advertised channels retract nothing (event-driven only — a second
  // delete for the same id is a no-op, not a repeated notification).
  (t.client as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'channel_delete',
    channelId: channel.id,
    guildId: channel.guildId,
  });
  assert.equal(t.notifications.length, 1);
});

test('a channel arriving via live channel_create is announced as added', async () => {
  const t = await registeredServer();
  const fresh: PortalChannel = {
    id: '1526659685036331099',
    guildId: 'g1',
    name: 'freshly-granted',
    type: 'text',
    capabilities: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'],
  };

  (t.client as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'channel_create',
    channel: fresh,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(t.notifications.length, 1);
  const params = t.notifications[0].params as { added?: Array<{ id: string }>; updated?: unknown[] };
  assert.equal(params.added?.length, 1);
  assert.equal(params.added?.[0].id, `portal:${fresh.id}`);
  assert.equal(params.updated, undefined);
});

test('a removal landing during the in-flight initial register is retracted after the ack', async () => {
  const client = clientWithChannel();
  const state = new AgentState();
  const agent = new PortalAgent(client, { state, hostOwnsChannelLifecycle: true });
  const server = new PortalMcplServer(client, agent);
  const notifications: Array<{ method: string; params: unknown }> = [];
  let releaseRegister!: () => void;
  const registerGate = new Promise<void>((resolve) => (releaseRegister = resolve));
  const internal = server as unknown as {
    conn: {
      sendRequest(method: string, params: unknown): Promise<unknown>;
      sendNotification(method: string, params: unknown): void;
    };
    mcplEnabled: boolean;
    registerChannels(): Promise<void>;
    wireClient(): void;
  };
  internal.conn = {
    async sendRequest() {
      await registerGate; // hold channels/register in flight
      return { registered: [`portal:${channel.id}`] };
    },
    sendNotification(method, params) {
      notifications.push({ method, params });
    },
  };
  grant(server);
  internal.wireClient();

  const registration = internal.registerChannels();
  // The channel dies while the register request is still awaiting the host.
  (client as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'channel_delete',
    channelId: channel.id,
    guildId: channel.guildId,
  });
  assert.equal(notifications.length, 0, 'retraction must wait for the ack');

  releaseRegister();
  await registration;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, 'channels/changed');
  assert.deepEqual(notifications[0].params, { removed: [`portal:${channel.id}`] });
});
