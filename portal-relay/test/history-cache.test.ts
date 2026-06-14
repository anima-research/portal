import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCache } from '../src/history-cache.js';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) })) as never[];

test('hit within TTL, miss after TTL', () => {
  let t = 1000;
  const c = new HistoryCache(5000, 500, () => t);
  c.set('chan', 50, undefined, undefined, msgs(3));
  assert.equal(c.get('chan', 50, undefined, undefined)?.length, 3);
  t = 1000 + 4999;
  assert.ok(c.get('chan', 50, undefined, undefined), 'still fresh at 4999ms');
  t = 1000 + 5000;
  assert.equal(c.get('chan', 50, undefined, undefined), undefined, 'expired at TTL');
});

test('distinct keys for cursors', () => {
  const c = new HistoryCache(5000, 500, () => 0);
  c.set('chan', 50, 'before1', undefined, msgs(1));
  c.set('chan', 50, 'before2', undefined, msgs(2));
  assert.equal(c.get('chan', 50, 'before1', undefined)?.length, 1);
  assert.equal(c.get('chan', 50, 'before2', undefined)?.length, 2);
});

test('invalidate drops only that channel', () => {
  const c = new HistoryCache(5000, 500, () => 0);
  c.set('a', 50, undefined, undefined, msgs(1));
  c.set('b', 50, undefined, undefined, msgs(1));
  c.invalidate('a');
  assert.equal(c.get('a', 50, undefined, undefined), undefined);
  assert.ok(c.get('b', 50, undefined, undefined));
});

test('ttl=0 disables the cache', () => {
  const c = new HistoryCache(0, 500, () => 0);
  c.set('a', 50, undefined, undefined, msgs(1));
  assert.equal(c.get('a', 50, undefined, undefined), undefined);
  assert.equal(c.enabled, false);
});

test('LRU eviction respects cap', () => {
  const c = new HistoryCache(5000, 2, () => 0);
  c.set('a', 1, undefined, undefined, msgs(1));
  c.set('b', 1, undefined, undefined, msgs(1));
  c.set('c', 1, undefined, undefined, msgs(1)); // evicts 'a' (oldest)
  assert.equal(c.get('a', 1, undefined, undefined), undefined);
  assert.ok(c.get('b', 1, undefined, undefined));
  assert.ok(c.get('c', 1, undefined, undefined));
});
