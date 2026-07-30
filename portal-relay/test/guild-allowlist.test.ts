// Runtime-editable guild allow-list (PORTAL_GUILDS):
//   1) GuildAllowStore seeding, persistence, idempotency, reload-diff.
//   2) DiscordBot live-accessor semantics (null ⇒ allow-all, [] ⇒ deny-all).
//   3) Relay fan-out: allow ⇒ guild_create to live personas; disallow ⇒
//      guild_delete + zeroed capabilities (the capsFor allow-gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildAllowStore, type GuildAllowChange } from '../src/guild-allowlist.js';
import { DiscordBot } from '../src/discord-bot.js';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

// ── GuildAllowStore ──

test('store: seeds from snapshot when file missing, reads back when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-ga-'));
  const path = join(dir, 'guilds.json');
  try {
    const store = new GuildAllowStore(path, ['g1', 'g2']);
    assert.ok(existsSync(path), 'file created on first boot');
    assert.deepEqual(store.list().sort(), ['g1', 'g2']);
    // Second instance ignores the seed and reads the file (env changes don't clobber).
    const store2 = new GuildAllowStore(path, ['other']);
    assert.deepEqual(store2.list().sort(), ['g1', 'g2']);
    // Empty seed produces an explicit empty list (deny-all in store mode).
    const emptyPath = join(dir, 'empty.json');
    const empty = new GuildAllowStore(emptyPath, []);
    assert.deepEqual(empty.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(emptyPath, 'utf8')), { guildIds: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: allow/disallow persist, are idempotent, and emit precise diffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-ga-'));
  const path = join(dir, 'guilds.json');
  try {
    const store = new GuildAllowStore(path, ['g1']);
    const changes: GuildAllowChange[] = [];
    store.onChange((c) => changes.push(c));

    assert.equal(store.allow('g2'), true);
    assert.equal(store.allow('g2'), false, 'duplicate allow is a no-op');
    assert.equal(store.disallow('g1'), true);
    assert.equal(store.disallow('g1'), false, 'absent disallow is a no-op');
    assert.deepEqual(changes, [
      { added: ['g2'], removed: [] },
      { added: [], removed: ['g1'] },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).guildIds, ['g2']);

    // External edit + reload() diffs old vs new.
    writeFileSync(path, JSON.stringify({ guildIds: ['g2', 'g3'] }));
    (store as unknown as { reload(): void }).reload();
    assert.deepEqual(changes[2], { added: ['g3'], removed: [] });
    assert.ok(store.has('g3'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DiscordBot accessor semantics (no login; guildAllowed is pure) ──

test('bot: null accessor ⇒ allow-all, empty list ⇒ deny-all, list ⇒ membership', () => {
  const allowAll = new DiscordBot('x', () => null, { guildMembersIntent: false });
  assert.equal(allowAll.isGuildAllowed('anything'), true);

  const denyAll = new DiscordBot('x', () => [], { guildMembersIntent: false });
  assert.equal(denyAll.isGuildAllowed('anything'), false);

  let list: string[] = ['g1'];
  const scoped = new DiscordBot('x', () => list, { guildMembersIntent: false });
  assert.equal(scoped.isGuildAllowed('g1'), true);
  assert.equal(scoped.isGuildAllowed('g2'), false);
  list = ['g1', 'g2']; // live: no reconstruction needed
  assert.equal(scoped.isGuildAllowed('g2'), true);
});

// ── Relay fan-out ──

const GUILD = 'g-new';
const CHAN = 'chan1';
const PERSONA = 'alice';

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-ga-relay-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  const allowPath = join(dir, 'guilds.json');
  writeFileSync(identityPath, JSON.stringify({
    personas: [{ id: PERSONA, displayName: 'Alice', avatar: '', token: 'tok' }],
  }));
  writeFileSync(permissionsPath, JSON.stringify({
    personas: {
      [PERSONA]: { default: [], guilds: { [GUILD]: { default: ['VIEW_CHANNEL', 'SEND_MESSAGES'] } } },
    },
  }));

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [],
    guildAllowPath: allowPath,
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  const store: GuildAllowStore = relay.guildAllow;
  assert.ok(store, 'store mode active');
  // Fan-out subscription normally happens in start(); wire it directly here.
  store.onChange((c: GuildAllowChange) => relay.onGuildAllowChange(c));

  // Fake bot: joined to GUILD with one channel; allow-check delegates to the
  // real store so the capsFor gate is exercised end-to-end.
  relay.bot = {
    listGuilds: () => (store.has(GUILD) ? [{ id: GUILD, name: 'New Guild', memberCount: 3 }] : []),
    listChannelMetas: () => [{ id: CHAN, guildId: GUILD, name: 'general', type: 'text', parentId: null, archived: false }],
    channelForPerms: () => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    meIn: () => ({}),
    isGuildAllowed: (gid: string) => store.has(gid),
  };
  const dispatched: Array<{ personaId: string; event: any }> = [];
  relay.gateway = {
    activePersonas: () => [PERSONA],
    streamPersonas: () => [PERSONA],
    hasStream: (pid: string) => pid === PERSONA,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
  };
  return { relay, store, dispatched, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('relay: allow ⇒ guild_create with per-persona channels; disallow ⇒ guild_delete + zeroed caps', () => {
  const { store, dispatched, cleanup } = makeRelay();
  try {
    store.allow(GUILD);
    const created = dispatched.find((d) => d.event.type === 'guild_create');
    assert.ok(created, 'guild_create dispatched');
    assert.equal(created!.personaId, PERSONA);
    assert.equal(created!.event.guild.id, GUILD);
    assert.equal(created!.event.channels.length, 1);
    assert.ok(
      created!.event.channels[0].capabilities.includes('SEND_MESSAGES'),
      'channel carries live per-persona caps',
    );

    dispatched.length = 0;
    store.disallow(GUILD);
    const deleted = dispatched.find((d) => d.event.type === 'guild_delete');
    assert.ok(deleted, 'guild_delete dispatched');
    assert.equal(deleted!.event.guildId, GUILD);
    const caps = dispatched.find((d) => d.event.type === 'capabilities_update');
    assert.ok(caps, 'capabilities re-pushed on disallow');
    assert.deepEqual(caps!.event.capabilities, [], 'capsFor allow-gate zeroes capabilities');
  } finally {
    cleanup();
  }
});

test('relay: allowing a not-yet-joined guild is dormant (no guild_create)', () => {
  const { store, dispatched, cleanup } = makeRelay();
  try {
    store.allow('9999900000');
    assert.equal(dispatched.length, 0, 'no fan-out for a guild the bot is not in');
  } finally {
    cleanup();
  }
});
