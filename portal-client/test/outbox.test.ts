import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

/** Minimal ws stand-in exposing the surface PortalClient touches. */
class FakeWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  feed(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
  rpcFrames(): Array<{ op: 'rpc'; d: { id: string; method: string } }> {
    return this.sent.map((s) => JSON.parse(s)).filter((f) => f.op === 'rpc');
  }
}

const READY = {
  op: 'ready',
  d: { sessionId: 's1', seq: 0, persona: { id: 'p', displayName: 'x', avatarUrl: '' }, guilds: [], channels: [], capabilities: {}, subscriptions: [] },
};
const HELLO = { op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 30000 } };

/** The calls still waiting for an answer, each holding its timer. */
const pendingOf = (client: PortalClient) => (client as unknown as { pending: Map<string, unknown> }).pending;

function makeClient(rpcTimeoutMs = 1000) {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    rpcTimeoutMs,
    maxBackoffMs: 20,
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w as unknown as import('ws').WebSocket;
    },
  });
  return { client, created };
}

test('an RPC issued before ready is held, sent on ready, and resolves', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  // Issued while connect() is still in flight — the first-call-after-startup case.
  const p = client.fetchHistory({ channelId: 'c1', limit: 1 });
  const ws = created[0];
  assert.equal(ws.rpcFrames().length, 0, 'not sent before the session is ready');

  ws.feed(HELLO);
  assert.equal(ws.rpcFrames().length, 0, 'not sent between hello and ready either');
  ws.feed(READY);
  const frames = ws.rpcFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].d.method, 'fetch_history');

  ws.feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messages: [] } } });
  assert.deepEqual(await p, { messages: [] });
});

test('held RPCs flush in call order', (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  client.fetchHistory({ channelId: 'c1', limit: 1 }).catch(() => {});
  client.sendMessage({ channelId: 'c1', content: 'hi' }).catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);
  const frames = created[0].rpcFrames();
  assert.deepEqual(frames.map((f) => f.d.method), ['fetch_history', 'send_message']);
  // Answered, so neither call's timer outlives the test.
  created[0].feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messages: [] } } });
  created[0].feed({ op: 'rpc_result', d: { id: frames[1].d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.equal(pendingOf(client).size, 0);
});

test('a held RPC that times out is rejected, saying it was never sent, and never sent', async (t) => {
  const { client, created } = makeClient(20);
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  await assert.rejects(
    client.fetchHistory({ channelId: 'c1', limit: 1 }),
    /RPC fetch_history timed out before it was sent: no relay session within 20 ms/,
  );
  created[0].feed(HELLO);
  created[0].feed(READY);
  assert.equal(created[0].rpcFrames().length, 0);
});

test('a sent RPC that gets no answer times out saying it may have run', async (t) => {
  // A caller can retry a call that was never sent; one that was may have run.
  const { client, created } = makeClient(20);
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);
  const p = client.fetchHistory({ channelId: 'c1', limit: 1 });
  assert.equal(created[0].rpcFrames().length, 1, 'sent at once');
  await assert.rejects(p, /RPC fetch_history timed out after it was sent; it may have run/);
});

// Whether a call was sent is the outbox's to say, not the session's state at
// the timeout: these three cases tell the two apart.
test('a held RPC flushed on ready that then gets no answer times out saying it may have run', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.connect().catch(() => {});
  const p = client.fetchHistory({ channelId: 'c1', limit: 1 });
  created[0].feed(HELLO);
  created[0].feed(READY);
  assert.equal(created[0].rpcFrames().length, 1, 'flushed on ready');
  t.mock.timers.tick(1000); // its timeout (rpcTimeoutMs 1000)
  await assert.rejects(p, /RPC fetch_history timed out after it was sent; it may have run/);
});

test('a sent RPC whose socket drops before its answer times out saying it may have run, beside one still held', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);
  const sent = client.fetchHistory({ channelId: 'c1', limit: 1 });
  assert.equal(created[0].rpcFrames().length, 1, 'sent at once');
  created[0].emit('close', 1006); // the session is gone, but the call already went out
  const held = client.sendMessage({ channelId: 'c1', content: 'during the gap' });
  const sentRejects = assert.rejects(sent, /RPC fetch_history timed out after it was sent; it may have run/);
  const heldRejects = assert.rejects(held, /RPC send_message timed out before it was sent: no relay session within 1000 ms/);
  t.mock.timers.tick(1000); // both timeouts (rpcTimeoutMs 1000); no reconnect answers meanwhile
  await sentRejects;
  await heldRejects;
});

test('an RPC a closing socket refused times out saying it was never sent', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);
  created[0].readyState = 2; // CLOSING, before its close event: the session still reads as ready
  const p = client.fetchHistory({ channelId: 'c1', limit: 1 });
  assert.equal(created[0].rpcFrames().length, 0, 'held, not sent');
  t.mock.timers.tick(1000); // its timeout (rpcTimeoutMs 1000)
  await assert.rejects(p, /RPC fetch_history timed out before it was sent: no relay session within 1000 ms/);
});

test('an RPC issued during a reconnect is sent on resumed', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  created[0].emit('close', 1006); // unexpected drop → reconnect scheduled
  const p = client.sendMessage({ channelId: 'c1', content: 'during the gap' });
  await new Promise((r) => setTimeout(r, 60)); // > jittered backoff (≤20ms)
  const ws2 = created[1];
  assert.ok(ws2, 'reconnected');

  ws2.feed(HELLO); // client has a session → sends resume
  assert.equal(ws2.rpcFrames().length, 0, 'held until resumed');
  ws2.feed({ op: 'resumed', d: { replayedEvents: 0 } });
  const frames = ws2.rpcFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].d.method, 'send_message');

  ws2.feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.deepEqual(await p, { messageId: 'm1', channelId: 'c1' });
});

