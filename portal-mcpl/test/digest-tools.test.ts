/**
 * The digest view behind its toggle (portal#79). Off, the served tool surface is today's and a call that asks for the
 * view is refused out loud; on, `view: "digest"` is a per-call choice and `fetch_message` serves what a digest cut.
 * These drive the real PortalAgent.handleToolCall with a client whose fetches are faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { PortalCcChannelServer } from '../src/server-cc.js';
import { digestToolDefinitions, toolDefinitions, withDigestView } from '../src/tools.js';
import * as publicApi from '../src/index.js';

const CHANNEL = '100000000000000003';
const NO_MENTIONS = { personas: [], roles: [], users: [], everyone: false };
let n = 0;
function msg(text: string, over: Partial<PortalMessage> = {}): PortalMessage {
  n++;
  return {
    id: `rel-${n}`, nativeId: `${5000 + n}`, channelId: CHANNEL, guildId: 'g1',
    author: { kind: 'user', userId: 'u1', username: 'ada', displayName: 'Ada', bot: false },
    content: text, cleanContent: text, attachments: [], mentions: NO_MENTIONS, reactions: [],
    createdAt: `2026-10-20T14:${String(n % 60).padStart(2, '0')}:00.000Z`, ...over,
  } as PortalMessage;
}
const words = (k: number): string => Array.from({ length: k }, (_, i) => `w${i + 1}`).join(' ');

type HistoryFn = (params: Record<string, unknown>) => PortalMessage[];
function setup(opts: { digestView?: boolean } = {}, history: PortalMessage[] | HistoryFn = []) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'persona-me' });
  const fetches: Array<Record<string, unknown>> = [];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async (p: Record<string, unknown>) => {
    fetches.push(p);
    return { messages: typeof history === 'function' ? history(p) : history };
  };
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true, ...opts });
  return { agent, fetches, history, client };
}
/** A fake relay for one channel: pages newest-first, and `before` is an exclusive snowflake cursor, as the real one is. */
function fakeRelay(store: Map<string, PortalMessage>): HistoryFn {
  return (p) => {
    const before = typeof p.before === 'string' ? BigInt(p.before) : undefined;
    const rows = [...store.values()].filter((m) => before === undefined || BigInt(m.nativeId) < before);
    rows.sort((a, b) => (BigInt(a.nativeId) < BigInt(b.nativeId) ? 1 : -1));
    return rows.slice(0, typeof p.limit === 'number' ? p.limit : 50);
  };
}
const served = (agent: PortalAgent, name: string) => agent.tools.find((t) => t.name === name);
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.PORTAL_DIGEST_VIEW;
  if (value === undefined) delete process.env.PORTAL_DIGEST_VIEW; else process.env.PORTAL_DIGEST_VIEW = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.PORTAL_DIGEST_VIEW; else process.env.PORTAL_DIGEST_VIEW = saved; }
}

// ── off (the default): today's surface ──

test('off by default: no fetch_message in the served tools, and neither fetch tool offers view or words', () => {
  withEnv(undefined, () => {
    const { agent } = setup();
    assert.equal(served(agent, 'fetch_message'), undefined);
    for (const name of ['fetch_history', 'fetch_around']) {
      const props = served(agent, name)!.inputSchema.properties;
      assert.ok(!('view' in props) && !('words' in props), `${name} offers a digest property while off`);
    }
  });
});

test('off: the two fetch tools are served exactly as the static definitions have them', () => {
  withEnv(undefined, () => {
    const { agent } = setup();
    for (const name of ['fetch_history', 'fetch_around']) {
      assert.deepEqual(served(agent, name), toolDefinitions.find((t) => t.name === name));
    }
  });
});

test('off: a call that passes view is refused before anything is fetched, and says how to turn it on', async () => {
  await withEnv(undefined, async () => {
    const { agent, fetches } = setup({}, [msg('hi')]);
    for (const tool of ['fetch_history', 'fetch_around']) {
      await assert.rejects(
        agent.handleToolCall(tool, { channelId: CHANNEL, messageId: 'rel-1', view: 'digest' }),
        /digest view is not enabled on this server[\s\S]*PORTAL_DIGEST_VIEW/,
      );
    }
    assert.equal(fetches.length, 0, 'nothing was fetched for a refused call');
  });
});

