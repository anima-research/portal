import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

// After close() and connect(), the old socket can still deliver events while
// its closing handshake runs. Those events belong to a session the client has
// left, so only the socket the client now uses may act on it, with one
// exception: an rpc_result on the old socket still settles the call it
// carried (the last test). Issue #75.

/** A socket whose close() starts the closing handshake: its close event comes
 *  only when the test calls finish(), as a real socket's does once the relay
 *  answers the close. One made with `connecting` is still CONNECTING, and its
 *  close() aborts the handshake, with error and close a tick later, as ws and
 *  browsers do. */
class ClosingWs extends EventEmitter {
  readyState: number;
  readonly OPEN = 1;
  sent: string[] = [];
  constructor(connecting = false) {
    super();
    this.readyState = connecting ? 0 : 1;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 0) {
      this.readyState = 2;
      setImmediate(() => {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
        this.finish(1006);
      });
      return;
    }
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
const RESUMED = { op: 'resumed', d: { replayedEvents: 0 } };
const REFUSED = { op: 'invalid_session', d: { resumable: false, reason: 'unknown session' } };
const readyOf = (c: PortalClient) => (c as unknown as { ready?: boolean }).ready;
const internals = (c: PortalClient) =>
  c as unknown as { reconnectTimer?: unknown; heartbeat?: unknown };

/** Wait until `check` holds, polling, and fail if it doesn't within `ms`. */
async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const heartbeats = (w: ClosingWs) => w.frames().filter((f) => f.op === 'heartbeat') as unknown as Array<{ d: { seq: number } }>;

/** A client whose sockets are ClosingWs. It's closed when the test ends,
 *  pass or fail, so a failing check leaves no heartbeat or reconnect timer
 *  running. */
function makeClient(t: TestContext, connecting = false) {
  const created: ClosingWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20,
    wsFactory: () => {
      const w = new ClosingWs(connecting);
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
  const { client, created, a, b } = await supersede(t, true);
  b.feed(HELLO);
  assert.equal(b.ops()[0], 'resume');
  b.feed(RESUMED);
  const closes: unknown[] = [];
  client.on('close', (e) => closes.push(e));

  a.finish(1000);
  assert.equal(internals(client).reconnectTimer, undefined, 'no reconnect is scheduled');
  assert.deepEqual(closes, [], 'no close event for the old socket');
  assert.equal(readyOf(client), true, 'the new session stays ready');
  const before = heartbeats(b).length;
  await until(() => heartbeats(b).length > before, 'a heartbeat on the new socket');
  assert.equal(created.length, 2, 'no third socket');
});

test("the old socket's late ready isn't taken for the new connection", async (t) => {
  const { a, b, second } = await supersede(t, false);
  let resolvedWith: string | undefined;
  void second.then((d) => (resolvedWith = d.sessionId));

  a.feed(readyFrame('s1'));
  await new Promise((resolve) => setImmediate(resolve));
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
  b.feed(REFUSED); // the relay refuses the resume, so the client identifies
  assert.deepEqual(b.ops(), ['resume', 'identify']);
  b.feed(readyFrame('s2'));
  const d = await second;

  assert.equal(d.sessionId, 's2');
  assert.deepEqual(errors, [], 'the old socket\'s error is not the client\'s');
});

test("the old socket's late events and hello don't reach the client", async (t) => {
  const { a, b, client } = await supersede(t, true);
  const events: unknown[] = [];
  client.on('event', (e) => events.push(e));
  b.feed(HELLO);
  b.feed(RESUMED);

  // The old socket's comes last, so if it moved lastSeq the heartbeat would
  // carry its seq.
  b.feed({ op: 'dispatch', seq: 1, d: { type: 'voice_status', channelId: 'c', guildId: null, joined: false } });
  a.feed({ op: 'dispatch', seq: 5, d: { type: 'voice_status', channelId: 'c', guildId: null, joined: true } });
  a.feed({ op: 'dispatch_ephemeral', d: { type: 'voice_status', channelId: 'c', guildId: null, joined: true } });

  assert.deepEqual(events, [{ type: 'voice_status', channelId: 'c', guildId: null, joined: false }]);

  // A hello on the old socket would restart the heartbeat at its interval and
  // send a resume on the new socket.
  a.feed({ op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 60_000 } });
  assert.deepEqual(b.ops().filter((op) => op !== 'heartbeat'), ['resume'], 'no second resume or identify on the new socket');

  const before = heartbeats(b).length;
  await until(() => heartbeats(b).length > before, 'a heartbeat on the new socket at its own 10 ms interval');
  assert.equal(heartbeats(b).at(-1)?.d.seq, 1, "the new session's heartbeat carries its own seq, not the old socket's");
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
  assert.equal(created.length, 2, 'a new socket');
  const b = created[1];
  assert.equal(a.readyState, 2, 'the replaced socket was asked to close');
  assert.equal(readyOf(client), false, "the new socket hasn't identified");
  assert.equal(internals(client).heartbeat, undefined, "the replaced session's heartbeat stopped");
  const call = client.call('list_emojis', {});
  assert.deepEqual(b.ops(), [], 'the call waits for the new session');

  a.finish(1000);
  assert.equal(internals(client).reconnectTimer, undefined, "the replaced socket's close schedules no reconnect");

  b.feed(HELLO);
  b.feed(REFUSED);
  b.feed(readyFrame('s2'));
  assert.equal((await second).sessionId, 's2');
  assert.deepEqual(b.ops(), ['resume', 'identify', 'rpc:list_emojis'], 'the call goes out once the new session is ready');
  const id = b.frames().find((f) => f.op === 'rpc')?.d.id;
  b.feed({ op: 'rpc_result', d: { id, ok: true, result: { emojis: [] } } });
  assert.deepEqual(await call, { emojis: [] });
});

test("a connect() while the client's socket is still connecting aborts it, and the abort doesn't reach the client", async (t) => {
  const { client, created } = makeClient(t, true);
  const errors: Error[] = [];
  client.on('error', (e) => errors.push(e));
  const first = client.connect();
  first.catch(() => {});
  const a = created[0];

  const second = client.connect();
  const b = created[1];
  assert.equal(a.readyState, 2, 'the connecting socket was asked to close');
  await until(() => a.readyState === 3, "the aborted socket's error and close");
  assert.deepEqual(errors, [], "the aborted socket's error isn't the client's");
  assert.equal(internals(client).reconnectTimer, undefined, "its close schedules no reconnect");

  b.readyState = 1;
  b.feed(HELLO);
  b.feed(readyFrame('s2'));
  assert.equal((await second).sessionId, 's2');
  assert.equal(created.length, 2, 'no third socket');
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