test('an RPC issued while the socket is closing is held, not dropped', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  // CLOSING: the socket is no longer OPEN but its close event hasn't fired yet.
  created[0].readyState = 2;
  const p = client.sendMessage({ channelId: 'c1', content: 'while closing' });
  created[0].emit('close', 1006);
  await new Promise((r) => setTimeout(r, 60)); // > jittered backoff (≤20ms)
  const ws2 = created[1];
  assert.ok(ws2, 'reconnected');

  ws2.feed(HELLO);
  ws2.feed({ op: 'resumed', d: { replayedEvents: 0 } });
  const frames = ws2.rpcFrames();
  assert.equal(frames.length, 1, 'the call made during CLOSING is sent after resume');
  assert.equal(frames[0].d.method, 'send_message');

  ws2.feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.deepEqual(await p, { messageId: 'm1', channelId: 'c1' });
});

test('an RPC held through a reconnect whose resume is refused is sent once the fresh session is ready', async (t) => {
  // The path every relay restart takes: the relay keeps sessions in memory,
  // so it refuses the resume, and the client identifies afresh.
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  created[0].emit('close', 1006); // unexpected drop → reconnect scheduled
  const p = client.sendMessage({ channelId: 'c1', content: 'across a relay restart' });
  t.mock.timers.tick(20); // the reconnect, due within maxBackoffMs
  const ws2 = created[1];
  assert.ok(ws2, 'reconnected');

  ws2.feed(HELLO);
  assert.equal(JSON.parse(ws2.sent.at(-1)!).op, 'resume', 'the client has a session, so it resumes');
  ws2.feed({ op: 'invalid_session', d: { resumable: false, reason: 'unknown session' } });
  assert.equal(JSON.parse(ws2.sent.at(-1)!).op, 'identify', 'a refused resume starts a fresh session');
  assert.equal(ws2.rpcFrames().length, 0, 'held until the fresh session is ready');
  ws2.feed(READY);
  const frames = ws2.rpcFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].d.method, 'send_message');

  ws2.feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.deepEqual(await p, { messageId: 'm1', channelId: 'c1' });
});

test('a connect() after close() holds calls until its own session is ready, while the old socket is still closing', async (t) => {
  // A real socket emits close only after its closing handshake, so close()
  // itself ends the session that takes calls.
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  created[0].close = () => { created[0].readyState = 2; }; // CLOSING; its close event doesn't come in this test
  client.close();
  client.connect().catch(() => {});
  const ws2 = created[1];
  const p = client.sendMessage({ channelId: 'c1', content: 'after reconnecting' });
  assert.equal(ws2.rpcFrames().length, 0, 'not sent on a socket that has not identified');

  ws2.feed(HELLO); // the client kept its session, so it resumes
  ws2.feed({ op: 'resumed', d: { replayedEvents: 0 } });
  const frames = ws2.rpcFrames();
  assert.equal(frames.length, 1);
  ws2.feed({ op: 'rpc_result', d: { id: frames[0].d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.deepEqual(await p, { messageId: 'm1', channelId: 'c1' });
});

test('a connect() after close() rejects when its socket errors before its session is ready, as a first connect() does', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  created[0].close = () => { created[0].readyState = 2; }; // CLOSING; its close event doesn't come in this test
  client.close();
  let outcome: unknown = 'still pending';
  client.connect().then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
  created[1].emit('error', new Error('connect ECONNREFUSED'));
  await new Promise((resolve) => setImmediate(resolve)); // the rejection settles in microtasks
  assert.match(String(outcome), /ECONNREFUSED/);
});

test('close() rejects held RPCs and a later connect() never sends them', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  const p = client.sendMessage({ channelId: 'c1', content: 'before shutdown' });
  const rejected = assert.rejects(p, /closed/);

  client.close();
  client.connect().catch(() => {});
  const ws2 = created[1];
  ws2.feed(HELLO);
  ws2.feed(READY);
  assert.equal(ws2.rpcFrames().length, 0, 'work queued before close() is not sent after reconnecting');
  await rejected;
});

test('a held RPC sends the params as they were at call time', (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  const params = { channelId: 'c1', content: 'hi' };
  client.sendMessage(params).catch(() => {});
  params.channelId = 'c2';

  created[0].feed(HELLO);
  created[0].feed(READY);
  const [frame] = created[0].sent.map((s) => JSON.parse(s)).filter((f) => f.op === 'rpc');
  assert.equal(frame.d.params.channelId, 'c1');
  // Answered, so its timer doesn't outlive the test.
  created[0].feed({ op: 'rpc_result', d: { id: frame.d.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.equal(pendingOf(client).size, 0);
});

test('an RPC issued after close() is rejected and never sent on a later connect()', async (t) => {
  const { client, created } = makeClient();
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  created[0].feed(HELLO);
  created[0].feed(READY);

  client.close();
  const p = client.sendMessage({ channelId: 'c1', content: 'after shutdown' });
  const rejected = assert.rejects(p, /closed/);
  client.connect().catch(() => {});
  created[1].feed(HELLO); // the client kept its session, so it resumes
  assert.equal(JSON.parse(created[1].sent.at(-1)!).op, 'resume');
  created[1].feed({ op: 'resumed', d: { replayedEvents: 0 } }); // as the relay answers a resume
  assert.equal(created[1].rpcFrames().length, 0, 'a call made after close() is not sent after reconnecting');
  await rejected;
});
