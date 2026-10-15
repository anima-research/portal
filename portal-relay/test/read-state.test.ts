import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { ReadStateStore } from '../src/read-state.js';

let clock = 0;
function msg(over: Partial<PortalMessage> & { channelId: string; content: string }): PortalMessage {
  clock += 1000;
  const createdAt = new Date(clock).toISOString();
  return {
    id: over.id ?? `rm_${over.channelId}_${clock}`,
    nativeId: String(clock),
    channelId: over.channelId,
    guildId: 'g1',
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: over.content,
    cleanContent: over.content,
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt,
    ...over,
  };
}

test('addressed message → pending ping + unread tally', () => {
  const rs = new ReadStateStore();
  rs.record('p1', msg({ channelId: 'c1', content: 'hey @p1' }), true, ['role_mention']);
  assert.equal(rs.pendingPings('p1').length, 1);
  assert.equal(rs.pendingPings('p1')[0].reasons[0], 'role_mention');
  const unread = rs.unread('p1');
  assert.equal(unread.length, 1);
  assert.equal(unread[0].count, 1);
  assert.equal(unread[0].channelId, 'c1');
});

test('ambient message → tally only, no ping; characters counted', () => {
  const rs = new ReadStateStore();
  rs.record('p1', msg({ channelId: 'c1', content: 'hello' }), false, []);
  rs.record('p1', msg({ channelId: 'c1', content: 'world!' }), false, []);
  assert.equal(rs.pendingPings('p1').length, 0);
  const m = rs.missed('p1', 'c1');
  assert.equal(m.messages, 2);
  assert.equal(m.characters, 'hello'.length + 'world!'.length);
});

test('messages at/under watermark are ignored after mark_read', () => {
  const rs = new ReadStateStore();
  rs.record('p1', msg({ channelId: 'c1', content: 'a' }), true, ['role_mention']);
  rs.record('p1', msg({ channelId: 'c1', content: 'b' }), false, []);
  rs.markRead('p1', 'c1');
  assert.equal(rs.pendingPings('p1').length, 0);
  assert.equal(rs.unread('p1').length, 0);
  assert.equal(rs.missed('p1', 'c1').messages, 0);
  // A new message after the watermark accrues again.
  const since = rs.missed('p1', 'c1').since;
  assert.ok(since, 'watermark recorded');
});

test('pings are capped (oldest dropped)', () => {
  const rs = new ReadStateStore({ pingsCap: 3 });
  for (let i = 0; i < 5; i++) {
    rs.record('p1', msg({ channelId: 'c1', content: `m${i}` }), true, ['role_mention']);
  }
  assert.equal(rs.pendingPings('p1').length, 3);
  // Oldest (m0, m1) dropped; newest kept.
  assert.match(rs.pendingPings('p1')[2].message.content, /m4/);
});

test('per-persona isolation', () => {
  const rs = new ReadStateStore();
  rs.record('p1', msg({ channelId: 'c1', content: 'for p1' }), true, ['role_mention']);
  assert.equal(rs.pendingPings('p1').length, 1);
  assert.equal(rs.pendingPings('p2').length, 0);
});

