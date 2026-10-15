import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
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

function harness(opts: { connect?: (creds: PortalCredentials) => Promise<unknown>; invite?: string; max?: number; onSwitch?: (next: PortalSession) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-identity-'));
  const sessions: FakeSession[] = [];
  const swaps: string[] = [];
  const enrolls: Array<{ desiredName: string; uniqueName?: boolean }> = [];
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
      enroll: async ({ desiredName, uniqueName }) => {
        enrolls.push({ desiredName, uniqueName });
        return { personaId: `p_${++minted}`, token: `tok_${desiredName}_SECRET` };
      },
    });
  const manager = make();
  const rootSession = fakeSession(ROOT, () => Promise.resolve({}));
  manager.bind(rootSession, async (next) => { if (opts.onSwitch) await opts.onSwitch(next); swaps.push(next.creds.personaId); });
  return { dir, manager, make, sessions, swaps, rootSession, enrolls };
}

test('mint creates a 0600 creds file, switches by default, and never returns a token', async () => {
  const h = harness({ invite: 'inv' });
  const out = await h.manager.handleToolCall('mint_persona', { name: 'Night Shift' });
  assert.deepEqual(h.swaps, ['p_1']);
  assert.equal(h.rootSession.closed, true, 'old session retired after a successful switch');
  const credsPath = join(h.dir, 'night-shift.creds.json');
  assert.equal(statSync(credsPath).mode & 0o777, 0o600);
  const listed = await h.manager.handleToolCall('list_personas', {});
  for (const result of [out, listed]) assert.doesNotMatch(JSON.stringify(result), /SECRET|tok_/);
  assert.equal((listed as { active: string }).active, 'Night Shift');
  // The roster holds paths and ids — never tokens.
  assert.doesNotMatch(readFileSync(join(h.dir, 'root.identities.json'), 'utf8'), /SECRET|tok_/);
});

test('a minted name must be unique on the relay (the model picked it)', async () => {
  const h = harness({ invite: 'inv' });
  await h.manager.handleToolCall('mint_persona', { name: 'Night Shift' });
  assert.deepEqual(h.enrolls, [{ desiredName: 'Night Shift', uniqueName: true }]);
});

test('mint refuses to adopt a creds file it did not write', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'lena46.creds.json'), JSON.stringify({ personaId: 'p_lena', token: 'someone-elses' }));
  await assert.rejects(h.manager.handleToolCall('mint_persona', { name: 'Lena46' }), /already exists on this host/);
  assert.deepEqual(h.swaps, []);
  assert.match(readFileSync(join(h.dir, 'lena46.creds.json'), 'utf8'), /someone-elses/, 'the existing file is untouched');
});

test('two processes minting names that slug alike: one wins, the other is refused, no token overwritten', async () => {
  const h = harness({ invite: 'inv' });
  const other = h.make(); // a second process sharing the credentials directory
  const results = await Promise.allSettled([
    h.manager.handleToolCall('mint_persona', { name: 'Écho', switch: false }),
    other.handleToolCall('mint_persona', { name: 'Cho', switch: false }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /already exists on this host/);
  assert.equal(h.enrolls.length, 1, 'the loser never enrolled a persona it could not keep');
  const saved = JSON.parse(readFileSync(join(h.dir, 'cho.creds.json'), 'utf8'));
  assert.equal(saved.personaId, 'p_1');
});

test('a failed enrollment releases the reserved creds file', async () => {
  const h = harness({ invite: 'inv' });
  const manager = new IdentityManager({
    url: 'ws://test', credsDir: h.dir, rosterPath: join(h.dir, 'other.identities.json'), invite: 'inv',
    root: { name: 'Root', creds: ROOT, credsPath: null },
    createSession: () => { throw new Error('unused'); },
    enroll: async () => { throw new Error('enroll rejected: name "Night" reads like a server member\'s name'); },
  });
  await assert.rejects(manager.handleToolCall('mint_persona', { name: 'Night', switch: false }), /reads like a server member/);
  assert.equal(existsSync(join(h.dir, 'night.creds.json')), false);
});

test('switching is limited to the roster', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'spawner.creds.json'), JSON.stringify({ personaId: 'p_spawner', token: 'x' }));
  await assert.rejects(h.manager.handleToolCall('switch_persona', { name: 'spawner' }), /no persona "spawner"/);
  await assert.rejects(h.manager.handleToolCall('switch_persona', { name: 'p_spawner' }), /no persona/);
});

