import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCache, type HistoryPage } from '../src/history-cache.js';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) })) as never[];

const page = (channelId: string, limit = 50, before?: string, after?: string): HistoryPage => ({
  channelId,
  limit,
  before,
  after,
});

function bot(n = 1) {
  let calls = 0;
  return {
    fetch: async () => {
      calls++;
      return msgs(n);
    },
    calls: () => calls,
  };
}

const cachedOnly = async (): Promise<never> => assert.fail('the cache read Discord');

test('hit within TTL, miss after TTL', async () => {
  let t = 1000;
  const c = new HistoryCache(5000, 500, () => t);
  const b = bot(3);
  assert.equal((await c.read(page('chan'), b.fetch)).length, 3);
  t = 1000 + 4999;
  assert.equal((await c.read(page('chan'), b.fetch)).length, 3);
  assert.equal(b.calls(), 1, 'still fresh at 4999ms');
  t = 1000 + 5000;
  await c.read(page('chan'), b.fetch);
  assert.equal(b.calls(), 2, 'expired at TTL');
});

test('a page lives for the TTL from when it is stored, not from when its read began', async () => {
  let t = 0;
  const c = new HistoryCache(5000, 500, () => t);
  await c.read(page('chan'), async () => {
    t = 6000;
    return msgs(1);
  });
  t = 6000 + 4999;
  assert.ok(await c.read(page('chan'), cachedOnly));
});

test('a read that returns or throws leaves no read under way', async () => {
  const c = new HistoryCache(5000, 500, () => 0);
  await c.read(page('a'), bot().fetch);
  await assert.rejects(
    c.read(page('b'), async () => {
      throw new Error('Discord refused the read');
    }),
  );
  assert.equal((c as unknown as { reading: Map<string, unknown> }).reading.size, 0);
});

test('distinct keys for cursors', async () => {
  const c = new HistoryCache(5000, 500, () => 0);
  await c.read(page('chan', 50, 'before1'), bot(1).fetch);
  await c.read(page('chan', 50, 'before2'), bot(2).fetch);
  assert.equal((await c.read(page('chan', 50, 'before1'), cachedOnly)).length, 1);
  assert.equal((await c.read(page('chan', 50, 'before2'), cachedOnly)).length, 2);
});

test('invalidate drops only that channel', async () => {
  const c = new HistoryCache(5000, 500, () => 0);
  await c.read(page('a'), bot().fetch);
  await c.read(page('b'), bot().fetch);
  c.invalidate('a');
  const again = bot();
  await c.read(page('a'), again.fetch);
  assert.equal(again.calls(), 1);
  assert.ok(await c.read(page('b'), cachedOnly));
});

test('ttl=0 disables the cache', async () => {
  const c = new HistoryCache(0, 500, () => 0);
  const b = bot();
  await c.read(page('a'), b.fetch);
  await c.read(page('a'), b.fetch);
  assert.equal(b.calls(), 2);
  assert.equal(c.enabled, false);
});

test('LRU eviction respects cap', async () => {
  const c = new HistoryCache(5000, 2, () => 0);
  await c.read(page('a', 1), bot().fetch);
  await c.read(page('b', 1), bot().fetch);
  await c.read(page('c', 1), bot().fetch); // evicts 'a' (oldest)
  assert.ok(await c.read(page('b', 1), cachedOnly));
  assert.ok(await c.read(page('c', 1), cachedOnly));
  const again = bot();
  await c.read(page('a', 1), again.fetch);
  assert.equal(again.calls(), 1);
});

test('a read whose place changed while it read returns its page and stores nothing; a read begun after the change stores its page', async () => {
  const c = new HistoryCache(5000, 500, () => 0);
  let answer!: () => void;
  const overtaken = c.read(page('chan'), () => new Promise((resolve) => (answer = () => resolve(msgs(1)))));
  c.invalidate('chan');
  answer();
  assert.equal((await overtaken).length, 1, 'the overtaken read still returns its page');
  const next = bot(2);
  assert.equal((await c.read(page('chan'), next.fetch)).length, 2);
  assert.equal(next.calls(), 1, 'the overtaken page was not stored');
  assert.equal((await c.read(page('chan'), cachedOnly)).length, 2, 'the read begun after the change stored its page');
});
