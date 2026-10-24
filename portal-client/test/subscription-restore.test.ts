// A resumed relay session starts with no ambient subscriptions (portal-relay
// gateway.ts onResume; identify carries them, a resume doesn't), so the client
// asks for them again on a resume. A failed subscribe or unsubscribe changes
// nothing in the list, unless a caller asks for its change to stand, and since
// it can still have reached the relay, the relay is told the list's state for
// the channel when it was the newest call there. These drive the real client
// over a fake socket.
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
   *  carried for `method` and `channelId`, a success with `result`. */
  answer(method: string, channelId: string, ok: boolean, nth = 0, result: unknown = {}): void {
    const rpc = this.sent.filter((f) => f.op === 'rpc' && f.d.method === method && f.d.params?.channelId === channelId).at(nth);
    assert.ok(rpc, `no ${method} for ${channelId} (#${nth}) was sent`);
    this.frame(ok
      ? { op: 'rpc_result', d: { id: rpc.d.id, ok: true, result } }
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
  // The client holds the two calls below while its socket is down and sends
  // them after the resume, where nothing answers them, so they time out. The
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

test('a failed unsubscribe puts the channel back even after the relay removed it', async (t) => {
  // The caller still holds the channel open, as the failure told it. A caller
  // whose removal must hold whatever the relay answers says undo: false.
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  const ws = sockets[0];
  const closing = client.unsubscribe('c1');
  client.cache.apply({ type: 'channel_delete', channelId: 'c1', guildId: 'g' });
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(closing, /refused c1/);
  assert.deepEqual(listOf(client), ['c1', 'c2']);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('an unsubscribe with undo false keeps the channel out of the list when it fails', async (t) => {
  const { client, sockets } = await connected(t, ['c1', 'c2']);
  const ws = sockets[0];
  const removing = client.unsubscribe('c1', { undo: false });
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(removing, /refused c1/);
  assert.deepEqual(listOf(client), ['c2']);
  assert.deepEqual(ws.subscriptionCalls(), [['unsubscribe_channel', 'c1'], ['unsubscribe_channel', 'c1']]);
});

test('a subscribe with undo false keeps the channel listed when it fails, and the next resume asks for it again', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const ws = sockets[0];
  const reopening = client.subscribe('c3', { undo: false });
  ws.answer('subscribe_channel', 'c3', false);
  await assert.rejects(reopening, /refused c3/);
  assert.deepEqual(listOf(client), ['c1', 'c3']);
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c3'], ['subscribe_channel', 'c3']]);
  drop(ws);
  const next = await resumedSocket(sockets, 1);
  assert.deepEqual(next.subscriptionCalls().map(([, channel]) => channel).sort(), ['c1', 'c3']);
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
  // The list didn't hold c3 before the call, so it doesn't after the failure.
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

test('when two subscribes of a channel both fail, the list ends as it was before them', async (t) => {
  // As one failed subscribe does. While the older call still waits, the list
  // holds what it asks for; once it fails too, nothing that stood listed c1.
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const older = client.subscribe('c1');
  const newer = client.subscribe('c1');
  ws.answer('subscribe_channel', 'c1', false, 1);
  await assert.rejects(newer, /refused c1/);
  assert.deepEqual(listOf(client), ['c1'], 'the older call is still out');
  ws.answer('subscribe_channel', 'c1', false, 0);
  await assert.rejects(older, /refused c1/);
  assert.deepEqual(listOf(client), []);
  assert.deepEqual(ws.subscriptionCalls(), [
    ['subscribe_channel', 'c1'], ['subscribe_channel', 'c1'], ['subscribe_channel', 'c1'], ['unsubscribe_channel', 'c1'],
  ]);
});

test('an unsubscribe that fails after an older subscribe of the channel succeeded leaves it listed', async (t) => {
  // The subscribe stood, so the failed unsubscribe changes nothing: the list
  // holds what it held before the unsubscribe, not before the subscribe.
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const opening = client.subscribe('c1');
  const closing = client.unsubscribe('c1');
  ws.answer('subscribe_channel', 'c1', true);
  await opening;
  assert.deepEqual(listOf(client), [], 'the unsubscribe is still out');
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(closing, /refused c1/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(ws.subscriptionCalls(), [['subscribe_channel', 'c1'], ['unsubscribe_channel', 'c1'], ['subscribe_channel', 'c1']]);
});

test('a subscribe whose frame a dropped socket lost times out after a newer one succeeded, and leaves the channel to it', async (t) => {
  // The case the newest call is for: the older call can only time out, after
  // the resume and the newer call have settled the channel.
  const { client, sockets } = await connected(t, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Sent on the first socket, so its frame goes with it. A call made after
  // the drop would be held and sent after the resume instead.
  const older = client.subscribe('c1').catch((error: unknown) => error);
  assert.deepEqual(sockets[0].subscriptionCalls(), [['subscribe_channel', 'c1']], 'its frame went out on the first socket');
  drop(sockets[0]);
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

test('a call whose frame a dropped socket lost, timing out while a later call on the channel waits, leaves the channel to it', async (t) => {
  // A call that stood passed over the lost one, so its timeout finds it in no
  // run and changes nothing, though a later call has started a run since.
  const { client, sockets } = await connected(t, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Sent on the first socket, so its frame goes with it.
  const lost = client.unsubscribe('c1').catch((error: unknown) => error);
  assert.deepEqual(sockets[0].subscriptionCalls(), [['unsubscribe_channel', 'c1']], 'its frame went out on the first socket');
  drop(sockets[0]);
  t.mock.timers.tick(20); // the reconnect, due within maxBackoffMs
  const ws = resume(sockets[1]);
  const standing = client.unsubscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', true, -1);
  await standing;
  const waiting = client.subscribe('c1');
  assert.deepEqual(listOf(client), ['c1'], 'the waiting subscribe lists it');
  t.mock.timers.tick(280); // the lost call times out (made at 0, rpcTimeoutMs 300); the waiting one, made at 20, doesn't
  assert.match(String(await lost), /timed out/);
  assert.deepEqual(listOf(client), ['c1'], 'still the waiting call\'s');
  ws.answer('subscribe_channel', 'c1', true, -1);
  await waiting;
  assert.deepEqual(listOf(client), ['c1']);
});

test('a newer call that fails after an older one on the channel settled still undoes its change', async (t) => {
  // The older call's success leaves the newer call deciding the channel.
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

test('a channel keeps no record of its calls once none is waiting', async (t) => {
  // A long-running client meets many short-lived channels, such as threads.
  const { client, sockets } = await connected(t, []);
  const ws = sockets[0];
  const runs = () => (client as unknown as { subscriptionRuns: Map<string, unknown> }).subscriptionRuns;
  const subscribing = client.subscribe('c1');
  assert.equal(runs().size, 1, 'a waiting call is recorded');
  ws.answer('subscribe_channel', 'c1', true);
  await subscribing;
  assert.equal(runs().size, 0, 'none after a call that succeeded');
  const failing = client.unsubscribe('c1');
  ws.answer('unsubscribe_channel', 'c1', false);
  await assert.rejects(failing, /refused c1/);
  assert.equal(runs().size, 0, 'none after a call that failed');
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

test('a resumed frame that arrives after close() asks the relay for nothing', async (t) => {
  // As for a reassert: the next connect() asks the relay for the list itself
  // (it resumes and restores it, or identifies with it), and a call now would
  // only start a timer.
  const { client, sockets } = await connected(t, ['c1']);
  client.close();
  sockets[0].frame({ op: 'resumed', d: { replayedEvents: 0 } });
  assert.deepEqual(sockets[0].subscriptionCalls(), []);
  const pending = (client as unknown as { pending: Map<string, unknown> }).pending;
  assert.equal(pending.size, 0, 'no call left waiting, so no timer');
});

test('close() while a reconnect waits for its backoff cancels it, so a closed client stays closed', async (t) => {
  // A reconnect would resume the session and ask for the list again, for a
  // client nobody listens to any more, such as the identity a switch left.
  const { client, sockets } = await connected(t, ['c1']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  assert.ok((client as unknown as { reconnectTimer?: unknown }).reconnectTimer, 'a reconnect is waiting');
  client.close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 1, 'no new socket');
});

test('a connect() while a reconnect waits for its backoff takes its place, so only one socket opens', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  assert.ok((client as unknown as { reconnectTimer?: unknown }).reconnectTimer, 'a reconnect is waiting');
  void client.connect().catch(() => {});
  assert.equal(sockets.length, 2, "connect()'s socket");
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2, 'no socket from the waiting reconnect');
});

test("a connect() whose socket the factory can't make, while a reconnect waits, leaves the reconnect to try again", async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  assert.ok((client as unknown as { reconnectTimer?: unknown }).reconnectTimer, 'a reconnect is waiting');
  const opts = (client as unknown as { opts: { wsFactory: (url: string) => unknown } }).opts;
  const factory = opts.wsFactory;
  opts.wsFactory = () => {
    opts.wsFactory = factory;
    throw new Error('no socket now');
  };
  await assert.rejects(client.connect(), /no socket now/);
  assert.equal(sockets.length, 1, 'connect() made no socket');
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2, 'the waiting reconnect opened one');
});

test('a second close while a reconnect waits leaves one reconnect, which close() cancels', async (t) => {
  // A close event that arrives late, from the same socket or an earlier one.
  const { client, sockets } = await connected(t, ['c1']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  drop(sockets[0]);
  drop(sockets[0]);
  assert.ok((client as unknown as { reconnectTimer?: unknown }).reconnectTimer, 'a reconnect is waiting');
  client.close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 1, 'no new socket');
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

// voice_join subscribes the session to its channel as the relay joins it
// (portal-relay relay.ts, voice_join), and the relay stays in the channel
// across a reconnect, so the channel goes in the list like a subscribe's.
// Issue #77.

test('a voice_join that succeeded is listed, so a resume asks for its transcripts again', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  sockets[0].answer('voice_join', 'c3', true, 0, { listening: true });
  assert.deepEqual(await joining, { listening: true }, "voiceJoin() resolves with the relay's answer");
  assert.deepEqual(listOf(client), ['c1', 'c3']);

  drop(sockets[0]);
  const next = await resumedSocket(sockets, 1);
  assert.deepEqual(next.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c3']]);
});

test('after a voice_join, an identify the relay asks for carries its channel', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  sockets[0].answer('voice_join', 'c3', true);
  await joining;

  drop(sockets[0]);
  for (let i = 0; i < 100 && sockets.length === 1; i++) await new Promise((r) => setTimeout(r, 5));
  const next = sockets[1];
  next.frame({ op: 'hello', d: { heartbeatIntervalMs: 60_000 } });
  next.frame({ op: 'invalid_session', d: { resumable: false, reason: 'resume window exceeded' } });
  const identify = next.sent.find((f) => f.op === 'identify') as { d: { subscriptions?: string[] } } | undefined;
  assert.deepEqual([...(identify?.d.subscriptions ?? [])].sort(), ['c1', 'c3']);
});

test('a voice_join that fails leaves the list as it was, and the relay is told so', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  assert.deepEqual(listOf(client), ['c1', 'c3'], 'listed while it waits, as a subscribe is');
  sockets[0].answer('voice_join', 'c3', false);
  await assert.rejects(joining, /refused c3/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(sockets[0].subscriptionCalls(), [['unsubscribe_channel', 'c3']]);
});

test('a voice_join that fails on a channel already listed keeps it listed, and the relay is told so', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c1');
  sockets[0].answer('voice_join', 'c1', false);
  await assert.rejects(joining, /refused c1/);
  assert.deepEqual(listOf(client), ['c1']);
  assert.deepEqual(sockets[0].subscriptionCalls(), [['subscribe_channel', 'c1']]);
});

test('a voice_join and an unsubscribe made after it leave the channel unlisted when the unsubscribe answers first', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  const unsubscribing = client.unsubscribe('c3');
  sockets[0].answer('unsubscribe_channel', 'c3', true);
  assert.deepEqual(listOf(client), ['c1']);
  sockets[0].answer('voice_join', 'c3', true);
  await Promise.all([joining, unsubscribing]);
  assert.deepEqual(listOf(client), ['c1'], "the older join's answer changes nothing");
});

test('a voice_join and an unsubscribe made after it leave the channel unlisted when the join answers first', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  const unsubscribing = client.unsubscribe('c3');
  sockets[0].answer('voice_join', 'c3', true);
  await joining;
  assert.deepEqual(listOf(client), ['c1'], 'the newer unsubscribe still decides while it waits');
  sockets[0].answer('unsubscribe_channel', 'c3', true);
  await unsubscribing;
  assert.deepEqual(listOf(client), ['c1']);
});

test('a voice_leave leaves the joined channel listed, as the relay leaves it subscribed, until unsubscribe()', async (t) => {
  const { client, sockets } = await connected(t, ['c1']);
  const joining = client.voiceJoin('c3');
  sockets[0].answer('voice_join', 'c3', true);
  await joining;
  const leaving = client.voiceLeave('c3');
  sockets[0].answer('voice_leave', 'c3', true);
  await leaving;
  assert.deepEqual(listOf(client), ['c1', 'c3']);
  drop(sockets[0]);
  const next = await resumedSocket(sockets, 1);
  assert.deepEqual(next.subscriptionCalls(), [['subscribe_channel', 'c1'], ['subscribe_channel', 'c3']], 'a resume asks for it again');
  next.answer('subscribe_channel', 'c1', true);
  next.answer('subscribe_channel', 'c3', true);
  await tick();

  const unsubscribing = client.unsubscribe('c3');
  next.answer('unsubscribe_channel', 'c3', true);
  await unsubscribing;
  assert.deepEqual(listOf(client), ['c1']);
});
