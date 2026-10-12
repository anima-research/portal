import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { RegisterData, RegisteredData, ServerFrame } from '@animalabs/portal-protocol';
import { Gateway, type GatewayHooks, Session } from '../src/gateway.js';

// Exercise retention with a controlled clock rather than minute-long sleeps.
// The existing gateway suite covers the real WebSocket handshake/replay path.
interface GatewayInternals {
  sessionPersona: Map<string, unknown>;
  byPersona: Map<string, unknown>;
  onIdentify(s: Session, token: string, personaId: string): Promise<void>;
  onRegister(s: Session, data: RegisterData): Promise<void>;
  onResume(s: Session, sessionId: string, seq: number): void;
  onFrame(s: Session, frame: unknown): Promise<void>;
  onDisconnect(s: Session): void;
  reapStale(): void;
}

function fixture(
  t: TestContext,
  enroll?: GatewayHooks['enroll'],
  opts: { resumeRetentionMs?: number; log?: (line: string) => void; hooks?: Partial<GatewayHooks> } = { resumeRetentionMs: 100 },
) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { hooks, ...gatewayOpts } = opts;
  const gw = new Gateway({
    authenticate: (_token, personaId) => personaId,
    buildReady: async (s) => ({
      sessionId: s.id,
      persona: { id: s.personaId, displayName: s.personaId, avatarUrl: '' },
      guilds: [], channels: [], seq: gw.seqOf(s.personaId),
    }),
    handleRpc: async () => {},
    enroll,
    ...hooks,
  }, 30_000, { log: () => {}, ...gatewayOpts });
  const internals = gw as unknown as GatewayInternals;
  const sockets = new Map<Session, { readyState: number }>();
  const socket = () => {
    const frames: ServerFrame[] = [];
    const closed: { code?: number; reason?: string }[] = [];
    const ws = {
      OPEN: 1, readyState: 1,
      send: (data: string) => frames.push(JSON.parse(data) as ServerFrame),
      // As ws does: a close starts the handshake, and the socket is CLOSING
      // until it emits 'close'.
      close: (code?: number, reason?: string) => {
        closed.push({ code, reason });
        if (ws.readyState === 1) ws.readyState = 2;
      },
      terminate: () => {},
    };
    const session = new Session(ws as unknown as WebSocket, gw);
    sockets.set(session, ws);
    return { session, frames, ws, closed };
  };
  const identify = async (personaId = 'p1') => {
    const connection = socket();
    await internals.onIdentify(connection.session, 'secret', personaId);
    return connection;
  };
  return {
    gw, internals, socket, identify,
    at: (time: number) => { now = time; },
    sweep: () => internals.reapStale(),
    // As ws does: the socket is CLOSED by the time it emits 'close'.
    disconnect: (s: Session) => {
      const ws = sockets.get(s);
      if (ws) ws.readyState = 3;
      internals.onDisconnect(s);
    },
  };
}

test('disconnected resume keys and streams expire even while events keep arriving', async (t) => {
  const f = fixture(t);
  const a = await f.identify();
  f.disconnect(a.session);
  assert.equal(f.internals.byPersona.size, 0, 'empty live-persona indexes are removed immediately');
  f.at(99);
  f.gw.dispatch('p1', { type: 'pins_update', channelId: 'c1' });
  f.sweep();
  assert.equal(f.gw.seqOf('p1'), 1, 'replay is retained inside the window');

  f.at(100);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.deepEqual(f.gw.streamPersonas(), []);
  f.gw.dispatch('p1', { type: 'pins_update', channelId: 'c1' });
  f.gw.dispatch('never-connected', { type: 'pins_update', channelId: 'c1' });
  assert.equal(f.gw.hasStream('p1'), false, 'late events do not resurrect expired state');
  assert.equal(f.gw.hasStream('never-connected'), false);

  const b = f.socket();
  f.internals.onResume(b.session, a.session.id, 0);
  assert.equal(b.frames.at(-1)?.op, 'invalid_session');
  await f.internals.onIdentify(b.session, 'secret', 'p1');
  const ready = b.frames.at(-1);
  assert.equal(ready?.op, 'ready', 'expired clients can identify for a fresh snapshot');
  if (ready?.op === 'ready') assert.equal(ready.d.seq, 0);
});