test('a failed connect leaves the old identity live and closes the attempt', async () => {
  let fail = false;
  const h = harness({ invite: 'inv', connect: () => (fail ? new Promise(() => {}) : Promise.resolve({})) });
  await h.manager.handleToolCall('mint_persona', { name: 'Alt', switch: false });
  assert.deepEqual(h.swaps, []);
  fail = true;
  await assert.rejects(h.manager.handleToolCall('switch_persona', { name: 'alt' }), /could not connect.*still Root/);
  assert.deepEqual(h.swaps, []);
  assert.equal(h.rootSession.closed, false);
  assert.equal(h.sessions.at(-1)!.closed, true, 'the abandoned session must stop reconnecting');
  assert.equal(h.manager.session, h.rootSession);
});

test('the server refusing the swap leaves the old session live and the roster unchanged', async () => {
  let refuse = false;
  const h = harness({ invite: 'inv', onSwitch: async () => { if (refuse) throw new Error('host said no'); } });
  await h.manager.handleToolCall('mint_persona', { name: 'Alt', switch: false });
  refuse = true;
  await assert.rejects(h.manager.handleToolCall('switch_persona', { name: 'alt' }), /switch to "Alt" failed: host said no — still Root/);
  assert.equal(h.manager.session, h.rootSession, 'still serving the old session');
  assert.equal(h.rootSession.closed, false, 'old socket still open');
  assert.equal(h.sessions.at(-1)!.closed, true, 'the refused session was torn down');
  assert.equal(h.make().startupCreds().personaId, 'p_root', 'roster still names root as active');
  refuse = false;
  await h.manager.handleToolCall('switch_persona', { name: 'alt' });
  assert.equal(h.make().startupCreds().personaId, 'p_1');
});

test('no invite → mint fails cleanly; limit is enforced', async () => {
  await assert.rejects(harness().manager.handleToolCall('mint_persona', { name: 'A' }), /no invite available/);
  const h = harness({ invite: 'inv', max: 2 });
  await h.manager.handleToolCall('mint_persona', { name: 'A', switch: false });
  await assert.rejects(h.manager.handleToolCall('mint_persona', { name: 'B', switch: false }), /persona limit/);
  await assert.rejects(h.manager.handleToolCall('mint_persona', { name: 'a' }), /already have a persona/);
});

