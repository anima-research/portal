// Regressions for issue #27: the capability model must gate EVERYTHING the
// relay serves, not only message-level RPCs.
//
//   1) Directory reads (ready, list_guilds, list_channels) are filtered to the
//      guilds a persona has rights in and the channels it holds a capability
//      in; threads inherit their parent's visibility.
//   2) Guild-level reads (list_members / resolve_mentions / list_roles /
//      list_emojis) FORBID outside those guilds; list_members' limit is bounded.
//   3) set_typing gates like send_message; unreact gates like react.
//   4) Subscriptions restored at identify/register pass the subscribe_channel
//      VIEW_CHANNEL gate.
//   5) Addressed deliveries (role_mention / reply) do NOT bypass VIEW_CHANNEL —
//      live dispatch and durable pings both drop a mention from a channel the
//      persona cannot view (the prompt-injection path into walled-garden agents).
//   6) Read-state reads re-check VIEW_CHANNEL at read time.
//   7) A grant that makes a hidden channel visible materializes it (guild first
//      if the stream never saw the guild); a revocation zeroes the client's
//      copy; hidden-stays-hidden costs nothing on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { PortalMessage, ReadyData, ServerFrame } from '@animalabs/portal-protocol';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import { Gateway, type GatewayHooks, type Session } from '../src/gateway.js';
import type { ChannelMeta } from '../src/discord-bot.js';

const G1 = 'guild-1';
const G2 = 'guild-2';
const OPEN = 'chan-open'; // alice: RW here, and nowhere else
const SECRET = 'chan-secret'; // same guild, no rights → must be invisible
const THREAD_OPEN = 'thread-open'; // thread under OPEN → visible, parent caps
const THREAD_SECRET = 'thread-secret'; // thread under SECRET → invisible
const C2 = 'chan-g2'; // other guild, no rights
const ALICE = 'alice';
const BOB = 'bob'; // no rights anywhere
const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'ADD_REACTIONS'];

function meta(id: string, guildId: string, parentId?: string): ChannelMeta {
  return {
    id, name: id, type: parentId ? 'thread' : 'text', guildId,
    isThread: !!parentId, parentId, archived: parentId ? false : undefined,
  };
}

