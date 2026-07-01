// Regression for the subscribe_channel capability leak (task A2).
//
// Before the fix, `subscribe_channel` skipped the VIEW_CHANNEL capability check
// that every sibling channel RPC enforces, and live dispatch gated only on
// `personaSubscribed` — so a persona could subscribe to a channel it cannot view
// and receive its live messages. These tests pin both halves of the fix:
//   1) subscribe_channel FORBIDs a non-viewable channel and permits a viewable one.
//   2) live dispatch to a subscribed persona is suppressed once the persona can no
//      longer view the channel (defence-in-depth for the subscribe-then-revoke race).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';

const GUILD = 'g1';
const CHAN_OPEN = 'chan-open'; // persona can VIEW_CHANNEL here
const CHAN_SECRET = 'chan-secret'; // persona has no rights here
const PERSONA = 'alice';
const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'];

/** Build a Relay wired to real Identity/Permissions/ReadState stores (tmp files)
 *  but with the Discord bot and WS gateway replaced by fakes — no network, and
 *  full control over channel visibility and dispatch capture. */
function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-a2-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(
    identityPath,
    JSON.stringify({
      personas: [{ id: PERSONA, displayName: 'Alice', avatar: '', token: 'tok' }],
    }),
  );
  // Alice may view CHAN_OPEN only; CHAN_SECRET is outside her scope → deny.
  writeFileSync(
    permissionsPath,
    JSON.stringify({
      personas: {
        [PERSONA]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN_OPEN]: RW } } } },
      },
    }),
  );

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // Fake bot: every channel lives in GUILD and the bot has all Discord perms, so
  // the effective capability is decided purely by the persona policy above.
  relay.bot = {
    channelForPerms: (_channelId: string) => ({
      guildId: GUILD,
      permissionsFor: () => ({ has: () => true }),
    }),
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 1 }],
  };

  // Fake gateway: captures dispatch and lets the test drive subscription state.
  const dispatched: Array<{ personaId: string; event: any }> = [];
  const subscriptions = new Map<string, Set<string>>();
  relay.gateway = {
    activePersonas: () => [...subscriptions.keys()],
    personaSubscribed: (pid: string, chan: string) => subscriptions.get(pid)?.has(chan) ?? false,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
  };

  return { relay, dispatched, subscriptions, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function message(channelId: string): PortalMessage {
  return {
    id: `relay:${channelId}:1`, nativeId: '1', channelId, guildId: GUILD,
    author: { kind: 'user', userId: 'u1', username: 'human', displayName: 'Human', bot: false },
    content: 'hello', cleanContent: 'hello', attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt: '2026-06-30T00:00:00.000Z',
  };
}

test('subscribe_channel: FORBIDDEN on a non-viewable channel, allowed on a viewable one', async () => {
  const { relay, cleanup } = makeRelay();
  try {
    const session = { personaId: PERSONA, subscriptions: new Set<string>() } as unknown as Session;

    // Non-viewable channel → must be rejected with FORBIDDEN, and NOT subscribed.
    await assert.rejects(
      () => relay.dispatchRpc(session, 'subscribe_channel', { channelId: CHAN_SECRET }),
      (err: any) => err?.code === 'FORBIDDEN',
    );
    assert.equal(session.subscriptions.has(CHAN_SECRET), false);

    // Viewable channel → succeeds and is recorded.
    await relay.dispatchRpc(session, 'subscribe_channel', { channelId: CHAN_OPEN });
    assert.equal(session.subscriptions.has(CHAN_OPEN), true);
  } finally {
    cleanup();
  }
});

test('live dispatch: a subscribed-but-non-viewable channel leaks nothing; a viewable one delivers', () => {
  const { relay, dispatched, subscriptions, cleanup } = makeRelay();
  try {
    // Simulate the subscribe-then-revoke race: alice is subscribed to BOTH
    // channels (e.g. subscribed while she had access, since removed for SECRET).
    subscriptions.set(PERSONA, new Set([CHAN_OPEN, CHAN_SECRET]));

    // Ambient message in the channel she can no longer view → no dispatch.
    relay.deliverMessage('message_create', message(CHAN_SECRET));
    assert.equal(
      dispatched.some((d) => d.event?.message?.channelId === CHAN_SECRET),
      false,
      'must not dispatch a channel the persona cannot view',
    );

    // Ambient message in the channel she can view → dispatched.
    relay.deliverMessage('message_create', message(CHAN_OPEN));
    const open = dispatched.filter((d) => d.event?.message?.channelId === CHAN_OPEN);
    assert.equal(open.length, 1, 'must dispatch a viewable subscribed channel');
    assert.equal(open[0].personaId, PERSONA);
  } finally {
    cleanup();
  }
});
