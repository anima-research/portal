// Reactions + custom-emoji: list_emojis token/reactionArg mapping, and the
// native (real Discord) reaction path on react/unreact (in addition to the
// structured pseudo-reaction + webhook emulation, which stay intact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';

const GUILD = 'g1';
const PERSONA = 'alice';

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-react-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: [{ id: PERSONA, displayName: 'Alice', avatar: '', token: 'tok' }] }));
  writeFileSync(permissionsPath, JSON.stringify({ personas: { [PERSONA]: { default: [], guilds: { [GUILD]: { default: ['VIEW_CHANNEL', 'ADD_REACTIONS'], channels: {} } } } } }));

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  const calls: { addReaction: unknown[][]; removeReaction: unknown[][] } = { addReaction: [], removeReaction: [] };
  relay.bot = {
    listEmojis: async (_guildId?: string) => [
      { id: '1', name: 'party', animated: false, guildId: GUILD, guildName: 'G' },
      { id: '2', name: 'spin', animated: true, guildId: GUILD, guildName: 'G' },
    ],
    addReaction: async (...args: unknown[]) => { calls.addReaction.push(args); },
    removeReaction: async (...args: unknown[]) => { calls.removeReaction.push(args); },
    isGuildAllowed: () => true,
  };
  // Bypass message-store + capability lookups; we only exercise the react wiring.
  relay.resolveRef = async () => ({ channelId: 'chan', threadId: undefined, discordMsgId: 'disc1', guildId: GUILD, relayId: 'r1' });
  relay.requireCap = () => {};
  relay.displayName = () => 'Alice';
  const dispatched: Array<{ personaId: string; event: any }> = [];
  relay.gateway = { dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }) };

  const session = { personaId: PERSONA, subscriptions: new Set<string>() } as unknown as Session;
  return { relay, calls, dispatched, session, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('list_emojis maps to token (<:name:id>) + reactionArg (:name:), animated aware', async () => {
  const { relay, session, cleanup } = makeRelay();
  try {
    const res = (await relay.dispatchRpc(session, 'list_emojis', { guildId: GUILD })) as {
      emojis: Array<{ name: string; token: string; reactionArg: string; animated: boolean }>;
    };
    const party = res.emojis.find((e) => e.name === 'party')!;
    const spin = res.emojis.find((e) => e.name === 'spin')!;
    assert.equal(party.token, '<:party:1>');
    assert.equal(party.reactionArg, ':party:');
    assert.equal(spin.token, '<a:spin:2>'); // animated → <a:...>
    assert.equal(spin.reactionArg, ':spin:');
  } finally {
    cleanup();
  }
});

test('react native=true adds a real Discord reaction; the pseudo event still fires', async () => {
  const { relay, calls, dispatched, session, cleanup } = makeRelay();
  try {
    await relay.dispatchRpc(session, 'react', { messageId: 'r1', emoji: '👍', visible: false, native: true });
    assert.deepEqual(calls.addReaction[0], ['chan', 'disc1', '👍']);
    // structured pseudo reaction is always dispatched (agents/UI rely on it)
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].event.type, 'reaction_add');
    assert.equal(dispatched[0].event.reaction.kind, 'pseudo');
  } finally {
    cleanup();
  }
});

test('react native=false does NOT touch Discord (webhook/pseudo path unchanged)', async () => {
  const { relay, calls, session, cleanup } = makeRelay();
  try {
    await relay.dispatchRpc(session, 'react', { messageId: 'r1', emoji: '👍', visible: false });
    assert.equal(calls.addReaction.length, 0);
  } finally {
    cleanup();
  }
});

test('unreact native=true removes the shared bot reaction + dispatches pseudo remove', async () => {
  const { relay, calls, dispatched, session, cleanup } = makeRelay();
  try {
    await relay.dispatchRpc(session, 'unreact', { messageId: 'r1', emoji: '👍', native: true });
    assert.deepEqual(calls.removeReaction[0], ['chan', 'disc1', '👍']);
    assert.equal(dispatched[0].event.type, 'reaction_remove');
  } finally {
    cleanup();
  }
});
