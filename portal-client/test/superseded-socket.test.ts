import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

// After close() and connect(), the old socket can still deliver events while
// its closing handshake runs. Those events belong to a session the client has
// left, so only the socket the client now uses may act on it. Issue #75.

/** A socket whose close() starts the closing handshake: its close event comes
 *  only when the test calls finish(), as a real socket's does once the relay
 *  answers the close. */
class ClosingWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 2;
  }
  finish(code = 1000): void {
    this.readyState = 3;
    this.emit('close', code);
  }
  feed(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
  frames(): Array<{ op: string; d: { id?: string; method?: string } }> {
    return this.sent.map((s) => JSON.parse(s));
  }
  ops(): string[] {
    return this.frames().map((f) => (f.op === 'rpc' ? `rpc:${f.d.method}` : f.op));
  }
}

const HELLO = { op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 10 } };
const readyFrame = (sessionId: string) => ({
  op: 'ready',
  d: {
    sessionId,
    seq: 0,
    persona: { id: 'p', displayName: 'x', avatarUrl: '' },
    guilds: [],
    channels: [],
    capabilities: {},
    subscriptions: [],
  },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readyOf = (c: PortalClient) => (c as unknown as { ready?: boolean }).ready;

/** A client whose sockets are ClosingWs. It's closed when the test ends,
 *  pass or fail, so a failing check leaves no heartbeat or reconnect timer
 *  running. */
function makeClient(t: TestContext) {
  const created: ClosingWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20,
    wsFactory: () => {
      const w = new ClosingWs();
      created.push(w);
      return w;
    },
  });
  t.after(() => client.close());
  return { client, created };
}

/** Connect on socket A, close(), then connect() again on socket B, leaving A
 *  in its closing handshake. With `readyOnA`, A's session was ready first. */
async function supersede(t: TestContext, readyOnA: boolean) {
  const { client, created } = makeClient(t);
  const first = client.connect();
  const a = created[0];
  a.feed(HELLO);
  if (readyOnA) {
    a.feed(readyFrame('s1'));
    await first;
  } else {
    first.catch(() => {});
  }
  client.close();
  const second = client.connect();
  const b = created[1];
  return { client, created, a, b, second };
}

test("the old socket's late close leaves the new session alone", async (t) => {
  const { client, created, a, b, second } = await supersede(t, true);
  b.feed(HELLO);
  b.feed(readyFrame('s2'));
  await second;
  const closes: unknown[] = [];
  client.on('close', (e) => closes.push(e));

  a.finish(1000);
  const heartbeatsBefore = b.ops().filter((op) => op === 'heartbeat').length;
  await sleep(60);

  assert.equal(readyOf(client), true, 'the new session stays ready');
  assert.ok(b.ops().filter((op) => op === 'heartbeat').length > heartbeatsBefore, 'heartbeats go on on the new socket');
  assert.equal(created.length, 2, 'no reconnect opens a third socket');
  assert.deepEqual(closes, [], 'no close event for the old socket');
});

test("the old socket's late ready isn't taken for the new connection", async (t) => {
  const { a, b, second } = await supersede(t, false);
  let resolvedWith: string | undefined;
  void second.then((d) => (resolvedWith = d.sessionId));

  a.feed(readyFrame('s1'));
  await sleep(0);
  assert.equal(resolvedWith, undefined, "connect() doesn't resolve on the old socket's ready");

  b.feed(HELLO);
  assert.equal(b.ops()[0], 'identify', 'the new socket identifies, not resumes the old session');
  b.feed(readyFrame('s2'));
  await second;
  assert.equal(resolvedWith, 's2');
});

test("the old socket's error doesn't fail the new connect()", async (t) => {
  const { a, b, second, client } = await supersede(t, true);
  const errors: Error[] = [];
  client.on('error', (e) => errors.push(e));

  a.emit('error', new Error('old socket failed'));
  b.feed(HELLO);
  b.feed(readyFrame('s2'));
  const d = await second;

  assert.equal(d.sessionId, 's2');
  assert.deepEqual(errors, [], 'the old socket\'s error is not the client\'s');
});

test("the old socket's late events don't reach listeners", async (t) => {
  const { a, b, second, client } = await supersede(t, true);
  const events: unknown[] = [];
  client.on('event', (e) => events.push(e));
  b.feed(HELLO);
  b.feed(readyFrame('s2'));
  await second;

  // The old socket's comes last, so if it moved lastSeq the heartbeat would
  // carry its seq.
  b.feed({ op: 'dispatch', seq: 1, d: { type: 'voice_status', channelId: 'c', guildId: null, joined: false } });
  a.feed({ op: 'dispatch', seq: 5, d: { type: 'voice_status', channelId: 'c', guildId: null, joined: true } });
  a.feed({ op: 'dispatch_ephemeral', d: { type: 'voice_status', channelId: 'c', guildId: null, joined: true } });

  assert.deepEqual(events, [{ type: 'voice_status', channelId: 'c', guildId: null, joined: false }]);
  const beats = b.sent.length;
  await sleep(30); // the heartbeat runs every 10 ms
  const heartbeat = b.sent.slice(beats).map((f) => JSON.parse(f)).find((f) => f.op === 'heartbeat');
  assert.equal(heartbeat?.d.seq, 1, "the new session's heartbeat carries its own seq, not the old socket's");
});

test("the old socket's late invalid_session and resumed don't act on the new connection", async (t) => {
  const { client, a, b } = await supersede(t, true);
  b.feed(HELLO);
  assert.deepEqual(b.ops(), ['resume'], 'the client holds a session, so it resumes it');

  a.feed({ op: 'invalid_session', d: { resumable: false, reason: 'old' } });
  a.feed({ op: 'resumed', d: { replayedEvents: 0 } });

  assert.deepEqual(b.ops(), ['resume'], 'no identify on the new socket for the old one\'s refusal');
  assert.equal(readyOf(client), false, "the old socket's resumed doesn't make the new session ready");
});

test("a connect() while the client's socket is still open closes that socket", async (t) => {
  const { client, created } = makeClient(t);
  const first = client.connect();
  const a = created[0];
  a.feed(HELLO);
  a.feed(readyFrame('s1'));
  await first;

  const second = client.connect();
  second.catch(() => {});
  assert.equal(created.length, 2, 'a new socket');
  assert.equal(a.readyState, 2, 'the replaced socket was asked to close');
  a.finish(1000);
  await sleep(60); // past any reconnect's backoff (maxBackoffMs 20)
  assert.equal(created.length, 2, "its close doesn't schedule a reconnect");
});

test('a call sent on the old socket still settles from its answer there', async (t) => {
  const { client, created } = makeClient(t);
  const first = client.connect();
  const a = created[0];
  a.feed(HELLO);
  a.feed(readyFrame('s1'));
  await first;
  const call = client.call('list_emojis', {});
  const id = a.frames().find((f) => f.op === 'rpc')?.d.id;
  assert.ok(id, 'the call went out on the old socket');

  client.close();
  const second = client.connect();
  second.catch(() => {});
  a.feed({ op: 'rpc_result', d: { id, ok: true, result: { emojis: [] } } });

  assert.deepEqual(await call, { emojis: [] });
});