const METAS: Record<string, ChannelMeta[]> = {
  [G1]: [meta(OPEN, G1), meta(SECRET, G1), meta(THREAD_OPEN, G1, OPEN), meta(THREAD_SECRET, G1, SECRET)],
  [G2]: [meta(C2, G2)],
};
const ALL_METAS = [...METAS[G1], ...METAS[G2]];
const guildOf = (id: string) => ALL_METAS.find((m) => m.id === id)?.guildId;

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-i27-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: [
    { id: ALICE, displayName: 'Alice', avatar: '', token: 'tok-a' },
    { id: BOB, displayName: 'Bob', avatar: '', token: 'tok-b' },
  ] }));
  writeFileSync(permissionsPath, JSON.stringify({ personas: {
    [ALICE]: { default: [], guilds: { [G1]: { default: [], channels: { [OPEN]: RW } } } },
    [BOB]: { default: [], guilds: {} },
  } }));

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [G1, G2],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // Fake bot: the bot holds every Discord permission everywhere, so effective
  // caps are the persona policy alone. Records the side-effecting calls.
  const calls: Record<string, unknown[][]> = { sendTyping: [], removeReaction: [], listMembers: [] };
  relay.bot = {
    channelForPerms: (id: string) => {
      const g = guildOf(id);
      return g ? { guildId: g, permissionsFor: () => ({ has: () => true }) } : undefined;
    },
    meIn: () => ({}),
    isGuildAllowed: (g: string) => g === G1 || g === G2,
    hasMembersIntent: true,
    listGuilds: () => [
      { id: G1, name: 'One', memberCount: 3 },
      { id: G2, name: 'Two', memberCount: 5 },
    ],
    listChannelMetas: (g: string) => METAS[g] ?? [],
    channelMetaFromCache: (id: string) => ALL_METAS.find((m) => m.id === id) ?? null,
    getChannelMeta: async (id: string) => ALL_METAS.find((m) => m.id === id) ?? null,
    resolveTarget: async (id: string) => {
      const m = ALL_METAS.find((x) => x.id === id);
      if (!m) return null;
      return m.isThread ? { parentChannelId: m.parentId!, threadId: m.id } : { parentChannelId: m.id };
    },
    sendTyping: async (...a: unknown[]) => { calls.sendTyping.push(a); },
    removeReaction: async (...a: unknown[]) => { calls.removeReaction.push(a); },
    listMembers: (...a: unknown[]) => { calls.listMembers.push(a); return [{ userId: 'u1' }]; },
    resolveHandles: () => ({ someone: 'u1' }),
    listRoles: () => [{ id: 'r1', guildId: G1, name: 'x', pooled: false }],
    listEmojis: async (g?: string) => [
      { id: '1', name: 'one', animated: false, guildId: G1, guildName: 'One' },
      { id: '2', name: 'two', animated: false, guildId: G2, guildName: 'Two' },
    ].filter((e) => !g || e.guildId === g),
  };
  // Addressing roles: no Discord.
  relay.roles = {
    bind: async () => 'role-1',
    unbind: async () => {},
    getRoleFor: () => 'role-1',
    roleByGuildFor: () => ({}),
    resolveRole: () => null,
  };

  // Fake gateway: captures dispatch; the test drives subscription/stream state.
  const dispatched: Array<{ personaId: string; event: any }> = [];
  const subscriptions = new Map<string, Set<string>>();
  relay.gateway = {
    activePersonas: () => [...subscriptions.keys()],
    streamPersonas: () => [...subscriptions.keys()],
    hasStream: (pid: string) => subscriptions.has(pid),
    personaSubscribed: (pid: string, chan: string) => subscriptions.get(pid)?.has(chan) ?? false,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
    seqOf: () => 0,
  };

  const session = (personaId: string) =>
    ({ id: `sess-${personaId}`, personaId, subscriptions: new Set<string>() }) as unknown as Session;
  const rpc = (personaId: string, method: string, params: unknown) =>
    relay.dispatchRpc(session(personaId), method, params);
  const ofType = (type: string) => dispatched.filter((d) => d.event?.type === type);
  const forbidden = (err: any) => err?.code === 'FORBIDDEN';

  return {
    relay, calls, dispatched, subscriptions, session, rpc, ofType, forbidden,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function message(channelId: string, extra: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: `relay:${channelId}:1`, nativeId: '1', channelId, guildId: guildOf(channelId) ?? null,
    author: { kind: 'user', userId: 'u1', username: 'human', displayName: 'Human', bot: false },
    content: 'hello', cleanContent: 'hello', attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt: '2026-09-08T00:00:00.000Z',
    ...extra,
  };
}

// ── 1) directory: ready / list_guilds / list_channels ──

test('ready lists only guilds with rights and channels with a capability; threads inherit the parent', async () => {
  const t = makeRelay();
  try {
    const ready = (await t.relay.buildReady(t.session(ALICE))) as ReadyData;
    assert.deepEqual(ready.guilds.map((g) => g.id), [G1], 'guild-2 (no rights) is not served');
    assert.deepEqual(
      ready.channels.map((c) => c.id).sort(),
      [OPEN, THREAD_OPEN].sort(),
      'the private channel, its thread, and the other guild are absent',
    );
    const open = ready.channels.find((c) => c.id === OPEN)!;
    const thread = ready.channels.find((c) => c.id === THREAD_OPEN)!;
    assert.deepEqual(thread.capabilities, open.capabilities, 'a thread carries its parent caps');
    assert.ok(open.capabilities.includes('VIEW_CHANNEL'));

    // A persona with no rights anywhere gets an empty directory, not the map.
    const bob = (await t.relay.buildReady(t.session(BOB))) as ReadyData;
    assert.deepEqual(bob.guilds, []);
    assert.deepEqual(bob.channels, []);
  } finally {
    t.cleanup();
  }
});

