// A resumed relay session starts with no ambient subscriptions (portal-relay
// gateway.ts onResume; identify carries them, a resume doesn't), so the client
// asks for them again on a resume. A failed subscribe or unsubscribe can still
// have reached the relay, so while it's the newest call on its channel the
// client undoes its change and tells the relay the list's state for that
// channel. These drive the real client over a fake socket.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

type Frame = { op: string; d: { id?: string; method?: string; params?: { channelId?: string } } };

/** A ws stand-in carrying frames both ways, as reconnect.test.ts's does. */
class FakeWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: Frame[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  /** A frame from the relay. */
  frame(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
  /** The subscription RPCs this socket carried, in order, as [method, channel]. */
  subscriptionCalls(): Array<[string, string | undefined]> {
    return this.sent
      .filter((f) => f.op === 'rpc' && /subscribe_channel$/.test(f.d.method ?? ''))
      .map((f) => [f.d.method!, f.d.params?.channelId]);
  }
  /** Answer the nth (from 0, or from the end when negative) RPC this socket
   *  carried for `method` and `channelId`. */
  answer(method: string, channelId: string, ok: boolean, nth = 0): void {
    const rpc = this.sent.filter((f) => f.op === 'rpc' && f.d.method === method && f.d.params?.channelId === channelId).at(nth);
    assert.ok(rpc, `no ${method} for ${channelId} (#${nth}) was sent`);
    this.frame(ok
      ? { op: 'rpc_result', d: { id: rpc.d.id, ok: true, result: {} } }
      : { op: 'rpc_result', d: { id: rpc.d.id, ok: false, error: { code: 'forbidden', message: `refused ${channelId}` } } });
  }
}

const READY = {
  sessionId: 's1', seq: 0, persona: { id: 'p', displayName: 'P', avatarUrl: '' },
  guilds: [{ id: 'g', name: 'G' }],
  channels: ['c1', 'c2', 'c3'].map((id) => ({ id, guildId: 'g', name: id, type: 'text', capabilities: ['VIEW_CHANNEL'] })),
  capabilities: {}, subscriptions: [],
};

/** The list a reconnect restores, sorted: its order means nothing. */
const listOf = (client: PortalClient): string[] =>
  [...((client as unknown as { opts: { subscriptions?: string[] } }).opts.subscriptions ?? [])].sort();

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A client that identified and got ready on its first socket, closed when
 *  the test ends however it ends, so no heartbeat or reconnect outlives it. */
async function connected(t: TestContext, subscriptions: string[]) {
  const sockets: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test', token: 't', personaId: 'p', subscriptions,
    maxBackoffMs: 20, rpcTimeoutMs: 300,
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws as unknown as import('ws').WebSocket;
    },
  });
  t.after(() => client.close());
  const errors: Error[] = [];
  client.on('error', (err) => errors.push(err));
  const ready = client.connect();
  sockets[0].frame({ op: 'hello', d: { heartbeatIntervalMs: 60_000 } });
  sockets[0].frame({ op: 'ready', d: READY });
  await ready;
  return { client, sockets, errors };
}

/** Drop the socket the client is on, as a network fault does. */
function drop(socket: FakeWs): void {
  socket.readyState = 3;
  socket.emit('close', 1006);
}

/** Greet the client on its new socket and resume its session there. */
function resume(ws: FakeWs): FakeWs {
  ws.frame({ op: 'hello', d: { heartbeatIntervalMs: 60_000 } });
  assert.equal(ws.sent.at(-1)?.op, 'resume', 'the client resumes rather than identifying');
  ws.frame({ op: 'resumed', d: { replayedEvents: 0 } });
  return ws;
}

/** The client's next socket, once its reconnect has opened it and resumed. */
async function resumedSocket(sockets: FakeWs[], before: number): Promise<FakeWs> {
  for (let i = 0; i < 100 && sockets.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sockets.length > before, 'the client reconnected');
  return resume(sockets.at(-1)!);
}

test('a resume asks the relay for each subscription again, before resumed is emitted', async (t) => {
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  let askedBeforeResumed: Array<[string, string | undefined]> | undefined;
  client.on('resumed', () => {
    askedBeforeResumed = sockets.at(-1)!.subscriptionCalls();
  });
  drop(sockets[0]);
  const ws = await resumedSocket(sockets, 1);
  assert.deepEqual(askedBeforeResumed, [['subscribe_channel', 'c1'], ['subscribe_channel', 'c2']]);
  ws.answer('subscribe_channel', 'c1', true);
  ws.answer('subscribe_channel', 'c2', true);
});

