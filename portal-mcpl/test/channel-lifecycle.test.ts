import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { PortalCcChannelServer } from '../src/server-cc.js';
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

function clientWithChannel(subscriptions?: string[]): PortalClient {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p', subscriptions });
  client.cache.hydrate({
    sessionId: 's1',
    persona: { id: 'p', displayName: 'Test', avatarUrl: 'https://example.test/a.png' },
    guilds: [{ id: 'g1', name: 'Guild' }],
    channels: [channel],
    seq: 0,
  });
  return client;
}

/**
 * Stub only the client's RPCs, so its own subscribe and unsubscribe logic runs
 * (the list, each failed call's undo, the newest call deciding), and the test
 * answers each call when it chooses.
 */
function heldCalls(client: PortalClient) {
  const calls: Array<{ method: string; channelId?: string; answer(ok: boolean): void }> = [];
  (client as unknown as { call(method: string, params: { channelId?: string }): Promise<unknown> }).call = (method, params) =>
    new Promise((resolve, reject) => {
      calls.push({
        method,
        channelId: params?.channelId,
        answer: (ok) => (ok ? resolve({}) : reject(new Error(`refused ${params?.channelId}`))),
      });
    });
  /** The nth (from 0) call of `method` on `channelId`. */
  const nth = (method: string, channelId: string, n = 0) =>
    calls.filter((c) => c.method === method && c.channelId === channelId)[n];
  return { calls, nth };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  // The relay's answers, under the real subscribe and unsubscribe, so the
  // client's list moves as it does in use: the open stands only while the
  // list holds the channel.
  (client as unknown as { call(method: string, params: { channelId?: string }): Promise<unknown> }).call = async (
    method,
    params,
  ) => {
    calls.push(`${method.replace(/_channel$/, '')}:${params?.channelId}`);
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

test("a relay resume doesn't make the server subscribe its open channels again: the client restores its own", async () => {
  // The client asks the relay for its list again on a resume (portal-client's
  // restoreSubscriptions), and a host-open channel is in it. A server that
  // subscribed its open channels too would put back one whose close was still
  // waiting on its unsubscribe (portal #50).
  const client = clientWithChannel();
  const subscribed: string[] = [];
  client.subscribe = async (channelId) => {
    subscribed.push(channelId);
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

  assert.deepEqual(subscribed, []);
});

type WsFactory = NonNullable<ConstructorParameters<typeof PortalClient>[0]['wsFactory']>;

/**
 * One socket of a relay stand-in for the real PortalClient. Like the gateway,
 * it keeps a subscription set per socket: identify fills it from the frame's
 * list, and a resumed session starts with it empty. It answers the frames it
 * has received in the order they came, and only when the test calls
 * `answer()`, so a test can put a call on the wire between `resume` and
 * `resumed`.
 */
class RelaySocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly subscriptions = new Set<string>();
  readonly inbox: Array<{ op: string; d: Record<string, unknown> }> = [];

  send(data: string): void {
    this.inbox.push(JSON.parse(data));
  }

  close(): void {
    this.drop(1000);
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code);
  }

  deliver(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }

  /** Answer every frame received so far, and those the answers make the client send. */
  answer(ready: unknown): void {
    while (this.inbox.length > 0) {
      const frame = this.inbox.shift()!;
      if (frame.op === 'identify') {
        for (const id of (frame.d.subscriptions as string[] | undefined) ?? []) this.subscriptions.add(id);
        this.deliver({ op: 'ready', d: ready });
      } else if (frame.op === 'resume') {
        this.deliver({ op: 'resumed', d: { replayedEvents: 0 } });
      } else if (frame.op === 'rpc') {
        const { id, method, params } = frame.d as { id: string; method: string; params: { channelId: string } };
        if (method === 'subscribe_channel') this.subscriptions.add(params.channelId);
        if (method === 'unsubscribe_channel') this.subscriptions.delete(params.channelId);
        this.deliver({ op: 'rpc_result', d: { id, ok: true, result: {} } });
      }
    }
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2000) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('with the real client, a close made between its resume and the relay\'s resumed leaves the channel unsubscribed', async () => {
  // A close made after the client sends `resume`, and before `resumed`
  // arrives, reaches the relay after the resume by either route: a client
  // that sends at once puts it on the wire behind the resume, and one that
  // holds calls until its session is ready flushes it just before it emits
  // `resumed`. Either way the relay sends `resumed` and then applies the
  // unsubscribe, so a resume that subscribed every open channel would put the
  // closing channel back on the relay after it.
  const sockets: RelaySocket[] = [];
  const factory = (() => {
    const socket = new RelaySocket();
    sockets.push(socket);
    setImmediate(() => socket.deliver({ op: 'hello', d: { heartbeatIntervalMs: 60_000 } }));
    return socket;
  }) as unknown as WsFactory;
  const ready = {
    sessionId: 's1',
    persona: { id: 'p', displayName: 'Test', avatarUrl: 'https://example.test/a.png' },
    guilds: [{ id: 'g1', name: 'Guild' }],
    channels: [channel],
    seq: 0,
  };
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p', maxBackoffMs: 20, wsFactory: factory });
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { hostOwnsChannelLifecycle: true }),
  );
  const internal = server as unknown as {
    openChannels: Set<string>;
    wireClient(): void;
    handleChannelOpen(params: { channelId: string; type: string; address: unknown }): Promise<unknown>;
    handleChannelClose(params: { channelId: string }): Promise<{ closed: boolean }>;
  };
  const listed = () => (client as unknown as { opts: { subscriptions?: string[] } }).opts.subscriptions ?? [];
  internal.wireClient();

  try {
    const connected = client.connect();
    await until(() => sockets[0]?.inbox.some((frame) => frame.op === 'identify') === true, 'the client identifies');
    sockets[0].answer(ready);
    await connected;

    const opening = internal.handleChannelOpen({ channelId: `portal:${channel.id}`, type: 'portal', address: {} });
    await until(() => sockets[0].inbox.length > 0, 'the open subscribes');
    sockets[0].answer(ready);
    await opening;
    assert.equal(sockets[0].subscriptions.has(channel.id), true, 'the open subscribed the channel');

    sockets[0].drop();
    await until(() => sockets[1]?.inbox.some((frame) => frame.op === 'resume') === true, 'the client resumes');
    const closing = internal.handleChannelClose({ channelId: `portal:${channel.id}` });
    assert.equal(sockets[1].inbox[0]?.op, 'resume', 'the relay has the resume before anything the close sends');
    sockets[1].answer(ready);

    assert.deepEqual(await closing, { closed: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    sockets[1].answer(ready);
    assert.equal(sockets[1].subscriptions.has(channel.id), false, 'the relay holds no subscription for the closed channel');
    assert.equal(internal.openChannels.has(channel.id), false);
    assert.equal(listed().includes(channel.id), false, 'a later identify will not ask for the closed channel');
  } finally {
    client.close();
  }
});

test("a standalone agent doesn't subscribe its durable channels again on a resume: the client restores them", async () => {
  // The client is built with the durable list (session.ts) and restores it on
  // every reconnect, so the agent asks for nothing itself.
  const client = clientWithChannel();
  const subscribed: string[] = [];
  client.subscribe = async (channelId) => {
    subscribed.push(channelId);
    return {};
  };
  const state = new AgentState();
  state.subscribe(channel.id);
  new PortalAgent(client, { state });

  client.emit('resumed', 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(subscribed, []);
});

test("a standalone agent's auto-subscribe keeps the durable state as the client's list leaves the channel", async () => {
  const client = clientWithChannel();
  const { calls, nth } = heldCalls(client);
  const state = new AgentState();
  const agent = new PortalAgent(client, { state });
  const mention = (id: string) => client.emit('message', {
    message: message(id, '2026-01-01T00:00:00Z'),
    addressedToMe: true,
    reasons: ['role_mention'],
  });
  const subscribes = () => calls.filter((c) => c.method === 'subscribe_channel').length;

  // Refused: the client takes the channel back, so the state does, and the
  // next mention tries again.
  mention('m1');
  assert.deepEqual(state.subscriptionList(), [channel.id], 'followed at once');
  nth('subscribe_channel', channel.id, 0).answer(false);
  await settle();
  assert.deepEqual(state.subscriptionList(), [], "the failed subscribe isn't kept as durable");
  mention('m2');
  assert.equal(subscribes(), 2, 'the next mention subscribes again');

  // That one fails after a newer subscribe of the channel succeeded: the client
  // keeps the channel for the newer call, and so does the state.
  const tool = agent.handleToolCall('subscribe_channel', { channelId: channel.id });
  nth('subscribe_channel', channel.id, 2).answer(true);
  await tool;
  nth('subscribe_channel', channel.id, 1).answer(false);
  await settle();
  assert.deepEqual(state.subscriptionList(), [channel.id]);
});

test("a standalone agent's subscription tools keep the durable state as the client's list leaves each channel", async () => {
  // The client is built with the state's list (session.ts). A failed
  // unsubscribe puts its channel back, since its caller still holds it.
  const c = channel.id;
  const [a, d] = ['1526659685036331001', '1526659685036331004'];
  const client = clientWithChannel([c]);
  const { nth } = heldCalls(client);
  const state = new AgentState();
  state.subscribe(c);
  const agent = new PortalAgent(client, { state });

  // The state changes as each call starts, and stays as a call that succeeds
  // left it.
  const subscribing = agent.handleToolCall('subscribe_channel', { channelId: a });
  assert.deepEqual(state.subscriptionList().sort(), [a, c].sort(), 'followed before the answer');
  nth('subscribe_channel', a).answer(true);
  await subscribing;
  const unsubscribing = agent.handleToolCall('unsubscribe_channel', { channelId: a });
  assert.deepEqual(state.subscriptionList(), [c], 'dropped before the answer');
  nth('unsubscribe_channel', a).answer(true);
  await unsubscribing;

  // Refused: the client takes the subscribe back, and so does the state.
  const refused = agent.handleToolCall('subscribe_channel', { channelId: d });
  nth('subscribe_channel', d, 0).answer(false);
  await assert.rejects(refused, /refused/);
  assert.deepEqual(state.subscriptionList(), [c]);

  // Failed: the client puts the channel back, and so does the state.
  const failing = agent.handleToolCall('unsubscribe_channel', { channelId: c });
  nth('unsubscribe_channel', c, 0).answer(false);
  await assert.rejects(failing, /refused/);
  assert.deepEqual(state.subscriptionList(), [c]);

  // An older call that fails after a newer one on its channel succeeded: the
  // client leaves the channel as the newer call left it, and so does the state.
  const olderSubscribe = agent.handleToolCall('subscribe_channel', { channelId: d });
  const newerSubscribe = agent.handleToolCall('subscribe_channel', { channelId: d });
  nth('subscribe_channel', d, 2).answer(true);
  await newerSubscribe;
  nth('subscribe_channel', d, 1).answer(false);
  await assert.rejects(olderSubscribe, /refused/);
  assert.deepEqual(state.subscriptionList().sort(), [c, d].sort(), 'kept for the newer subscribe');

  const olderUnsubscribe = agent.handleToolCall('unsubscribe_channel', { channelId: c });
  const newerUnsubscribe = agent.handleToolCall('unsubscribe_channel', { channelId: c });
  nth('unsubscribe_channel', c, 2).answer(true);
  await newerUnsubscribe;
  nth('unsubscribe_channel', c, 1).answer(false);
  await assert.rejects(olderUnsubscribe, /refused/);
  assert.deepEqual(state.subscriptionList(), [d], 'left out for the newer unsubscribe');
});

// ── Live rights propagation (issue #5) ──

/** Harness with a captured conn + wired client events (post-initial-registration). */
async function registeredServer(subscriptions?: string[]) {
  const client = clientWithChannel(subscriptions);
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

test("channelRemove takes a removed channel out of the client's list for good", async () => {
  // A reconnect asks for every listed channel, so a removed one left listed
  // would be subscribed again if it came back into view.
  const remove = (t: Awaited<ReturnType<typeof registeredServer>>) =>
    (t.client as unknown as { onEvent(e: unknown): void }).onEvent({
      type: 'channel_delete',
      channelId: channel.id,
      guildId: channel.guildId,
    });

  // Listed, and its unsubscribe fails: the removal's unsubscribe stands
  // whatever the relay answers, so the channel isn't put back.
  {
    const t = await registeredServer([channel.id]);
    t.internal.openChannels.add(channel.id);
    const { nth } = heldCalls(t.client);
    remove(t);
    assert.deepEqual(t.notifications[0]?.params, { removed: [`portal:${channel.id}`] });
    assert.equal(t.client.isListed(channel.id), false);
    nth('unsubscribe_channel', channel.id, 0).answer(false);
    await settle();
    assert.equal(t.client.isListed(channel.id), false, 'not put back after the failure');
  }

  // A close still waiting when the removal lands, which then fails: the
  // removal's unsubscribe is the newest call, so nothing puts the channel back.
  {
    const t = await registeredServer([channel.id]);
    t.internal.openChannels.add(channel.id);
    const { nth } = heldCalls(t.client);
    const closing = t.client.unsubscribe(channel.id).catch(() => {});
    remove(t);
    nth('unsubscribe_channel', channel.id, 0).answer(false);
    await closing;
    nth('unsubscribe_channel', channel.id, 1).answer(true);
    await settle();
    assert.equal(t.client.isListed(channel.id), false);
  }

  // Never listed: the unsubscribe goes out all the same, and changes nothing.
  {
    const t = await registeredServer();
    const { calls } = heldCalls(t.client);
    remove(t);
    assert.deepEqual(calls.map((c) => [c.method, c.channelId]), [['unsubscribe_channel', channel.id]]);
    assert.equal(t.client.isListed(channel.id), false);
  }
});

/** A host connection the test scripts: the messages the server reads, in
 *  order, and the responses it sends. */
function scriptedHost() {
  const queue: unknown[] = [];
  let waiting: { resolve(m: unknown): void; reject(e: Error): void } | null = null;
  let closed = false;
  const responses: Array<{ id: unknown; result?: unknown; error?: unknown }> = [];
  const closedError = () => Object.assign(new Error('closed'), { name: 'ConnectionClosedError' });
  const conn = {
    get isClosed() { return closed; },
    nextMessage: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : closed
          ? Promise.reject(closedError())
          : new Promise((resolve, reject) => { waiting = { resolve, reject }; }),
    sendResponse: (id: unknown, result: unknown) => void responses.push({ id, result }),
    sendError: (id: unknown, code: unknown, message: unknown) => void responses.push({ id, error: { code, message } }),
    sendNotification: () => {},
    sendRequest: async () => ({}),
    close: () => { closed = true; },
  };
  const deliver = (message: unknown) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.resolve(message);
    } else queue.push(message);
  };
  return {
    conn,
    responses,
    request: (id: number, method: string, params: unknown) => deliver({ type: 'request', request: { jsonrpc: '2.0', id, method, params } }),
    notify: (method: string) => deliver({ type: 'notification', notification: { jsonrpc: '2.0', method, params: {} } }),
    end: () => {
      closed = true;
      if (waiting) waiting.reject(closedError());
    },
  };
}

test("serve() reads a host's next request only once the last one is answered, so its opens and closes never overlap", async () => {
  // The client's list holds every channel the host opened only because of
  // this: a close sent while an open waits would otherwise race it.
  const client = clientWithChannel();
  const server = new PortalMcplServer(client, new PortalAgent(client, { hostOwnsChannelLifecycle: true }));
  const { calls, nth } = heldCalls(client);
  const host = scriptedHost();
  const serving = server.serve(host.conn as unknown as Parameters<PortalMcplServer['serve']>[0]);
  host.request(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  host.notify('notifications/initialized');
  host.request(1, 'channels/open', { channelId: `portal:${channel.id}`, type: 'portal', address: {} });
  host.request(2, 'channels/close', { channelId: `portal:${channel.id}` });
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(calls.map((c) => c.method), ['subscribe_channel'], 'the close waits for the open');
  nth('subscribe_channel', channel.id, 0).answer(true);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(calls.map((c) => c.method), ['subscribe_channel', 'unsubscribe_channel']);
  nth('unsubscribe_channel', channel.id, 0).answer(true);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(host.responses.map((r) => [r.id, r.error === undefined]), [[0, true], [1, true], [2, true]]);
  host.end();
  await serving;
});

test('a removal that lands while an open waits for its subscribe leaves the channel neither open nor listed', async () => {
  // The relay's answer to the subscribe and the channel's removal can reach
  // the client in one read, so the removal runs before the open resumes.
  const t = await registeredServer();
  const { nth } = heldCalls(t.client);
  const open = (t.server as unknown as {
    handleChannelOpen(params: { channelId: string; type: string; address: unknown }): Promise<unknown>;
  }).handleChannelOpen({ channelId: `portal:${channel.id}`, type: 'portal', address: {} });
  await settle();
  const subscribing = nth('subscribe_channel', channel.id, 0);
  assert.ok(subscribing, "the open's subscribe went out");
  (t.client as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'channel_delete',
    channelId: channel.id,
    guildId: channel.guildId,
  });
  subscribing.answer(true);
  await assert.rejects(open, /Nothing was opened: portal:\S+ was removed from this persona's view while it was being opened/);
  assert.equal(t.internal.openChannels.has(channel.id), false, 'not open');
  assert.equal(t.client.isListed(channel.id), false, 'not listed');
  assert.deepEqual(t.notifications.at(-1)?.params, { removed: [`portal:${channel.id}`] }, 'the host was told');
});

test("an open whose subscribe fails leaves the channel closed and out of the client's list", async () => {
  // openChannels changes only once the call has succeeded.
  const t = await registeredServer();
  const { nth } = heldCalls(t.client);
  const open = (t.server as unknown as {
    handleChannelOpen(params: { channelId: string; type: string; address: unknown }): Promise<unknown>;
  }).handleChannelOpen({ channelId: `portal:${channel.id}`, type: 'portal', address: {} });
  await settle();
  const subscribing = nth('subscribe_channel', channel.id, 0);
  assert.ok(subscribing, "the open's subscribe went out");
  assert.equal(t.internal.openChannels.has(channel.id), false, 'not open while the subscribe waits');
  subscribing.answer(false);
  await assert.rejects(open, /refused/);
  assert.equal(t.internal.openChannels.has(channel.id), false, 'not open');
  assert.equal(t.client.isListed(channel.id), false, 'not listed');
});

test('a close whose unsubscribe fails leaves the channel open and listed, and subscribes it again', async () => {
  // The host still holds the channel open, as the failure tells it.
  const t = await registeredServer();
  const { nth } = heldCalls(t.client);
  const handlers = t.server as unknown as {
    handleChannelOpen(params: { channelId: string; type: string; address: unknown }): Promise<unknown>;
    handleChannelClose(params: { channelId: string }): Promise<unknown>;
  };
  const open = handlers.handleChannelOpen({ channelId: `portal:${channel.id}`, type: 'portal', address: {} });
  await settle();
  nth('subscribe_channel', channel.id, 0).answer(true);
  await open;
  const close = handlers.handleChannelClose({ channelId: `portal:${channel.id}` });
  await settle();
  assert.equal(t.internal.openChannels.has(channel.id), true, 'still open while the unsubscribe waits');
  nth('unsubscribe_channel', channel.id, 0).answer(false);
  await assert.rejects(close, /refused/);
  assert.equal(t.internal.openChannels.has(channel.id), true, 'still open');
  assert.equal(t.client.isListed(channel.id), true, 'listed again');
  assert.ok(nth('subscribe_channel', channel.id, 1), 'subscribed again on the relay');
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

test('a catch-up wake names the thread of each message in one, and says to pass it as threadId', async () => {
  const client = clientWithChannel();
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true });
  const inThread = { ...message('m1', '2026-01-01T00:00:00Z'), threadId: '1526659685036331999' };
  const inChannel = message('m2', '2026-01-01T00:01:00Z');
  (agent as unknown as { pendingPingsFromRelay(): Promise<unknown> }).pendingPingsFromRelay = async () => [
    { message: inThread, reasons: ['mention'], at: inThread.createdAt },
    { message: inChannel, reasons: ['mention'], at: inChannel.createdAt },
  ];

  // The MCPL server: one push/event carries the catch-up.
  const server = new PortalMcplServer(client, agent);
  const pushes: Array<{ method: string; params: unknown }> = [];
  const internal = server as unknown as {
    conn: { sendRequest(method: string, params: unknown): Promise<unknown>; sendNotification(): void };
    catchUp(): Promise<void>;
  };
  internal.conn = {
    async sendRequest(method, params) {
      pushes.push({ method, params });
      return {};
    },
    sendNotification() {},
  };
  grant(server);
  await internal.catchUp();
  assert.equal(pushes.length, 1);
  const text = (pushes[0].params as { payload: { content: Array<{ text: string }> } }).payload.content[0].text;
  const lines = text.split('\n');
  assert.ok(lines.some((l) => l.includes('message m1') && l.endsWith('[thread 1526659685036331999]')), text);
  assert.ok(lines.some((l) => l.includes('message m2') && !l.includes('[thread')), text);
  assert.ok(text.includes('send_message with the channel as channelId and the thread as threadId'), text);

  // The Claude Code server, through a wake sink: the same lines and hint.
  const wakes: Array<{ content: string }> = [];
  const cc = new PortalCcChannelServer(client, agent, {
    wakeSink: { kind: 'test', deliver: async (payload) => { wakes.push(payload); } },
  });
  (cc as unknown as { conn: unknown }).conn = { sendNotification() {} };
  await (cc as unknown as { catchUp(): Promise<void> }).catchUp();
  assert.equal(wakes.length, 1);
  const ccLines = wakes[0].content.split('\n');
  // The CC wake marks addressed lines with a trailing "⟵ addressed to you", so
  // the thread is named on the line rather than at its very end.
  assert.ok(ccLines.some((l) => l.includes('message m1') && l.includes('[thread 1526659685036331999]')), wakes[0].content);
  assert.ok(ccLines.some((l) => l.includes('message m2') && !l.includes('[thread')), wakes[0].content);
  assert.ok(wakes[0].content.includes('send_message with the channel as channelId and the thread as threadId'), wakes[0].content);
});

test("the voice_join tool lists its channel in the client, so a reconnect asks for its transcripts again", async () => {
  // The relay subscribes the session as it joins (issue #77), so the tool goes
  // through voiceJoin(), whose channel joins the list a reconnect restores.
  const client = clientWithChannel();
  const { nth } = heldCalls(client);
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true });

  const joining = agent.handleToolCall('voice_join', { channelId: channel.id });
  assert.equal(client.isListed(channel.id), true, 'listed while the join waits');
  nth('voice_join', channel.id).answer(true);
  await joining;
  assert.equal(client.isListed(channel.id), true);
});