test('resume checks the expiry deadline even before the next heartbeat sweep', async (t) => {
  const f = fixture(t);
  const a = await f.identify();
  f.disconnect(a.session);
  f.at(100);
  const b = f.socket();
  f.internals.onResume(b.session, a.session.id, 0);
  assert.equal(b.frames.at(-1)?.op, 'invalid_session');
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.equal(f.gw.hasStream('p1'), false);
});

test('successful reconnects retain the original client key without adding resume keys', async (t) => {
  const f = fixture(t);
  const first = await f.identify();
  const key = first.session.id;
  let current = first.session;
  for (let i = 0; i < 20; i++) {
    f.at(i * 200);
    current.touch();
    f.sweep();
    assert.equal(f.internals.sessionPersona.size, 1, 'live keys never expire');
    f.disconnect(current);
    f.at(i * 200 + 99);
    f.gw.dispatch('p1', { type: 'pins_update', channelId: 'c1' });
    const next = f.socket();
    f.internals.onResume(next.session, key, i);
    assert.equal(next.frames[0]?.op, 'dispatch');
    assert.deepEqual(next.frames.at(-1), { op: 'resumed', d: { replayedEvents: 1 } });
    assert.equal(f.internals.sessionPersona.size, 1, 'resume does not mint another key');
    current = next.session;
  }
  f.disconnect(current);
  f.at(20 * 200 + 99);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.equal(f.gw.hasStream('p1'), false);
});

test('old keys expire independently while another session keeps the persona live', async (t) => {
  const f = fixture(t);
  const live = await f.identify();
  for (let i = 0; i < 25; i++) {
    const old = await f.identify();
    f.disconnect(old.session);
  }
  assert.equal(f.internals.sessionPersona.size, 26);
  f.at(100);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 1);
  assert.equal(f.gw.hasStream('p1'), true);
  assert.deepEqual(f.gw.activePersonas(), ['p1']);
  f.disconnect(live.session);
  f.at(200);
  f.sweep();
  assert.equal(f.internals.byPersona.size, 0);
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.equal(f.gw.hasStream('p1'), false);
});

test('overlapping sockets using the same resume key keep it until the last disconnect', async (t) => {
  const f = fixture(t);
  const a = await f.identify();
  const b = f.socket();
  f.internals.onResume(b.session, a.session.id, 0);
  assert.equal(b.frames.at(-1)?.op, 'resumed');
  f.disconnect(a.session);
  f.at(100);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 1);
  assert.equal(f.gw.hasStream('p1'), true);
  f.disconnect(b.session);
  f.at(199);
  f.sweep();
  assert.equal(f.gw.hasStream('p1'), true);
  f.at(200);
  f.sweep();
  assert.equal(f.gw.hasStream('p1'), false);
});

test('dropping a persona invalidates its old resume keys even if it identifies again', async (t) => {
  const f = fixture(t);
  const a = await f.identify();
  f.gw.dropStream('p1');
  f.disconnect(a.session);
  assert.equal(f.internals.sessionPersona.size, 0);
  await f.identify();
  const b = f.socket();
  f.internals.onResume(b.session, a.session.id, 0);
  assert.equal(b.frames.at(-1)?.op, 'invalid_session');
});

test('an identified socket cannot resume into a second persona or leave stale live indexes', async (t) => {
  const f = fixture(t);
  const a = await f.identify('p1');
  const b = await f.identify('p2');
  f.internals.onResume(a.session, b.session.id, 0);
  assert.equal(a.session.personaId, 'p1');
  f.disconnect(a.session);
  assert.deepEqual(f.gw.activePersonas(), ['p2']);
});

