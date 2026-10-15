import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelNameResolver, clipToGuild, type ChannelFetch, type ChannelSource } from '../src/admin/names.js';
import type { ChannelMeta } from '../src/discord-bot.js';

const text = (id: string, name: string, guildId = 'G1'): ChannelMeta =>
  ({ id, name, type: 'text', guildId, isThread: false });
const thread = (id: string, name: string, parentId: string, archived = true, guildId = 'G1'): ChannelMeta =>
  ({ id, name, type: 'thread', guildId, parentId, archived, isThread: true });

/** A source whose cache and REST answers are scripted; counts fetches. */
function source(cache: ChannelMeta[], rest: Record<string, ChannelFetch | Error | (() => Promise<ChannelFetch>)>) {
  const byId = new Map(cache.map((c) => [c.id, c]));
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const src: ChannelSource = {
    cached: (id) => byId.get(id) ?? null,
    fetch: async (id) => {
      calls.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setImmediate(r));
        const v = rest[id];
        if (v instanceof Error) throw v;
        if (typeof v === 'function') return await v();
        return v ?? 'deleted';
      } finally {
        active--;
      }
    },
  };
  return { src, calls, maxActive: () => maxActive, byId };
}

test('names: cached channels are named without a REST call', async () => {
  const s = source([text('c1', 'general')], {});
  const r = new ChannelNameResolver(s.src);
  const out = await r.resolve(['c1']);
  assert.deepEqual(out.get('c1'), { id: 'c1', name: 'general', type: 'text', guildId: 'G1' });
  assert.deepEqual(s.calls, []);
});

test('names: an archived thread outside the cache is fetched once, named with its parent, and memoised', async () => {
  const s = source([text('c1', 'general')], { t1: thread('t1', 'design-notes', 'c1') });
  const r = new ChannelNameResolver(s.src);
  const a = await r.resolve(['t1']);
  assert.equal(a.get('t1')!.name, 'design-notes');
  assert.equal(a.get('t1')!.parentName, 'general');
  assert.equal(a.get('t1')!.archived, true);
  await r.resolve(['t1', 't1']);
  assert.deepEqual(s.calls, ['t1'], 'second view reuses the memo; duplicates collapse');
});

test('names: an uncached parent is fetched too', async () => {
  const s = source([], { t1: thread('t1', 'notes', 'c9'), c9: text('c9', 'old-parent') });
  const r = new ChannelNameResolver(s.src);
  const out = await r.resolve(['t1']);
  assert.equal(out.get('t1')!.parentName, 'old-parent');
  assert.deepEqual(s.calls.sort(), ['c9', 't1']);
});

test('names: deleted and hidden are told apart; a transient error is pending and retried', async () => {
  let fail = true;
  const s = source([], {
    gone: 'deleted',
    secret: 'hidden',
    flaky: async () => { if (fail) throw new Error('503'); return text('flaky', 'back'); },
  });
  const r = new ChannelNameResolver(s.src);
  const a = await r.resolve(['gone', 'secret', 'flaky']);
  assert.deepEqual(a.get('gone'), { id: 'gone', name: null, missing: true });
  assert.deepEqual(a.get('secret'), { id: 'secret', name: null, missing: true, hidden: true });
  assert.deepEqual(a.get('flaky'), { id: 'flaky', name: null, pending: true });
  fail = false;
  const b = await r.resolve(['gone', 'flaky']);
  assert.equal(b.get('flaky')!.name, 'back');
  assert.equal(s.calls.filter((c) => c === 'gone').length, 1, '"gone" is remembered');
});

test('names: memo entries expire (negative sooner than positive)', async () => {
  let now = 0;
  const s = source([text('c1', 'general')], { gone: 'deleted', t1: thread('t1', 'x', 'c1') });
  const r = new ChannelNameResolver(s.src, { now: () => now, positiveTtlMs: 1000, negativeTtlMs: 100 });
  await r.resolve(['gone', 't1']);
  now = 500;
  await r.resolve(['gone', 't1']);
  assert.deepEqual(s.calls.sort(), ['gone', 'gone', 't1']);
  now = 2000;
  await r.resolve(['t1']);
  assert.equal(s.calls.filter((c) => c === 't1').length, 2);
});

test('names: past the deadline the answer is pending, and the lookup finishes in the background', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = source([], { slow: async () => { await gate; return text('slow', 'eventually'); } });
  const r = new ChannelNameResolver(s.src, { deadlineMs: 20 });
  const a = await r.resolve(['slow']);
  assert.deepEqual(a.get('slow'), { id: 'slow', name: null, pending: true });
  release();
  await new Promise((res) => setTimeout(res, 10));
  const b = await r.resolve(['slow']);
  assert.equal(b.get('slow')!.name, 'eventually');
  assert.deepEqual(s.calls, ['slow'], 'the background lookup was reused, not repeated');
});

