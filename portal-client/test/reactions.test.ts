import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalClient } from '../src/client.js';

/** Minimal ws stand-in exposing the surface PortalClient touches. */
class FakeWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  feed(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }
}

function makeClient() {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    rpcTimeoutMs: 50, // no fake relay answers RPCs; let pending calls settle fast
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w as unknown as import('ws').WebSocket;
    },
  });
  client.connect().catch(() => {}); // opens ws #1
  const ws = created[0];
  // RPCs are held until the session is ready, so bring it up first.
  ws.feed({ op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 30000 } });
  ws.feed({
    op: 'ready',
    d: { sessionId: 's1', seq: 0, persona: { id: 'p', displayName: 'x', avatarUrl: '' }, guilds: [], channels: [], capabilities: {}, subscriptions: [] },
  });
  return { client, ws };
}

test('reaction_add dispatch → typed reactionAdd event', () => {
  const { client, ws } = makeClient();
  const got: Array<{ channelId: string; messageId: string; reaction: { emoji: string; kind: string } }> = [];
  client.on('reactionAdd', (e) => got.push(e as never));
  ws.feed({
    op: 'dispatch',
    seq: 1,
    d: {
      type: 'reaction_add',
      channelId: 'c1',
      messageId: 'm1',
      reaction: { emoji: '👍', count: 1, kind: 'native', by: [{ kind: 'user', id: 'u1', name: 'bob' }] },
    },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].channelId, 'c1');
  assert.equal(got[0].messageId, 'm1');
  assert.equal(got[0].reaction.emoji, '👍');
  assert.equal(got[0].reaction.kind, 'native');
  client.close();
});

test('reaction_remove dispatch → typed reactionRemove event', () => {
  const { client, ws } = makeClient();
  const got: Array<{ emoji: string; actor: { kind: string; name: string } }> = [];
  client.on('reactionRemove', (e) => got.push(e as never));
  ws.feed({
    op: 'dispatch',
    seq: 1,
    d: {
      type: 'reaction_remove',
      channelId: 'c1',
      messageId: 'm1',
      emoji: 'party:123',
      actor: { kind: 'user', id: 'u2', name: 'alice' },
    },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].emoji, 'party:123');
  assert.equal(got[0].actor.name, 'alice');
  client.close();
});

test('react/unreact convenience wrappers send native + visible params', () => {
  const { client, ws } = makeClient();
  // The RPC frame is enqueued synchronously in call(); the promise won't resolve
  // (no fake relay), so swallow the eventual timeout rejection.
  client.react('m1', ':tada:', true, true).catch(() => {});
  client.unreact('m1', ':tada:', true).catch(() => {});
  client.listEmojis('g1').catch(() => {});
  const frames = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.op === 'rpc');
  const react = frames.find((f) => f.d.method === 'react');
  const unreact = frames.find((f) => f.d.method === 'unreact');
  const listEmojis = frames.find((f) => f.d.method === 'list_emojis');
  assert.deepEqual(react.d.params, { messageId: 'm1', emoji: ':tada:', visible: true, native: true });
  assert.deepEqual(unreact.d.params, { messageId: 'm1', emoji: ':tada:', native: true });
  assert.deepEqual(listEmojis.d.params, { guildId: 'g1' });
  client.close();
});
