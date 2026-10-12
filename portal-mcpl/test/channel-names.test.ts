// Name-based channel addressing (ported from discord-mcpl's channel-names).
//
//   1) Parser: ids and the `portal:<id>` composite pass through; `#name` and
//      `#name (Guild)` parse as names.
//   2) Resolver: exact/case-insensitive, hard-errors on ambiguity (quoting
//      labels, and ids when labels collide), no fuzzy matching, text beats voice.
//   3) Candidates: capability-filtered before matching; threads/categories are
//      id-only.
//   4) Round-trip: the label toDescriptor/list_channels print is the string the
//      resolver accepts.
//   5) Chokepoint: PortalAgent.handleToolCall resolves once, before any side
//      effect; an ambiguous name sends nothing.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { toDescriptor } from '../src/channels.js';
import {
  buildCandidates,
  channelLabel,
  formatChannelLabel,
  isSnowflake,
  parseChannelRef,
  resolveChannelName,
  type ChannelCandidate,
} from '../src/channel-names.js';

const ch = (
  id: string, name: string, guildId: string, guildName: string,
  type: ChannelCandidate['type'] = 'text',
): ChannelCandidate => ({ id, name, guildId, guildName, type });

const CONN_GENERAL = ch('100000000000000001', 'general', 'g1', 'Connectome');
const ANIMA_GENERAL = ch('100000000000000002', 'general', 'g2', 'Anima Mundi');
const LENA_DEV = ch('100000000000000003', 'lena_dev', 'g1', 'Connectome');
const CANDIDATES = [CONN_GENERAL, ANIMA_GENERAL, LENA_DEV];

describe('parseChannelRef', () => {
  it('passes snowflakes and the portal composite through as ids', () => {
    assert.ok(isSnowflake('100000000000000001'));
    assert.deepEqual(parseChannelRef('100000000000000001'), { kind: 'id', id: '100000000000000001' });
    assert.deepEqual(parseChannelRef('portal:100000000000000001'), { kind: 'id', id: '100000000000000001' });
    assert.deepEqual(parseChannelRef('portal:c1'), { kind: 'id', id: 'c1' });
  });
  it('parses bare and qualified names, hash optional, whitespace tolerated', () => {
    assert.deepEqual(parseChannelRef('#general'), { kind: 'name', name: 'general' });
    assert.deepEqual(parseChannelRef('general'), { kind: 'name', name: 'general' });
    assert.deepEqual(parseChannelRef('  #lena_dev (Connectome)  '), { kind: 'name', name: 'lena_dev', guild: 'Connectome' });
    assert.deepEqual(parseChannelRef("#general (Jai's Lab — v2)"), { kind: 'name', name: 'general', guild: "Jai's Lab — v2" });
  });
  it('returns null for empty-ish input', () => {
    for (const v of ['', '   ', '#', ' # ']) assert.equal(parseChannelRef(v), null, JSON.stringify(v));
  });
});