test('off: even view "full" is refused, so an agent never believes it is getting a view the server does not have', async () => {
  await withEnv(undefined, async () => {
    const { agent, fetches } = setup();
    await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'full' }), /not enabled/);
    await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, words: 10 }), /not enabled/);
    assert.equal(fetches.length, 0);
  });
});

test('off: fetch_message is refused with the same explanation', async () => {
  await withEnv(undefined, async () => {
    const { agent } = setup();
    await assert.rejects(agent.handleToolCall('fetch_message', { messageId: 'rel-1' }), /fetch_message[\s\S]*not enabled[\s\S]*PORTAL_DIGEST_VIEW/);
  });
});

test('off: fetch_history and fetch_around return the relay\'s messages untouched, as before', async () => {
  await withEnv(undefined, async () => {
    const history = [msg(words(100)), msg('short')];
    const { agent } = setup({}, history);
    assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL }), { messages: history });
    // Both halves of the window come from the same page here, so a correct merge is that page once, oldest first.
    const around = (await agent.handleToolCall('fetch_around', { channelId: CHANNEL, messageId: 'rel-1' })) as { messages: PortalMessage[] };
    assert.deepEqual(around.messages.map((m) => m.id), [...history].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((m) => m.id));
    assert.equal(around.messages.length, history.length, 'duplicates from the two halves are merged');
  });
});

// ── on ──

test('on: view and words are offered, with view limited to full and digest, and fetch_message is served', () => {
  const { agent } = setup({ digestView: true });
  for (const name of ['fetch_history', 'fetch_around']) {
    const props = served(agent, name)!.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
    assert.deepEqual(props.view!.enum, ['full', 'digest']);
    assert.equal(props.words!.type, 'integer');
  }
  assert.deepEqual(served(agent, 'fetch_message')!.inputSchema.required, ['messageId']);
});

test('on: the channel and cursor properties the tools already had are all still there', () => {
  const { agent } = setup({ digestView: true });
  const was = (name: string) => Object.keys(toolDefinitions.find((t) => t.name === name)!.inputSchema.properties);
  for (const name of ['fetch_history', 'fetch_around']) {
    const now = Object.keys(served(agent, name)!.inputSchema.properties);
    for (const p of was(name)) assert.ok(now.includes(p), `${name} lost ${p}`);
    assert.deepEqual(served(agent, name)!.inputSchema.required, toolDefinitions.find((t) => t.name === name)!.inputSchema.required);
  }
});

test('on, but view not asked for: the result is the full messages, as today (the digest is per-call)', async () => {
  const history = [msg(words(100))];
  const { agent } = setup({ digestView: true }, history);
  assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL }), { messages: history });
  assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'full' }), { messages: history });
});

test('on: view "digest" returns one line per message, a note, and asks the relay for the same page it always did', async () => {
  const history = [msg(words(60)), msg('short one')];
  const { agent, fetches } = setup({ digestView: true }, history);
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, limit: 2, view: 'digest', words: 10 })) as {
    view: string; count: number; note: string; ids: string[]; lines: string[];
  };
  assert.equal(out.view, 'digest');
  assert.equal(out.count, 2);
  assert.equal(out.lines.length, 2);
  assert.ok(out.lines[0]!.includes('… (+50 words, full: '), out.lines[0]);
  assert.ok(out.lines[1]!.endsWith(': short one'));
  assert.match(out.note, /fetch_message/);
  assert.match(out.note, /UTC/);
  assert.match(out.note, /reads the message from the relay now/, 'the note promises a live read, and fetch_message keeps the promise');
  assert.deepEqual(out.ids, history.map((m) => m.id).sort((a, b) => (history.find((x) => x.id === a)!.createdAt < history.find((x) => x.id === b)!.createdAt ? -1 : 1)));
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0]!.limit, 2, 'the page size is the caller\'s, not changed by the view');
  assert.ok(!('view' in fetches[0]!) && !('words' in fetches[0]!), 'the relay is not sent a view it does not know');
});

test('on: the digest knows the agent\'s own persona, so a message that mentions it comes back whole', async () => {
  const history = [msg(words(80), { mentions: { ...NO_MENTIONS, personas: ['persona-me'] } }), msg(words(80))];
  const { agent } = setup({ digestView: true }, history);
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  const whole = out.lines.find((l) => l.includes('★to-you'))!;
  assert.ok(whole.endsWith('w80'));
  assert.ok(out.lines.some((l) => l.includes('… (+75 words')), out.lines.join('\n'));
});

