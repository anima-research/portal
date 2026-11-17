import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { DiscordBot } from '../src/discord-bot.js';

// Issue #95: list_channels entries carry no parentId for text channels, so a
// flat listing cannot tell a live room from one filed under an archive
// heading. metaOf should surface the category id for every channel kind
// (threads keep their parent channel, as before). The category's NAME is
// already in the same listing — categories are entries of their own — so one
// id makes the listing joinable without a protocol change.

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