test('list_guilds / list_channels are filtered the same way; list_channels FORBIDs an ungranted guild', async () => {
  const t = makeRelay();
  try {
    const guilds = await t.rpc(ALICE, 'list_guilds', {});
    assert.deepEqual(guilds.guilds.map((g: any) => g.id), [G1]);

    const chans = await t.rpc(ALICE, 'list_channels', { guildId: G1 });
    assert.deepEqual(chans.channels.map((c: any) => c.id).sort(), [OPEN, THREAD_OPEN].sort());
    assert.ok(chans.channels.every((c: any) => c.capabilities.length > 0));

    await assert.rejects(() => t.rpc(ALICE, 'list_channels', { guildId: G2 }), t.forbidden);
    await assert.rejects(() => t.rpc(BOB, 'list_channels', { guildId: G1 }), t.forbidden);
    assert.deepEqual((await t.rpc(BOB, 'list_guilds', {})).guilds, []);
  } finally {
    t.cleanup();
  }
});

// ── 2) guild-level reads ──

test('list_members / resolve_mentions / list_roles / list_emojis require rights in the guild; limit is bounded', async () => {
  const t = makeRelay();
  try {
    for (const [method, params] of [
      ['list_members', { guildId: G2 }],
      ['resolve_mentions', { guildId: G2, handles: ['someone'] }],
      ['list_roles', { guildId: G2 }],
      ['list_emojis', { guildId: G2 }],
    ] as const) {
      await assert.rejects(() => t.rpc(ALICE, method, params), t.forbidden, `${method} must FORBID`);
      await assert.rejects(() => t.rpc(BOB, method, { ...params, guildId: G1 }), t.forbidden, `${method} must FORBID (no rights)`);
    }
    // Granted guild → served.
    assert.equal((await t.rpc(ALICE, 'list_members', { guildId: G1 })).members.length, 1);
    assert.equal((await t.rpc(ALICE, 'resolve_mentions', { guildId: G1, handles: ['someone'] })).resolved.someone, 'u1');
    assert.equal((await t.rpc(ALICE, 'list_roles', { guildId: G1 })).roles.length, 1);
    assert.deepEqual((await t.rpc(ALICE, 'list_emojis', { guildId: G1 })).emojis.map((e: any) => e.name), ['one']);
    // Omitted guildId spans all allowed guilds — filtered to the granted ones.
    assert.deepEqual((await t.rpc(ALICE, 'list_emojis', {})).emojis.map((e: any) => e.name), ['one']);
    assert.deepEqual((await t.rpc(BOB, 'list_emojis', {})).emojis, []);

    // limit: default 100, clamped to 1000, floored at 1, garbage → default.
    await t.rpc(ALICE, 'list_members', { guildId: G1 });
    await t.rpc(ALICE, 'list_members', { guildId: G1, limit: 999_999 });
    await t.rpc(ALICE, 'list_members', { guildId: G1, limit: -5 });
    await t.rpc(ALICE, 'list_members', { guildId: G1, limit: 'lots' });
    assert.deepEqual(t.calls.listMembers.map((a) => a[2]), [100, 100, 1000, 1, 100]);
  } finally {
    t.cleanup();
  }
});

// ── 3) side effects: set_typing / unreact ──

test('set_typing requires SEND_MESSAGES (SEND_IN_THREADS in a thread), like send_message', async () => {
  const t = makeRelay();
  try {
    await assert.rejects(() => t.rpc(ALICE, 'set_typing', { channelId: SECRET }), t.forbidden);
    await assert.rejects(() => t.rpc(ALICE, 'set_typing', { channelId: THREAD_SECRET }), t.forbidden);
    await assert.rejects(() => t.rpc(ALICE, 'set_typing', { channelId: C2 }), t.forbidden);
    // Alice has SEND_MESSAGES but not SEND_IN_THREADS on OPEN.
    await assert.rejects(() => t.rpc(ALICE, 'set_typing', { channelId: OPEN, threadId: THREAD_OPEN }), t.forbidden);
    await assert.rejects(() => t.rpc(ALICE, 'set_typing', { channelId: THREAD_OPEN }), t.forbidden);
    assert.equal(t.calls.sendTyping.length, 0, 'the shared bot never typed');

    await t.rpc(ALICE, 'set_typing', { channelId: OPEN });
    assert.deepEqual(t.calls.sendTyping, [[OPEN]]);

    t.relay.permissions.setChannel(ALICE, G1, OPEN, [...RW, 'SEND_IN_THREADS']);
    await t.rpc(ALICE, 'set_typing', { channelId: OPEN, threadId: THREAD_OPEN });
    assert.deepEqual(t.calls.sendTyping.at(-1), [THREAD_OPEN]);
  } finally {
    t.cleanup();
  }
});