test('on: fetch_around digests the window it already builds: halves merged once, oldest first, cut at words', async () => {
  const late = msg('closing line', { createdAt: '2026-10-20T16:00:00.000Z' });
  const early = msg(words(40), { createdAt: '2026-10-20T14:00:00.000Z' });
  // The stub gives both halves the same page, so a correct window holds each message once.
  const { agent } = setup({ digestView: true }, [late, early]);
  const out = (await agent.handleToolCall('fetch_around', { channelId: CHANNEL, messageId: 'rel-1', view: 'digest', words: 5 })) as { lines: string[]; count: number; ids: string[] };
  assert.equal(out.count, 2);
  assert.deepEqual(out.ids, [early.id, late.id]);
  assert.match(out.lines[0]!, /^#1 10-20 14:00 Ada: w1 w2 w3 w4 w5… \(\+35 words, full: rel-\d+\)$/);
  assert.match(out.lines[1]!, /^#2 10-20 16:00 Ada: closing line$/);
});

const store = (...ms: PortalMessage[]) => new Map(ms.map((m) => [m.nativeId, m]));

test('R1-2: fetch_message is a live read: it asks the relay for exactly that message, in its channel, and returns what the relay says now', async () => {
  const target = msg(words(90));
  const newer = msg('a later message in the same channel');
  const relay = store(target, newer);
  const { agent, fetches } = setup({ digestView: true }, fakeRelay(relay));
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  fetches.length = 0;
  assert.deepEqual(await agent.handleToolCall('fetch_message', { messageId: target.id }), { message: target });
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0], { channelId: CHANNEL, threadId: undefined, before: String(BigInt(target.nativeId) + 1n), limit: 1 });
  assert.deepEqual(await agent.handleToolCall('fetch_message', { messageId: target.nativeId }), { message: target }, 'by snowflake too');
});

test('R1-2: an edit is seen with no event: the relay\'s answer is the message, reactions included', async () => {
  const m = msg(words(90));
  const relay = store(m);
  const { agent } = setup({ digestView: true }, fakeRelay(relay));
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  relay.set(m.nativeId, { ...m, content: 'edited text', cleanContent: 'edited text', reactions: [{ emoji: '👍', count: 3, kind: 'native', by: [] }] });
  const now = (await agent.handleToolCall('fetch_message', { messageId: m.id })) as { message: PortalMessage };
  assert.equal(now.message.cleanContent, 'edited text');
  assert.equal(now.message.reactions[0]!.count, 3);
});

test('R1-2: a message the relay no longer has is reported gone, not served from memory', async () => {
  const older = msg('older');            // an OLDER snowflake, so the relay has something just before the target to hand back
  const m = msg(words(90));
  const relay = store(older, m);
  const { agent } = setup({ digestView: true }, fakeRelay(relay));
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  relay.delete(m.nativeId);
  await assert.rejects(agent.handleToolCall('fetch_message', { messageId: m.id }), /no longer there[\s\S]*deleted/);
  assert.ok(relay.has(older.nativeId), 'premise: the relay still answers with the message just before the deleted one, and that is not the target');
});

test('R1-2: when the relay refuses the read (the agent lost access), the refusal is the answer, not a cached copy', async () => {
  const m = msg(words(90));
  let revoked = false;
  const relay = fakeRelay(store(m));
  const { agent } = setup({ digestView: true }, (p) => { if (revoked) throw new Error('you can no longer read this channel'); return relay(p); });
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  revoked = true;
  await assert.rejects(agent.handleToolCall('fetch_message', { messageId: m.id }), /no longer read this channel/);
});

test('R1-2: a message in a thread is read in its thread', async () => {
  const m = msg(words(90), { threadId: 'thread-9' });
  const { agent, fetches } = setup({ digestView: true }, fakeRelay(store(m)));
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  fetches.length = 0;
  await agent.handleToolCall('fetch_message', { messageId: m.id });
  assert.equal(fetches[0]!.threadId, 'thread-9');
});

