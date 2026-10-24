import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

// A client that still holds its session resumes it on its next socket, and
// the relay answers a resume with `resumed` alone, after replaying what the
// session missed. connect() must settle on that answer as it does on `ready`.
// Issue #76.

/** A socket whose close event comes when the test calls finish(), and whose
 *  frames from the relay come when the test feeds them. */
class FakeWs extends EventEmitter {
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
  ops(): string[] {
    return this.sent.map((s) => JSON.parse(s).op);
  }
}

const HELLO = { op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 60_000 } };
const GUILD = { id: 'g1', name: 'Guild' };
const CHANNEL = { id: 'c1', guildId: 'g1', name: 'general', type: 'text' };
const READY = {
  op: 'ready',
  d: {
    sessionId: 's1',
    seq: 3,
    persona: { id: 'p', displayName: 'Before', avatarUrl: '' },
    guilds: [GUILD],
    channels: [CHANNEL],
  },
};
const RESUMED = { op: 'resumed', d: { replayedEvents: 1 } };
const RENAMED = { id: 'p', displayName: 'After', avatarUrl: '' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client whose sockets are FakeWs, closed when the test ends, pass or fail,
 *  so a failing check leaves no timer running. */
function makeClient(t: TestContext) {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20,
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w;
    },
  });
  t.after(() => client.close());
  return { client, created };
}

async function connectedClient(t: TestContext) {
  const { client, created } = makeClient(t);
  const first = client.connect();
  created[0].feed(HELLO);
  created[0].feed(READY);
  await first;
  return { client, created };
}

/** What a pending promise has done after a short wait. */
async function settled<T>(p: Promise<T>): Promise<{ value: T } | { error: unknown } | 'pending'> {
  return Promise.race([
    p.then((value) => ({ value }), (error: unknown) => ({ error })),
    sleep(30).then(() => 'pending' as const),
  ]);
}

test('a connect() after close() resolves when the relay resumes the session, with the session after its replay', async (t) => {
  const { client, created } = await connectedClient(t);
  client.close();
  created[0].finish(1000);

  const second = client.connect();
  const b = created[1];
  b.feed(HELLO);
  assert.equal(b.ops()[0], 'resume', 'the client still holds its session, so it resumes');
  b.feed({ op: 'dispatch', seq: 4, d: { type: 'persona_update', persona: RENAMED } });
  b.feed(RESUMED);

  assert.deepEqual(await settled(second), {
    value: { sessionId: 's1', seq: 4, persona: RENAMED, guilds: [GUILD], channels: [CHANNEL] },
  });
});

test('a connect() while a reconnect waits resolves when the relay resumes the session', async (t) => {
  const { client, created } = await connectedClient(t);
  created[0].finish(1006); // an unexpected drop: a reconnect waits for its backoff
  const second = client.connect();
  const b = created[1];
  b.feed(HELLO);
  assert.equal(b.ops()[0], 'resume');
  b.feed({ op: 'resumed', d: { replayedEvents: 0 } });

  assert.deepEqual(await settled(second), {
    value: { sessionId: 's1', seq: 3, persona: READY.d.persona, guilds: [GUILD], channels: [CHANNEL] },
  });
});

test("a resumed frame for no session the client holds doesn't settle connect(), and its ready does", async (t) => {
  const { client, created } = makeClient(t);
  const first = client.connect();
  const a = created[0];
  a.feed(HELLO);
  assert.equal(a.ops()[0], 'identify', 'a new client holds no session');
  a.feed({ op: 'resumed', d: { replayedEvents: 0 } });
  assert.equal(await settled(first), 'pending');

  a.feed(READY);
  assert.deepEqual(await settled(first), { value: READY.d });
});

test("a connect() whose socket the factory can't make leaves none of its listeners behind", async (t) => {
  const { client } = makeClient(t);
  const opts = (client as unknown as { opts: { wsFactory: (url: string) => unknown } }).opts;
  opts.wsFactory = () => {
    throw new Error('no socket now');
  };
  await assert.rejects(client.connect(), /no socket now/);

  const listeners = (client as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
  for (const event of ['ready', 'resumed', 'error']) {
    assert.equal(listeners.get(event)?.size ?? 0, 0, `no ${event} listener left`);
  }
});
