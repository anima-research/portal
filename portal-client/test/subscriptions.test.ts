import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '../src/client.js';

type ClientInternals = {
  opts: { subscriptions?: string[] };
  call(method: string, params: unknown): Promise<unknown>;
};

test('failed subscribe rolls back reconnect state', async () => {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const internal = client as unknown as ClientInternals;
  internal.call = async () => {
    throw new Error('denied');
  };

  await assert.rejects(client.subscribe('c1'), /denied/);
  assert.deepEqual(internal.opts.subscriptions, []);
});

test('failed unsubscribe restores reconnect state', async () => {
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    subscriptions: ['c1', 'c2'],
  });
  const internal = client as unknown as ClientInternals;
  internal.call = async () => {
    throw new Error('relay unavailable');
  };
  // Before any ready the cache is empty, and the undo reads no cache.
  await assert.rejects(client.unsubscribe('c1'), /relay unavailable/);
  // Back in the list, at its end: the order a reconnect asks in means nothing.
  assert.deepEqual([...(internal.opts.subscriptions ?? [])].sort(), ['c1', 'c2']);
});
