/**
 * MCPL RFC-011 targeted publish on portal. A guild text or forum channel
 * declares `exact` (it holds threads), and a thread or a voice channel's chat
 * declares `root`. A DM, a category and an unknown kind declare nothing. A
 * publish naming its place lands exactly there, through the relay's exact
 * container resolution, or is refused with nothing posted. `null` lands only
 * where the channel's root takes posts: a `root` channel, or an `exact` one
 * other than a forum. The echo is where the relay says it posted.
 *
 * Platform boundary: the relay is a stub here (send_message's answers are
 * modeled); the relay's own resolution, its result's threadId and the error
 * codes it passes through are covered in
 * portal-relay/test/thread-targeting.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, ReadyData } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { AgentState } from '../src/agent-state.js';
import { publishTarget, rootTakesPosts, toDescriptor } from '../src/channels.js';
import { PortalMcplServer } from '../src/server.js';

const TEXT: PortalChannel = { id: '100', guildId: 'g1', name: 'general', type: 'text', capabilities: [] };
const THREAD: PortalChannel = { id: '200', guildId: 'g1', name: 'design', type: 'thread', parentId: '100', capabilities: [] };
// A DM as the relay describes one: no guild, and a kind its mapping doesn't
// name (discord-bot.ts mapChannelType), so `unknown`.
const DM: PortalChannel = { id: '300', guildId: null, name: 'alice', type: 'unknown', capabilities: [] };
const VOICE: PortalChannel = { id: '400', guildId: 'g1', name: 'lounge', type: 'voice', capabilities: [] };
const FORUM: PortalChannel = { id: '500', guildId: 'g1', name: 'ideas', type: 'forum', capabilities: [] };
const CATEGORY: PortalChannel = { id: '600', guildId: 'g1', name: 'stuff', type: 'category', capabilities: [] };
const UNKNOWN: PortalChannel = { id: '700', guildId: 'g1', name: 'stage', type: 'unknown', capabilities: [] };

const READY: ReadyData = {
  sessionId: 's1',
  persona: { id: 'p', displayName: 'Test', avatarUrl: 'https://example.test/a.png' },
  guilds: [{ id: 'g1', name: 'Guild' }],
  channels: [TEXT, THREAD, DM, VOICE, FORUM, CATEGORY, UNKNOWN],
  seq: 0,
} as ReadyData;

type Send = { channelId: string; threadId?: string; content: string };
type Answer = (p: Send, n: number) => Promise<{ messageId: string; threadId?: string | null }>;

function setup(answer: Answer, opts: { hydrated?: boolean } = {}) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  if (opts.hydrated !== false) client.cache.hydrate(READY);
  const sent: Send[] = [];
  (client as unknown as { sendMessage: (p: Send) => Promise<unknown> }).sendMessage = async (p: Send) => {
    sent.push(p);
    return answer(p, sent.length);
  };
  const server = new PortalMcplServer(client, new PortalAgent(client, { state: new AgentState(), hostOwnsChannelLifecycle: true }));
  const publish = (params: Record<string, unknown>) =>
    (server as unknown as { handlePublish(p: unknown): Promise<Record<string, unknown>> }).handlePublish({
      conversationId: 'c',
      content: [{ type: 'text', text: 'answer' }],
      ...params,
    });
  return { client, server, sent, publish };
}

/** A relay answer like the real one: the thread it posted into, else null. */
const relayLike: Answer = async (p, n) => {
  const thread = p.threadId ?? (p.channelId === THREAD.id ? THREAD.id : null);
  return { messageId: `m${n}`, threadId: thread };
};

/** Asserts a refusal: delivered false, a reason matching `reason`, no messageId or threadId, nothing sent. */
function assertRefused(res: Record<string, unknown>, sent: Send[], reason: RegExp, what: string) {
  assert.equal(res.delivered, false, what);
  assert.equal('messageId' in res, false, `${what}: no messageId`);
  assert.equal('threadId' in res, false, `${what}: no threadId`);
  assert.match(String(res.reason), reason, what);
  assert.match(String(res.reason), /nothing was posted$/, `${what}: the reason says nothing was posted`);
  assert.equal(sent.length, 0, `${what}: nothing sent`);
}

const long = (n: number) => [{ type: 'text', text: 'x'.repeat(2000 * n - 500) }];