test('on: fetch_message for an id no digest showed says why and what to do, and does not guess', async () => {
  const { agent, fetches } = setup({ digestView: true });
  await assert.rejects(
    agent.handleToolCall('fetch_message', { messageId: 'rel-unknown' }),
    /isn't one this server has shown in a digest[\s\S]*500[\s\S]*restart[\s\S]*fetch_history/,
  );
  assert.equal(fetches.length, 0, 'nothing is asked of the relay for an id it cannot place');
});

test('on: a view other than full or digest, or words without the digest, is refused before anything is fetched', async () => {
  const { agent, fetches } = setup({ digestView: true }, [msg('hi')]);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'brief' }), /view must be "full" or "digest"/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, words: 10 }), /words only applies to view "digest"/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 0 }), /words/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 'ten' }), /words/);
  assert.equal(fetches.length, 0);
});

// ── the toggle itself ──

test('PORTAL_DIGEST_VIEW turns it on at the server (1 or true); anything else leaves it off', () => {
  for (const [value, on] of [['1', true], ['true', true], ['0', false], ['', false], ['yes', false], [undefined, false]] as const) {
    withEnv(value, () => assert.equal(setup().agent.tools.some((t) => t.name === 'fetch_message'), on, `PORTAL_DIGEST_VIEW=${String(value)}`));
  }
});

test('an explicit option beats the environment, both ways', () => {
  withEnv('1', () => assert.equal(setup({ digestView: false }).agent.tools.some((t) => t.name === 'fetch_message'), false));
  withEnv(undefined, () => assert.equal(setup({ digestView: true }).agent.tools.some((t) => t.name === 'fetch_message'), true));
});

test('the host-owned-channels filter still applies with the digest on', () => {
  const { agent } = setup({ digestView: true });
  assert.equal(served(agent, 'subscribe_channel'), undefined);
  assert.ok(served(agent, 'fetch_history') && served(agent, 'send_message'));
});

// ── the public list, the cache's freshness, replies to older posts, and the server path ──

test('the public toolDefinitions is the surface a server without the view offers: no fetch_message, no view or words', () => {
  assert.ok(!toolDefinitions.some((t) => t.name === 'fetch_message'));
  for (const name of ['fetch_history', 'fetch_around']) {
    const props = toolDefinitions.find((t) => t.name === name)!.inputSchema.properties;
    assert.ok(!('view' in props) && !('words' in props), name);
  }
  assert.deepEqual(digestToolDefinitions.map((t) => t.name), ['fetch_message']);
});

test('a reply to an older post of the agent\'s own, outside the batch, comes back whole when this server sent that post', async () => {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'persona-me' });
  const reply = msg(words(80), { replyToId: 'rm_c_sent_earlier' });
  (client as unknown as { sendMessage: unknown }).sendMessage = async () => ({ messageId: 'rm_c_sent_earlier' });
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async () => ({ messages: [reply] });
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true, digestView: true });
  const before = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  assert.ok(before.lines[0]!.includes('… (+75 words'), 'before the agent has posted, it is just a reply to something unseen');
  await agent.handleToolCall('send_message', { channelId: CHANNEL, content: 'hello' });
  const after = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  assert.ok(after.lines[0]!.includes('★to-you') && after.lines[0]!.endsWith('w80'), after.lines[0]);
});

test('a message of the agent\'s own that a digest showed is remembered, so a later reply to it counts', async () => {
  const mine = msg('my old post', { author: { kind: 'persona', personaId: 'persona-me', displayName: 'me', avatarUrl: '' } });
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'persona-me' });
  let page: PortalMessage[] = [mine];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async () => ({ messages: page });
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true, digestView: true });
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest' });
  page = [msg(words(80), { replyToId: mine.id })];
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  assert.ok(out.lines[0]!.includes('★to-you'), out.lines[0]);
});