test('unreact requires ADD_REACTIONS, like react — the shared bot reaction is not stripped', async () => {
  const t = makeRelay();
  try {
    const refIn = (channelId: string) =>
      ({ channelId, threadId: undefined, discordMsgId: 'd1', guildId: G1, relayId: `rm_${channelId}_d1` });
    t.relay.resolveRef = async (id: string) => refIn(id.startsWith('secret') ? SECRET : OPEN);

    await assert.rejects(
      () => t.rpc(ALICE, 'unreact', { messageId: 'secret-msg', emoji: '👍', native: true }),
      t.forbidden,
    );
    assert.equal(t.calls.removeReaction.length, 0);
    assert.equal(t.ofType('reaction_remove').length, 0, 'no pseudo-remove either');

    await t.rpc(ALICE, 'unreact', { messageId: 'open-msg', emoji: '👍', native: true });
    assert.equal(t.calls.removeReaction.length, 1);
    assert.equal(t.ofType('reaction_remove').length, 1);
  } finally {
    t.cleanup();
  }
});

// ── 4) identify/register subscriptions ──

test('canSubscribe mirrors the subscribe_channel VIEW_CHANNEL gate', () => {
  const t = makeRelay();
  try {
    assert.equal(t.relay.canSubscribe(ALICE, OPEN), true);
    assert.equal(t.relay.canSubscribe(ALICE, SECRET), false);
    assert.equal(t.relay.canSubscribe(ALICE, C2), false);
    assert.equal(t.relay.canSubscribe(ALICE, 'no-such-channel'), false);
    assert.equal(t.relay.canSubscribe(BOB, OPEN), false);
  } finally {
    t.cleanup();
  }
});

test('gateway drops identify/register subscriptions the canSubscribe hook refuses', async () => {
  const PORT = 8811;
  const hooks: GatewayHooks = {
    authenticate: (token, personaId) => (token === 'secret' ? personaId : null),
    canSubscribe: (_personaId, channelId) => channelId === 'allowed',
    buildReady: async (session: Session): Promise<ReadyData> => ({
      sessionId: session.id,
      persona: { id: session.personaId, displayName: 'T', avatarUrl: '' },
      guilds: [], channels: [], seq: 0,
    }),
    handleRpc: async (session, req) => {
      session.send({ op: 'rpc_result', d: { id: req.id, ok: true, result: { subs: [...session.subscriptions] } } });
    },
    enroll: async (d) => ({
      personaId: 'minted', token: 'tok',
      persona: { id: 'minted', displayName: d.desiredName, avatarUrl: '' },
    }),
  };
  const gw = new Gateway(hooks, 30_000);
  gw.listen(PORT);
  const listSubs = async (first: object): Promise<string[]> => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const frames: ServerFrame[] = [];
    const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      frames.push(f);
      const i = waiters.findIndex((w) => w.pred(f));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(f);
    });
    const next = (pred: (f: ServerFrame) => boolean) => new Promise<ServerFrame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`frame timeout; saw ${JSON.stringify(frames)}`)), 2000);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
    await new Promise<void>((r) => ws.on('open', () => r()));
    await next((f) => f.op === 'hello');
    ws.send(JSON.stringify(first));
    await next((f) => f.op === 'ready');
    ws.send(JSON.stringify({ op: 'rpc', d: { id: 'r1', method: 'list_subscriptions', params: {} } }));
    const res = (await next((f) => f.op === 'rpc_result')) as any;
    ws.close();
    return res.d.result.subs;
  };
  try {
    assert.deepEqual(
      await listSubs({ op: 'identify', d: { protocolVersion: 1, token: 'secret', personaId: 'p1', subscriptions: ['allowed', 'denied'] } }),
      ['allowed'],
    );
    assert.deepEqual(
      await listSubs({ op: 'register', d: { protocolVersion: 1, invite: 'x', desiredName: 'N', subscriptions: ['denied', 'allowed'] } }),
      ['allowed'],
    );
  } finally {
    await gw.close();
  }
});

