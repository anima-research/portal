// Live rights propagation (issue #5), client side: capability and channel
// lifecycle events must surface through the emitter, not just mutate the cache
// silently — portal-mcpl (→ host channel registry) reacts to these emits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortalChannel } from '@animalabs/portal-protocol';
import { PortalClient } from '../src/client.js';

const chanA: PortalChannel = {
  id: 'c-a', native: 'c-a', guildId: 'g1', name: 'alpha', type: 'text',
  capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'],
};
const chanB: PortalChannel = {
  id: 'c-b', native: 'c-b', guildId: 'g1', name: 'beta', type: 'text',
  capabilities: ['VIEW_CHANNEL'],
};
const chanOther: PortalChannel = {
  id: 'c-x', native: 'c-x', guildId: 'g2', name: 'exo', type: 'text',
  capabilities: ['VIEW_CHANNEL'],
};

function makeClient() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's1',
    persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }],
    channels: [chanA, chanB, chanOther],
    seq: 0,
  });
  const changes: PortalChannel[] = [];
  const removes: Array<{ channelId: string; guildId: string | null }> = [];
  client.on('channelChange', (c) => changes.push(c));
  client.on('channelRemove', (e) => removes.push(e));
  const dispatch = (event: unknown) => (client as any).onEvent(event);
  return { client, changes, removes, dispatch };
}

test('capabilities_update merges into the cache and emits channelChange', () => {
  const t = makeClient();
  t.dispatch({ type: 'capabilities_update', channelId: 'c-a', capabilities: ['VIEW_CHANNEL'] });

  assert.equal(t.changes.length, 1);
  assert.equal(t.changes[0].id, 'c-a');
  assert.deepEqual(t.changes[0].capabilities, ['VIEW_CHANNEL']);
  assert.deepEqual(t.client.cache.getChannel('c-a')?.capabilities, ['VIEW_CHANNEL']);
  assert.equal(t.changes[0].name, 'alpha', 'non-caps fields preserved');
});

test('capabilities_update for an unknown channel is ignored', () => {
  const t = makeClient();
  t.dispatch({ type: 'capabilities_update', channelId: 'nope', capabilities: [] });
  assert.equal(t.changes.length, 0);
  assert.equal(t.removes.length, 0);
});

test('channel_delete drops the cache entry and emits channelRemove', () => {
  const t = makeClient();
  t.dispatch({ type: 'channel_delete', channelId: 'c-a', guildId: 'g1' });

  assert.deepEqual(t.removes, [{ channelId: 'c-a', guildId: 'g1' }]);
  assert.equal(t.client.cache.getChannel('c-a'), undefined);
});

test('guild_delete drops the guild AND its channels, emitting channelRemove for each', () => {
  const t = makeClient();
  t.dispatch({ type: 'guild_delete', guildId: 'g1' });

  assert.deepEqual(
    new Set(t.removes.map((r) => r.channelId)),
    new Set(['c-a', 'c-b']),
    'both g1 channels removed',
  );
  assert.equal(t.client.cache.getChannel('c-a'), undefined);
  assert.equal(t.client.cache.getChannel('c-b'), undefined);
  assert.equal(t.client.cache.getChannel('c-x')?.id, 'c-x', 'other guild untouched');
  assert.equal(t.client.cache.getGuild('g1'), undefined);
});

test('guild_create emits channelChange for every carried channel', () => {
  const t = makeClient();
  const chanNew: PortalChannel = {
    id: 'c-n', native: 'c-n', guildId: 'g3', name: 'new', type: 'text', capabilities: [],
  };
  t.dispatch({
    type: 'guild_create',
    guild: { id: 'g3', name: 'Three' },
    channels: [chanNew],
  });

  assert.equal(t.changes.length, 1);
  assert.equal(t.changes[0].id, 'c-n');
  assert.equal(t.client.cache.getChannel('c-n')?.id, 'c-n');
});

test('channel_delete for an unknown channel emits nothing (no phantom removals)', () => {
  const t = makeClient();
  t.dispatch({ type: 'channel_delete', channelId: 'never-known', guildId: 'g1' });
  assert.equal(t.removes.length, 0);
  assert.equal(t.changes.length, 0);
});
