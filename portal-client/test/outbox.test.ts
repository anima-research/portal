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
  assert.deepEqual(
    created[0].rpcFrames().map((f) => f.d.method),
    ['fetch_history', 'send_message'],
  );
});

test('a held RPC that times out is rejected and never sent', async (t) => {
  const { client, created } = makeClient(20);
  t.after(() => client.close()); // also on a failed assertion, so the heartbeat can't hang the run
  client.connect().catch(() => {});
  await assert.rejects(client.fetchHistory({ channelId: 'c1', limit: 1 }), /timed out/);
  created[0].feed(HELLO);
  created[0].feed(READY);
  assert.equal(created[0].rpcFrames().length, 0);
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
