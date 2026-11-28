// fetch_around and the fetch_history passthrough at the agent boundary
// (#98, review R1-3): which calls carry `direction: 'forward'`, and what the
// merged window looks like. The relay double records every call; the body
// semantics live in the relay's own suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { AgentState } from '../src/agent-state.js';

// A snowflake-shaped id: the tool boundary resolves channel refs, and a raw
// id passes through only when it looks like one.
const C = '100000000000000001';
const S = (n: number) => new Date(Date.UTC(2026, 8, 21, 11, 0, n)).toISOString();

function msg(id: string, at: string): PortalMessage {
  return {
    id, nativeId: id, channelId: C, guildId: 'g1',
    author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
    content: `m${id}`, cleanContent: `m${id}`, attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt: at,
  };
}

function harness() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }],
    channels: [{ id: C, guildId: 'g1', name: 'one', type: 'text', capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'] }],
    seq: 0,
  });
  // m1..m20, ascending; the double serves the documented pages and records
  // each call so the tests can see exactly what the agent asked for.
  const store = Array.from({ length: 20 }, (_, i) => msg(`m${i + 1}`, S(i + 1)));
  const calls: Array<{ before?: string; after?: string; limit?: number; direction?: 'forward' }> = [];
  Object.assign(client, {
    async fetchHistory(p: { channelId: string; limit?: number; before?: string; after?: string; direction?: 'forward' }) {
      calls.push({ before: p.before, after: p.after, limit: p.limit, direction: p.direction });
      let newestFirst = [...store].reverse();
      if (p.before) {
        const i = newestFirst.findIndex((m) => m.id === p.before);
        newestFirst = i >= 0 ? newestFirst.slice(i + 1) : [];
      }
      if (p.after) {
        const i = newestFirst.findIndex((m) => m.id === p.after);
        if (i >= 0) newestFirst = newestFirst.slice(0, i);
      }
      const forwardServed = !!p.after && !p.before && p.direction === 'forward';
      const slice = forwardServed ? newestFirst.slice(-(p.limit ?? 50)) : newestFirst.slice(0, p.limit ?? 50);
      return { messages: slice, ...(forwardServed ? { forward: true as const } : {}) };
    },
  });
  const agent = new PortalAgent(client, { state: new AgentState() });
  return { agent, calls };
}

test('fetch_around asks the newer half for the forward walk, so it is the half nearest the anchor', async () => {
  const h = harness();
  const got = (await h.agent.handleToolCall('fetch_around', { channelId: C, messageId: 'm10', limit: 6 })) as {
    messages: PortalMessage[];
  };
  const newer = h.calls.find((c) => c.after === 'm10');
  const older = h.calls.find((c) => c.before === 'm10');
  assert.equal(newer?.direction, 'forward', 'the newer half opts into the forward walk');
  assert.equal(older?.direction, undefined, 'the older half is a plain before page');
  assert.deepEqual(
    got.messages.map((m) => m.id),
    ['m7', 'm8', 'm9', 'm11', 'm12', 'm13'],
    'three on each side of the anchor, ascending, anchor excluded',
  );
});

test('the fetch_history tool sends direction exactly on after-only calls', async () => {
  const h = harness();
  await h.agent.handleToolCall('fetch_history', { channelId: C, after: 'm5', limit: 3 });
  await h.agent.handleToolCall('fetch_history', { channelId: C, before: 'm5', limit: 3 });
  await h.agent.handleToolCall('fetch_history', { channelId: C, before: 'm9', after: 'm5', limit: 3 });
  assert.equal(h.calls[0].direction, 'forward', 'after-only scrolls forward');
  assert.equal(h.calls[1].direction, undefined, 'before-only never asks for it');
  assert.equal(h.calls[2].direction, undefined, 'a bounded window never asks for it');
});
