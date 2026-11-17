import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordBot } from '../src/discord-bot.js';

// fetchHistory against a fake channel that serves pages the way Discord's
// REST endpoint does (issue #91). The fake encodes the documented semantics:
// every page is returned newest-first; `before` selects the newest messages
// below the cursor; `after` selects the OLDEST messages above the cursor
// (that is what makes forward pagination possible). Not run against live
// Discord; the live boundary is discord.js's `messages.fetch`.

type FetchOpts = { limit: number; before?: string; after?: string };

const num = (id: string) => Number(id);

function fakeChannel(ids: string[]) {
  const sorted = [...ids].sort((a, b) => num(a) - num(b)); // ascending
  return {
    messages: {
      fetch: async ({ limit, before, after }: FetchOpts) => {
        let pool = sorted;
        if (before !== undefined) pool = pool.filter((id) => num(id) < num(before));
        if (after !== undefined) pool = pool.filter((id) => num(id) > num(after));
        // `after` pages take the oldest qualifying set, `before`/bare take
        // the newest; Discord returns every page newest-first.
        const slice = after !== undefined && before === undefined
          ? pool.slice(0, limit)
          : pool.slice(-limit);
        const page = [...slice].sort((a, b) => num(b) - num(a));
        return new Map(page.map((id) => [id, { id }]));
      },
    },
  };
}

function botOver(ids: string[]) {
  const channel = fakeChannel(ids);
  const fake = {
    client: { channels: { fetch: async () => channel } },
    convert: (m: { id: string }) => ({ id: m.id }),
  };
  return fake as unknown as DiscordBot;
}

const idsOf = (msgs: Array<{ id: string }>) => msgs.map((m) => m.id);

const range = (lo: number, hi: number) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));

test('after without before returns the messages just after the cursor, newest-first', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, undefined, '110');
  assert.deepEqual(idsOf(got), ['115', '114', '113', '112', '111']);
});

test('after with fewer than limit remaining returns all of them', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, undefined, '138');
  assert.deepEqual(idsOf(got), ['140', '139']);
});

test('after at the newest message returns empty', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, undefined, '140');
  assert.deepEqual(idsOf(got), []);
});

test('forward paging crosses the 100-message page boundary', async () => {
  const bot = botOver(range(1001, 1220));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 150, undefined, '1010');
  assert.equal(got.length, 150);
  assert.equal(got[0].id, '1160'); // newest of the 150 just after the cursor
  assert.equal(got[149].id, '1011'); // oldest, immediately after the cursor
});

test('before alone keeps its shape: newest messages below the cursor', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, '110', undefined);
  assert.deepEqual(idsOf(got), ['109', '108', '107', '106', '105']);
});

test('before and after together keep their shape: a bounded window from the top', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 10, '120', '114');
  assert.deepEqual(idsOf(got), ['119', '118', '117', '116', '115']);
});