test('a resume asks for the list as it stands, with changes made while the socket was down', async (t) => {
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  // The two calls below can only time out, since their frames go nowhere. The
  // clock is held, so they can't time out before the resume however slowly
  // this runs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  const closing = client.unsubscribe('c1').catch(() => {});
  const opening = client.subscribe('c3').catch(() => {});
  t.mock.timers.tick(20); // the reconnect, due within maxBackoffMs
  assert.equal(sockets.length, 2, 'the client reconnected');
  const ws = resume(sockets[1]);
  const asked = new Set(ws.subscriptionCalls().filter(([method]) => method === 'subscribe_channel').map(([, id]) => id));
  assert.deepEqual([...asked].sort(), ['c2', 'c3'], 'the replay asks for c2 and c3, and nothing asks for c1');
  t.mock.timers.tick(300); // now the two calls time out
  await Promise.all([closing, opening]);
});

test('a failed subscribe leaves the list and unsubscribes the channel on the relay', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const opening = client.subscribe('c3');
  assert.deepEqual(listOf(client), ['c1', 'c3']);
  ws.answer('subscribe_channel', 'c3', false);
  await assert.rejects(opening, /refused c3/);
  assert.deepEqual(listOf(client), ['c1']);
  // Its reply could have been the only thing lost: the relay hears the list's
  // state once.
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c3'], ['unsubscribe_channel', 'c3']]);
});

test('a failed unsubscribe puts the channel back in the list and subscribes it on the relay', async (t) => {
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  const ws = sockets[0];
  const closing = client.unsubscribe('c1');
  assert.deepEqual(listOf(client), ['c2']);
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(closing, /refused c1/);
  assert.deepEqual(listOf(client), ['c1', 'c2']);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('a failed unsubscribe leaves out a channel the relay removed while it waited', async (t) => {
  // Putting it back would only have every reconnect ask for a channel that
  // can't be subscribed.
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  const ws = sockets[0];
  const closing = client.unsubscribe('c1');
  client.cache.apply({ type: 'channel_delete', channelId: 'c1', guildId: 'g' });
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(closing, /refused c1/);
  assert.deepEqual(listOf(client), ['c2']);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['unsubscribe_channel', 'c1']]);
});