test('channels declare where a publish lands by kind, and where the root takes posts', () => {
  assert.equal(publishTarget(TEXT), 'exact');
  assert.equal(publishTarget(FORUM), 'exact');
  assert.equal(publishTarget(THREAD), 'root');
  assert.equal(publishTarget(VOICE), 'root');
  assert.equal(publishTarget(DM), undefined, 'the relay posts through webhooks, and a DM has none');
  assert.equal(publishTarget({ ...DM, type: 'text' }), undefined, 'no guild declares nothing, whatever the kind');
  assert.equal(publishTarget(CATEGORY), undefined);
  assert.equal(publishTarget(UNKNOWN), undefined);
  assert.deepEqual(
    [TEXT, THREAD, VOICE, FORUM, DM, CATEGORY, UNKNOWN].map(rootTakesPosts),
    [true, true, true, false, false, false, false],
  );
  assert.deepEqual(toDescriptor(TEXT).capabilities?.publish, { target: 'exact' });
  assert.deepEqual(toDescriptor(THREAD).capabilities?.publish, { target: 'root' });
  assert.equal(toDescriptor(DM).capabilities?.publish, undefined);
  assert.equal(toDescriptor(CATEGORY).capabilities?.publish, undefined);
  assert.ok(toDescriptor(TEXT).capabilities?.history, 'the other capabilities stay');
});

test('a thread target posts into that thread and echoes it', async () => {
  const { sent, publish } = setup(relayLike);
  const res = await publish({ channelId: 'portal:100', threadId: '200' });
  assert.deepEqual(res, { delivered: true, messageId: 'm1', threadId: '200' });
  assert.deepEqual(sent, [{ channelId: '100', threadId: '200', content: 'answer' }]);
});

test('null posts in the channel itself and echoes null, in a text channel, a bare thread channel and a voice chat', async () => {
  for (const [channel, id] of [['portal:100', '100'], ['portal:200', '200'], ['portal:400', '400']] as const) {
    const { sent, publish } = setup(relayLike);
    const res = await publish({ channelId: channel, threadId: null });
    assert.deepEqual(res, { delivered: true, messageId: 'm1', threadId: null }, channel);
    assert.deepEqual(sent, [{ channelId: id, content: 'answer' }]);
  }
});

test('a forum takes a publish in one of its posts, and refuses its root', async () => {
  // A forum's posts are threads under it, and Discord takes no message at
  // the forum's root. The stub would accept a root post, so a refusal here
  // comes from portal-mcpl itself, before the relay is asked.
  const post = setup(relayLike);
  assert.deepEqual(await post.publish({ channelId: 'portal:500', threadId: '510' }), {
    delivered: true,
    messageId: 'm1',
    threadId: '510',
  });
  assert.deepEqual(post.sent, [{ channelId: '500', threadId: '510', content: 'answer' }]);

  const root = setup(relayLike);
  assertRefused(await root.publish({ channelId: 'portal:500', threadId: null }), root.sent, /forum channel has no root/, 'forum root');
});