test('persistence round-trips across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-rs-'));
  const path = join(dir, 'read-state.json');
  try {
    const a = new ReadStateStore({ path });
    a.record('p1', msg({ channelId: 'c1', content: 'persist me' }), true, ['reply']);
    a.flush();
    const b = new ReadStateStore({ path });
    assert.equal(b.pendingPings('p1').length, 1);
    assert.equal(b.pendingPings('p1')[0].reasons[0], 'reply');
    assert.equal(b.unread('p1')[0].count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Partial marks, threads, keepPings (#35 review) ──

test('a partial mark keeps the channel listed with what is left (count from the caller)', () => {
  const rs = new ReadStateStore();
  const ms = Array.from({ length: 10 }, (_, i) => msg({ channelId: 'c', content: `m${i}` }));
  for (const m of ms) rs.record('p1', m, false, []);
  rs.markRead('p1', 'c', ms[3].createdAt, { count: 4 });
  const u = rs.unread('p1');
  assert.equal(u.length, 1, 'still listed — the rest is still unread');
  assert.equal(u[0].count, 6);
  assert.equal(rs.missed('p1', 'c').since, ms[3].createdAt);
  // Without a count the previous tally stays (never less than one).
  rs.markRead('p1', 'c', ms[5].createdAt);
  assert.equal(rs.unread('p1')[0].count, 6);
  // A mark through the newest clears it.
  rs.markRead('p1', 'c', ms[9].createdAt, { count: 4 });
  assert.deepEqual(rs.unread('p1'), []);
});

test('thread replies are tallied per thread under their channel', () => {
  const rs = new ReadStateStore();
  rs.record('p1', msg({ channelId: 'c', content: 'parent' }), false, []);
  const t1 = msg({ channelId: 'c', threadId: 't1', content: 'reply' });
  rs.record('p1', t1, false, []);
  rs.record('p1', msg({ channelId: 'c', threadId: 't1', content: 'reply 2' }), false, []);
  const m = rs.missed('p1', 'c');
  assert.equal(m.messages, 3);
  assert.deepEqual(m.threads?.map((t) => [t.threadId, t.messages]), [['t1', 2]]);
  assert.equal(m.threadsTruncated, undefined);
  // A partial mark past a thread's last reply drops it from the list.
  const later = msg({ channelId: 'c', content: 'later' });
  rs.record('p1', later, false, []);
  rs.markRead('p1', 'c', rs.missed('p1', 'c').threads![0].lastAt, { count: 3 });
  assert.deepEqual(rs.missed('p1', 'c').threads, [], 'a known-empty list, not an absent one (absent = older relay)');
  assert.equal(rs.unread('p1')[0].count, 1);
});

test('the thread list is bounded and says when it is incomplete', () => {
  const rs = new ReadStateStore();
  for (let i = 0; i < 60; i++) rs.record('p1', msg({ channelId: 'c', threadId: `t${i}`, content: 'r' }), false, []);
  const m = rs.missed('p1', 'c');
  assert.equal(m.threads?.length, 50);
  assert.equal(m.threadsTruncated, true);
  assert.ok(m.threads!.some((t) => t.threadId === 't59') && !m.threads!.some((t) => t.threadId === 't0'), 'newest kept');
});

test('keepPings advances the watermark without acknowledging pending pings', () => {
  const rs = new ReadStateStore();
  const p = msg({ channelId: 'c', content: '@me' });
  rs.record('p1', p, true, ['mention']);
  rs.record('p1', msg({ channelId: 'c', content: 'after' }), false, []);
  rs.markRead('p1', 'c', undefined, { keepPings: true });
  assert.equal(rs.pendingPings('p1').length, 1, 'the ping is still pending');
  assert.deepEqual(rs.unread('p1'), []);
  rs.markRead('p1', 'c');
  assert.equal(rs.pendingPings('p1').length, 0);
});

test('a thread message whose new tally is evicted on the spot does not throw', () => {
  const rs = new ReadStateStore({ channelsCap: 1 });
  rs.record('p1', msg({ channelId: 'busy', content: 'newer' }), false, []);
  // An OLDER message for another channel: its new tally is the oldest and is
  // evicted immediately.
  const old = msg({ channelId: 'quiet', threadId: 't1', content: 'late reply' });
  const backdated = { ...old, createdAt: new Date(0).toISOString() };
  assert.doesNotThrow(() => rs.record('p1', backdated, true, ['mention']));
  assert.equal(rs.pendingPings('p1').length, 1, 'the ping is still stored');
});

test('a repeated or overlapping partial mark does not subtract the same messages twice', () => {
  const rs = new ReadStateStore();
  const ms = Array.from({ length: 10 }, (_, i) => msg({ channelId: 'c', content: `m${i}` }));
  for (const m of ms) rs.record('p1', m, false, []);
  // Two sessions fold the same 4-message prefix from the same watermark.
  rs.markRead('p1', 'c', ms[3].createdAt, { count: 4 });
  rs.markRead('p1', 'c', ms[3].createdAt, { count: 4 });
  assert.equal(rs.unread('p1')[0].count, 6);
  // A mark counted from an older watermark than the relay's (overlap): the
  // count can't be trusted, so it stays overstated rather than shrink.
  rs.markRead('p1', 'c', ms[5].createdAt, { count: 6, since: ms[0].createdAt });
  assert.equal(rs.unread('p1')[0].count, 6);
  // Counted from exactly where the watermark is: applied.
  rs.markRead('p1', 'c', ms[7].createdAt, { count: 2, since: ms[5].createdAt });
  assert.equal(rs.unread('p1')[0].count, 4);
});

test('channel_missed says where the tally started (the lower bound with no watermark), per channel and thread', () => {
  const rs = new ReadStateStore();
  const first = msg({ channelId: 'c', content: 'first' });
  rs.record('p1', first, false, []);
  const reply = msg({ channelId: 'c', threadId: 't1', content: 'reply' });
  rs.record('p1', reply, false, []);
  rs.record('p1', msg({ channelId: 'c', content: 'later' }), false, []);
  const m = rs.missed('p1', 'c');
  assert.equal(m.since, undefined, 'never marked read');
  assert.equal(m.firstAt, first.createdAt);
  assert.equal(m.threads?.[0].firstAt, reply.createdAt);
  assert.deepEqual(rs.missed('p1', 'none').threads, [], 'no tally: still a (known-empty) list');
});

test('tallies saved by an older relay: no invented lower bound, and threads listed only if known', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-rs-legacy-'));
  const path = join(dir, 'read-state.json');
  const legacyTally = (threadId?: string) => ({
    ...(threadId ? { threadId } : {}), messages: 3, characters: 9,
    lastAt: '2026-01-01T00:00:03.000Z', lastMessageId: 'm3', lastPreview: 'x',
  });
  writeFileSync(path, JSON.stringify({ p1: { watermarks: {}, pings: [], tallies: { quiet: legacyTally(), threaded: legacyTally('t9') } } }));
  const rs = new ReadStateStore({ path });
  rs.record('p1', msg({ channelId: 'quiet', content: 'new' }), false, []);
  const q = rs.missed('p1', 'quiet');
  assert.equal(q.firstAt, undefined, "the next message isn't where the older unread began");
  assert.deepEqual(q.threads, [], 'no thread activity before: a complete, empty list');
  const t = rs.missed('p1', 'threaded');
  assert.equal(t.threads, undefined, "thread replies from before can't be listed — so the list is omitted");
  rmSync(dir, { recursive: true, force: true });
});
