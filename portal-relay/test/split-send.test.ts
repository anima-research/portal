import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPreservingMarkdown } from '../src/discord-markdown.js';
import { MessageStore } from '../src/message-store.js';
import { stripBridges } from '../src/relay.js';
import { PartialSendError, WebhookPool, type WebhookOps, type WebhookSendOpts } from '../src/webhook-pool.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'portal-split-')), 'attr.json');

// ── WebhookPool.sendMany ──

function fakeOps(failAt?: number): { ops: WebhookOps; sent: WebhookSendOpts[] } {
  const sent: WebhookSendOpts[] = [];
  let n = 0;
  const ops: WebhookOps = {
    ensureWebhooks: async () => ['wh1'],
    sendWebhook: async (_id, opts) => {
      if (failAt !== undefined && n === failAt) throw new Error('boom');
      sent.push(opts);
      return { messageId: `m${++n}` };
    },
    editWebhookMessage: async () => {},
    deleteWebhookMessage: async () => {},
  };
  return { ops, sent };
}

test('sendMany sends all parts in order on one webhook', async () => {
  const { ops, sent } = fakeOps();
  const pool = new WebhookPool(ops, 1);
  const base = { username: 'u', avatarURL: '' };
  const res = await pool.sendMany('chan', 'p1', [
    { ...base, content: 'one' },
    { ...base, content: 'two' },
    { ...base, content: 'three' },
  ]);
  assert.deepEqual(res.messageIds, ['m1', 'm2', 'm3']);
  assert.deepEqual(sent.map((s) => s.content), ['one', 'two', 'three']);
});

test('sendMany keeps parts contiguous against concurrent sends', async () => {
  const { ops, sent } = fakeOps();
  const pool = new WebhookPool(ops, 1);
  const base = { username: 'u', avatarURL: '' };
  const [multi] = await Promise.all([
    pool.sendMany('chan', 'p1', [
      { ...base, content: 'a1' },
      { ...base, content: 'a2' },
    ]),
    pool.send('chan', 'p1', { ...base, content: 'b' }),
  ]);
  assert.equal(multi.messageIds.length, 2);
  const order = sent.map((s) => s.content);
  const i1 = order.indexOf('a1');
  // The two parts must be adjacent — 'b' cannot land between them.
  assert.equal(order[i1 + 1], 'a2');
});

test('sendMany fires onSent per part, in order, as each part posts', async () => {
  const { ops } = fakeOps();
  const pool = new WebhookPool(ops, 1);
  const base = { username: 'u', avatarURL: '' };
  const seen: Array<[number, string, string]> = [];
  await pool.sendMany(
    'chan', 'p1',
    [{ ...base, content: 'one' }, { ...base, content: 'two' }],
    (i, id, wh) => seen.push([i, id, wh]),
  );
  assert.deepEqual(seen, [[0, 'm1', 'wh1'], [1, 'm2', 'wh1']]);
});

test('sendMany fires onSent only for parts that landed before a failure', async () => {
  const { ops } = fakeOps(1); // second send fails
  const pool = new WebhookPool(ops, 1);
  const base = { username: 'u', avatarURL: '' };
  const seen: string[] = [];
  await assert.rejects(
    pool.sendMany(
      'chan', 'p1',
      [{ ...base, content: 'one' }, { ...base, content: 'two' }],
      (_i, id) => seen.push(id),
    ),
    PartialSendError,
  );
  assert.deepEqual(seen, ['m1']);
});

test('sendMany surfaces a PartialSendError carrying the ids that DID send', async () => {
  const { ops } = fakeOps(1); // second send fails
  const pool = new WebhookPool(ops, 1);
  const base = { username: 'u', avatarURL: '' };
  await assert.rejects(
    pool.sendMany('chan', 'p1', [
      { ...base, content: 'one' },
      { ...base, content: 'two' },
    ]),
    (err: unknown) => {
      assert.ok(err instanceof PartialSendError);
      assert.deepEqual(err.sentIds, ['m1']);
      return true;
    },
  );
});

// ── MessageStore split metadata ──

test('split metadata round-trips through attribution persistence', () => {
  const path = tmpFile();
  const s1 = new MessageStore({ path });
  s1.record({
    channelId: 'c', guildId: 'g', discordMsgId: 'd1', personaId: 'p', webhookId: 'w',
    bridgeClose: '```', parts: ['d1', 'd2'],
  });
  s1.record({
    channelId: 'c', guildId: 'g', discordMsgId: 'd2', personaId: 'p', webhookId: 'w',
    bridgeOpen: '```ts\n', partOf: 'd1',
  });
  s1.flush();

  const s2 = new MessageStore({ path });
  const first = s2.getByDiscordId('d1')!;
  const second = s2.getByDiscordId('d2')!;
  assert.deepEqual(first.parts, ['d1', 'd2']);
  assert.equal(first.bridgeClose, '```');
  assert.equal(second.partOf, 'd1');
  assert.equal(second.bridgeOpen, '```ts\n');
});

test('setSplitMeta overwrites bridges — including back to undefined', () => {
  const s = new MessageStore();
  s.record({
    channelId: 'c', guildId: 'g', discordMsgId: 'd1', personaId: 'p',
    bridgeClose: '**', parts: ['d1', 'd2'],
  });
  s.setSplitMeta('d1', {});
  const ref = s.getByDiscordId('d1')!;
  assert.equal(ref.bridgeClose, undefined);
  assert.equal(ref.parts, undefined);
});

// ── stripBridges ──

test('stripBridges removes exact reopener and closer', () => {
  assert.equal(stripBridges('```ts\ncode()', { bridgeOpen: '```ts\n' }), 'code()');
  assert.equal(stripBridges('code()\n```', { bridgeClose: '\n```' }), 'code()');
  assert.equal(
    stripBridges('```ts\ncode()\n```', { bridgeOpen: '```ts\n', bridgeClose: '\n```' }),
    'code()',
  );
});

test('stripBridges tolerates a rewritten fence info string', () => {
  // Discord normalized the info line (e.g. a mention) so the exact match fails,
  // but the fence marker run still identifies the synthetic opener line.
  assert.equal(stripBridges('```@Alice x\ncode()', { bridgeOpen: '```<@1> x\n' }), 'code()');
});

test('stripBridges leaves unrelated text alone', () => {
  assert.equal(stripBridges('plain text', { bridgeOpen: '```\n', bridgeClose: '\n```' }), 'plain text');
  assert.equal(stripBridges('plain text', {}), 'plain text');
});

// ── End-to-end shape: split → strip reassembles the original ──

test('splitting then stripping each part reassembles the original text', () => {
  const original = ['# Doc', '```python', ...Array.from({ length: 120 }, (_, i) => `line_${i} = ${i}  # padding padding padding`), '```', 'tail **bold text** end'].join('\n');
  assert.ok(original.length > 2000);
  const { chunks } = splitPreservingMarkdown(original, 2000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.length <= 2000);
  const reassembled = chunks
    .map((c) => stripBridges(c.text, { bridgeOpen: c.bridgeOpen, bridgeClose: c.bridgeClose }))
    .join('');
  assert.equal(reassembled, original);
});