test('the active identity survives a restart; a broken entry falls back to root', async () => {
  const h = harness({ invite: 'inv' });
  await h.manager.handleToolCall('mint_persona', { name: 'Alt' });
  assert.equal(h.make().startupCreds().personaId, 'p_1');
  // Switch back to root by persona id, then restart.
  await h.manager.handleToolCall('switch_persona', { name: 'p_root' });
  assert.equal(h.make().startupCreds().personaId, 'p_root');
  // Creds replaced underneath us → not the identity we minted → root.
  await h.manager.handleToolCall('switch_persona', { name: 'Alt' });
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

test('swapSession drops every channel: retracts the old set, registers the new view closed, detaches the old client', async () => {
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

  assert.ok(internal.availableTools().some((t) => t.name === 'switch_persona'));

  await server.swapSession(
    newClient,
    new PortalAgent(newClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }),
  );
  await new Promise((r) => setImmediate(r));

  const removed = notifications.flatMap((n) => (n.params.removed as string[] | undefined) ?? []);
  const added = notifications.flatMap((n) => ((n.params.added as Array<{ id: string }> | undefined) ?? []).map((d) => d.id));
  // The old identity's whole set is retracted — the shared channel too — and
  // the new identity's view is offered fresh, so the host holds it closed.
  assert.deepEqual(removed.sort(), ['portal:100', 'portal:200']);
  assert.deepEqual(added.sort(), ['portal:100', 'portal:300']);
  const removedAt = notifications.findIndex((n) => n.params.removed);
  const addedAt = notifications.findIndex((n) => n.params.added);
  assert.ok(removedAt < addedAt, 'retraction goes out before the re-registration');
  assert.deepEqual(subscribed, [], 'nothing the old identity had open is reopened');
  assert.deepEqual([...internal.openChannels], []);

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
  assert.equal(internal.availableTools().some((t) => t.name === 'mint_persona'), false);
  assert.equal('portal.identity' in internal.declared, false);
});

// ── Claude Code channel binding ──

test('CC swapSession drops the old follows (the new identity keeps its own), and detaches the old client', async () => {
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
  newState.subscribe('300'); // the new identity's own follow (identify replays it)
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
  assert.ok(sent[0].result.tools!.some((t) => t.name === 'mint_persona'));
  await internal.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_personas' } });
  assert.match(sent[1].result.content![0].text, /identity/);

  await server.swapSession(newClient, new PortalAgent(newClient, { state: newState }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(subscribed, [], 'nothing the old identity followed is followed under the new one');
  assert.deepEqual(newState.subscriptionList(), ['300'], "the new identity's saved follows are untouched");
  assert.deepEqual(oldState.subscriptionList().sort(), ['100', '200'], "the old identity's follows stay its own");
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
  assert.equal(sent[0].tools.some((t) => t.name === 'switch_persona'), false);
});

test('identity switching is on by default and off only on an explicit 0/false/no/off', async () => {
  const { identitySwitchingEnabled } = await import('../src/identity.js');
  assert.equal(identitySwitchingEnabled({}), true);
  assert.equal(identitySwitchingEnabled({ PORTAL_IDENTITY_SWITCHING: '1' }), true);
  for (const v of ['0', 'false', 'NO', 'off', ' off ']) {
    assert.equal(identitySwitchingEnabled({ PORTAL_IDENTITY_SWITCHING: v }), false, v);
  }
});

test('the subscription seed is handed out once per process (a switch back to root does not re-follow)', async () => {
  const { seedOnce, buildSession } = await import('../src/session.js');
  const dir = mkdtempSync(join(tmpdir(), 'portal-seed-'));
  const next = seedOnce(['111', '222']);
  const first = buildSession(ROOT, { url: 'ws://test', stateDir: dir, seedSubscriptions: next() });
  assert.deepEqual(first.agent.state.subscriptionList().sort(), ['111', '222']);
  first.agent.state.unsubscribe('222'); // the persona leaves a seeded channel
  first.close?.();
  const again = buildSession(ROOT, { url: 'ws://test', stateDir: dir, seedSubscriptions: next() });
  assert.deepEqual(again.agent.state.subscriptionList(), ['111'], 'the unsubscribe holds across the rebuild');
  assert.equal(next(), undefined);
});

test('two processes sharing a roster both keep their minted identities', async () => {
  const h = harness({ invite: 'inv' });
  const other = h.make();
  await h.manager.handleToolCall('mint_persona', { name: 'Morning', switch: false });
  await other.handleToolCall('mint_persona', { name: 'Evening', switch: false });
  const names = (r: unknown) => (r as { personas: Array<{ name: string }> }).personas.map((i) => i.name).sort();
  // After a restart, both are there.
  assert.deepEqual(names(await h.make().handleToolCall('list_personas', {})), ['Evening', 'Morning', 'Root']);
  // And the first process can find the second's without restarting.
  const found = (h.manager as unknown as { find(n: string): unknown }).find('Evening');
  assert.ok(found, "the other process's identity is visible");
});

test("MCPL: a message still building (image download) when the identity switches is not pushed as the new persona's", async () => {
  const shared = chan('100', 'shared');
  const oldClient = readyClient('p_old', [shared]);
  const newClient = readyClient('p_new', [shared]);
  (newClient as unknown as { call: () => Promise<unknown> }).call = async () => ({ pings: [] });
  const server = new PortalMcplServer(
    oldClient,
    new PortalAgent(oldClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }),
    { identity: { handleToolCall: async () => ({}) } },
  );
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const internal = server as unknown as {
    conn: unknown; mcplEnabled: boolean; initialRegistrationComplete: boolean;
    policy: { applyRequest(p: unknown): unknown }; wireClient(): void;
    wokenByPersona: Map<string, Set<string>>;
  };
  internal.conn = {
    sendRequest: async (method: string, params: Record<string, unknown>) => { requests.push({ method, params }); return {}; },
    sendNotification: () => {},
  };
  internal.mcplEnabled = true;
  internal.initialRegistrationComplete = true;
  internal.policy.applyRequest({
    effectiveCapabilities: [...new Set(Object.values({ ...featureSets, ...identityFeatureSets }).flatMap((s) => s.uses as string[]))],
  });
  internal.wireClient();

  // Hold the image download open across the switch.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { await gate; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }) as typeof fetch;
  try {
    oldClient.emit('message', {
      message: {
        id: 'm_img', nativeId: 'm_img', channelId: '100', guildId: 'g1',
        author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
        content: '@old look', cleanContent: '@old look',
        attachments: [{ id: 'a1', name: 'x.png', url: 'https://cdn.example/x.png', contentType: 'image/png', size: 3 }],
        mentions: { personas: [], roles: [], users: [], everyone: false },
        reactions: [], createdAt: '2026-01-01T00:00:00Z',
      },
      addressedToMe: true,
      reasons: ['mention'],
    } as never);
    await server.swapSession(newClient, new PortalAgent(newClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
    release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.fetch = realFetch;
  }
  const pushed = requests.filter((r) => JSON.stringify(r.params).includes('m_img'));
  assert.deepEqual(pushed, [], "the old persona's message was not pushed after the switch");
  assert.equal(internal.wokenByPersona.get('p_old')?.has('m_img') ?? false, false, "left for the old persona's next catch-up");
});

/** An MCPL server on `client` with every capability granted and a recording
 *  connection. `register` decides how channels/register requests resolve. */
function mcplHarness(client: PortalClient, opts: { register?: () => Promise<unknown> } = {}) {
  const server = new PortalMcplServer(
    client,
    new PortalAgent(client, { state: new AgentState(), hostOwnsChannelLifecycle: true }),
    { identity: { handleToolCall: async () => ({}) } },
  );
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const internal = server as unknown as {
    conn: unknown; mcplEnabled: boolean; initialRegistrationComplete: boolean;
    policy: { applyRequest(p: unknown): unknown }; wireClient(): void; registerChannels(): Promise<void>;
    catchUp(): Promise<void>; advertised: Map<string, string>;
  };
  internal.conn = {
    sendRequest: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'channels/register' && opts.register) return opts.register();
      return {};
    },
    sendNotification: (method: string, params: Record<string, unknown>) => void notifications.push({ method, params }),
  };
  internal.mcplEnabled = true;
  internal.policy.applyRequest({
    effectiveCapabilities: [...new Set(Object.values({ ...featureSets, ...identityFeatureSets }).flatMap((s) => s.uses as string[]))],
  });
  internal.wireClient();
  return { server, requests, notifications, internal };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const withPings = (client: PortalClient, pings: Array<{ id: string; channelId: string; content: string }>) => {
  (client as unknown as { call: (m: string) => Promise<unknown> }).call = async (m: string) => (m === 'get_pending_pings'
    ? { pings: pings.map((p) => ({ reasons: ['mention'], at: '2026-01-01T00:00:00.000Z', message: {
        id: p.id, nativeId: p.id, channelId: p.channelId, guildId: 'g1',
        author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
        content: p.content, cleanContent: p.content, attachments: [],
        mentions: { personas: [], roles: [], users: [], everyone: false }, reactions: [], createdAt: '2026-01-01T00:00:00.000Z',
      } })) }
    : {});
  return client;
};

test('MCPL: switching while the first channels/register is pending returns at once (no deadlock with a serial host)', async () => {
  let ackRegister!: (v: unknown) => void;
  const pending = new Promise((r) => { ackRegister = r; });
  const oldClient = readyClient('p_old', [chan('100', 'shared')]);
  const newClient = readyClient('p_new', [chan('100', 'shared'), chan('300', 'new-only')]);
  (newClient as unknown as { call: () => Promise<unknown> }).call = async () => ({ pings: [] });
  const h = mcplHarness(oldClient, { register: () => pending });
  void h.internal.registerChannels(); // the initial register, held by the host
  await flush();
  const switched = h.server.swapSession(newClient, new PortalAgent(newClient, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
  const outcome = await Promise.race([switched.then(() => 'returned'), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
  assert.equal(outcome, 'returned', 'the switch does not wait for the host to answer channels/register');
  // Once the host answers, the old view is retracted and the new one offered.
  ackRegister({ results: [{ id: 'portal:100', accepted: true }] });
  await flush();
  // Replay what the host was told: the old view was retracted, and what it
  // ends up holding is exactly the new identity's view.
  const held = new Set<string>(['portal:100']); // acked by the initial register
  let retractedOld = false;
  for (const n of h.notifications) {
    for (const id of (n.params.removed as string[] | undefined) ?? []) { if (id === 'portal:100') retractedOld = true; held.delete(id); }
    for (const d of (n.params.added as Array<{ id: string }> | undefined) ?? []) held.add(d.id);
  }
  assert.ok(retractedOld, "the old identity's channel was retracted");
  assert.deepEqual([...held].sort(), ['portal:100', 'portal:300']);
});

test('MCPL A→B→A: a ping already surfaced for A is not pushed again when switching back', async () => {
  const pingA = [{ id: 'm_a1', channelId: '100', content: '@a once' }];
  const a = withPings(readyClient('p_a', [chan('100', 'shared')]), pingA);
  const b = withPings(readyClient('p_b', [chan('100', 'shared')]), []);
  const h = mcplHarness(a);
  h.internal.initialRegistrationComplete = true;
  await h.internal.catchUp();
  const pushes = () => h.requests.filter((r) => r.method === 'push/event' && JSON.stringify(r.params).includes('@a once')).length;
  assert.equal(pushes(), 1);
  await h.server.swapSession(b, new PortalAgent(b, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
  await flush();
  const a2 = withPings(readyClient('p_a', [chan('100', 'shared')]), pingA);
  await h.server.swapSession(a2, new PortalAgent(a2, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
  await flush();
  assert.equal(pushes(), 1, "A's ping was pushed once");
});

test("MCPL: a catch-up whose ping read spans a switch drops the old persona's pings", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = readyClient('p_a', [chan('100', 'shared')]);
  (a as unknown as { call: (m: string) => Promise<unknown> }).call = async (m: string) => {
    if (m !== 'get_pending_pings') return {};
    await gate; // the round trip is still out when the switch happens
    return withPings(readyClient('x', []), [{ id: 'm_old', channelId: '100', content: '@a stale' }])
      .call('get_pending_pings', {});
  };
  const b = withPings(readyClient('p_b', [chan('100', 'shared')]), []);
  const h = mcplHarness(a);
  h.internal.initialRegistrationComplete = true;
  const catching = h.internal.catchUp();
  await flush();
  await h.server.swapSession(b, new PortalAgent(b, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
  release();
  await catching;
  await flush();
  assert.equal(h.requests.filter((r) => JSON.stringify(r.params).includes('@a stale')).length, 0);
});

test('a roster lock left by a dead process is recovered at once, and the mint is recorded', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'root.identities.json.lock'), '999999'); // no such process
  const t0 = Date.now();
  await h.manager.handleToolCall('mint_persona', { name: 'After Crash', switch: false });
  assert.ok(Date.now() - t0 < 1000, 'did not wait out a dead holder');
  const listed = await h.make().handleToolCall('list_personas', {});
  assert.ok((listed as { personas: Array<{ name: string }> }).personas.some((i) => i.name === 'After Crash'));
});

test("a creds reservation left by a process that died mid-mint doesn't block the name; a live one does", async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'orphan.creds.json'), JSON.stringify({ reserving: true, pid: 999999, at: new Date().toISOString() }));
  await h.manager.handleToolCall('mint_persona', { name: 'Orphan', switch: false });
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'orphan.creds.json'), 'utf8')).personaId, 'p_1');
  writeFileSync(join(h.dir, 'busy.creds.json'), JSON.stringify({ reserving: true, pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(h.manager.handleToolCall('mint_persona', { name: 'Busy', switch: false }), /already exists on this host/);
});

test('taking over an abandoned reservation is exclusive: not while another process holds the mint lock', async () => {
  const h = harness({ invite: 'inv' });
  writeFileSync(join(h.dir, 'contested.creds.json'), JSON.stringify({ reserving: true, pid: 999999, at: new Date().toISOString() }));
  // Another live process (this one, as far as the lock can tell) is mid-takeover:
  // the mint waits for it rather than take over the same reservation too.
  writeFileSync(join(h.dir, '.mint.lock'), String(process.pid));
  await assert.rejects(h.manager.handleToolCall('mint_persona', { name: 'Contested', switch: false }), /locked by another process/);
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'contested.creds.json'), 'utf8')).reserving, true, 'untouched while locked');
  // Once it lets go, the takeover goes through — once.
  rmSync(join(h.dir, '.mint.lock'));
  await h.manager.handleToolCall('mint_persona', { name: 'Contested', switch: false });
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'contested.creds.json'), 'utf8')).personaId, 'p_1');
});

