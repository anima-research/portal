// `@` + a persona's display name, typed as plain text, addresses that persona
// (`name_mention`).
//
// A persona's addressing role is named with the pool prefix (`portal-Alice`),
// which nobody types: a writer with Discord's autocomplete picks the role, but
// an agent writes the name it sees on the persona's messages. That text reached
// nobody — the protocol declared `name_mention` and portal-mcpl tagged it, but
// the relay never produced one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import { RolePool, type RoleOps } from '../src/role-pool.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const OTHER_GUILD = 'g2';
const CHAN = 'chan-1';
const ALICE = 'alice-1';
const HAND = 'claude-code-fable-5-2-scout-1';
const SHORT = 'claude-code-fable-5-aaaa';
const SPACED = 'claude-cc-1';

function fakeOps(): RoleOps {
  let seq = 0;
  return {
    createRole: async () => `role-${++seq}`,
    renameRole: async () => {},
    deleteRole: async () => {},
    discoverPooledRoles: async () => [],
  };
}

async function makePool(): Promise<RolePool> {
  const pool = new RolePool(fakeOps(), 50, 'portal-');
  await pool.bind(GUILD, ALICE, 'Alice');
  await pool.bind(GUILD, HAND, 'Claude-Code-fable-5-2-scout');
  await pool.bind(GUILD, SHORT, 'Claude-Code-fable-5');
  await pool.bind(GUILD, SPACED, 'Claude (CC)');
  return pool;
}

test('namedIn finds a display name written after @, whatever its case', async () => {
  const pool = await makePool();
  assert.deepEqual(pool.namedIn(GUILD, '@Alice can you look?'), [ALICE]);
  assert.deepEqual(pool.namedIn(GUILD, 'over to you, @alice.'), [ALICE]);
  assert.deepEqual(pool.namedIn(GUILD, "that is @ALICE's call"), [ALICE]);
  assert.deepEqual(pool.namedIn(GUILD, '@Claude (CC) and @Alice'), [SPACED, ALICE]);
  assert.deepEqual(pool.namedIn(GUILD, '@Alice @Alice'), [ALICE]);
});

test('namedIn takes the longest name where one starts another', async () => {
  const pool = await makePool();
  assert.deepEqual(pool.namedIn(GUILD, '@Claude-Code-fable-5-2-scout — one for you'), [HAND]);
  assert.deepEqual(pool.namedIn(GUILD, '@Claude-Code-fable-5: still there?'), [SHORT]);
});

test('namedIn leaves alone a name that is part of something else', async () => {
  const pool = await makePool();
  assert.deepEqual(pool.namedIn(GUILD, 'mail bob@alice.example'), [], 'an address');
  assert.deepEqual(pool.namedIn(GUILD, '@Alicette and @Alice2 and @Alice-b'), [], 'runs on into a longer name');
  assert.deepEqual(pool.namedIn(GUILD, 'Alice said so'), [], 'no @');
  assert.deepEqual(pool.namedIn(GUILD, '@portal-Alice'), [], 'the role name is not the display name');
  assert.deepEqual(pool.namedIn(GUILD, '@Claude-Code-fable-5-9'), [], 'a different, unknown hand');
});

test('namedIn only knows personas with a role in that guild', async () => {
  const pool = await makePool();
  assert.deepEqual(pool.namedIn(OTHER_GUILD, '@Alice'), []);
  await pool.unbind(GUILD, ALICE);
  assert.deepEqual(pool.namedIn(GUILD, '@Alice'), []);
});

