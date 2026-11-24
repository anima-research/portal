import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const CHAN = 'chan-1';
const THREAD = 'thread-1';
const OTHER = 'chan-2';
const PERSONA = 'alice';
const WEBHOOK = 'wh-1';
const CAPS = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'EDIT_OWN'];

function incoming(over: Record<string, unknown> = {}) {
  return {
    id: '100', content: 'old', cleanContent: 'old',
    authorId: 'u1', authorName: 'someone', authorDisplayName: 'someone',
    isBot: false, webhookId: undefined,
    channelId: CHAN, parentChannelId: CHAN, threadId: undefined,
    guildId: GUILD, channelName: 'chan',
    mentionUserIds: [], mentionRoleIds: [], mentionsEveryone: false,
    replyToId: undefined, replyToUserId: null,
    attachments: [], reactions: [], timestamp: new Date(),
    ...over,
  };
}
type Incoming = ReturnType<typeof incoming>;

const inThread = (over: Record<string, unknown>) =>
  incoming({ channelId: THREAD, parentChannelId: CHAN, threadId: THREAD, ...over });

function makeRelay(ttl = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-history-race-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: [{ id: PERSONA, displayName: 'Alice', avatar: '', token: 'tok' }] }));
  writeFileSync(
    permissionsPath,
    JSON.stringify({ personas: { [PERSONA]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN]: CAPS, [OTHER]: CAPS } } } } } }),
  );
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: ttl, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  const metas: Record<string, { id: string; parentId?: string; isThread: boolean; guildId: string }> = {
    [CHAN]: { id: CHAN, isThread: false, guildId: GUILD },
    [THREAD]: { id: THREAD, parentId: CHAN, isThread: true, guildId: GUILD },
    [OTHER]: { id: OTHER, isThread: false, guildId: GUILD },
  };
  const discord: Record<string, Incoming[]> = {
    [CHAN]: [incoming()],
    [THREAD]: [inThread({ id: '101' })],
    [OTHER]: [incoming({ id: '102', channelId: OTHER, parentChannelId: OTHER })],
  };
  const reads: string[] = [];
  const answers: (() => void)[] = [];
  let toHold = 0;
  let readStarted: (() => void) | undefined;

  relay.bot = {
    getChannelMeta: async (id: string) => metas[id] ?? null,
    resolveTarget: async (id: string) => {
      const meta = metas[id];
      if (!meta) return null;
      return meta.isThread && meta.parentId ? { parentChannelId: meta.parentId, threadId: meta.id } : { parentChannelId: meta.id };
    },
    channelForPerms: () => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    channelMetaFromCache: (id: string) => metas[id] ?? null,
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 1 }],
    isGuildAllowed: () => true,
    ownsWebhook: (id: string) => id === WEBHOOK,
    resolveOutgoingMentions: (_g: string | null, content: string) => content,
    fetchHistory: async (place: string) => {
      const page = [...discord[place]!];
      reads.push(place);
      readStarted?.();
      if (toHold === 0) return page;
      toHold--;
      return new Promise((resolve) => answers.push(() => resolve(page)));
    },
  };

  let sent = 0;
  let editGate: Promise<void> = Promise.resolve();
  let editStarted: (() => void) | undefined;
  let editFails = false;
  relay.webhooks = {
    send: async (channelId: string, _personaId: string, opts: { content: string; threadId?: string }) => {
      const messageId = `own-${++sent}`;
      const place = opts.threadId ?? channelId;
      const message = { id: messageId, content: opts.content, cleanContent: opts.content, webhookId: WEBHOOK };
      discord[place] = [opts.threadId ? inThread(message) : incoming({ ...message, channelId, parentChannelId: channelId }), ...discord[place]!];
      return { messageId, webhookId: WEBHOOK };
    },
    ensureLoaded: async () => {},
    edit: async (_webhookId: string, messageId: string, content: string, threadId?: string) => {
      editStarted?.();
      await editGate;
      const place = threadId ?? CHAN;
      discord[place] = discord[place]!.map((m) => (m.id === messageId ? { ...m, content, cleanContent: content } : m));
      if (editFails) {
        editFails = false;
        throw new Error('The edit request timed out');
      }
    },
  };

  const rpc = (method: string, params: unknown) => relay.dispatchRpc({ personaId: PERSONA, send: () => {} }, method, params);
  return {
    rpc,
    reads,
    hold: (n = 1) => { toHold = n; },
    answer: () => answers.shift()!(),
    nextRead: () => new Promise<void>((resolve) => (readStarted = resolve)),
    failNextEdit: () => { editFails = true; },
    holdEdit: () => {
      let release!: () => void;
      editGate = new Promise((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (editStarted = resolve));
      return { started, release };
    },
    arrive: (place: string, inc: Incoming) => {
      discord[place] = [inc, ...discord[place]!];
      relay.onDiscordMessage(inc);
    },
    edit: (place: string, id: string, content: string) => {
      discord[place] = discord[place]!.map((m) => (m.id === id ? { ...m, content, cleanContent: content } : m));
      relay.onDiscordEdit(discord[place]!.find((m) => m.id === id));
    },
    remove: (place: string, id: string) => {
      discord[place] = discord[place]!.filter((m) => m.id !== id);
      relay.onDiscordDelete(place, id);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const contents = (r: { messages: { content: string }[] }) => r.messages.map((m) => m.content);

async function heldRead(w: ReturnType<typeof makeRelay>, params: Record<string, unknown>) {
  const started = w.nextRead();
  const answered = w.rpc('fetch_history', params);
  await started;
  return { answered };
}

const places = [
  { name: 'a channel', read: { channelId: CHAN, limit: 5 }, place: CHAN, id: '100' },
  { name: 'a thread', read: { channelId: CHAN, threadId: THREAD, limit: 5 }, place: THREAD, id: '101' },
  { name: 'a thread named by its own id as channelId', read: { channelId: THREAD, limit: 5 }, place: THREAD, id: '101' },
];

for (const { name, read, place } of places) {
  test(`a message that arrives in ${name} while a page of it is read: the next call of the same shape reads Discord again, and has it`, async () => {
    const w = makeRelay();
    try {
      w.hold();
      const { answered: first } = await heldRead(w, read);
      const message = { id: '200', content: 'NEW', cleanContent: 'NEW' };
      w.arrive(place, place === THREAD ? inThread(message) : incoming(message));
      w.answer();
      assert.deepEqual(contents(await first), ['old'], 'the overtaken read returns the page it read');
      const second = await w.rpc('fetch_history', read);
      assert.deepEqual(contents(second), ['NEW', 'old']);
      assert.equal(w.reads.length, 2);
    } finally { w.cleanup(); }
  });
}

test('with no change while a page is read, the next call of the same shape within the cache life reads no Discord', async () => {
  const w = makeRelay();
  try {
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    assert.equal(w.reads.length, 1);
  } finally { w.cleanup(); }
});

for (const change of ['an edit', 'a delete'] as const) {
  for (const { name, read, place, id } of places) {
    test(`${change} that reaches ${name} while a page of it is read keeps the page from being stored`, async () => {
      const w = makeRelay();
      try {
        w.hold();
        const { answered: first } = await heldRead(w, read);
        if (change === 'an edit') w.edit(place, id, 'EDITED');
        else w.remove(place, id);
        w.answer();
        await first;
        const second = await w.rpc('fetch_history', read);
        assert.deepEqual(contents(second), change === 'an edit' ? ['EDITED'] : []);
        assert.equal(w.reads.length, 2);
      } finally { w.cleanup(); }
    });
  }
}

test('a message in another channel while a page is read leaves the page stored', async () => {
  const w = makeRelay();
  try {
    w.hold();
    const { answered: first } = await heldRead(w, { channelId: CHAN, limit: 5 });
    w.arrive(OTHER, incoming({ id: '200', channelId: OTHER, parentChannelId: OTHER }));
    w.answer();
    await first;
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    assert.equal(w.reads.length, 1);
  } finally { w.cleanup(); }
});

test('two reads of one shape under way when a message arrives: neither page is stored', async () => {
  const w = makeRelay();
  try {
    w.hold(2);
    const { answered: first } = await heldRead(w, { channelId: CHAN, limit: 5 });
    const { answered: second } = await heldRead(w, { channelId: CHAN, limit: 5 });
    w.arrive(CHAN, incoming({ id: '200', content: 'NEW', cleanContent: 'NEW' }));
    w.answer();
    w.answer();
    await Promise.all([first, second]);
    const third = await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    assert.deepEqual(contents(third), ['NEW', 'old']);
    assert.equal(w.reads.length, 3);
  } finally { w.cleanup(); }
});

test('a thread and its parent channel are two places: a message in one while the other is read leaves the read page stored', async () => {
  const cases = [
    { read: { channelId: CHAN, threadId: THREAD, limit: 5 }, readPlace: THREAD, arrives: incoming({ id: '200' }) },
    { read: { channelId: CHAN, limit: 5 }, readPlace: CHAN, arrives: inThread({ id: '201' }) },
  ];
  for (const { read, readPlace, arrives } of cases) {
    const w = makeRelay();
    try {
      w.hold();
      const { answered } = await heldRead(w, read);
      w.arrive(arrives.channelId, arrives);
      w.answer();
      await answered;
      await w.rpc('fetch_history', read);
      assert.deepEqual(w.reads, [readPlace], readPlace);
    } finally { w.cleanup(); }
  }
});

test('with a cache life of 0, each call reads Discord', async () => {
  const w = makeRelay(0);
  try {
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    assert.equal(w.reads.length, 2);
  } finally { w.cleanup(); }
});

test("a persona's edit of its own message clears the place's cached pages, though no edit event follows it", async () => {
  for (const threadId of [undefined, THREAD]) {
    const w = makeRelay();
    try {
      const place = { channelId: CHAN, threadId };
      const { messageId } = await w.rpc('send_message', { ...place, content: 'first' });
      const before = contents(await w.rpc('fetch_history', { ...place, limit: 5 }));
      await w.rpc('edit_message', { messageId, content: 'second' });
      const after = contents(await w.rpc('fetch_history', { ...place, limit: 5 }));
      assert.deepEqual([before[0], after[0]], ['first', 'second'], threadId ?? CHAN);
      assert.equal(w.reads.length, 2, threadId ?? CHAN);
    } finally { w.cleanup(); }
  }
});

test("a read that starts while a persona's edit is on its way to Discord, and returns after it, is not stored", async () => {
  const w = makeRelay();
  try {
    const { messageId } = await w.rpc('send_message', { channelId: CHAN, content: 'first' });
    const edit = w.holdEdit();
    const editing = w.rpc('edit_message', { messageId, content: 'second' });
    await edit.started;
    w.hold();
    const { answered } = await heldRead(w, { channelId: CHAN, limit: 5 });
    edit.release();
    await editing;
    w.answer();
    assert.equal(contents(await answered)[0], 'first');
    assert.equal(contents(await w.rpc('fetch_history', { channelId: CHAN, limit: 5 }))[0], 'second');
  } finally { w.cleanup(); }
});

test("an edit_message whose webhook call fails after Discord applied the edit still clears the place's cached pages", async () => {
  const w = makeRelay();
  try {
    const { messageId } = await w.rpc('send_message', { channelId: CHAN, content: 'first' });
    await w.rpc('fetch_history', { channelId: CHAN, limit: 5 });
    w.failNextEdit();
    await assert.rejects(w.rpc('edit_message', { messageId, content: 'second' }));
    assert.equal(contents(await w.rpc('fetch_history', { channelId: CHAN, limit: 5 }))[0], 'second');
  } finally { w.cleanup(); }
});