test('names: REST lookups run with bounded concurrency', async () => {
  const rest: Record<string, ChannelMeta> = {};
  const ids = Array.from({ length: 25 }, (_, i) => `t${i}`);
  for (const id of ids) rest[id] = thread(id, id, 'c1');
  const s = source([text('c1', 'general')], rest);
  const r = new ChannelNameResolver(s.src, { concurrency: 3 });
  const out = await r.resolve(ids);
  assert.equal(out.size, 25);
  assert.ok([...out.values()].every((l) => l.name !== null));
  assert.ok(s.maxActive() <= 3, `max parallel ${s.maxActive()}`);
});

test('names: the memo is bounded', async () => {
  const rest: Record<string, ChannelMeta> = {};
  for (let i = 0; i < 10; i++) rest[`t${i}`] = thread(`t${i}`, `n${i}`, 'c1');
  const s = source([text('c1', 'general')], rest);
  const r = new ChannelNameResolver(s.src, { maxEntries: 4 });
  const first = await r.resolve(Object.keys(rest));
  assert.ok([...first.values()].every((l) => l.name !== null), 'one call keeps its own results even past the bound');
  await r.resolve(['t0']);
  assert.equal(s.calls.filter((c) => c === 't0').length, 2, 'oldest entry was evicted');
});

test('clipToGuild: another guild\'s, deleted and hidden channels all read the same — unavailable, no name', () => {
  const labels = new Map([
    ['mine', { id: 'mine', name: 'general', type: 'text' as const, guildId: 'G1' }],
    ['theirs', { id: 'theirs', name: 'secret', type: 'text' as const, guildId: 'G2' }],
    ['gone', { id: 'gone', name: null, missing: true as const }],
    ['hid', { id: 'hid', name: null, missing: true as const, hidden: true as const }],
    ['wait', { id: 'wait', name: null, pending: true as const }],
  ]);
  const out = clipToGuild(labels, 'G1');
  assert.equal(out.mine.name, 'general');
  for (const id of ['theirs', 'gone', 'hid']) assert.deepEqual(out[id], { id, name: null, unavailable: true });
  assert.deepEqual(out.wait, { id: 'wait', name: null, pending: true });
});

test('names: one request starts at most maxPerRequest lookups; the rest answer pending', async () => {
  const rest: Record<string, ChannelMeta> = {};
  for (let i = 0; i < 10; i++) rest[`t${i}`] = thread(`t${i}`, `n${i}`, 'c1');
  const s = source([text('c1', 'general')], rest);
  const r = new ChannelNameResolver(s.src, { maxPerRequest: 4 });
  const out = await r.resolve(Object.keys(rest));
  assert.equal(s.calls.length, 4);
  assert.equal([...out.values()].filter((l) => l.pending).length, 6);
});

test('names: past maxQueued, ids answer pending without queueing more lookups', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const rest: Record<string, () => Promise<ChannelFetch>> = {};
  for (let i = 0; i < 10; i++) rest[`t${i}`] = async () => { await gate; return 'deleted'; };
  const s = source([], rest);
  const r = new ChannelNameResolver(s.src, { concurrency: 1, maxQueued: 3, deadlineMs: 10 });
  await r.resolve(Object.keys(rest));
  // 1 running + 3 queued; the other 6 were never queued.
  release();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(s.calls.length, 4);
});

test('names: REST lookups are rate limited (burst, then ratePerSec)', async () => {
  const rest: Record<string, ChannelMeta> = {};
  for (let i = 0; i < 6; i++) rest[`t${i}`] = thread(`t${i}`, `n${i}`, 'c1');
  const s = source([text('c1', 'general')], rest);
  const r = new ChannelNameResolver(s.src, { burst: 2, ratePerSec: 20, deadlineMs: 2000 });
  const t0 = Date.now();
  const out = await r.resolve(Object.keys(rest));
  const took = Date.now() - t0;
  assert.ok([...out.values()].every((l) => l.name !== null));
  // 2 at once, then 4 more at 20/s ≈ 200ms.
  assert.ok(took >= 150, `took ${took}ms — rate limit not applied`);
});

test('names: a source that throws synchronously frees its slot and stays retryable', async () => {
  let calls = 0;
  const r = new ChannelNameResolver({
    cached: () => null,
    fetch: (id) => { calls++; if (calls === 1) throw new Error('sync boom'); return Promise.resolve(text(id, 'ok')); },
  }, { concurrency: 1 });
  const a = await r.resolve(['x']);
  assert.deepEqual(a.get('x'), { id: 'x', name: null, pending: true });
  const b = await r.resolve(['x', 'y']);
  assert.equal(b.get('x')!.name, 'ok');
  assert.equal(b.get('y')!.name, 'ok');
});
