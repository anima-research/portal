import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { ServerFrame } from '@animalabs/portal-protocol';
import { Gateway, Session } from '../src/gateway.js';

// Exercise retention with a controlled clock rather than minute-long sleeps.
// The existing gateway suite covers the real WebSocket handshake/replay path.
interface GatewayInternals {
  sessionPersona: Map<string, unknown>;
  byPersona: Map<string, unknown>;
  onIdentify(s: Session, token: string, personaId: string): Promise<void>;
  onResume(s: Session, sessionId: string, seq: number): void;
  onDisconnect(s: Session): void;
  reapStale(): void;
}

function fixture(t: TestContext) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const gw = new Gateway({
    authenticate: (_token, personaId) => personaId,
    buildReady: async (s) => ({
      sessionId: s.id,
      persona: { id: s.personaId, displayName: s.personaId, avatarUrl: '' },
      guilds: [], channels: [], seq: gw.seqOf(s.personaId),
    }),
    handleRpc: async () => {},
  }, 30_000, { resumeRetentionMs: 100, log: () => {} });
  const internals = gw as unknown as GatewayInternals;
  const socket = () => {
    const frames: ServerFrame[] = [];
    const ws = {
      OPEN: 1, readyState: 1,
      send: (data: string) => frames.push(JSON.parse(data) as ServerFrame),
      close: () => {}, terminate: () => {},
    };
    return { session: new Session(ws as unknown as WebSocket, gw), frames };
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
    disconnect: (s: Session) => internals.onDisconnect(s),
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

test('resume retention must be finite and nonnegative', () => {
  const hooks = { authenticate: () => null, buildReady: async () => { throw new Error('unused'); }, handleRpc: async () => {} };
  for (const resumeRetentionMs of [-1, Infinity, NaN]) {
    assert.throws(() => new Gateway(hooks, 30_000, { resumeRetentionMs }), /resumeRetentionMs/);
  }
  assert.doesNotThrow(() => new Gateway(hooks, 30_000, { resumeRetentionMs: 0 }));
});