describe('resolveChannelName', () => {
  it('resolves an unambiguous bare name, case-insensitively', () => {
    const r = resolveChannelName({ name: 'LENA_DEV', guild: 'connectome' }, CANDIDATES);
    assert.ok(r.ok);
    assert.equal(r.id, LENA_DEV.id);
  });
  it('hard-errors on a cross-guild collision, quoting the qualified labels', () => {
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.message, /#general \(Connectome\)/);
    assert.match(r.message, /#general \(Anima Mundi\)/);
  });
  it('resolves the collision when the guild is supplied', () => {
    const a = resolveChannelName({ name: 'general', guild: 'Connectome' }, CANDIDATES);
    assert.ok(a.ok && a.id === CONN_GENERAL.id);
    const b = resolveChannelName({ name: 'general', guild: 'Anima Mundi' }, CANDIDATES);
    assert.ok(b.ok && b.id === ANIMA_GENERAL.id);
  });
  it('distinguishes wrong-guild from no-such-channel', () => {
    const r = resolveChannelName({ name: 'general', guild: 'Nowhere' }, CANDIDATES);
    assert.ok(!r.ok && r.reason === 'not-found');
    assert.match(r.message, /exists elsewhere/);
  });
  it('does no fuzzy matching', () => {
    for (const name of ['lena_devs', 'lenadev', 'lena dev', 'gener']) {
      const r = resolveChannelName({ name }, CANDIDATES);
      assert.ok(!r.ok && r.reason === 'not-found', name);
    }
  });
  it('quotes ids when two matches share a label', () => {
    const dupe = ch('100000000000000004', 'general', 'g1', 'Connectome');
    const r = resolveChannelName({ name: 'general', guild: 'Connectome' }, [CONN_GENERAL, dupe]);
    assert.ok(!r.ok && r.reason === 'ambiguous');
    assert.match(r.message, /100000000000000001/);
    assert.match(r.message, /100000000000000004/);
  });
  it('tie-breaks text over voice, but not text over text', () => {
    const voice = ch('100000000000000005', 'General', 'g1', 'Connectome', 'voice');
    const r = resolveChannelName({ name: 'general', guild: 'Connectome' }, [CONN_GENERAL, voice]);
    assert.ok(r.ok && r.id === CONN_GENERAL.id);
    const text2 = ch('100000000000000006', 'general', 'g1', 'Connectome', 'text');
    const r2 = resolveChannelName({ name: 'general', guild: 'Connectome' }, [CONN_GENERAL, text2]);
    assert.ok(!r2.ok && r2.reason === 'ambiguous');
  });
});

// ── candidates from the cache ──

function channel(id: string, name: string, guildId: string, extra: Partial<PortalChannel> = {}): PortalChannel {
  return {
    id, native: id, guildId, name, type: 'text', capabilities: ['VIEW_CHANNEL', 'SEND_MESSAGES'], ...extra,
  } as PortalChannel;
}
const GUILDS = [
  { id: 'g1', native: 'g1', name: 'Connectome', memberCount: 1 },
  { id: 'g2', native: 'g2', name: 'Anima Mundi', memberCount: 1 },
];

describe('buildCandidates', () => {
  it('keeps text/voice only, and only channels with a capability', () => {
    const got = buildCandidates([
      channel('1', 'text-room', 'g1'),
      channel('2', 'voice-room', 'g1', { type: 'voice' }),
      channel('3', 'a-category', 'g1', { type: 'category' }),
      channel('4', 'a-thread', 'g1', { type: 'thread', parentId: '1' }),
      channel('5', 'a-forum', 'g1', { type: 'forum' }),
      channel('6', 'secret', 'g1', { capabilities: [] }),
    ], GUILDS);
    assert.deepEqual(got.map((c) => c.name).sort(), ['text-room', 'voice-room']);
    assert.equal(got[0].guildName, 'Connectome');
  });
  it('an ungranted channel cannot manufacture a spurious collision', () => {
    const got = buildCandidates([
      channel('1', 'general', 'g1'),
      channel('2', 'general', 'g1', { capabilities: [] }),
    ], GUILDS);
    const r = resolveChannelName({ name: 'general' }, got);
    assert.ok(r.ok && r.id === '1');
  });
});

describe('display form == address form', () => {
  it('the descriptor label and list label round-trip through the resolver', () => {
    for (const c of CANDIDATES) {
      const label = channelLabel(c);
      const parsed = parseChannelRef(label);
      assert.deepEqual(parsed, { kind: 'name', name: c.name, guild: c.guildName });
      const r = resolveChannelName(parsed as { name: string; guild?: string }, CANDIDATES);
      assert.ok(r.ok && r.id === c.id, label);
    }
    const d = toDescriptor(channel('1', 'lena_dev', 'g1'), false, 500, 'Connectome');
    assert.equal(d.label, '#lena_dev (Connectome)');
    assert.equal(d.label, formatChannelLabel('lena_dev', 'Connectome'));
    // No guild name known → unqualified label, still parseable.
    assert.equal(toDescriptor(channel('1', 'lena_dev', 'g1')).label, '#lena_dev');
    assert.equal(toDescriptor(channel('1', 'x', null as never)).label, '#x (dm)');
  });
});

// ── chokepoint ──

function agentWithCache() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', seq: 0,
    persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: GUILDS,
    channels: [
      channel('100000000000000001', 'general', 'g1'),
      channel('100000000000000002', 'general', 'g2'),
      channel('100000000000000003', 'lena_dev', 'g1'),
    ],
  });
  const sent: Array<{ channelId: string }> = [];
  (client as unknown as { sendMessage: unknown }).sendMessage = async (p: { channelId: string }) => {
    sent.push(p);
    return { messageId: 'm1' };
  };
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true });
  return { agent, sent, client };
}

test('a qualified label reaches the client as a resolved id; ids and the composite pass through', async () => {
  const { agent, sent } = agentWithCache();
  await agent.handleToolCall('send_message', { channelId: '#lena_dev (Connectome)', content: 'hi' });
  await agent.handleToolCall('send_message', { channelId: 'lena_dev', content: 'hi' });
  await agent.handleToolCall('send_message', { channelId: '100000000000000003', content: 'hi' });
  await agent.handleToolCall('send_message', { channelId: 'portal:100000000000000003', content: 'hi' });
  assert.deepEqual(sent.map((s) => s.channelId), Array(4).fill('100000000000000003'));
});

