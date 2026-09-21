import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalClient, type PortalCredentials } from '@animalabs/portal-client';
import type { PortalChannel } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';
import { IdentityManager, identityFeatureSets, type PortalSession } from '../src/identity.js';

const ROOT: PortalCredentials = { personaId: 'p_root', token: 'tok_root_SECRET' };

interface FakeSession extends PortalSession {
  closed: boolean;
}

/** A session whose connect() succeeds or fails on demand — no sockets. */
function fakeSession(creds: PortalCredentials, connect: () => Promise<unknown>): FakeSession {
  const client = new PortalClient({ url: 'ws://test', token: creds.token, personaId: creds.personaId });
  (client as unknown as { connect: () => Promise<unknown> }).connect = connect;
  const agent = new PortalAgent(client, { state: new AgentState(), hostOwnsChannelLifecycle: true });
  const session: FakeSession = {
    creds,
    client,
    agent,
    closed: false,
    close() {
      session.closed = true;
    },
  };
  return session;
}

function harness(opts: { connect?: (creds: PortalCredentials) => Promise<unknown>; invite?: string; max?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-identity-'));
  const sessions: FakeSession[] = [];
  const swaps: string[] = [];
  let minted = 0;
  const make = () =>
    new IdentityManager({
      url: 'ws://test',
      credsDir: dir,
      rosterPath: join(dir, 'root.identities.json'),
      invite: opts.invite,
      root: { name: 'Root', creds: ROOT, credsPath: null },
      maxIdentities: opts.max,
      connectTimeoutMs: 200,
      createSession: (creds) => {
        const s = fakeSession(creds, () => (opts.connect ? opts.connect(creds) : Promise.resolve({})));
        sessions.push(s);
        return s;
      },
      enroll: async ({ desiredName }) => ({ personaId: `p_${++minted}`, token: `tok_${desiredName}_SECRET` }),
    });
  const manager = make();
  const rootSession = fakeSession(ROOT, () => Promise.resolve({}));
  manager.bind(rootSession, async (next) => void swaps.push(next.creds.personaId));
  return { dir, manager, make, sessions, swaps, rootSession };
}

test('mint creates a 0600 creds file, switches by default, and never returns a token', async () => {
  const h = harness({ invite: 'inv' });
  const out = await h.manager.handleToolCall('mint_identity', { name: 'Night Shift' });
  assert.deepEqual(h.swaps, ['p_1']);
  assert.equal(h.rootSession.closed, true, 'old session retired after a successful switch');
  const credsPath = join(h.dir, 'night-shift.creds.json');
  assert.equal(statSync(credsPath).mode & 0o777, 0o600);
  const listed = await h.manager.handleToolCall('list_identities', {});
  for (const result of [out, listed]) assert.doesNotMatch(JSON.stringify(result), /SECRET|tok_/);
  assert.equal((listed as { active: string }).active, 'Night Shift');
  // The roster holds paths and ids — never tokens.
  assert.doesNotMatch(readFileSync(join(h.dir, 'root.identities.json'), 'utf8'), /SECRET|tok_/);
});

test('mint refuses to adopt a creds file it did not write', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'lena46.creds.json'), JSON.stringify({ personaId: 'p_lena', token: 'someone-elses' }));
  await assert.rejects(h.manager.handleToolCall('mint_identity', { name: 'Lena46' }), /already taken/);
  assert.deepEqual(h.swaps, []);
});

test('switching is limited to the roster', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'spawner.creds.json'), JSON.stringify({ personaId: 'p_spawner', token: 'x' }));
  await assert.rejects(h.manager.handleToolCall('switch_identity', { name: 'spawner' }), /no identity "spawner"/);
  await assert.rejects(h.manager.handleToolCall('switch_identity', { name: 'p_spawner' }), /no identity/);
});

test('a failed connect leaves the old identity live and closes the attempt', async () => {
  let fail = false;
  const h = harness({ invite: 'inv', connect: () => (fail ? new Promise(() => {}) : Promise.resolve({})) });
  await h.manager.handleToolCall('mint_identity', { name: 'Alt', switch: false });
  assert.deepEqual(h.swaps, []);
  fail = true;
  await assert.rejects(h.manager.handleToolCall('switch_identity', { name: 'alt' }), /could not connect.*still Root/);
  assert.deepEqual(h.swaps, []);
  assert.equal(h.rootSession.closed, false);
  assert.equal(h.sessions.at(-1)!.closed, true, 'the abandoned session must stop reconnecting');
  assert.equal(h.manager.session, h.rootSession);
});

