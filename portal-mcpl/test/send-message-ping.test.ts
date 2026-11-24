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