test('late enrollment cannot promote a disconnected socket into an immortal session', async (t) => {
  let complete!: (data: RegisteredData) => void;
  const pending = new Promise<RegisteredData>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending);
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, {
    protocolVersion: 4, invite: 'invite', desiredName: 'new',
  });
  f.disconnect(a.session);
  complete({ personaId: 'new', token: 'new-token', persona: { id: 'new', displayName: 'New', avatarUrl: '' } });
  await registering;
  f.at(1000);
  f.sweep();
  assert.equal(a.session.identified, false);
  assert.deepEqual(a.frames, []);
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.deepEqual(f.gw.activePersonas(), []);
  assert.deepEqual(f.gw.streamPersonas(), []);
});

test('late enrollment cannot replace a concurrent successful identify', async (t) => {
  const lines: string[] = [];
  let complete!: (data: RegisteredData) => void;
  const pending = new Promise<RegisteredData>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, {
    protocolVersion: 4, invite: 'invite', desiredName: 'new',
  });
  await f.internals.onIdentify(a.session, 'secret', 'existing');
  complete({ personaId: 'new', token: 'new-token', persona: { id: 'new', displayName: 'New', avatarUrl: '' } });
  await registering;
  assert.equal(a.session.personaId, 'existing');
  assert.deepEqual(a.frames.map((frame) => frame.op), ['ready']);
  assert.ok(lines.some((l) => / session register-abandoned .*reason="already identified" minted=new /.test(l)), lines.join('\n'));
  assert.deepEqual(f.gw.activePersonas(), ['existing']);
  assert.deepEqual(f.gw.streamPersonas(), ['existing']);
  assert.equal(f.internals.sessionPersona.size, 1);
  f.disconnect(a.session);
  f.at(100);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.deepEqual(f.gw.streamPersonas(), []);
});

test('resume retention must be finite and nonnegative', () => {
  const hooks = { authenticate: () => null, buildReady: async () => { throw new Error('unused'); }, handleRpc: async () => {} };
  for (const resumeRetentionMs of [-1, Infinity, NaN]) {
    assert.throws(() => new Gateway(hooks, 30_000, { resumeRetentionMs }), /resumeRetentionMs/);
  }
  assert.doesNotThrow(() => new Gateway(hooks, 30_000, { resumeRetentionMs: 0 }));
});

test('the default resume window is five minutes', async (t) => {
  // Every other test shortens the window; this one pins the default the relay runs with.
  const f = fixture(t, undefined, {});
  const a = await f.identify();
  f.disconnect(a.session);
  f.at(5 * 60_000 - 1);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 1, 'kept until the five minutes are up');
  f.at(5 * 60_000);
  f.sweep();
  assert.equal(f.internals.sessionPersona.size, 0);
});

test("each key's deadline runs from its own last disconnect", async (t) => {
  // One persona, two keys, disconnected 50 ms apart: the later disconnect must not
  // move the earlier key's deadline, nor the earlier one the later's.
  const f = fixture(t);
  const a = await f.identify();
  const b = await f.identify();
  f.disconnect(a.session);
  f.at(50);
  f.disconnect(b.session);
  f.at(100);
  f.sweep();
  const fresh = f.socket();
  f.internals.onResume(fresh.session, a.session.id, 0);
  assert.equal(fresh.frames.at(-1)?.op, 'invalid_session', 'the first key expired at 100');
  f.at(149);
  const resumed = f.socket();
  f.internals.onResume(resumed.session, b.session.id, 0);
  assert.equal(resumed.frames.at(-1)?.op, 'resumed', 'the second key lives until 150');
});

test('an expired key is logged when it is released', async (t) => {
  const lines: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = await f.identify();
  f.disconnect(a.session);
  f.at(100);
  f.sweep();
  assert.equal(lines.filter((l) => / session resume-expired persona=p1 /.test(l)).length, 1, lines.join('\n'));
});

test('a late enrollment is logged when it is discarded, and a closing socket is never promoted', async (t) => {
  const lines: string[] = [];
  let complete!: (data: RegisteredData) => void;
  const pending = new Promise<RegisteredData>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, {
    protocolVersion: 4, invite: 'invite', desiredName: 'new',
  });
  // The close handshake has begun, but ws hasn't emitted 'close' yet.
  a.ws.readyState = 2;
  complete({ personaId: 'new', token: 'new-token', persona: { id: 'new', displayName: 'New', avatarUrl: '' } });
  await registering;
  assert.equal(a.session.identified, false);
  assert.deepEqual(a.frames, []);
  assert.equal(f.internals.sessionPersona.size, 0);
  assert.deepEqual(f.gw.streamPersonas(), []);
  assert.ok(lines.some((l) => / session register-abandoned .*reason="socket closed" minted=new /.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => / session register /.test(l)), 'no live register line for a socket that never got the result');
});