// ── through the relay ──

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-name-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  const caps = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'];
  writeFileSync(identityPath, JSON.stringify({ personas: [
    { id: ALICE, displayName: 'Alice', avatar: '', token: 'tok-a' },
    { id: HAND, displayName: 'Claude-Code-fable-5-2-scout', avatar: '', token: 'tok-h' },
  ] }));
  writeFileSync(permissionsPath, JSON.stringify({ personas: {
    [ALICE]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN]: caps } } } },
    [HAND]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN]: caps } } } },
  } }));
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  relay.bot = {
    channelForPerms: () => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    channelMetaFromCache: () => ({ id: CHAN, isThread: false, guildId: GUILD }),
    meIn: () => ({}),
    isGuildAllowed: () => true,
    ownsWebhook: () => false,
  };
  relay.roles = new RolePool(fakeOps(), 50, 'portal-');

  const dispatched: Array<{ personaId: string; event: any }> = [];
  // Only Alice is connected; the hand is offline.
  relay.gateway = {
    activePersonas: () => [ALICE],
    streamPersonas: () => [ALICE],
    hasStream: (pid: string) => pid === ALICE,
    personaSubscribed: () => true,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
    seqOf: () => 0,
  };

  let n = 0;
  const incoming = (content: string, over: Record<string, unknown> = {}) => ({
    id: `d-${++n}`, content, cleanContent: content,
    authorId: 'u1', authorName: 'someone', authorDisplayName: 'Someone', isBot: true, webhookId: undefined,
    channelId: CHAN, parentChannelId: CHAN, threadId: undefined, guildId: GUILD, channelName: 'chan',
    mentionUserIds: [], mentionRoleIds: [] as string[], mentionsEveryone: false,
    replyToId: undefined, replyToUserId: null, attachments: [], reactions: [], timestamp: new Date(),
    ...over,
  });
  return { relay, dispatched, incoming, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a typed @Name is delivered as addressed, with reason name_mention', async () => {
  const t = makeRelay();
  try {
    await t.relay.roles.bind(GUILD, ALICE, 'Alice');
    t.relay.onDiscordMessage(t.incoming('@Alice — one for you'));
    assert.equal(t.dispatched.length, 1);
    const { event } = t.dispatched[0];
    assert.equal(event.addressedToMe, true);
    assert.deepEqual(event.reasons, ['name_mention']);
    assert.deepEqual(event.message.mentions.personas, [ALICE]);
    assert.deepEqual(event.message.mentions.named, [ALICE]);
    assert.equal(t.relay.readState.pendingPings(ALICE).length, 1, 'a ping, like any mention');
  } finally {
    t.cleanup();
  }
});

test('a typed @Name of an offline persona waits for it as a pending ping, and other readers see who it names', async () => {
  const t = makeRelay();
  try {
    await t.relay.roles.bind(GUILD, ALICE, 'Alice');
    await t.relay.roles.bind(GUILD, HAND, 'Claude-Code-fable-5-2-scout');
    t.relay.onDiscordMessage(t.incoming('@Claude-Code-fable-5-2-scout — one for you'));
    // Alice, subscribed, gets it as ambient traffic that names the hand.
    assert.equal(t.dispatched.length, 1);
    assert.equal(t.dispatched[0].event.addressedToMe, false);
    assert.deepEqual(t.dispatched[0].event.message.mentions.personas, [HAND]);
    const pings = t.relay.readState.pendingPings(HAND);
    assert.equal(pings.length, 1);
    assert.deepEqual(pings[0].reasons, ['name_mention']);
  } finally {
    t.cleanup();
  }
});

test('a role mention stays a role_mention, also when the name is typed beside it', async () => {
  const t = makeRelay();
  try {
    const role = await t.relay.roles.bind(GUILD, ALICE, 'Alice');
    t.relay.onDiscordMessage(t.incoming(`<@&${role}> @Alice hello`, { mentionRoleIds: [role] }));
    assert.deepEqual(t.dispatched[0].event.reasons, ['role_mention']);
    assert.deepEqual(t.dispatched[0].event.message.mentions.personas, [ALICE]);
    assert.equal(t.dispatched[0].event.message.mentions.named, undefined);
  } finally {
    t.cleanup();
  }
});

test('a message that names nobody carries no named list', async () => {
  const t = makeRelay();
  try {
    await t.relay.roles.bind(GUILD, ALICE, 'Alice');
    t.relay.onDiscordMessage(t.incoming('Alice said so'));
    assert.equal(t.dispatched[0].event.addressedToMe, false);
    assert.deepEqual(t.dispatched[0].event.message.mentions, { personas: [], roles: [], users: [], everyone: false });
  } finally {
    t.cleanup();
  }
});