test('no invite → mint fails cleanly; limit is enforced', async () => {
  await assert.rejects(harness().manager.handleToolCall('mint_identity', { name: 'A' }), /no invite available/);
  const h = harness({ invite: 'inv', max: 2 });
  await h.manager.handleToolCall('mint_identity', { name: 'A', switch: false });
  await assert.rejects(h.manager.handleToolCall('mint_identity', { name: 'B', switch: false }), /identity limit/);
  await assert.rejects(h.manager.handleToolCall('mint_identity', { name: 'a' }), /already have an identity/);
});

test('the active identity survives a restart; a broken entry falls back to root', async () => {
  const h = harness({ invite: 'inv' });
  await h.manager.handleToolCall('mint_identity', { name: 'Alt' });
  assert.equal(h.make().startupCreds().personaId, 'p_1');
  // Switch back to root by persona id, then restart.
  await h.manager.handleToolCall('switch_identity', { name: 'p_root' });
  assert.equal(h.make().startupCreds().personaId, 'p_root');
  // Creds replaced underneath us → not the identity we minted → root.
  await h.manager.handleToolCall('switch_identity', { name: 'Alt' });
  writeFileSync(join(h.dir, 'alt.creds.json'), JSON.stringify({ personaId: 'p_other', token: 'x' }));
  assert.equal(h.make().startupCreds().personaId, 'p_root');
  assert.ok(existsSync(join(h.dir, 'root.identities.json')));
});

// ── Server side ──

const chan = (id: string, name: string): PortalChannel => ({
  id,
  guildId: 'g1',
  name,
  type: 'text',
  capabilities: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
});

function readyClient(personaId: string, channels: PortalChannel[]): PortalClient {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId });
  client.cache.hydrate({
    sessionId: `s_${personaId}`,
    persona: { id: personaId, displayName: personaId, avatarUrl: 'https://example.test/a.png' },
    guilds: [{ id: 'g1', name: 'Guild' }],
    channels,
    seq: 0,
  });
  return client;
}

test('swapSession retracts unseen channels, reopens shared ones, and detaches the old client', async () => {
  const shared = chan('100', 'shared');
  const oldOnly = chan('200', 'old-only');
  const newOnly = chan('300', 'new-only');
  const oldClient = readyClient('p_old', [shared, oldOnly]);
  const newClient = readyClient('p_new', [shared, newOnly]);
  const subscribed: string[] = [];
  (newClient as unknown as { subscribe: (id: string) => Promise<unknown> }).subscribe = async (id) => {
    subscribed.push(id);
    return {};
  };
  (newClient as unknown as { call: () => Promise<unknown> }).call = async () => ({ pings: [] });

  const identity = { handleToolCall: async () => ({}) };
  const server = new PortalMcplServer(
    oldClient,
    new PortalAgent(oldClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }),
    { identity },
  );
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const internal = server as unknown as {
    conn: unknown;
    mcplEnabled: boolean;
    policy: { applyRequest(p: unknown): unknown };
    advertised: Map<string, string>;
    openChannels: Set<string>;
    initialRegistrationComplete: boolean;
    wireClient(): void;
    availableTools(): Array<{ name: string }>;
  };
  internal.conn = {
    sendRequest: async () => ({}),
    sendNotification: (method: string, params: Record<string, unknown>) => void notifications.push({ method, params }),
  };
  internal.mcplEnabled = true;
  internal.policy.applyRequest({
    effectiveCapabilities: [
      ...new Set(Object.values({ ...featureSets, ...identityFeatureSets }).flatMap((s) => s.uses as string[])),
    ],
  });
  internal.wireClient();
  internal.advertised.set('portal:100', 'stale-key');
  internal.advertised.set('portal:200', 'k');
  internal.initialRegistrationComplete = true;
  internal.openChannels.add('100').add('200');

  assert.ok(internal.availableTools().some((t) => t.name === 'switch_identity'));

  await server.swapSession(
    newClient,
    new PortalAgent(newClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }),
  );
  await new Promise((r) => setImmediate(r));

  const removed = notifications.flatMap((n) => (n.params.removed as string[] | undefined) ?? []);
  const added = notifications.flatMap((n) => ((n.params.added as Array<{ id: string }> | undefined) ?? []).map((d) => d.id));
  assert.deepEqual(removed, ['portal:200']);
  assert.deepEqual(added, ['portal:300']);
  assert.deepEqual(subscribed, ['100']);
  assert.deepEqual([...internal.openChannels], ['100']);

  // The outgoing client must no longer drive this server.
  const before = notifications.length;
  oldClient.emit('channelRemove', { channelId: '100', guildId: 'g1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(notifications.length, before);
});