test('send_message names a thread under channelId on every chunk, and only when given', async () => {
  const { agent, sent } = agentWithCache();
  // Over chunkText's 1900-character limit, so it goes out as two chunks.
  await agent.handleToolCall('send_message', {
    channelId: '100000000000000003',
    threadId: '200000000000000001',
    content: 'x'.repeat(2500),
  });
  await agent.handleToolCall('send_message', { channelId: '100000000000000003', content: 'hi' });
  assert.deepEqual(
    sent.map((s) => [s.channelId, (s as { threadId?: string }).threadId]),
    [
      ['100000000000000003', '200000000000000001'],
      ['100000000000000003', '200000000000000001'],
      ['100000000000000003', undefined],
    ],
  );
});

test('a one-chunk send_message carries its threadId, whatever form channelId takes', async () => {
  const { agent, sent } = agentWithCache();
  const thread = '200000000000000001';
  // The chokepoint rebuilds args for a label or portal: channelId; threadId must survive it.
  for (const channelId of ['100000000000000003', '#lena_dev (Connectome)', 'portal:100000000000000003']) {
    await agent.handleToolCall('send_message', { channelId, threadId: thread, content: 'one chunk' });
  }
  assert.deepEqual(
    sent.map((s) => [s.channelId, (s as { threadId?: string }).threadId]),
    Array(3).fill(['100000000000000003', thread]),
  );
});

test('threadId is addressed through the chokepoint: portal:<id> is the bare id, null is none, and channelId itself is the thread', async () => {
  const { agent, sent } = agentWithCache();
  await agent.handleToolCall('send_message', { channelId: '100000000000000003', threadId: 'portal:200000000000000001', content: 'a' });
  await agent.handleToolCall('send_message', { channelId: '100000000000000003', threadId: null, content: 'b' });
  // The thread passed as channelId and again as threadId posts into that thread, as channelId alone does.
  await agent.handleToolCall('send_message', { channelId: '200000000000000001', threadId: '200000000000000001', content: 'c' });
  assert.deepEqual(
    sent.map((s) => [s.channelId, (s as { threadId?: string }).threadId]),
    [
      ['100000000000000003', '200000000000000001'],
      ['100000000000000003', undefined],
      ['200000000000000001', undefined],
    ],
  );
});

test('a threadId that names no thread is refused before anything is sent or read', async () => {
  const { agent, sent, client } = agentWithCache();
  const fetched: unknown[] = [];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async (p: unknown) => {
    fetched.push(p);
    return { messages: [] };
  };
  for (const threadId of [42, '', '   ', { id: 'x' }, false]) {
    for (const [tool, extra] of [
      ['send_message', { content: 'hi' }],
      ['fetch_history', {}],
      ['fetch_around', { messageId: '300000000000000001' }],
    ] as const) {
      await assert.rejects(
        agent.handleToolCall(tool, { channelId: '100000000000000003', threadId, ...extra }),
        /threadId must name a thread .*Nothing was sent or read\./,
        `${tool} with threadId ${JSON.stringify(threadId)}`,
      );
    }
  }
  // A name that isn't a known channel is refused by the resolver, naming threadId.
  await assert.rejects(
    agent.handleToolCall('send_message', { channelId: '100000000000000003', threadId: '#no-such-thread', content: 'hi' }),
    /^Error: threadId: /,
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(fetched, []);
});

test('an ambiguous or unknown name errors and NOTHING is sent', async () => {
  const { agent, sent } = agentWithCache();
  await assert.rejects(
    () => agent.handleToolCall('send_message', { channelId: '#general', content: 'hi' }),
    /ambiguous.*#general \(Connectome\).*#general \(Anima Mundi\)/,
  );
  await assert.rejects(
    () => agent.handleToolCall('send_message', { channelId: '#nope', content: 'hi' }),
    /No addressable channel named #nope/,
  );
  assert.equal(sent.length, 0);
});

test('list_channels returns the label every channelId argument accepts', async () => {
  const { agent, client } = agentWithCache();
  (client as unknown as { call: unknown }).call = async (method: string) => {
    assert.equal(method, 'list_channels');
    return { channels: [{ id: '100000000000000003', name: 'lena_dev', type: 'text', capabilities: ['VIEW_CHANNEL'] }] };
  };
  const res = (await agent.handleToolCall('list_channels', { guildId: 'g1' })) as { channels: Array<{ label: string }> };
  assert.equal(res.channels[0].label, '#lena_dev (Connectome)');
  assert.equal(agent.labelFor('100000000000000003'), '#lena_dev (Connectome)');
  assert.equal(agent.labelFor('nope'), 'nope');
});
