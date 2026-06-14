import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentState } from '../src/agent-state.js';
import type { PortalMessage } from '@connectome/portal-protocol';

function msg(id: string, channelId: string, createdAt: string, content = 'hi'): PortalMessage {
  return {
    id,
    nativeId: id.replace(/^rm_[^_]+_/, ''),
    channelId,
    guildId: 'g1',
    author: { kind: 'user', userId: 'u1', username: 'bob', displayName: 'Bob', bot: false },
    content,
    cleanContent: content,
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt,
  };
}

test('addressed messages become pending pings', () => {
  const s = new AgentState();
  assert.equal(s.ingest(msg('m1', 'c1', '2026-01-01T00:00:00Z'), false, []), false);
  assert.equal(s.ingest(msg('m2', 'c1', '2026-01-01T00:01:00Z'), true, ['role_mention']), true);
  assert.equal(s.pendingPings().length, 1);
  assert.equal(s.unreadCount('c1'), 2);
});

test('markRead clears unread and pings up to the cutoff', () => {
  const s = new AgentState();
  s.ingest(msg('m1', 'c1', '2026-01-01T00:00:00Z'), true, ['reply']);
  s.ingest(msg('m2', 'c1', '2026-01-01T00:01:00Z'), false, []);
  s.markRead('c1');
  assert.equal(s.unreadCount('c1'), 0);
  assert.equal(s.pendingPings().length, 0);
});

test('messages at or below the watermark are ignored', () => {
  const s = new AgentState();
  s.ingest(msg('m2', 'c1', '2026-01-01T00:01:00Z'), false, []);
  s.markRead('c1');
  // An older (already-read) message arriving late must not resurface.
  assert.equal(s.ingest(msg('m1', 'c1', '2026-01-01T00:00:00Z'), true, ['reply']), false);
  assert.equal(s.pendingPings().length, 0);
});

test('serialize / restore round-trips watermarks + pings', () => {
  const s = new AgentState();
  s.ingest(msg('m1', 'c1', '2026-01-01T00:00:00Z'), true, ['role_mention']);
  const restored = AgentState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(restored.pendingPings().length, 1);
});

test('unreadByChannel summarizes with a preview', () => {
  const s = new AgentState();
  s.ingest(msg('m1', 'c1', '2026-01-01T00:00:00Z', 'hello world'), false, []);
  const [u] = s.unreadByChannel();
  assert.equal(u.channelId, 'c1');
  assert.equal(u.count, 1);
  assert.match(u.lastPreview ?? '', /Bob: hello world/);
});

test('subscriptions: add/remove, dedupe, and onChange fires', () => {
  const s = new AgentState();
  let changes = 0;
  s.onChange(() => changes++);
  assert.equal(s.subscribe('c1'), true);
  assert.equal(s.subscribe('c1'), false); // dedupe → no change
  assert.equal(s.subscribe('c2'), true);
  assert.deepEqual(s.subscriptionList().sort(), ['c1', 'c2']);
  assert.equal(s.isSubscribed('c1'), true);
  assert.equal(s.unsubscribe('c1'), true);
  assert.equal(s.unsubscribe('c1'), false);
  assert.deepEqual(s.subscriptionList(), ['c2']);
  assert.equal(changes, 3); // c1 add, c2 add, c1 remove
});

test('subscriptions survive serialize/restore', () => {
  const s = new AgentState();
  s.subscribe('c1');
  s.subscribe('c2');
  s.markRead('c1', '2026-01-01T00:00:00Z');
  const restored = AgentState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepEqual(restored.subscriptionList().sort(), ['c1', 'c2']);
});

test('drainUnread returns time-ordered unseen, then clears state', () => {
  const s = new AgentState();
  s.ingest(msg('m1', 'c1', '2026-01-01T00:00:01Z'), false, []);
  s.ingest(msg('m2', 'c2', '2026-01-01T00:00:00Z'), false, []);
  s.ingest(msg('m3', 'c1', '2026-01-01T00:00:03Z'), true, ['role_mention']);
  const drained = s.drainUnread();
  assert.deepEqual(drained.map((m) => m.id), ['m2', 'm1', 'm3']); // sorted by createdAt
  assert.equal(s.drainUnread().length, 0); // cleared
  assert.equal(s.pendingPings().length, 0); // pings cleared
  assert.equal(s.unreadCount('c1'), 0);
});
