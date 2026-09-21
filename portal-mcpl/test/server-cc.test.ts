// Claude Code channel binding: ambient traffic in followed channels never
// wakes, but it must never be LOST either. The relay's read-state is the
// durable record of what this persona missed; every wake folds it in and then
// advances the watermarks it folded — except for channels carrying a ping,
// whose watermark stays the agent's to advance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalCcChannelServer } from '../src/server-cc.js';

const A = '100'; // trigger channel
const B = '200'; // followed, with relay-side backlog
const C = '300'; // NOT followed, with relay-side backlog

const chan = (id: string, name: string): PortalChannel => ({
  id, guildId: 'g1', name, type: 'text', capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'],
});

function msg(id: string, channelId: string, createdAt: string, content = `m${id}`): PortalMessage {
  return {
    id, nativeId: id, channelId, guildId: 'g1',
    author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
    content, cleanContent: content, attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt,
  };
}

const T = (n: number) => `2026-09-21T10:${String(n).padStart(2, '0')}:00.000Z`;

/** A relay double: unread tallies + history per channel + a mark_read log. */
function harness(opts: { pings?: PortalMessage[] } = {}) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }], channels: [chan(A, 'alpha'), chan(B, 'beta'), chan(C, 'gamma')], seq: 0,
  });
  const history: Record<string, PortalMessage[]> = {
    [A]: [msg('a1', A, T(1)), msg('a2', A, T(2))],
    // b1 is at/under the watermark T(5): must be cut. b2/b3 are the backlog.
    [B]: [msg('b1', B, T(5)), msg('b2', B, T(6)), msg('b3', B, T(7))],
    [C]: [msg('c1', C, T(8))],
  };
  const marked: Array<{ channelId: string; uptoCreatedAt?: string }> = [];
  const calls: string[] = [];
  Object.assign(client, {
    async fetchHistory(p: { channelId: string; limit?: number }) {
      calls.push(`history:${p.channelId}`);
      return { messages: [...history[p.channelId]].reverse().slice(0, p.limit ?? 50) };
    },
    async call(method: string, params: Record<string, unknown>) {
      calls.push(method);
      switch (method) {
        case 'list_unread':
          return { channels: [
            { channelId: B, count: 2, lastAt: T(7) },
            { channelId: C, count: 1, lastAt: T(8) },
          ] };
        case 'channel_missed':
          return params.channelId === B
            ? { channelId: B, messages: 2, characters: 4, since: T(5), lastAt: T(7) }
            : { channelId: C, messages: 1, characters: 2, lastAt: T(8) };
        case 'mark_read':
          marked.push(params as { channelId: string; uptoCreatedAt?: string });
          return {};
        case 'get_pending_pings':
          return { pings: (opts.pings ?? []).map((m) => ({ message: m, reasons: ['role_mention'], at: m.createdAt })) };
        default:
          throw new Error(`unexpected rpc ${method}`);
      }
    },
  });
  const state = new AgentState();
  state.subscribe(A);
  state.subscribe(B);
  const agent = new PortalAgent(client, { state });
  const server = new PortalCcChannelServer(client, agent);
  const wakes: Array<{ content: string; meta: Record<string, string> }> = [];
  const internal = server as unknown as { conn: unknown; wireClient(): void; catchUp(): Promise<void>; wakeChain: Promise<void> };
  internal.conn = { sendNotification: (_m: string, p: { content: string; meta: Record<string, string> }) => void wakes.push(p) };
  internal.wireClient();
  const settle = async () => { await internal.wakeChain; await new Promise((r) => setImmediate(r)); };
  return { client, state, server, internal, wakes, marked, calls, settle };
}

test('a mention wake folds the relay-side backlog of FOLLOWED channels and settles their watermarks', async () => {
  const h = harness();
  const trigger = msg('a9', A, T(9), 'hey @P');
  h.client.emit('message', { message: trigger, addressedToMe: true, reasons: ['role_mention'] });
  await h.settle();

  assert.equal(h.wakes.length, 1);
  const { content, meta } = h.wakes[0];
  assert.equal(meta.channelId, A);
  // Backlog from B (above its watermark), history backfill for A, the trigger marked.
  assert.match(content, /— #beta —\nBob: mb2\nBob: mb3/);
  assert.doesNotMatch(content, /mb1/, 'messages at/under the watermark are not re-shown');
  // Time-ordered across channels: A's backfill, then B's backlog, then the trigger.
  assert.match(content, /— #alpha —\nBob: ma1\nBob: ma2\n\n— #beta —\nBob: mb2\nBob: mb3\n\n— #alpha —\n» Bob: hey @P.*addressed to you/);
  assert.doesNotMatch(content, /mc1/, 'unfollowed channels are not folded');
  // B settled on the relay up to its last missed message; A (the trigger) left to the agent.
  assert.deepEqual(h.marked, [{ channelId: B, uptoCreatedAt: T(7) }]);
  assert.ok(!h.calls.includes('history:300'), 'no history fetched for an unfollowed channel');
});

test('a catch-up wake carries the followed backlog alongside the pings, and settles only ping-free channels', async () => {
  const ping = msg('a5', A, T(5), '@P are you there');
  const h = harness({ pings: [ping] });
  await h.internal.catchUp();
  await h.settle();

  assert.equal(h.wakes.length, 1);
  const { content, meta } = h.wakes[0];
  assert.equal(meta.catchup, 'true');
  assert.match(content, /\[catch-up\] 1 message\(s\) addressed to you while you were away, plus what you missed in 1 followed channel\(s\)/);
  assert.match(content, /» Bob: @P are you there \(role_mention\)/);
  assert.match(content, /— #beta —\nBob: mb2\nBob: mb3/);
  assert.deepEqual(h.marked, [{ channelId: B, uptoCreatedAt: T(7) }]);
  assert.doesNotMatch(content, /mc1/);
});

test('ambient messages never wake; a second mention does not re-fold what was settled', async () => {
  const h = harness();
  h.client.emit('message', { message: msg('b8', B, T(8)), addressedToMe: false, reasons: [] });
  await h.settle();
  assert.equal(h.wakes.length, 0);

  h.client.emit('message', { message: msg('a9', A, T(9), '@P one'), addressedToMe: true, reasons: ['role_mention'] });
  await h.settle();
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].content, /mb8/, 'live-delivered ambient is folded');
  assert.match(h.wakes[0].content, /mb2/);

  // Local watermark for B is now past the backlog: nothing from B re-folds
  // even though the (unchanged) relay double still reports it unread.
  h.client.emit('message', { message: msg('a10', A, T(10), '@P two'), addressedToMe: true, reasons: ['role_mention'] });
  await h.settle();
  assert.equal(h.wakes.length, 2);
  assert.doesNotMatch(h.wakes[1].content, /mb[238]/);
});