// ── 5) addressed deliveries never bypass VIEW_CHANNEL ──

test('a role_mention from a channel the persona cannot view is dropped — live and as a pending ping', () => {
  const t = makeRelay();
  try {
    t.subscriptions.set(ALICE, new Set([OPEN]));
    const mention = { personas: [ALICE], roles: ['role-1'], users: [], everyone: false };

    t.relay.deliverMessage('message_create', message(SECRET, { mentions: mention }));
    assert.equal(t.dispatched.length, 0, 'no live delivery');
    assert.deepEqual(t.relay.readState.pendingPings(ALICE), [], 'no durable ping');
    assert.deepEqual(t.relay.readState.unread(ALICE), [], 'no tally');

    // Control: the same mention from the viewable channel is addressed delivery.
    t.relay.deliverMessage('message_create', message(OPEN, { mentions: mention }));
    assert.equal(t.dispatched.length, 1);
    assert.equal(t.dispatched[0].event.addressedToMe, true);
    assert.deepEqual(t.dispatched[0].event.reasons, ['role_mention']);
    assert.equal(t.relay.readState.pendingPings(ALICE).length, 1);
  } finally {
    t.cleanup();
  }
});

test('a reply to the persona from a channel it can no longer view is dropped', () => {
  const t = makeRelay();
  try {
    t.subscriptions.set(ALICE, new Set());
    // Alice posted in SECRET back when she could (a rights revocation since).
    const own = t.relay.store.record({ channelId: SECRET, guildId: G1, discordMsgId: 'd0', personaId: ALICE });
    t.relay.deliverMessage('message_create', message(SECRET, { id: 'relay:secret:2', replyToId: own.relayId }));
    assert.equal(t.dispatched.length, 0);
    assert.deepEqual(t.relay.readState.pendingPings(ALICE), []);

    const ownOpen = t.relay.store.record({ channelId: OPEN, guildId: G1, discordMsgId: 'd1', personaId: ALICE });
    t.relay.deliverMessage('message_create', message(OPEN, { id: 'relay:open:2', replyToId: ownOpen.relayId }));
    assert.equal(t.dispatched.length, 1);
    assert.deepEqual(t.dispatched[0].event.reasons, ['reply']);
  } finally {
    t.cleanup();
  }
});

// ── 6) read-state reads re-check the gate ──

test('pending pings / unread / channel_missed re-check VIEW_CHANNEL at read time', async () => {
  const t = makeRelay();
  try {
    t.subscriptions.set(ALICE, new Set([OPEN]));
    const mention = { personas: [ALICE], roles: ['role-1'], users: [], everyone: false };
    t.relay.deliverMessage('message_create', message(OPEN, { mentions: mention }));
    assert.equal((await t.rpc(ALICE, 'get_pending_pings', {})).pings.length, 1);
    assert.equal((await t.rpc(ALICE, 'list_unread', {})).channels.length, 1);
    assert.equal((await t.rpc(ALICE, 'channel_missed', { channelId: OPEN })).messages, 1);

    // Revoke: the durable rows still exist, but are no longer served.
    t.relay.permissions.setChannel(ALICE, G1, OPEN, []);
    assert.deepEqual((await t.rpc(ALICE, 'get_pending_pings', {})).pings, []);
    assert.deepEqual((await t.rpc(ALICE, 'list_unread', {})).channels, []);
    await assert.rejects(() => t.rpc(ALICE, 'channel_missed', { channelId: OPEN }), t.forbidden);
    await assert.rejects(() => t.rpc(ALICE, 'channel_missed', { channelId: SECRET }), t.forbidden);
  } finally {
    t.cleanup();
  }
});

// ── 7) live propagation under the filtered directory ──

