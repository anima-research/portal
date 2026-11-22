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
        /^Error: Nothing ran: threadId .* isn't a thread id\. A thread is named by its id \(or portal:<id>\)/,
        `${tool} with threadId ${JSON.stringify(threadId)}`,
      );
    }
  }
  // Threads aren't addressable by label, so a name is refused with a thread's own remedy,
  // even one that names a channel.
  for (const threadId of ['#no-such-thread', '#lena_dev (Connectome)']) {
    await assert.rejects(
      agent.handleToolCall('send_message', { channelId: '100000000000000003', threadId, content: 'hi' }),
      new RegExp(`^Error: Nothing ran: threadId ${JSON.stringify(threadId).replace(/[()]/g, '\\$&')} isn't a thread id\\. ` +
        "A thread is named by its id \\(or portal:<id>\\), as create_thread returns it and as a message's threadId shows it; " +
        'null or no threadId means no thread\\.$'),
    );
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(fetched, []);
});

test('an ambiguous or unknown name errors and NOTHING is sent', async () => {
  const { agent, sent } = agentWithCache();
  await assert.rejects(
    () => agent.handleToolCall('send_message', { channelId: '#general', content: 'hi' }),
    /^Error: Nothing ran: channelId "#general" is ambiguous: 2 channels match\. Call again with one of these: "#general \(Connectome\)", "#general \(Anima Mundi\)"\.$/,
  );
  await assert.rejects(
    () => agent.handleToolCall('send_message', { channelId: '#nope', content: 'hi' }),
    /^Error: Nothing ran: channelId "#nope" names no channel you can address\. list_channels, with a guildId from list_guilds, shows each channel's label and id: pass a text or voice channel's label, or any channel's id\.$/,
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

test("a retired tool points to the host's own channel tools without claiming their names", async () => {
  const { agent } = agentWithCache();
  for (const [tool, pointer] of [
    ['subscribe_channel', /^Error: subscribe_channel is retired here: this host opens and closes channels itself, so nothing ran\. .*such as channel_open\.$/],
    ['unsubscribe_channel', /such as channel_close\.$/],
    ['list_subscriptions', /such as channel_list\.$/],
    ['set_reaction_visibility', /^Error: set_reaction_visibility is retired here, so nothing ran: .*such as channel_open and channel_close\.$/],
  ] as const) {
    await assert.rejects(agent.handleToolCall(tool, { channelId: '100000000000000003', visible: true }), pointer, tool);
    // A name the resolver can't place doesn't get ahead of the pointer: the tool won't run anyway.
    await assert.rejects(agent.handleToolCall(tool, { channelId: '#nope', visible: true }), pointer, `${tool} with a bad name`);
  }
});

test('an unknown tool is answered before its arguments are looked at', async () => {
  const { agent, sent } = agentWithCache();
  await assert.rejects(
    agent.handleToolCall('send_mesage', { channelId: '#nope', content: 'hi' }),
    /^Error: There's no Portal tool named "send_mesage", so nothing ran\. Call one of the tools listed for you\.$/,
  );
  // Retired tools aren't offered where they're retired.
  await assert.rejects(
    agent.handleToolCall('subscribe_channe', {}),
    /^Error: There's no Portal tool named "subscribe_channe", so nothing ran\. Call one of the tools listed for you\.$/,
  );
  assert.deepEqual(sent, []);
});

test('an optional string argument of another type is refused by name, and nothing runs', async () => {
  const { agent, sent, client } = agentWithCache();
  const fetched: unknown[] = [];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async (p: unknown) => {
    fetched.push(p);
    return { messages: [] };
  };
  await assert.rejects(
    agent.handleToolCall('send_message', { channelId: '100000000000000003', content: 'hi', replyToId: 42 }),
    /^Error: Nothing ran: replyToId must be a string when given, got 42\.$/,
  );
  await assert.rejects(
    agent.handleToolCall('fetch_history', { channelId: '100000000000000003', before: 7 }),
    /^Error: Nothing ran: before must be a string when given, got 7\.$/,
  );
  // Absent and null still mean absent.
  await agent.handleToolCall('fetch_history', { channelId: '100000000000000003', before: null });
  assert.deepEqual(sent, []);
  assert.equal(fetched.length, 1);
});

test('a send split into parts carries the resolved files on its first part only', async () => {
  const { agent, client } = agentWithCache();
  const parts: Array<Record<string, unknown>> = [];
  (client as unknown as { sendMessage: unknown }).sendMessage = async (p: Record<string, unknown>) => {
    parts.push(p);
    return { messageId: `m${parts.length}` };
  };
  await agent.handleToolCall('send_message', {
    channelId: '100000000000000003',
    content: 'x'.repeat(2500),
    files: [{ bytes: 'aGk=', name: 'a.json' }],
  });
  assert.equal(parts.length, 2);
  // Resolved here: the content type is inferred from the name.
  assert.deepEqual(parts[0].files, [{ bytes: 'aGk=', name: 'a.json', contentType: 'application/json' }]);
  assert.equal('files' in parts[1], false);
});

test('an optional number or boolean argument of another type is refused by name, and nothing runs', async () => {
  const { agent, client } = agentWithCache();
  const calls: unknown[] = [];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async (p: unknown) => {
    calls.push(['fetchHistory', p]);
    return { messages: [] };
  };
  (client as unknown as { react: unknown }).react = async (...a: unknown[]) => {
    calls.push(['react', ...a]);
    return {};
  };
  (client as unknown as { call: unknown }).call = async (m: string, p: unknown) => {
    calls.push([m, p]);
    return {};
  };
  await assert.rejects(
    agent.handleToolCall('fetch_history', { channelId: '100000000000000003', limit: '5' }),
    /^Error: Nothing ran: limit must be a number when given, got "5"\.$/,
  );
  // Read as found, the string 'false' made a visible reaction.
  await assert.rejects(
    agent.handleToolCall('react', { messageId: 'm1', emoji: 'x', visible: 'false' }),
    /^Error: Nothing ran: visible must be true or false when given, got "false"\.$/,
  );
  // Read as found, a numeric uptoCreatedAt marked the whole channel read.
  await assert.rejects(
    agent.handleToolCall('mark_read', { channelId: '100000000000000003', uptoCreatedAt: 1760000000000 }),
    /^Error: Nothing ran: uptoCreatedAt must be a string when given, got 1760000000000\.$/,
  );
  await assert.rejects(
    agent.handleToolCall('fetch_history', { channelId: '100000000000000003', after: 5 }),
    /^Error: Nothing ran: after must be a string when given, got 5\.$/,
  );
  assert.deepEqual(calls, []);
  // Absent and null still mean absent.
  await agent.handleToolCall('react', { messageId: 'm1', emoji: 'x', visible: null, native: true });
  assert.deepEqual(calls, [['react', 'm1', 'x', false, true]]);
  // voice_speak's requestId too, like every other optional string.
  await agent.handleToolCall('voice_speak', { channelId: '100000000000000003', text: 'hi', requestId: null });
  assert.deepEqual(calls.at(-1), ['voice_speak', { channelId: '100000000000000003', text: 'hi' }]);
});

test('a send split into parts replies and mentions on its first part only', async () => {
  const { agent, client } = agentWithCache();
  const parts: Array<Record<string, unknown>> = [];
  (client as unknown as { sendMessage: unknown }).sendMessage = async (p: Record<string, unknown>) => {
    parts.push(p);
    return { messageId: `m${parts.length}` };
  };
  await agent.handleToolCall('send_message', {
    channelId: '100000000000000003',
    content: 'x'.repeat(2500),
    replyToId: 'm9',
    mentionPersonaIds: ['p1'],
  });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].replyToId, 'm9');
  assert.deepEqual(parts[0].mentionPersonaIds, ['p1']);
  assert.equal('replyToId' in parts[1], false);
  assert.equal('mentionPersonaIds' in parts[1], false);
});

test('a send split into parts says which parts went out when a later part fails', async () => {
  const { agent, client } = agentWithCache();
  const activity: string[] = [];
  (agent as unknown as { onPublicActivity: (kind: string) => void }).onPublicActivity = (kind) => activity.push(kind);
  let calls = 0;
  (client as unknown as { sendMessage: unknown }).sendMessage = async () => {
    calls++;
    if (calls === 1) return { messageId: 'm1' };
    throw new Error('Nothing ran: you can\'t send in this channel now.');
  };
  await assert.rejects(
    agent.handleToolCall('send_message', { channelId: '100000000000000003', content: 'x'.repeat(2500) }),
    /^Error: Only part of the message was sent: the first 1 of 2 parts were posted \("m1"\), and part 2 may not have been\. Its call answered: "Nothing ran: you can't send in this channel now\." To send the rest, call send_message with only the text that didn't go out; fetch_around shows what did\.$/,
  );
  assert.deepEqual(activity, ['message'], 'the posted part counts as public activity');
  // A failing first part is that part's own answer: nothing went out.
  calls = 1;
  await assert.rejects(
    agent.handleToolCall('send_message', { channelId: '100000000000000003', content: 'hi' }),
    /^Error: Nothing ran: you can't send in this channel now\.$/,
  );
  assert.deepEqual(activity, ['message'], 'a first part that fails posts nothing');
});

test('list_channels joins the category NAME when its entry is in the same response (#99 r1-3)', async () => {
  const { PortalClient } = await import('@animalabs/portal-client');
  const { PortalAgent } = await import('../src/agent.js');
  const { AgentState } = await import('../src/agent-state.js');
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }], channels: [], seq: 0,
  });
  Object.assign(client, {
    async call(method: string) {
      assert.equal(method, 'list_channels');
      return { channels: [
        { id: 'cat1', name: 'ARCHIVE', type: 'category', capabilities: ['VIEW_CHANNEL'] },
        { id: 'c1', name: 'filed', type: 'text', parentId: 'cat1', capabilities: ['VIEW_CHANNEL'] },
        { id: 'c2', name: 'orphan', type: 'text', parentId: 'cat-unseen', capabilities: ['VIEW_CHANNEL'] },
        { id: 'c3', name: 'top', type: 'text', capabilities: ['VIEW_CHANNEL'] },
        { id: 't1', name: 'a-thread', type: 'thread', parentId: 'c1', capabilities: ['VIEW_CHANNEL'] },
      ] };
    },
  });
  const agent = new PortalAgent(client, { state: new AgentState() });
  const got = (await agent.handleToolCall('list_channels', { guildId: 'g1' })) as {
    channels: Array<{ id: string; category?: string; parentId?: string }>;
  };
  const byId = new Map(got.channels.map((c) => [c.id, c]));
  assert.equal(byId.get('c1')!.category, 'ARCHIVE', 'the visible category is joined by name');
  assert.equal(byId.get('c2')!.category, undefined, 'a dangling id stays an id, nothing invented');
  assert.equal(byId.get('c2')!.parentId, 'cat-unseen', 'the honest dangling id is passed through');
  assert.equal(byId.get('c3')!.category, undefined);
  // A thread's parentId is a TEXT channel: the join must not serve it as a
  // "category" (review #99 r2-2 — the type check is what this pins).
  assert.equal(byId.get('t1')!.category, undefined, 'a thread gets no category from its text parent');
});