test('a frame on a closing socket is ignored: no handshake promotes it, and no rpc reaches its persona', async (t) => {
  const rpcs: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, hooks: { handleRpc: async (_s, req) => { rpcs.push(req.id); } } });
  // ws still emits 'message' while a socket is CLOSING, as when a revoke has begun closing it.
  const closing = f.socket();
  closing.ws.readyState = 2;
  await f.internals.onFrame(closing.session, { op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p1' } });
  assert.equal(closing.session.identified, false);
  assert.deepEqual(f.gw.activePersonas(), []);
  assert.equal(f.internals.sessionPersona.size, 0);
  const live = await f.identify('p2');
  live.ws.readyState = 2;
  await f.internals.onFrame(live.session, { op: 'rpc', d: { id: 'r1', method: 'fetch_history', params: {} } });
  assert.deepEqual(rpcs, []);
});

test('a ready whose socket begins closing while it is built is abandoned, not logged as live', async (t) => {
  const lines: string[] = [];
  const opened: string[] = [];
  let release!: () => void;
  const built = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(t, undefined, {
    resumeRetentionMs: 100,
    log: (line) => lines.push(line),
    hooks: {
      buildReady: async (s) => {
        await built;
        return { sessionId: s.id, persona: { id: s.personaId, displayName: s.personaId, avatarUrl: '' }, guilds: [], channels: [], seq: 0 };
      },
      onOpen: (s) => { opened.push(s.personaId); },
    },
  });
  const a = f.socket();
  const identifying = f.internals.onIdentify(a.session, 'secret', 'p1');
  a.ws.readyState = 2;
  release();
  await identifying;
  assert.deepEqual(a.frames, []);
  assert.deepEqual(opened, []);
  assert.ok(lines.some((l) => / session identify-abandoned persona=p1 /.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => / session identify persona=/.test(l)), 'no live identify line for a ready nobody received');
});

test("a late enrollment's discard line names the hook's error", async (t) => {
  const lines: string[] = [];
  let complete!: (data: { error: string }) => void;
  const pending = new Promise<{ error: string }>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, { protocolVersion: 4, invite: 'invite', desiredName: 'new' });
  a.ws.readyState = 2;
  complete({ error: 'invite expired' });
  await registering;
  assert.deepEqual(a.frames, []);
  assert.ok(lines.some((l) => / session register-abandoned .*reason="socket closed" error="invite expired"/.test(l)), lines.join('\n'));
});

test('a pending enrollment cannot undo a revoke: credentials that no longer authenticate are refused', async (t) => {
  const lines: string[] = [];
  let revoked = false;
  let complete!: (data: RegisteredData) => void;
  const pending = new Promise<RegisteredData>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending, {
    resumeRetentionMs: 100,
    log: (line) => lines.push(line),
    hooks: { authenticate: (_token, personaId) => (revoked && personaId === 'new' ? null : personaId) },
  });
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, { protocolVersion: 4, invite: 'invite', desiredName: 'new' });
  // The hook has minted 'new', and before it returns a force-revoke runs:
  // the credentials stop authenticating, then its sessions close and its stream drops.
  revoked = true;
  f.gw.closePersona('new');
  f.gw.dropStream('new');
  complete({ personaId: 'new', token: 'new-token', persona: { id: 'new', displayName: 'New', avatarUrl: '' } });
  await registering;
  assert.equal(a.session.identified, false);
  assert.deepEqual(a.frames.map((frame) => frame.op), ['invalid_session']);
  assert.deepEqual(a.closed, [{ code: 4003, reason: 'register failed' }]);
  assert.equal(f.internals.sessionPersona.size, 0, 'no resume key');
  assert.deepEqual(f.gw.streamPersonas(), [], 'no stream');
  assert.deepEqual(f.gw.activePersonas(), [], 'no live session');
  assert.ok(lines.some((l) => / session register-rejected .*reason="credentials no longer valid" minted=new/.test(l)), lines.join('\n'));
});

