import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';

const CH = '1526659685036331058';

function relay() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }],
    channels: [{ id: CH, guildId: 'g1', name: 'portables', type: 'text', capabilities: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }],
    seq: 0,
  });
  return { client };
}

test("send_message returns the first part's answer, pingCleared with it, for a message sent in parts", async () => {
  const { client } = relay();
  let calls = 0;
  Object.assign(client, {
    sendMessage: async () => (++calls === 1 ? { messageId: 'rm_a', pingCleared: true } : { messageId: `rm_${calls}` }),
  });
  const agent = new PortalAgent(client, { state: new AgentState() });
  const result = await agent.handleToolCall('send_message', { channelId: CH, content: 'x'.repeat(4500), replyToId: 'rm_y' });
  assert.ok(calls > 1, 'the message went in parts');
  assert.deepEqual(result, { messageId: 'rm_a', pingCleared: true });
});

async function failingSecondPart(firstAnswer: object, args: Record<string, unknown>): Promise<string> {
  const { client } = relay();
  let calls = 0;
  Object.assign(client, {
    sendMessage: async () => {
      if (++calls === 1) return firstAnswer;
      throw new Error('Discord refused part two');
    },
  });
  const agent = new PortalAgent(client, { state: new AgentState() });
  const err = await agent.handleToolCall('send_message', { channelId: CH, content: 'x'.repeat(4500), ...args }).then(
    () => assert.fail('the send should fail'),
    (e: unknown) => (e as Error).message,
  );
  assert.equal(calls, 2);
  assert.match(err, /^Only part of the message was sent/);
  return err;
}

test('a message whose later part fails says whether its first part cleared the ping', async () => {
  const cleared = await failingSecondPart({ messageId: 'rm_a', pingCleared: true }, { replyToId: 'rm_y' });
  assert.match(cleared, /The first part cleared the pending ping it replied to \(pingCleared\)\./);
  assert.doesNotMatch(cleared, /cleared no pending ping/);

  const notCleared = await failingSecondPart({ messageId: 'rm_a' }, { replyToId: 'rm_y' });
  assert.match(notCleared, /The first part cleared no pending ping\./);

  const noReply = await failingSecondPart({ messageId: 'rm_a' }, {});
  assert.doesNotMatch(noReply, /ping/);
});

test('a reply that clears its ping drops it from the local pending list and the sent ids', async () => {
  for (const cleared of [true, false]) {
    const { client } = relay();
    Object.assign(client, { sendMessage: async () => (cleared ? { messageId: 'rm_a', pingCleared: true } : { messageId: 'rm_a' }) });
    const state = new AgentState();
    state.ingest(
      {
        id: 'rm_y', nativeId: 'y', channelId: CH, guildId: 'g1',
        author: { kind: 'user', userId: 'u1', username: 'bob', displayName: 'Bob', bot: false },
        content: 'hi', cleanContent: 'hi', attachments: [],
        mentions: { personas: [], roles: [], users: [], everyone: false },
        reactions: [], createdAt: '2026-11-20T10:01:00.000Z',
      },
      true,
      ['role_mention'],
    );
    state.noteSent(['rm_y']);
    const agent = new PortalAgent(client, { state });
    await agent.handleToolCall('send_message', { channelId: CH, content: 'answer', replyToId: 'rm_y' });
    assert.equal(state.wasSent('rm_y'), !cleared);
    assert.deepEqual(state.pendingPings().map((p) => p.message.id), cleared ? [] : ['rm_y']);
  }
});