test('targets that cannot be honored post nothing, each with a reason that says what is known', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // A thread id needs `exact`.
    [{ channelId: 'portal:200', threadId: '999' }, /declares publish target root: it holds no threads, so thread 999/],
    [{ channelId: 'portal:300', threadId: '999' }, /declares no publish target \(a DM isn't one this server posts into\)/],
    [{ channelId: 'portal:600', threadId: '999' }, /declares no publish target \(its kind, category, isn't one/],
    [{ channelId: 'portal:700', threadId: '999' }, /declares no publish target \(its kind, unknown, isn't one/],
    // null needs a root that takes posts: a DM, a category or an unknown kind declares none.
    [{ channelId: 'portal:300', threadId: null }, /declares no publish target \(a DM isn't one this server posts into\), so it can't take a post at its root/],
    [{ channelId: 'portal:600', threadId: null }, /declares no publish target \(its kind, category, isn't one this server posts into\), so it can't take a post at its root/],
    [{ channelId: 'portal:700', threadId: null }, /declares no publish target \(its kind, unknown, isn't one this server posts into\), so it can't take a post at its root/],
    // A channel the cache doesn't hold once the relay is ready.
    [{ channelId: 'portal:777', threadId: '999' }, /unknown channel 777/],
    [{ channelId: 'portal:777', threadId: null }, /unknown channel 777/],
    // Invalid values, described by type with a short excerpt of a string.
    [{ channelId: 'portal:100', threadId: '' }, /invalid threadId \(an empty string\)/],
    [{ channelId: 'portal:100', threadId: 'abc' }, /invalid threadId \(the string "abc"\)/],
    [{ channelId: 'portal:100', threadId: 5 }, /invalid threadId \(a number\)/],
    [{ channelId: 'portal:100', threadId: { id: '200' } }, /invalid threadId \(an object\)/],
    [{ channelId: 'portal:100', threadId: ['200'] }, /invalid threadId \(an array\)/],
    [{ channelId: 'portal:100', threadId: true }, /invalid threadId \(a boolean\)/],
    // A malformed channel on the targeted path says why.
    [{ channelId: 'discord:100', threadId: '200' }, /invalid channelId \(the string "discord:100"\): expected portal:<channel id>/],
    [{ channelId: 'portal:', threadId: null }, /invalid channelId/],
    // No text, or only whitespace.
    [{ channelId: 'portal:100', threadId: null, content: [] }, /no text to send/],
    [{ channelId: 'portal:100', threadId: null, content: [{ type: 'text', text: ' \n\t ' }] }, /no text to send: the content is empty or only whitespace/],
  ];
  for (const [params, reason] of cases) {
    const { sent, publish } = setup(relayLike);
    assertRefused(await publish(params), sent, reason, JSON.stringify(params));
  }
});

test('an invalid threadId is described by an excerpt, never echoed whole', async () => {
  const { sent, publish } = setup(relayLike);
  const huge = `${'7'.repeat(50)}x${'8'.repeat(10_000)}`;
  const res = await publish({ channelId: 'portal:100', threadId: huge });
  assertRefused(res, sent, /invalid threadId \(the string "7{39}…"\)/, 'a long string');
  assert.ok(String(res.reason).length < 200, `bounded: ${String(res.reason).length} characters`);
});

test('a malformed channel on the legacy path keeps the legacy result', async () => {
  const { sent, publish } = setup(relayLike);
  assert.deepEqual(await publish({ channelId: 'discord:100' }), { delivered: false });
  assert.equal(sent.length, 0);
});

test('a refusal of the first chunk, by the relay or by Discord, is a definite failure with its reason', async () => {
  const cases: Array<[unknown, string, RegExp]> = [
    ['NOT_FOUND', 'channel not found', /the relay refused the post \(NOT_FOUND: channel not found\)/],
    ['FORBIDDEN', 'missing capability SEND_IN_THREADS', /the relay refused the post \(FORBIDDEN: missing capability SEND_IN_THREADS\)/],
    ['INVALID_PARAMS', 'File not found: /x', /the relay refused the post \(INVALID_PARAMS: File not found: \/x\)/],
    // Discord's JSON error code, passed through by the relay from a 4xx.
    [50013, 'Missing Permissions', /Discord refused the post \(50013: Missing Permissions\)/],
    [10003, 'Unknown Channel', /Discord refused the post \(10003: Unknown Channel\)/],
  ];
  for (const [code, message, reason] of cases) {
    const refused = setup(async () => {
      throw Object.assign(new Error(message), { code });
    });
    const res = await refused.publish({ channelId: 'portal:100', threadId: '200' });
    assert.equal(res.delivered, false, String(code));
    assert.equal('messageId' in res, false);
    assert.match(String(res.reason), reason);
    assert.match(String(res.reason), /nothing was posted$/);
    assert.equal(refused.sent.length, 1, 'asked once, refused');
  }
});

test('an uncertain failure of the first chunk stays an error, unconfirmed', async () => {
  const uncertain: Array<[unknown, string]> = [
    ['DISCORD_ERROR', 'voice join failed'],
    ['INTERNAL', 'Service Unavailable'],
    ['ECONNRESET', 'socket hang up'],
    [undefined, 'RPC send_message timed out'],
  ];
  for (const [code, message] of uncertain) {
    const failing = setup(async () => {
      throw Object.assign(new Error(message), code === undefined ? {} : { code });
    });
    await assert.rejects(failing.publish({ channelId: 'portal:100', threadId: '200' }), new RegExp(message), String(code));
  }
});

test('a later chunk failing reports what was posted, never as a refusal', async () => {
  const notFound = Object.assign(new Error('channel not found'), { code: 'NOT_FOUND' });
  const second = setup(async (_p, n) => {
    if (n === 2) throw notFound;
    return { messageId: `m${n}`, threadId: '200' };
  });
  const res = await second.publish({ channelId: 'portal:100', threadId: '200', content: long(3) });
  assert.equal(res.delivered, false);
  assert.equal(res.messageId, 'm1', "the first chunk's message, so a host can tell a partial post from none");
  assert.equal(res.threadId, '200', 'where the posted chunk landed');
  assert.match(
    String(res.reason),
    /^chunk 2 of 3 failed \(NOT_FOUND: channel not found\) after the first chunk was posted, starting with message m1; the rest was not sent$/,
  );
  assert.equal(second.sent.length, 2, 'the third chunk was not sent');

  const third = setup(async (_p, n) => {
    if (n === 3) throw Object.assign(new Error('Service Unavailable'), { code: 'INTERNAL' });
    return { messageId: `m${n}`, threadId: '200' };
  });
  const res3 = await third.publish({ channelId: 'portal:100', threadId: '200', content: long(3) });
  assert.equal(res3.delivered, false);
  assert.equal(res3.messageId, 'm1');
  assert.match(String(res3.reason), /^chunk 3 of 3 failed \(INTERNAL: Service Unavailable\) after the first 2 chunks were posted, starting with message m1/);
});

test('a chunked targeted publish that succeeds returns the first message and the agreed echo', async () => {
  const { sent, publish } = setup(relayLike);
  const res = await publish({ channelId: 'portal:100', threadId: '200', content: long(3) });
  assert.deepEqual(res, { delivered: true, messageId: 'm1', threadId: '200' });
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.channelId === '100' && s.threadId === '200'), 'every chunk targets the thread');
  assert.equal(sent.map((s) => s.content).join(''), 'x'.repeat(5500), 'the chunks carry the whole text');
});

test('the echo is what the relay reports, and nothing when it cannot tell', async () => {
  // An older relay omits threadId: no echo, so the host cannot confirm.
  const old = setup(async (_p, n) => ({ messageId: `m${n}` }));
  assert.deepEqual(await old.publish({ channelId: 'portal:100', threadId: '200' }), { delivered: true, messageId: 'm1' });
  // Chunks reporting different places: no echo.
  const split = setup(async (_p, n) => ({ messageId: `m${n}`, threadId: n === 1 ? '200' : null }));
  const res = await split.publish({ channelId: 'portal:100', threadId: '200', content: long(3) });
  assert.equal(res.delivered, true);
  assert.equal('threadId' in res, false);
  // A relay that posted elsewhere is echoed as it posted: the host compares.
  const elsewhere = setup(async (_p, n) => ({ messageId: `m${n}`, threadId: '201' }));
  assert.equal((await elsewhere.publish({ channelId: 'portal:100', threadId: '200' })).threadId, '201');
});

test("a targeted publish before the relay's ready frame waits for it, then decides from the hydrated cache", async () => {
  const { client, sent, publish } = setup(relayLike, { hydrated: false });
  const pending = publish({ channelId: 'portal:100', threadId: '200' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, 'nothing is sent before ready');
  // As the client does on its ready frame: hydrate, then emit.
  client.cache.hydrate(READY);
  (client as unknown as { emit(e: string, d: unknown): void }).emit('ready', READY);
  assert.deepEqual(await pending, { delivered: true, messageId: 'm1', threadId: '200' });
});

test('a targeted publish whose wait for ready runs out is refused as transient, with nothing posted', async () => {
  const { server, sent, publish } = setup(relayLike, { hydrated: false });
  (server as unknown as { readyWaitMs: number }).readyWaitMs = 30;
  const res = await publish({ channelId: 'portal:100', threadId: '200' });
  assertRefused(res, sent, /^not connected to the relay yet \(no ready frame within 0\.03s\), so where this channel takes posts is unknown; try again shortly/, 'no ready');
});

test('a publish without threadId keeps the legacy path and result shape', async () => {
  const { sent, publish } = setup(relayLike);
  const res = await publish({ channelId: 'portal:100' });
  assert.deepEqual(res, { delivered: true, messageId: 'm1' });
  assert.deepEqual(sent, [{ channelId: '100', content: 'answer' }]);
});

test("send_message's output carries the relay's threadId, as its description says", async () => {
  const { client } = setup(async () => ({ messageId: 'm1', threadId: null }));
  const agent = new PortalAgent(client, { state: new AgentState(), hostOwnsChannelLifecycle: true });
  assert.deepEqual(await agent.handleToolCall('send_message', { channelId: '100000000000000001', content: 'hi' }), { messageId: 'm1', threadId: null });
  const inThread = setup(async () => ({ messageId: 'm2', threadId: '200' }));
  const agent2 = new PortalAgent(inThread.client, { state: new AgentState(), hostOwnsChannelLifecycle: true });
  assert.deepEqual(await agent2.handleToolCall('send_message', { channelId: 'portal:100000000000000002', content: 'hi' }), { messageId: 'm2', threadId: '200' });
});