test('identity tools are absent — and undeclared — unless a manager is attached', () => {
  const client = readyClient('p', []);
  const server = new PortalMcplServer(client, new PortalAgent(client, { hostOwnsChannelLifecycle: true }));
  const internal = server as unknown as {
    availableTools(): Array<{ name: string }>;
    declared: Record<string, unknown>;
  };
  assert.equal(internal.availableTools().some((t) => t.name === 'mint_identity'), false);
  assert.equal('portal.identity' in internal.declared, false);
});

// ── Claude Code channel binding ──

test('CC swapSession carries followed channels over where visible, and detaches the old client', async () => {
  const { PortalCcChannelServer } = await import('../src/server-cc.js');
  const shared = chan('100', 'shared');
  const oldOnly = chan('200', 'old-only');
  const oldClient = readyClient('p_old', [shared, oldOnly]);
  const newClient = readyClient('p_new', [shared]);
  const subscribed: string[] = [];
  (newClient as unknown as { subscribe: (id: string) => Promise<unknown> }).subscribe = async (id) => {
    subscribed.push(id);
    return {};
  };
  let pingFetches = 0;
  (newClient as unknown as { call: () => Promise<unknown> }).call = async () => {
    pingFetches++;
    return { pings: [] };
  };

  const oldState = new AgentState();
  oldState.subscribe('100');
  oldState.subscribe('200');
  const newState = new AgentState();
  const server = new PortalCcChannelServer(oldClient, new PortalAgent(oldClient, { state: oldState }), {
    identity: { handleToolCall: async () => ({ ok: 'identity' }) },
  });
  const sent: Array<{ id: unknown; result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> = [];
  const notifications: unknown[] = [];
  const internal = server as unknown as {
    conn: unknown;
    wireClient(): void;
    handleRequest(req: unknown): Promise<void>;
  };
  internal.conn = {
    sendResponse: (id: unknown, result: never) => void sent.push({ id, result }),
    sendNotification: (...args: unknown[]) => void notifications.push(args),
  };
  internal.wireClient();

  await internal.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(sent[0].result.tools!.some((t) => t.name === 'mint_identity'));
  await internal.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_identities' } });
  assert.match(sent[1].result.content![0].text, /identity/);

  await server.swapSession(newClient, new PortalAgent(newClient, { state: newState }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(subscribed, ['100'], 'only channels the new identity can see are followed');
  assert.deepEqual(newState.subscriptionList(), ['100']);
  assert.equal(pingFetches, 1, 'catch-up runs for the new identity');

  // A ping on the OLD client must no longer wake this session.
  const before = notifications.length;
  oldClient.emit('message', {
    message: {
      id: 'm1', nativeId: 'm1', channelId: '100', guildId: 'g1',
      author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
      content: 'hi', cleanContent: 'hi', attachments: [],
      mentions: { personas: [], roles: [], users: [], everyone: false },
      reactions: [], createdAt: '2026-01-01T00:00:00Z',
    },
    addressedToMe: true,
    reasons: ['mention'],
  } as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(notifications.length, before);
});

test('CC binding exposes no identity tools unless a manager is attached', async () => {
  const { PortalCcChannelServer } = await import('../src/server-cc.js');
  const client = readyClient('p', []);
  const server = new PortalCcChannelServer(client, new PortalAgent(client, {}));
  const sent: Array<{ tools: Array<{ name: string }> }> = [];
  const internal = server as unknown as { conn: unknown; handleRequest(req: unknown): Promise<void> };
  internal.conn = { sendResponse: (_id: unknown, result: never) => void sent.push(result) };
  await internal.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(sent[0].tools.some((t) => t.name === 'switch_identity'), false);
});

test('identity switching is on by default and off only on an explicit 0/false/no/off', async () => {
  const { identitySwitchingEnabled } = await import('../src/identity.js');
  assert.equal(identitySwitchingEnabled({}), true);
  assert.equal(identitySwitchingEnabled({ PORTAL_IDENTITY_SWITCHING: '1' }), true);
  for (const v of ['0', 'false', 'NO', 'off', ' off ']) {
    assert.equal(identitySwitchingEnabled({ PORTAL_IDENTITY_SWITCHING: v }), false, v);
  }
});
