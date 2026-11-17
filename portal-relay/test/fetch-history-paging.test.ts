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

// BigInt, not Number: real snowflakes are 19 digits and adjacent ids
// compare equal as doubles (review finding 3).
const cmp = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function fakeChannel(ids: string[]) {
  const sorted = [...ids].sort(cmp); // ascending
  return {
    messages: {
      fetch: async ({ limit, before, after }: FetchOpts) => {
        let pool = sorted;
        if (before !== undefined) pool = pool.filter((id) => cmp(id, before) < 0);
        if (after !== undefined) pool = pool.filter((id) => cmp(id, after) > 0);
        // `after` pages take the oldest qualifying set, `before`/bare take
        // the newest; Discord returns every page newest-first.
        const slice = after !== undefined && before === undefined
          ? pool.slice(0, limit)
          : pool.slice(-limit);
        const page = [...slice].sort((a, b) => cmp(b, a));
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
  // The whole window, not endpoints and a count (review finding 5): the
  // 150 ids just after the cursor, descending, no gaps or duplicates.
  assert.deepEqual(idsOf(got), range(1011, 1160).reverse());
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

test('before alone pages across the 100-message boundary too', async () => {
  const bot = botOver(range(1001, 1220));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 150, '1200', undefined);
  assert.deepEqual(idsOf(got), range(1050, 1199).reverse());
});

test('a bounded window wider than the limit serves its newest messages, from the top', async () => {
  const bot = botOver(range(101, 140));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, '140', '110');
  assert.deepEqual(idsOf(got), ['139', '138', '137', '136', '135']);
});

test('adjacent snowflake-width ids stay distinct (no Number collapse)', async () => {
  // 1000000000000000000 and ...001 compare equal as doubles; the cursor at
  // the former must still admit the latter.
  const ids = ['1000000000000000000', '1000000000000000001', '1000000000000000002'];
  const bot = botOver(ids);
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 5, undefined, '1000000000000000000');
  assert.deepEqual(idsOf(got), ['1000000000000000002', '1000000000000000001']);
});

test('a digit-length boundary does not reorder the walk', async () => {
  // 95..105 cross the two-to-three-digit boundary, where a lexicographic
  // sort would interleave ('100' < '95' as strings).
  const bot = botOver(range(95, 105));
  const got = await DiscordBot.prototype.fetchHistory.call(bot, 'c', 4, undefined, '98');
  assert.deepEqual(idsOf(got), ['102', '101', '100', '99']);
});
