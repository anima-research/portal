import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TypedEmitter } from '../src/emitter.js';
import { PortalClient } from '../src/client.js';

test('emit isolates a throwing listener — others still run, caller unaffected', () => {
  const em = new TypedEmitter<{ x: () => void }>();
  let secondRan = false;
  em.on('x', () => {
    throw new Error('boom');
  });
  em.on('x', () => {
    secondRan = true;
  });
  assert.doesNotThrow(() => em.emit('x')); // must not propagate to caller
  assert.equal(secondRan, true); // subsequent listener still ran
});

/** Minimal ws stand-in: EventEmitter with the surface PortalClient touches. */
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
}

test('reconnect survives a throwing close listener and opens a new connection', async () => {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20, // keep the (jittered) delay tiny for the test
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w as unknown as import('ws').WebSocket;
    },
  });

  // A misbehaving close listener must NOT stall the reconnect loop.
  client.on('close', () => {
    throw new Error('boom');
  });

  client.connect().catch(() => {}); // opens ws #1; never resolves (no 'ready' frame)
  assert.equal(created.length, 1);

  created[0].emit('close', 1006); // simulate an unexpected drop
  await new Promise((r) => setTimeout(r, 60)); // > jittered backoff (≤20ms)

  assert.ok(created.length >= 2, 'a new connection was opened despite the throwing listener');
  client.close(); // stop further reconnects
});

test('a synchronous reconnect open failure emits error and keeps retrying', async () => {
  const created: FakeWs[] = [];
  let attempts = 0;
  const errors: Error[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20,
    wsFactory: () => {
      attempts++;
      if (attempts === 2) throw new Error('factory boom');
      const w = new FakeWs();
      created.push(w);
      return w;
    },
  });
  client.on('error', (error) => errors.push(error));

  client.connect().catch(() => {});
  assert.equal(attempts, 1);
  created[0].emit('close', 1006);
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(errors.some((error) => error.message === 'factory boom'));
  assert.ok(attempts >= 3, 'the reconnect loop retried after the synchronous throw');
  assert.ok(created.length >= 2, 'a later reconnect produced a socket');
  client.close();
});

test('auth rejection reconnects with the same persona credentials', async () => {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 'stable-token',
    personaId: 'stable-persona',
    maxBackoffMs: 20,
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w;
    },
  });

  client.connect().catch(() => {});
  created[0].emit('message', JSON.stringify({
    op: 'hello',
    d: { heartbeatIntervalMs: 60_000 },
  }));
  const firstIdentify = JSON.parse(created[0].sent.at(-1)!);
  assert.equal(firstIdentify.op, 'identify');
  assert.equal(firstIdentify.d.token, 'stable-token');
  assert.equal(firstIdentify.d.personaId, 'stable-persona');

  created[0].emit('close', 4001);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(created.length >= 2);
  const next = created.at(-1)!;
  next.emit('message', JSON.stringify({
    op: 'hello',
    d: { heartbeatIntervalMs: 60_000 },
  }));
  const secondIdentify = JSON.parse(next.sent.at(-1)!);
  assert.equal(secondIdentify.op, 'identify');
  assert.deepEqual(secondIdentify.d, firstIdentify.d,
    '4001 reconnect preserves the complete identity payload');
  client.close();
});