test('a refused resume names the key it was given, so an expiry can be matched to it', async (t) => {
  const lines: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = await f.identify();
  const key = a.session.id.slice(5, 13);
  f.disconnect(a.session);
  f.at(100);
  f.sweep();
  const late = f.socket();
  f.internals.onResume(late.session, a.session.id, 0);
  assert.equal(late.frames.at(-1)?.op, 'invalid_session');
  assert.ok(lines.some((l) => new RegExp(` session resume-expired persona=p1 key=${key} `).test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => new RegExp(` session resume-rejected .*reason="unknown session" key=${key} `).test(l)), lines.join('\n'));
});

test('a discarded enrollment says the socket closed when it has, even if another identify won first', async (t) => {
  const lines: string[] = [];
  let complete!: (data: RegisteredData) => void;
  const pending = new Promise<RegisteredData>((resolve) => { complete = resolve; });
  const f = fixture(t, () => pending, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = f.socket();
  const registering = f.internals.onRegister(a.session, { protocolVersion: 4, invite: 'invite', desiredName: 'new' });
  await f.internals.onIdentify(a.session, 'secret', 'existing');
  a.ws.readyState = 2;
  complete({ personaId: 'new', token: 'new-token', persona: { id: 'new', displayName: 'New', avatarUrl: '' } });
  await registering;
  assert.ok(lines.some((l) => / session register-abandoned .*reason="socket closed" minted=new /.test(l)), lines.join('\n'));
});

test("a refused resume's key is logged only in the id alphabet: client text can't add a field", async (t) => {
  const lines: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const late = f.socket();
  // Longer than the eight characters logged, so the width is pinned too.
  f.internals.onResume(late.session, 'sess_a b=c "d-0123456789', 0);
  const line = lines.find((l) => / session resume-rejected /.test(l)) ?? '';
  assert.match(line, / key=a\?b\?c\?\?d from-seq=0 /, line);
});

test("a resume whose seq isn't a nonnegative integer is refused, and the seq isn't logged", async (t) => {
  const lines: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, log: (line) => lines.push(line) });
  const a = await f.identify();
  f.disconnect(a.session);
  for (const seq of ['0 persona=x', undefined, -1, 1.5] as unknown[]) {
    const late = f.socket();
    f.internals.onResume(late.session, a.session.id, seq as number);
    assert.equal(late.session.identified, false, `seq ${String(seq)}`);
    assert.deepEqual(late.frames, [{ op: 'invalid_session', d: { resumable: false, reason: 'bad seq' } }], `seq ${String(seq)}`);
  }
  assert.equal(lines.filter((l) => / session resume-rejected .*reason="bad seq"/.test(l)).length, 4, lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('persona=x')), lines.join('\n'));
  // The key is still good: a well-formed resume takes it.
  const resumed = f.socket();
  f.internals.onResume(resumed.session, a.session.id, 0);
  assert.equal(resumed.frames.at(-1)?.op, 'resumed');
});

test("a revoke's close stops the persona's next rpc: the socket is CLOSING once the gateway closes it", async (t) => {
  const rpcs: string[] = [];
  const f = fixture(t, undefined, { resumeRetentionMs: 100, hooks: { handleRpc: async (_s, req) => { rpcs.push(req.id); } } });
  const a = await f.identify('p1');
  await f.internals.onFrame(a.session, { op: 'rpc', d: { id: 'before', method: 'list_guilds', params: {} } });
  f.gw.closePersona('p1');
  assert.deepEqual(a.closed, [{ code: 4001, reason: 'persona revoked' }]);
  await f.internals.onFrame(a.session, { op: 'rpc', d: { id: 'after', method: 'list_guilds', params: {} } });
  assert.deepEqual(rpcs, ['before']);
});
