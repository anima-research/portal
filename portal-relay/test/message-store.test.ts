import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageStore, makeRelayId, parseRelayId } from '../src/message-store.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'portal-attr-')), 'attr.json');

test('deterministic id: same snowflake → same id across instances', () => {
  assert.equal(makeRelayId('chan1', 'msg1'), makeRelayId('chan1', 'msg1'));
  assert.deepEqual(parseRelayId(makeRelayId('chan1', 'msg1')), {
    channelId: 'chan1',
    discordMsgId: 'msg1',
  });
});

test('parseRelayId rejects malformed ids', () => {
  assert.equal(parseRelayId('nope'), null);
  assert.equal(parseRelayId('rm_'), null);
  assert.equal(parseRelayId('rm_only'), null);
  assert.equal(parseRelayId('rm_c_'), null);
});

test('record derives a deterministic id; thread container is the thread', () => {
  const s = new MessageStore();
  assert.equal(
    s.record({ channelId: 'c', guildId: 'g', discordMsgId: 'm', personaId: 'p', webhookId: 'w' }).relayId,
    makeRelayId('c', 'm'),
  );
  assert.equal(
    s.record({ channelId: 'parent', threadId: 't', guildId: 'g', discordMsgId: 'm2' }).relayId,
    makeRelayId('t', 'm2'),
  );
});

test('attribution survives a simulated restart (new store, same file)', () => {
  const path = tmpFile();
  const s1 = new MessageStore({ path });
  const ref = s1.record({ channelId: 'c', guildId: 'g', discordMsgId: 'm', personaId: 'alice', webhookId: 'wh' });
  s1.flush();

  const s2 = new MessageStore({ path }); // fresh in-memory state = restart
  const byId = s2.getByRelayId(ref.relayId);
  assert.ok(byId, 'pre-restart relay id resolves');
  assert.equal(byId.personaId, 'alice');
  assert.equal(byId.webhookId, 'wh');
  assert.equal(byId.channelId, 'c');
  assert.equal(s2.getByDiscordId('m')?.personaId, 'alice');
});

test('external (no-persona) messages are not ownable after restart', () => {
  const path = tmpFile();
  const s1 = new MessageStore({ path });
  s1.record({ channelId: 'c', guildId: 'g', discordMsgId: 'x' }); // external: no personaId
  s1.flush();
  const s2 = new MessageStore({ path });
  // Not recoverable → an edit attempt would NOT_FOUND rather than mis-attribute.
  assert.equal(s2.getByRelayId(makeRelayId('c', 'x')), undefined);
});

test('memory eviction keeps persisted attribution intact', () => {
  const path = tmpFile();
  const s1 = new MessageStore({ path, cap: 2 });
  s1.record({ channelId: 'c', guildId: 'g', discordMsgId: 'a', personaId: 'p', webhookId: 'w' });
  s1.record({ channelId: 'c', guildId: 'g', discordMsgId: 'b', personaId: 'p', webhookId: 'w' });
  s1.record({ channelId: 'c', guildId: 'g', discordMsgId: 'd', personaId: 'p', webhookId: 'w' }); // evicts 'a'
  // 'a' evicted from memory, but persisted attribution still resolves it.
  assert.equal(s1.getByRelayId(makeRelayId('c', 'a'))?.personaId, 'p');
  s1.flush();
});
