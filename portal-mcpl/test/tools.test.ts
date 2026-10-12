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

test('send_message offers threadId, and its description names both ways to post in a thread', () => {
  const t = byName.get('send_message')!;
  assert.ok('threadId' in t.inputSchema.properties, 'threadId is in the schema the model sees');
  assert.match(t.description, /pass its id as threadId with its parent as channelId/);
  assert.match(t.description, /pass the thread channel id directly as channelId/);
});

test('fetch_around requires channelId + messageId', () => {
  const t = byName.get('fetch_around')!;
  assert.deepEqual(t.inputSchema.required, ['channelId', 'messageId']);
});

test('mark_read accepts optional uptoCreatedAt', () => {
  const props = byName.get('mark_read')!.inputSchema.properties;
  assert.ok('uptoCreatedAt' in props);
});

test('reaction + emoji tools are exposed', () => {
  for (const name of ['react', 'unreact', 'list_emojis', 'set_reaction_visibility']) {
    assert.ok(byName.has(name), `missing tool ${name}`);
  }
});

test('react exposes both visible and native flags', () => {
  const props = byName.get('react')!.inputSchema.properties;
  assert.ok('visible' in props && 'native' in props);
});

test('set_reaction_visibility requires channelId + visible', () => {
  const t = byName.get('set_reaction_visibility')!;
  assert.deepEqual(t.inputSchema.required, ['channelId', 'visible']);
});
