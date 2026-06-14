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
