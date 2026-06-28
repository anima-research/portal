import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../src/tools.js';

const byName = new Map(toolDefinitions.map((t) => [t.name, t]));

test('read-state + history tools are exposed', () => {
  for (const name of [
    'get_pending_pings',
    'list_unread',
    'mark_read',
    'channel_missed',
    'fetch_history',
    'fetch_around',
  ]) {
    assert.ok(byName.has(name), `missing tool ${name}`);
  }
});

test('fetch_history exposes before/after/threadId cursors', () => {
  const props = byName.get('fetch_history')!.inputSchema.properties;
  assert.ok('before' in props && 'after' in props && 'threadId' in props);
});

test('fetch_around requires channelId + messageId', () => {
  const t = byName.get('fetch_around')!;
  assert.deepEqual(t.inputSchema.required, ['channelId', 'messageId']);
});

test('mark_read accepts optional uptoCreatedAt', () => {
  const props = byName.get('mark_read')!.inputSchema.properties;
  assert.ok('uptoCreatedAt' in props);
});
