import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