test('a failed subscribe of a channel already in the list leaves it there', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const opening = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', false);
  await assert.rejects(opening, /refused c1/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('a failed unsubscribe of a channel not in the list leaves it out', async (t) => {
  // c3 is in the cache, so only the call having taken nothing out keeps it out.
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const closing = client.unsubscribe('c3');
  ws.answer('unsubscribe_channel', 'c3', false);
  await assert.rejects(closing, /refused c3/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c3'], ['unsubscribe_channel', 'c3']]);
});

test('a refused reassert changes nothing more, and nothing rejects or reports an error', async (t) => {
  const { client, sockets, errors } = await connected(t, []);
  const ws = sockets[0];
  const opening = client.subscribe('c3');
  ws.answer('subscribe_channel', 'c3', false);
  await assert.rejects(opening, /refused c3/);
  ws.answer('unsubscribe_channel', 'c3', false);
  await tick();
  assert.deepEqual(listOf(client), []);
  assert.deepEqual(errors, []);
});

test('a failed unsubscribe keeps the change another call made while it waited', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const closing = client.unsubscribe('c1');
  const opening = client.subscribe('c2');
  ws.answer('subscribe_channel', 'c2', true);
  await opening;
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(closing, /refused c1/);
  assert.deepEqual(listOf(client), ['c1', 'c2']);
});

test('a failed subscribe keeps the change another call made while it waited', async (t) => {
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  const ws = sockets[0];
  const opening = client.subscribe('c3');
  const closing = client.unsubscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', true);
  await closing;
  ws.answer('subscribe_channel', 'c3', false);
  await assert.rejects(opening, /refused c3/);
  assert.deepEqual(listOf(client), ['c2']);
});

test('an older subscribe that fails leaves the channel to a newer call on it that succeeded', async (t) => {
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const older = client.subscribe('c1');
  const newer = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', true, 1);
  await newer;
  ws.answer('subscribe_channel', 'c1', false, 0);
  await assert.rejects(older, /refused c1/);
  assert.deepEqual(listOf(client), ['c1']);
  // Nothing tells the relay otherwise: the newer call decided the channel.
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('an older unsubscribe that fails leaves the channel to a newer call on it that succeeded', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const older = client.unsubscribe('c1');
  const newer = client.unsubscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', true, 1);
  await newer;
  ws.answer('unsubscribe_channel', 'c1', false, 0);
  await assert.rejects(older, /refused c1/);
  assert.deepEqual(listOf(client), []);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['unsubscribe_channel', 'c1']]);
});

test('an older subscribe that fails while a newer one on the channel waits leaves the channel to it', async (t) => {
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const older = client.subscribe('c1');
  const newer = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', false, 0);
  await assert.rejects(older, /refused c1/);
  assert.deepEqual(listOf(client), ['c1'], 'the newer call is still out');
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
  ws.answer('subscribe_channel', 'c1', true, 1);
  await newer;
  assert.deepEqual(listOf(client), ['c1']);
});

test('when two subscribes of a channel both fail, the list ends as the newer one found it', async (t) => {
  // The newer call found the channel listed by the older one, so it has
  // nothing of its own to take back, and the relay hears the list's state once.
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const older = client.subscribe('c1');
  const newer = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', false, 1);
  await assert.rejects(newer, /refused c1/);
  ws.answer('subscribe_channel', 'c1', false, 0);
  await assert.rejects(older, /refused c1/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('a subscribe whose frame a dropped socket lost times out after a newer one succeeded, and leaves the channel to it', async (t) => {
  // The case the newest call is for: the older call can only time out, after
  // the resume and the newer call have settled the channel.
  const { client, sockets } = await connected(t, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  const older = client.subscribe('c1').catch((error: unknown) => error);
  t.mock.timers.tick(20); // the reconnect, due within maxBackoffMs
  const ws = resume(sockets[1]);
  const newer = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', true, -1); // the newer call's is the last
  await newer;
  t.mock.timers.tick(300); // the older call times out
  assert.match(String(await older), /timed out/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.ok(!ws.subscriptionCalls().some(([method]) => method === 'unsubscribe_channel'), 'nothing unsubscribed it');
});

test('a newer call that fails after an older one on the channel settled still undoes its change', async (t) => {
  // The older call's settling leaves the newer call's number in place.
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const older = client.unsubscribe('c1');
  const newer = client.subscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', true);
  await older;
  ws.answer('subscribe_channel', 'c1', false);
  await assert.rejects(newer, /refused c1/);
  assert.deepEqual(listOf(client), [], 'the failed subscribe takes c1 back out');
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['subscribe_channel', 'c1'], ['unsubscribe_channel', 'c1']]);
});

test('a settled call leaves no number behind for its channel', async (t) => {
  // A long-running client meets many short-lived channels, such as threads.
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const numbers = () => (client as unknown as { newestSubscriptionCall: Map<string, number> }).newestSubscriptionCall;
  const subscribing = client.subscribe('c1');
  assert.equal(numbers().size, 1, 'a waiting call keeps its number');
  ws.answer('subscribe_channel', 'c1', true);
  await subscribing;
  assert.equal(numbers().size, 0, 'none after a call that succeeded');
  const failing = client.unsubscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(failing, /refused c1/);
  assert.equal(numbers().size, 0, 'none after a call that failed');
});

test('a call still waiting at close() sends no reassert when it times out', async (t) => {
  // Nothing would hear it, and its timer would keep the process up for another
  // rpcTimeoutMs. The undo still runs, so the next connect() sends the list as
  // the call left it.
  const { client } = await connected(t, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const subscribing = client.subscribe('c1').catch((error: unknown) => error);
  client.close();
  t.mock.timers.tick(300); // the call's timeout (rpcTimeoutMs 300)
  assert.match(String(await subscribing), /timed out/);
  assert.deepEqual(listOf(client), []);
  const pending = (client as unknown as { pending: Map<string, unknown> }).pending;
  assert.equal(pending.size, 0, 'no call left waiting, so no timer');
});

test('a channel the relay refuses on a resume stays in the list, and nothing rejects or reports an error', async (t) => {
  const { client, sockets, errors } = await connected(t, ['c1']);
  drop(sockets[0]);
  const first = await resumedSocket(sockets, 1);
  first.answer('subscribe_channel', 'c1', false);
  await tick();
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(errors, []);
  // The next resume asks again, as an identify would.
  drop(first);
  const second = await resumedSocket(sockets, 2);
  assert.deepEqual(second.subscriptionCalls(), [['subscribe_channel', 'c1']]);
  second.answer('subscribe_channel', 'c1', true);
});
