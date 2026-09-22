// MCPL server: an addressed push for a CLOSED channel folds in the relay's
// missed backlog for that channel (the agent's only view of it), cut at the
// watermark, without touching the relay's watermark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';

const CH = '500';
const chan: PortalChannel = { id: CH, guildId: 'g1', name: 'nda', type: 'text', capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'] };
const T = (n: number) => `2026-09-21T23:${String(n).padStart(2, '0')}:00.000Z`;
function msg(id: string, createdAt: string, content: string, who = 'janus'): PortalMessage {
  return {
    id, nativeId: id, channelId: CH, guildId: 'g1',
    author: { kind: 'user', userId: who, username: who, displayName: who, bot: false },
    content, cleanContent: content, attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false }, reactions: [], createdAt,
  };
}

test('closed-channel addressed push carries the missed backlog since the watermark, once', async () => {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }], channels: [chan], seq: 0,
  });
  const rpc: string[] = [];
  const history = [msg('m1', T(1), 'old, under watermark'), msg('m2', T(2), 'between'), msg('m3', T(3), 'also between'), msg('m4', T(4), '@P ping')];
  Object.assign(client, {
    async fetchHistory() { rpc.push('fetch_history'); return { messages: [...history].reverse() }; },
    async call(method: string) {
      rpc.push(method);
      if (method === 'channel_missed') return { channelId: CH, messages: 3, characters: 30, since: T(1), lastAt: T(4) };
      if (method === 'get_pending_pings') return { pings: [] };
      throw new Error(`unexpected ${method}`);
    },
  });
  const agent = new PortalAgent(client, { state: new AgentState(), hostOwnsChannelLifecycle: true });
  const server = new PortalMcplServer(client, agent);
  const pushes: Array<{ payload: { content: Array<{ type: string; text?: string }> } }> = [];
  const internal = server as unknown as {
    conn: unknown; mcplEnabled: boolean; policy: { applyRequest(p: unknown): unknown }; wireClient(): void;
  };
  internal.conn = {
    async sendRequest(m: string, params: never) { if (m === 'push/event') pushes.push(params); return {}; },
    sendNotification() {},
  };
  internal.mcplEnabled = true;
  internal.policy.applyRequest({ effectiveCapabilities: [...new Set(Object.values(featureSets).flatMap((s) => s.uses as string[]))] });
  internal.wireClient();

  client.emit('message', { message: history[3], addressedToMe: true, reasons: ['role_mention'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushes.length, 1);
  const text = pushes[0].payload.content.map((b) => b.text ?? '').join('\n');
  assert.match(text, /\[2 message\(s\) in #nda since you last read it:\]\njanus: between\njanus: also between\n\[addressed to you:\]\njanus: @P ping/);
  assert.doesNotMatch(text, /under watermark/);
  assert.ok(!rpc.includes('mark_read'), "the relay's watermark is the agent's to advance");

  // A second ping: the local watermark cuts the already-folded backlog.
  const m5 = msg('m5', T(5), '@P again');
  history.push(m5);
  client.emit('message', { message: m5, addressedToMe: true, reasons: ['role_mention'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushes.length, 2);
  const text2 = pushes[1].payload.content.map((b) => b.text ?? '').join('\n');
  assert.doesNotMatch(text2, /between/);
  // m4 (the previous ping) is above the local watermark and before m5 → folded as context.
  assert.match(text2, /\[1 message\(s\) in #nda since you last read it:\]\njanus: @P ping\n\[addressed to you:\]\njanus: @P again/);

  // Ambient in a closed channel still pushes plainly (no fold, no wake flags added).
  client.emit('message', { message: msg('m6', T(6), 'chatter'), addressedToMe: false, reasons: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushes.length, 3);
  assert.equal(pushes[2].payload.content.length, 1);
});