test('a grant materializes a hidden channel (guild first when the stream never saw it); a revocation zeroes it', async () => {
  const t = makeRelay();
  try {
    t.subscriptions.set(ALICE, new Set()); // stream-retained
    await t.relay.buildReady(t.session(ALICE)); // seeds the dedup + guild baselines

    // Grant in the OTHER guild: alice's ready omitted guild-2 entirely.
    // The store→relay onChange wiring lives in start(); drive the handler
    // directly, as live-propagation.test.ts does.
    const grant = (guildId: string, channelId: string, caps: string[]) => {
      t.relay.permissions.setChannel(ALICE, guildId, channelId, caps);
      t.relay.onPermissionChange({ personaId: ALICE, scope: 'channel', guildId, channelId });
    };
    grant(G2, C2, RW);
    const types = t.dispatched.map((d) => d.event.type);
    assert.deepEqual(types, ['guild_create', 'channel_update'], 'guild materialized before its channel');
    assert.equal(t.dispatched[0].event.guild.id, G2);
    assert.deepEqual(t.dispatched[0].event.channels, []);
    assert.equal(t.dispatched[1].event.channel.id, C2);
    assert.ok(t.dispatched[1].event.channel.capabilities.includes('VIEW_CHANNEL'));
    assert.equal(t.ofType('capabilities_update').length, 0, 'never a bare caps event for a channel the client cannot have');

    // Grant in the SAME guild (guild already delivered): channel only, and
    // the parent's thread follows (its caps are the parent's).
    t.dispatched.length = 0;
    grant(G1, SECRET, RW);
    assert.deepEqual(
      t.dispatched.map((d) => [d.event.type, d.event.channel.id]),
      [['channel_update', SECRET], ['thread_update', THREAD_SECRET]],
    );

    // Repush with nothing changed: silent.
    t.dispatched.length = 0;
    t.relay.onPermissionChange({ personaId: ALICE, scope: 'guild', guildId: G1 });
    assert.equal(t.dispatched.length, 0);

    // Revoke: the client's copy is zeroed (it knew the channel), thread too.
    grant(G1, SECRET, []);
    assert.deepEqual(
      t.dispatched.map((d) => [d.event.type, d.event.channelId, d.event.capabilities]),
      [['capabilities_update', SECRET, []], ['capabilities_update', THREAD_SECRET, []]],
    );

    // Hidden stays hidden: a guild-wide repush serves nothing for it.
    t.dispatched.length = 0;
    t.relay.onPermissionChange({ personaId: ALICE, scope: 'guild', guildId: G1 });
    assert.equal(t.dispatched.length, 0);
  } finally {
    t.cleanup();
  }
});

test('Discord-side channel create/update and resync respect the filter', async () => {
  const t = makeRelay();
  try {
    t.subscriptions.set(ALICE, new Set());
    t.subscriptions.set(BOB, new Set());
    await t.relay.buildReady(t.session(ALICE));
    await t.relay.buildReady(t.session(BOB));

    // A new private channel: nobody with no rights in it hears about it.
    const priv = meta('chan-new-private', G1);
    METAS[G1].push(priv);
    try {
      t.relay.onBotChannelChange(priv, 'create');
      assert.equal(t.dispatched.length, 0);

      // Rename of a visible channel reaches alice (full object), never bob.
      t.relay.onBotChannelChange({ ...meta(OPEN, G1), name: 'renamed' }, 'update');
      assert.deepEqual(t.dispatched.map((d) => [d.personaId, d.event.type, d.event.channel.name]),
        [[ALICE, 'channel_update', 'renamed']]);

      // Resync: only visible channels are pushed.
      t.dispatched.length = 0;
      assert.equal(t.relay.resyncPersona(ALICE), 2);
      assert.deepEqual(t.dispatched.map((d) => d.event.channel.id).sort(), [OPEN, THREAD_OPEN].sort());
      t.dispatched.length = 0;
      assert.equal(t.relay.resyncPersona(BOB), 0);
      assert.equal(t.dispatched.length, 0);
    } finally {
      METAS[G1].pop();
    }
  } finally {
    t.cleanup();
  }
});