// The server path (Claude Code channel server): a tools/call for a tool this server hides is answered by the agent, as an
// error result that says how to turn it on, and nothing is fetched.
function ccServer(opts: { digestView?: boolean }, history: PortalMessage[] = []) {
  const { agent, fetches, client } = setup(opts, history);
  const server = new PortalCcChannelServer(client, agent);
  const responses: Array<{ content: Array<{ text: string }>; isError?: boolean }> = [];
  (server as unknown as { conn: unknown }).conn = {
    sendResponse(_id: number, result: unknown) { responses.push(result as never); },
    sendError() {}, sendNotification() {}, async sendRequest() { return {}; },
  };
  const call = (name: string, args: Record<string, unknown>) =>
    (server as unknown as { handleRequest(r: unknown): Promise<void> }).handleRequest({ id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { call, responses, fetches };
}

test('server path, off: a hidden fetch_message and a stray view each come back as an error result, and nothing is fetched', async () => {
  await withEnv(undefined, async () => {
    const { call, responses, fetches } = ccServer({}, [msg('hi')]);
    await call('fetch_message', { messageId: 'rel-1' });
    await call('fetch_history', { channelId: CHANNEL, view: 'digest' });
    assert.equal(responses.length, 2);
    assert.ok(responses.every((r) => r.isError === true));
    assert.match(responses[0]!.content[0]!.text, /fetch_message is not enabled[\s\S]*PORTAL_DIGEST_VIEW=1/);
    assert.match(responses[1]!.content[0]!.text, /digest view is not enabled[\s\S]*PORTAL_DIGEST_VIEW=1/);
    assert.equal(fetches.length, 0);
  });
});

test('server path, on: tools/call fetch_history with view digest answers with the digest', async () => {
  const { call, responses } = ccServer({ digestView: true }, [msg('short one')]);
  await call('fetch_history', { channelId: CHANNEL, view: 'digest' });
  assert.equal(responses[0]!.isError, undefined);
  assert.match(responses[0]!.content[0]!.text, /"view": "digest"[\s\S]*short one/);
});

// ── the second review (Anarchid's campaign, R1-1..R1-7) ──

test('R1-3: through the agent, an addressed message keeps its line breaks in the digest line', async () => {
  const code = 'please check:\n```py\ndef f(x):\n    if x:\n        return 1\n    return 2\n```';
  const { agent } = setup({ digestView: true }, [msg(code, { mentions: { ...NO_MENTIONS, personas: ['persona-me'] } })]);
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[]; note: string };
  assert.ok(out.lines[0]!.endsWith(`: ${code}`), JSON.stringify(out.lines[0]));
  assert.match(out.note, /line breaks/);
});

test('R1-1: through the agent, a result is valid for the API even when a cut falls inside an emoji', async () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const { agent } = setup({ digestView: true }, [msg('abcdefghijk' + '😀'.repeat(40)), msg('日本語'.repeat(80))]);
  const out = await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 1 });
  const wire = JSON.stringify(out, null, 2);
  assert.ok(!lone.test(JSON.parse(wire).lines.join('\n')), wire);
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(wire), 'no unpaired surrogate escape on the wire');
});

test('R1-5: the package exports what a host that builds its own tools/list needs', () => {
  assert.equal(publicApi.digestToolDefinitions, digestToolDefinitions);
  assert.equal(publicApi.withDigestView, withDigestView);
  assert.equal(publicApi.toolDefinitions, toolDefinitions);
});

test('R1-6: past the remembered-ids bound it is the OLDEST own posts that are forgotten, not the newest', async () => {
  const mine = Array.from({ length: 2100 }, (_, i) => msg(`own post ${i}`, {
    author: { kind: 'persona', personaId: 'persona-me', displayName: 'me', avatarUrl: '' },
    createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + i * 1000).toISOString(),
  }));
  const newestFirst = [...mine].reverse();                   // the relay returns history newest-first
  let page: PortalMessage[] = newestFirst;
  const { agent } = setup({ digestView: true }, () => page);
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest' });
  page = [
    msg(words(60), { replyToId: mine[2099]!.id, createdAt: '2026-10-21T00:00:00.000Z' }),
    msg(words(60), { replyToId: mine[0]!.id, createdAt: '2026-10-21T00:00:01.000Z' }),
  ];
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  assert.ok(out.lines[0]!.includes('★to-you'), `a reply to the newest own post is known: ${out.lines[0]}`);
  assert.ok(out.lines[1]!.includes('… (+55 words') && !out.lines[1]!.includes('★'), `a reply to the oldest, past the bound, is not: ${out.lines[1]}`);
});

test('R1-7: words is declared as a bounded integer, so a model sees the contract before it is refused', () => {
  const { agent } = setup({ digestView: true });
  for (const name of ['fetch_history', 'fetch_around']) {
    const words = (served(agent, name)!.inputSchema.properties as Record<string, Record<string, unknown>>).words!;
    assert.equal(words.type, 'integer');
    assert.equal(words.minimum, 1);
    assert.equal(words.maximum, 500);
  }
});