test("MCPL: a register reply that lands after the switch retires the OLD persona's bootstrap follows, not the new one's", async () => {
  let ackRegister!: (v: unknown) => void;
  const pending = new Promise((r) => { ackRegister = r; });
  const oldClient = readyClient('p_old', [chan('100', 'shared')]);
  const newClient = readyClient('p_new', [chan('100', 'shared'), chan('300', 'new-only')]);
  (newClient as unknown as { call: () => Promise<unknown> }).call = async () => ({ pings: [] });
  const oldState = new AgentState();
  oldState.subscribe('100');
  const newState = new AgentState();
  newState.subscribe('100'); // the new persona follows the shared channel too
  const h = mcplHarness(oldClient, { register: () => pending });
  (h.server as unknown as { agent: PortalAgent }).agent = new PortalAgent(oldClient, { state: oldState, hostOwnsChannelLifecycle: true });
  void h.internal.registerChannels();
  await flush();
  await h.server.swapSession(newClient, new PortalAgent(newClient, { state: newState, hostOwnsChannelLifecycle: true }));
  ackRegister({ results: [{ id: 'portal:100', accepted: true }] });
  await flush();
  assert.deepEqual(oldState.subscriptionList(), [], "the old persona's advertised follow is retired");
  // The new persona's follow of the shared channel survived the OLD reply long
  // enough to reach its own offer as an open hint (and is retired only after
  // that offer, by design — the host owns the open state from then on).
  const offered = h.notifications.flatMap((n) => (n.params.added as Array<{ id: string; initiallyOpen?: boolean }> | undefined) ?? []);
  assert.equal(offered.find((d) => d.id === 'portal:100')?.initiallyOpen, true, "the new persona's hint reaches its offer");
});

test('the pre-rename tool names still work, but only the persona names are advertised', async () => {
  const h = harness({ invite: 'inv' });
  await h.manager.handleToolCall('mint_identity', { name: 'Old Name Path', switch: false });
  const listed = (await h.manager.handleToolCall('list_identities', {})) as { personas: Array<{ name: string }> };
  assert.ok(listed.personas.some((p) => p.name === 'Old Name Path'));
  const { identityToolDefinitions, IDENTITY_TOOL_FEATURE_SETS } = await import('../src/identity.js');
  assert.deepEqual(identityToolDefinitions.map((t) => t.name), ['list_personas', 'mint_persona', 'switch_persona']);
  for (const legacy of ['list_identities', 'mint_identity', 'switch_identity']) assert.ok(legacy in IDENTITY_TOOL_FEATURE_SETS, legacy);
});
