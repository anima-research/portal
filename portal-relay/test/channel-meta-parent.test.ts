import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { DiscordBot } from '../src/discord-bot.js';

// Issue #95: list_channels entries carry no parentId for text channels, so a
// flat listing cannot tell a live room from one filed under an archive
// heading. metaOf should surface the category id for every channel kind
// (threads keep their parent channel, as before). When the persona can see
// the category it is an entry of the same listing (type "category"), so the
// id is joinable without a protocol change; a category the persona holds
// nothing in is filtered out and the id dangles honestly (see
// directory-caps.test.ts and the protocol comment).

type FakeChannel = {
  id: string;
  name: string | null;
  type: ChannelType;
  parentId: string | null;
  guildId: string;
  isThread: () => boolean;
  archived?: boolean;
};

const chan = (
  id: string,
  type: ChannelType,
  parentId: string | null,
  extra: Partial<FakeChannel> = {},
): FakeChannel => ({
  id,
  name: id,
  type,
  parentId,
  guildId: 'g1',
  isThread: () =>
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread,
  ...extra,
});

function botWith(channels: FakeChannel[]) {
  const cache = new Map(channels.map((c) => [c.id, c]));
  // Object.create keeps the prototype chain, so listChannelMetas can reach
  // the private metaOf, without running the real constructor (no client).
  const fake = Object.create(DiscordBot.prototype) as Record<string, unknown>;
  fake.client = { guilds: { cache: new Map([['g1', { channels: { cache } }]]) } };
  return fake as unknown as DiscordBot;
}

const metasOf = (channels: FakeChannel[]) =>
  Object.fromEntries(
    DiscordBot.prototype.listChannelMetas.call(botWith(channels), 'g1').map((m) => [m.id, m]),
  );

test('a text channel under a category carries the category id', () => {
  const metas = metasOf([
    chan('cat-archive', ChannelType.GuildCategory, null),
    chan('upcoming-events', ChannelType.GuildText, 'cat-archive'),
  ]);
  assert.equal(metas['upcoming-events'].parentId, 'cat-archive');
  assert.equal(metas['upcoming-events'].isThread, false);
});

test('a category itself has no parent', () => {
  const metas = metasOf([chan('cat-archive', ChannelType.GuildCategory, null)]);
  assert.equal(metas['cat-archive'].parentId, undefined);
});

test('an uncategorized text channel has no parent', () => {
  const metas = metasOf([chan('general', ChannelType.GuildText, null)]);
  assert.equal(metas['general'].parentId, undefined);
});

test('a thread still carries its parent channel, not a category', () => {
  const metas = metasOf([
    chan('general', ChannelType.GuildText, 'cat-live'),
    chan('thr-1', ChannelType.PublicThread, 'general', { archived: false }),
  ]);
  assert.equal(metas['thr-1'].parentId, 'general');
  assert.equal(metas['thr-1'].isThread, true);
});

test('voice and forum channels carry their category too', () => {
  const metas = metasOf([
    chan('voice-1', ChannelType.GuildVoice, 'cat-live'),
    chan('forum-1', ChannelType.GuildForum, 'cat-live'),
  ]);
  assert.equal(metas['voice-1'].parentId, 'cat-live');
  assert.equal(metas['forum-1'].parentId, 'cat-live');
});

test('webhook targeting: a categorized text channel posts to itself, a thread to its parent', async () => {
  // Finding 6 of the #99 review: a parentId no longer implies a thread, and
  // the webhook route must key on isThread, never on parentId presence.
  const route = async (meta: Record<string, unknown>) => {
    const fake = Object.create(DiscordBot.prototype) as Record<string, unknown>;
    fake.getChannelMeta = async () => meta;
    return DiscordBot.prototype.resolveTarget.call(fake as unknown as DiscordBot, meta.id as string);
  };
  assert.deepEqual(
    await route({ id: 'filed', type: 'text', parentId: 'cat-1', isThread: false, guildId: 'g1', name: 'filed' }),
    { parentChannelId: 'filed' },
    'a category parent never becomes a webhook target',
  );
  assert.deepEqual(
    await route({ id: 'thr', type: 'thread', parentId: 'general', isThread: true, guildId: 'g1', name: 'thr' }),
    { parentChannelId: 'general', threadId: 'thr' },
  );
});

test('fetchChannelMetaUncached carries the category id for a non-thread channel (#99 r1-2)', async () => {
  // The round-1 fix made the UNCACHED path match metaOf; only the cached
  // path had a test, so reverting the fix (back to thread-only parents)
  // stayed green. This drives the raw-REST route directly.
  const fetchRaw = async (raw: Record<string, unknown>) => {
    const fake = Object.create(DiscordBot.prototype) as { client: unknown };
    fake.client = { rest: { get: async () => raw } };
    return DiscordBot.prototype.fetchChannelMetaUncached.call(fake as unknown as DiscordBot, String(raw.id));
  };
  const filed = await fetchRaw({ id: '10001', name: 'filed', type: ChannelType.GuildText, parent_id: '20002', guild_id: 'g1' });
  assert.ok(typeof filed === 'object');
  assert.equal(filed.parentId, '20002', 'a text channel keeps its category heading on the uncached path');
  assert.equal(filed.isThread, false);
  const thr = await fetchRaw({ id: '10003', name: 'thr', type: ChannelType.PublicThread, parent_id: '10001', guild_id: 'g1', thread_metadata: { archived: true } });
  assert.ok(typeof thr === 'object');
  assert.equal(thr.parentId, '10001');
  assert.equal(thr.isThread, true);
  assert.equal(thr.archived, true);
  const top = await fetchRaw({ id: '10004', name: 'top', type: ChannelType.GuildText, parent_id: null, guild_id: 'g1' });
  assert.ok(typeof top === 'object');
  assert.equal(top.parentId, undefined, 'no parent, no invented id');
});
