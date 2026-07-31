// Forwards, system messages, reply gating, reaction snippets — ports of
// discord-mcpl 7225132/164e5aa/92ac27e adapted to the relay architecture.
// The visible-body resolution lives in discord-bot convert() (single choke
// point for live/edit/history/pins), so unit tests on the exported helpers
// plus the reaction-event pass-through cover every delivery path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageType } from 'discord.js';
import {
  buildForwardedContent,
  buildReactionSnippet,
  resolveVisibleContent,
  systemMessageText,
} from '../src/discord-bot.js';

// ── resolveVisibleContent: forwards ──

function snapshots(...snaps: Array<{ content?: string | null; attachments?: { size: number }; embeds?: { length: number } }>) {
  return { size: snaps.length, values: () => snaps };
}

test('bare forward renders its snapshot text instead of arriving empty', () => {
  const out = resolveVisibleContent({
    content: '',
    cleanContent: '',
    type: MessageType.Default,
    messageSnapshots: snapshots({ content: 'the original text' }),
  });
  assert.equal(out, '[forwarded message] the original text');
});

test('forward below commentary keeps the commentary first', () => {
  const out = resolveVisibleContent({
    content: 'look at this',
    cleanContent: 'look at this',
    messageSnapshots: snapshots({ content: 'original' }),
  });
  assert.equal(out, 'look at this\n[forwarded message] original');
});

test('attachment/embed-only snapshots get bracketed notes, not silence', () => {
  assert.equal(
    buildForwardedContent('', [{ content: null, attachments: { size: 2 } }]),
    '[forwarded message] [2 attachments]',
  );
  assert.equal(
    buildForwardedContent('', [{ content: null, embeds: { length: 1 } }]),
    '[forwarded message] [embed]',
  );
  assert.equal(buildForwardedContent('', [{ content: null }]), '[forwarded message] [no text content]');
});

test('empty snapshot collection falls back to the base content', () => {
  assert.equal(buildForwardedContent('base', []), 'base');
});

test('cleanContent fallback ordering: cleanContent > content', () => {
  assert.equal(resolveVisibleContent({ content: 'raw', cleanContent: 'clean' }), 'clean');
  assert.equal(resolveVisibleContent({ content: 'raw', cleanContent: '' }), 'raw');
  assert.equal(resolveVisibleContent({ content: 'raw' }), 'raw');
});

// ── resolveVisibleContent: system messages ──

test('content-less system message synthesizes the client affordance text', () => {
  assert.equal(
    resolveVisibleContent({ content: '', cleanContent: '', type: MessageType.UserJoin }),
    '[joined the server]',
  );
  assert.equal(
    resolveVisibleContent({ content: '', cleanContent: '', type: MessageType.ChannelPinnedMessage }),
    '[pinned a message to this channel]',
  );
});

test('unknown system types degrade to a typed marker, never empty', () => {
  const out = systemMessageText(999 as MessageType);
  assert.match(out, /^\[system message: type 999\]$/);
});

test('Default and Reply types never get system synthesis (attachment-only reply)', () => {
  assert.equal(resolveVisibleContent({ content: '', cleanContent: '', type: MessageType.Default }), '');
  assert.equal(resolveVisibleContent({ content: '', cleanContent: '', type: MessageType.Reply }), '');
});

test('system synthesis only applies when the body is empty', () => {
  assert.equal(
    resolveVisibleContent({ content: 'hi', cleanContent: 'hi', type: MessageType.UserJoin }),
    'hi',
  );
});

// ── buildReactionSnippet ──

test('reaction snippet: emoji rendered, whitespace collapsed, 80-char cap', () => {
  assert.equal(buildReactionSnippet('hello <:party:123>  world\n\nnext'), 'hello :party: world next');
  assert.equal(buildReactionSnippet(null), null);
  assert.equal(buildReactionSnippet('   \n '), null);
  const long = 'x'.repeat(200);
  const capped = buildReactionSnippet(long)!;
  assert.equal(capped.length, 80);
  assert.ok(capped.endsWith('…'));
});

// ── relay pass-through: snippet reaches reaction_add/remove dispatches ──

import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('onReactionEvent carries messageSnippet through to both dispatch shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-fwd-'));
  try {
    const identityPath = join(dir, 'identity.json');
    const permissionsPath = join(dir, 'permissions.json');
    writeFileSync(identityPath, JSON.stringify({ personas: [{ id: 'alice', displayName: 'Alice', avatar: '', token: 't' }] }));
    writeFileSync(permissionsPath, JSON.stringify({ personas: { alice: { default: [], guilds: {} } } }));
    const config: RelayConfig = {
      discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: ['g1'],
      identityPath, permissionsPath,
      rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
      heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
      historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
      allowPathFiles: false, replyLink: false,
    };
    const relay = new Relay(config) as any;
    const dispatched: Array<{ personaId: string; event: any }> = [];
    relay.gateway = {
      dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
      activePersonas: () => ['alice'],
      personaSubscribed: () => true,
    };
    relay.personaCanViewChannelId = () => true;
    relay.store = { getByRelayId: () => undefined };

    const base = {
      messageId: 'm1', channelId: 'c1', threadId: undefined, guildId: 'g1',
      emoji: '👍', userId: 'u1', userName: 'bob', isBot: false,
      messageSnippet: 'the reacted-to text',
    };
    relay.onReactionEvent('add', base);
    relay.onReactionEvent('remove', base);
    relay.onReactionEvent('add', { ...base, messageSnippet: null });

    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[0].event.type, 'reaction_add');
    assert.equal(dispatched[0].event.messageSnippet, 'the reacted-to text');
    assert.equal(dispatched[1].event.type, 'reaction_remove');
    assert.equal(dispatched[1].event.messageSnippet, 'the reacted-to text');
    assert.equal(dispatched[2].event.messageSnippet, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
