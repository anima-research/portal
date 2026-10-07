/**
 * MCPL RFC-011 targeted publish on portal. A guild text or forum channel
 * declares `exact` (it holds threads), and a thread, a DM or a voice
 * channel's chat declares `root`. A publish naming its place lands exactly
 * there, through the relay's exact container resolution, or fails with
 * nothing posted. The echo is where the relay says it posted.
 *
 * Platform boundary: the relay is a stub here (send_message's answers are
 * modeled); the relay's own resolution is covered in
 * portal-relay/test/thread-targeting.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { AgentState } from '../src/agent-state.js';
import { publishTarget, toDescriptor } from '../src/channels.js';
import { PortalMcplServer } from '../src/server.js';

const TEXT: PortalChannel = { id: '100', guildId: 'g1', name: 'general', type: 'text', capabilities: [] };
const THREAD: PortalChannel = { id: '200', guildId: 'g1', name: 'design', type: 'thread', parentId: '100', capabilities: [] };
const DM: PortalChannel = { id: '300', guildId: null, name: 'alice', type: 'text', capabilities: [] };
const VOICE: PortalChannel = { id: '400', guildId: 'g1', name: 'lounge', type: 'voice', capabilities: [] };
const FORUM: PortalChannel = { id: '500', guildId: 'g1', name: 'ideas', type: 'forum', capabilities: [] };
const CATEGORY: PortalChannel = { id: '600', guildId: 'g1', name: 'stuff', type: 'category', capabilities: [] };

type Send = { channelId: string; threadId?: string; content: string };

function setup(answer: (p: Send, n: number) => Promise<{ messageId: string; threadId?: string | null }>) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's1',
    persona: { id: 'p', displayName: 'Test', avatarUrl: 'https://example.test/a.png' },
    guilds: [{ id: 'g1', name: 'Guild' }],
    channels: [TEXT, THREAD, DM, VOICE, FORUM, CATEGORY],
    seq: 0,
  });
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
  return { sent, publish };
}

/** A relay answer like the real one: the thread it posted into, else null. */
const relayLike = async (p: Send, n: number) => {
  const thread = p.threadId ?? (p.channelId === THREAD.id ? THREAD.id : null);
  return { messageId: `m${n}`, threadId: thread };
};

test('channels declare where a publish lands by kind', () => {
  assert.equal(publishTarget(TEXT), 'exact');
  assert.equal(publishTarget(FORUM), 'exact');
  assert.equal(publishTarget(THREAD), 'root');
  assert.equal(publishTarget(DM), 'root');
  assert.equal(publishTarget(VOICE), 'root');
  assert.equal(publishTarget(CATEGORY), undefined);
  assert.deepEqual(toDescriptor(TEXT).capabilities?.publish, { target: 'exact' });
  assert.deepEqual(toDescriptor(THREAD).capabilities?.publish, { target: 'root' });
  assert.equal(toDescriptor(CATEGORY).capabilities?.publish, undefined);
  assert.ok(toDescriptor(TEXT).capabilities?.history, 'the other capabilities stay');
});

test('a thread target posts into that thread and echoes it', async () => {
  const { sent, publish } = setup(relayLike);
  const res = await publish({ channelId: 'portal:100', threadId: '200' });
  assert.deepEqual(res, { delivered: true, messageId: 'm1', threadId: '200' });
  assert.deepEqual(sent, [{ channelId: '100', threadId: '200', content: 'answer' }]);
});

test('null posts in the channel itself and echoes null, a bare thread channel included', async () => {
  for (const [channel, id] of [['portal:100', '100'], ['portal:200', '200'], ['portal:300', '300']] as const) {
    const { sent, publish } = setup(relayLike);
    const res = await publish({ channelId: channel, threadId: null });
    assert.deepEqual(res, { delivered: true, messageId: 'm1', threadId: null }, channel);
    assert.deepEqual(sent, [{ channelId: id, content: 'answer' }]);
  }
});

test('targets that cannot be honored post nothing', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ channelId: 'portal:200', threadId: '999' }, /no threads inside it/],
    [{ channelId: 'portal:300', threadId: '999' }, /no threads inside it/],
    [{ channelId: 'portal:600', threadId: '999' }, /no threads inside it/],
    [{ channelId: 'portal:777', threadId: '999' }, /unknown channel/],
    [{ channelId: 'portal:100', threadId: '' }, /invalid threadId/],
    [{ channelId: 'portal:100', threadId: 'abc' }, /invalid threadId/],
    [{ channelId: 'portal:100', threadId: 5 }, /invalid threadId/],
    [{ channelId: 'portal:100', threadId: null, content: [] }, /no text content/],
  ];
  for (const [params, reason] of cases) {
    const { sent, publish } = setup(relayLike);
    const res = await publish(params);
    assert.equal(res.delivered, false, JSON.stringify(params));
    assert.equal('messageId' in res, false);
    assert.equal('threadId' in res, false);
    assert.match(String(res.reason), reason);
    assert.equal(sent.length, 0);
  }
});

test("the relay's refusal of the first chunk is a definite failure; later or uncertain errors stay errors", async () => {
  const notFound = Object.assign(new Error('channel not found'), { code: 'NOT_FOUND' });
  const refused = setup(async () => { throw notFound; });
  const res = await refused.publish({ channelId: 'portal:100', threadId: '200' });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /NOT_FOUND/);

  const internal = setup(async () => { throw Object.assign(new Error('boom'), { code: 'DISCORD_ERROR' }); });
  await assert.rejects(internal.publish({ channelId: 'portal:100', threadId: '200' }), /boom/);

  // A second chunk failing after the first went out: something was posted.
  const partial = setup(async (_p, n) => {
    if (n === 2) throw notFound;
    return { messageId: `m${n}`, threadId: '200' };
  });
  await assert.rejects(
    partial.publish({ channelId: 'portal:100', threadId: '200', content: [{ type: 'text', text: 'x'.repeat(4500) }] }),
    /channel not found/,
  );
});

test('the echo is what the relay reports, and nothing when it cannot tell', async () => {
  // An older relay omits threadId: no echo, so the host cannot confirm.
  const old = setup(async (_p, n) => ({ messageId: `m${n}` }));
  assert.deepEqual(await old.publish({ channelId: 'portal:100', threadId: '200' }), { delivered: true, messageId: 'm1' });
  // Chunks reporting different places: no echo.
  const split = setup(async (_p, n) => ({ messageId: `m${n}`, threadId: n === 1 ? '200' : null }));
  const res = await split.publish({ channelId: 'portal:100', threadId: '200', content: [{ type: 'text', text: 'y'.repeat(4500) }] });
  assert.equal(res.delivered, true);
  assert.equal('threadId' in res, false);
  // A relay that posted elsewhere is echoed as it posted: the host compares.
  const elsewhere = setup(async (_p, n) => ({ messageId: `m${n}`, threadId: '201' }));
  assert.equal((await elsewhere.publish({ channelId: 'portal:100', threadId: '200' })).threadId, '201');
});

test('a publish without threadId keeps the legacy path and result shape', async () => {
  const { sent, publish } = setup(relayLike);
  const res = await publish({ channelId: 'portal:100' });
  assert.deepEqual(res, { delivered: true, messageId: 'm1' });
  assert.deepEqual(sent, [{ channelId: '100', content: 'answer' }]);
});
