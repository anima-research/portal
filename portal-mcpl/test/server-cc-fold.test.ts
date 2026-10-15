// Folding missed traffic into Claude Code wakes — the review-round cases
// (#35, Greptile): a live message must not move a watermark past an unseen
// gap, thread replies are folded rather than marked read unseen, other
// channels' pending pings stay pending, live and relay copies of a message
// show once, and work queued for one persona never runs as another.
//
// The relay double here computes unread from its own message store, so it
// never claims more or less than is really there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalCcChannelServer } from '../src/server-cc.js';

const A = '100';
const B = '200';
const TH = '900'; // a thread under B

const chan = (id: string, name: string): PortalChannel => ({
  id, guildId: 'g1', name, type: 'text', capabilities: ['VIEW_CHANNEL', 'READ_HISTORY'],
});
const S = (n: number) => new Date(Date.UTC(2026, 8, 21, 11, 0, n)).toISOString();

function msg(id: string, channelId: string, at: string, opts: { content?: string; threadId?: string } = {}): PortalMessage {
  const content = opts.content ?? `m${id}`;
  return {
    id, nativeId: id, channelId, guildId: 'g1', ...(opts.threadId ? { threadId: opts.threadId } : {}),
    author: { kind: 'user', userId: 'u', username: 'bob', displayName: 'Bob', bot: false },
    content, cleanContent: content, attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt: at,
  };
}

interface RelayOpts {
  personaId?: string;
  messages: PortalMessage[];
  watermarks?: Record<string, string>;
  pings?: PortalMessage[];
  /** Block list_unread until this resolves (to hold a wake mid-flight). */
  gate?: Promise<void>;
}

/** A client wired to an honest relay double. */
function relayClient(opts: RelayOpts) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: opts.personaId ?? 'p' });
  client.cache.hydrate({
    sessionId: 's', persona: { id: opts.personaId ?? 'p', displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }], channels: [chan(A, 'alpha'), chan(B, 'beta')], seq: 0,
  });
  const store = [...opts.messages];
  const watermarks: Record<string, string> = { ...(opts.watermarks ?? {}) };
  let pings = (opts.pings ?? []).map((m) => ({ message: m, reasons: ['role_mention'], at: m.createdAt }));
  const marked: Array<Record<string, unknown>> = [];
  const fetches: Array<{ channelId: string; threadId?: string }> = [];
  const unreadIn = (channelId: string) =>
    store.filter((m) => m.channelId === channelId && (!watermarks[channelId] || m.createdAt > watermarks[channelId]))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  Object.assign(client, {
    async fetchHistory(p: { channelId: string; threadId?: string; limit?: number; before?: string }) {
      fetches.push({ channelId: p.channelId, threadId: p.threadId });
      let newestFirst = store
        .filter((m) => m.channelId === p.channelId && (p.threadId ? m.threadId === p.threadId : !m.threadId))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (p.before) {
        const idx = newestFirst.findIndex((m) => m.id === p.before);
        newestFirst = idx >= 0 ? newestFirst.slice(idx + 1) : [];
      }
      return { messages: newestFirst.slice(0, p.limit ?? 50) };
    },
    async call(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'list_unread':
          if (opts.gate) await opts.gate;
          return {
            channels: [A, B].map((c) => ({ channelId: c, count: unreadIn(c).length, lastAt: unreadIn(c).at(-1)?.createdAt }))
              .filter((c) => c.count > 0),
          };
        case 'channel_missed': {
          const c = params.channelId as string;
          const un = unreadIn(c);
          const threads = new Map<string, { threadId: string; messages: number; lastAt: string }>();
          for (const m of un) {
            if (!m.threadId) continue;
            const t = threads.get(m.threadId) ?? { threadId: m.threadId, messages: 0, lastAt: m.createdAt };
            t.messages++; t.lastAt = m.createdAt; threads.set(m.threadId, t);
          }
          return {
            channelId: c, messages: un.length, characters: 0, since: watermarks[c],
            firstAt: un[0]?.createdAt, lastAt: un.at(-1)?.createdAt,
            threads: [...threads.values()],
          };
        }
        case 'mark_read': {
          marked.push(params);
          const c = params.channelId as string;
          const upto = params.uptoCreatedAt as string;
          if (!watermarks[c] || upto > watermarks[c]) watermarks[c] = upto;
          if (!params.keepPings) pings = pings.filter((p) => p.message.channelId !== c || p.at > upto);
          return {};
        }
        case 'get_pending_pings':
          return { pings };
        default:
          throw new Error(`unexpected rpc ${method}`);
      }
    },
  });
  return { client, marked, fetches, watermarks };
}

function serverFor(client: PortalClient, opts: { cap?: number; wakeSink?: { kind: string; deliver(p: { content: string }): Promise<void> } } = {}) {
  if (opts.cap) process.env.PORTAL_CONTEXT_CAP = String(opts.cap);
  try {
    const state = new AgentState();
    state.subscribe(A);
    state.subscribe(B);
    const agent = new PortalAgent(client, { state });
    const server = new PortalCcChannelServer(client, agent, opts.wakeSink ? { wakeSink: opts.wakeSink } : {});
    const wakes: Array<{ content: string; meta: Record<string, string> }> = [];
    const internal = server as unknown as {
      conn: unknown; wireClient(): void; wakeChain: Promise<void>;
      wokenByPersona: Map<string, Set<string>>;
    };
    internal.conn = { sendNotification: (_m: string, p: { content: string; meta: Record<string, string> }) => void wakes.push(p) };
    internal.wireClient();
    const settle = async () => {
      for (let i = 0; i < 5; i++) { await internal.wakeChain; await new Promise((r) => setImmediate(r)); }
    };
    return { server, agent, state, wakes, internal, settle };
  } finally {
    delete process.env.PORTAL_CONTEXT_CAP;
  }
}

const shownIds = (content: string) => [...content.matchAll(/Bob: m(\w+)/g)].map((m) => m[1]);
const ping = (client: PortalClient, m: PortalMessage) =>
  client.emit('message', { message: m, addressedToMe: true, reasons: ['role_mention'] });
const ambient = (client: PortalClient, m: PortalMessage) =>
  client.emit('message', { message: m, addressedToMe: false, reasons: [] });

test('a live message newer than an unseen gap does not move the watermark past the gap', async () => {
  const backlog = Array.from({ length: 60 }, (_, i) => msg(`b${i + 1}`, B, S(i + 1)));
  const live = msg('b61', B, S(61));
  const r = relayClient({ messages: [...backlog, live, msg('a1', A, S(0))], watermarks: { [B]: S(0) } });
  const h = serverFor(r.client, { cap: 20 });
  ambient(r.client, live);
  ping(r.client, msg('a99', A, S(99), { content: '@P hi' }));
  await h.settle();

  const shown = shownIds(h.wakes[0].content);
  assert.ok(shown.includes('b61'), 'the live message is shown');
  assert.ok(shown.includes('b1') && !shown.includes('b40'), 'the oldest backlog is folded, not all of it');
  const markB = r.marked.find((m) => m.channelId === B)!;
  const lastPrefix = backlog[shown.filter((id) => /^b\d+$/.test(id) && id !== 'b61').length - 1];
  assert.equal(markB.uptoCreatedAt, lastPrefix.createdAt, 'marked only through the unbroken run shown');
  assert.notEqual(markB.uptoCreatedAt, live.createdAt);
  assert.equal(markB.count, shown.filter((id) => /^b\d+$/.test(id) && id !== 'b61').length);

  // The next wake continues right after the run — nothing in the gap skipped.
  ping(r.client, msg('a100', A, S(100), { content: '@P again' }));
  await h.settle();
  const next = shownIds(h.wakes[1].content).filter((id) => /^b\d+$/.test(id));
  assert.equal(next[0], `b${Number(lastPrefix.id.slice(1)) + 1}`);
});

test('thread replies under a followed channel are folded (fetched by threadId), not marked read unseen', async () => {
  const r = relayClient({
    messages: [
      msg('b1', B, S(1)),
      msg('t2', B, S(2), { threadId: TH }),
      msg('b3', B, S(3)),
    ],
    watermarks: { [B]: S(0) },
  });
  const h = serverFor(r.client);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();

  assert.deepEqual(shownIds(h.wakes[0].content).filter((id) => id !== 'a9'), ['b1', 't2', 'b3']);
  assert.match(h.wakes[0].content, /Bob: mt2 \[thread 900\]/, 'a thread reply is labelled with its thread');
  assert.ok(r.fetches.some((f) => f.channelId === B && f.threadId === TH), 'the thread was read');
  assert.deepEqual(r.marked.find((m) => m.channelId === B), { channelId: B, uptoCreatedAt: S(3), count: 3, since: S(0), keepPings: true });
});

test("another channel's pending ping keeps that channel's relay watermark; it still isn't re-folded", async () => {
  const bPing = msg('b2', B, S(2), { content: '@P over here' });
  const r = relayClient({
    messages: [msg('b1', B, S(1)), bPing, msg('b3', B, S(3))],
    watermarks: { [B]: S(0) },
    pings: [bPing],
  });
  const h = serverFor(r.client);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();

  assert.ok(shownIds(h.wakes[0].content).includes('b3'), 'B is folded as context');
  assert.equal(r.marked.filter((m) => m.channelId === B).length, 0, "B's watermark stays the agent's while its ping is pending");

  ping(r.client, msg('a10', A, S(10), { content: '@P two' }));
  await h.settle();
  assert.equal(shownIds(h.wakes[1].content).filter((id) => id.startsWith('b')).length, 0, 'what was shown is not folded again');
});

test('a message both delivered live and in the relay history is shown once', async () => {
  const b5 = msg('b5', B, S(5));
  const r = relayClient({ messages: [msg('b4', B, S(4)), b5], watermarks: { [B]: S(0) } });
  const h = serverFor(r.client);
  ambient(r.client, b5);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();
  assert.deepEqual(shownIds(h.wakes[0].content).filter((id) => id.startsWith('b')), ['b4', 'b5']);
  assert.deepEqual(r.marked.find((m) => m.channelId === B), { channelId: B, uptoCreatedAt: S(5), count: 2, since: S(0), keepPings: true });
});

test("a ping queued for persona A behind a switch to B is not delivered as B's, and stays pending for A", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ra = relayClient({ personaId: 'pa', messages: [], gate });
  const rb = relayClient({ personaId: 'pb', messages: [] });
  const h = serverFor(ra.client);

  ping(ra.client, msg('a1', A, S(1), { content: '@A first' })); // starts, blocks in list_unread
  await new Promise((r) => setImmediate(r));
  const stateB = new AgentState();
  const swapped = h.server.swapSession(rb.client, new PortalAgent(rb.client, { state: stateB })); // queued behind it
  ping(ra.client, msg('a2', A, S(2), { content: '@A second' })); // A's listener is still attached: queued after the swap
  release();
  await swapped;
  await h.settle();

  // One wake — A's. (A's later ping may appear in it as context, since A's
  // agent had already taken it in; it is never presented as addressed, and no
  // wake is built for it after the switch.)
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].content, /» Bob: @A first/, "A's first ping was handled as A's");
  assert.doesNotMatch(h.wakes[0].content, /» Bob: @A second/, "A's later ping was not woken on as addressed");
  assert.equal(h.internal.wokenByPersona.get('pa')!.has('a2'), false, "un-marked for A's next catch-up");
});

test('a wake delivered after a switch settles the persona it was built for', async () => {
  let deliver!: () => void;
  const sink = { kind: 'test', deliver: () => new Promise<void>((r) => { deliver = r; }) };
  const ra = relayClient({ personaId: 'pa', messages: [msg('b1', B, S(1))], watermarks: { [B]: S(0) } });
  const rb = relayClient({ personaId: 'pb', messages: [] });
  const h = serverFor(ra.client, { wakeSink: sink });

  ping(ra.client, msg('a9', A, S(9), { content: '@A hi' }));
  await h.settle(); // built and handed to the sink, not yet delivered
  await h.server.swapSession(rb.client, new PortalAgent(rb.client, { state: new AgentState() }));
  deliver();
  await h.settle();

  assert.equal(ra.marked.filter((m) => m.channelId === B).length, 1, "A's fold was settled on A's relay session");
  assert.equal(rb.marked.length, 0, 'nothing was marked on B');
});

test('a fold never splits a group of messages sharing a timestamp', async () => {
  // b2 and b3 share a millisecond; the cap has room for b1 and one twin.
  const r = relayClient({
    messages: [msg('b1', B, S(1)), msg('b2', B, S(2)), msg('b3', B, S(2)), msg('b4', B, S(3)), msg('a0', A, S(0))],
    watermarks: { [B]: S(0) },
  });
  const h = serverFor(r.client, { cap: 4 }); // trigger + A backfill + 2 of B
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();
  assert.deepEqual(shownIds(h.wakes[0].content).filter((id) => id.startsWith('b')), ['b1'], 'stops before the pair');
  assert.deepEqual(r.marked.find((m) => m.channelId === B), { channelId: B, uptoCreatedAt: S(1), count: 1, since: S(0), keepPings: true });

  ping(r.client, msg('a10', A, S(10), { content: '@P again' }));
  await h.settle();
  const next = shownIds(h.wakes[1].content).filter((id) => id.startsWith('b'));
  assert.ok(next.includes('b2') && next.includes('b3'), 'the pair arrives together');
});

test('a timestamp group bigger than the room left is taken whole, so the fold always progresses', async () => {
  const r = relayClient({
    messages: [msg('b1', B, S(1)), msg('b2', B, S(1)), msg('b3', B, S(2))],
    watermarks: { [B]: S(0) },
  });
  const h = serverFor(r.client, { cap: 2 }); // the trigger + one slot
  for (let i = 0; i < 3; i++) {
    ping(r.client, msg(`a${i}`, A, S(10 + i), { content: `@P ${i}` }));
    await h.settle();
  }
  const ever = new Set(h.wakes.flatMap((w) => shownIds(w.content)).filter((id) => id.startsWith('b')));
  assert.deepEqual([...ever].sort(), ['b1', 'b2', 'b3'], 'every message reached the agent');
});

test("a relay that can't list threads (only names the latest) gets a note, not a fold that would lose replies", async () => {
  const r = relayClient({ messages: [msg('b1', B, S(1)), msg('t2', B, S(2), { threadId: TH })], watermarks: { [B]: S(0) } });
  // Simulate the old relay: channel_missed names threadId but no thread list.
  const call = (r.client as unknown as { call: (m: string, p: Record<string, unknown>) => Promise<unknown> }).call.bind(r.client);
  Object.assign(r.client, {
    async call(method: string, params: Record<string, unknown>) {
      const res = (await call(method, params)) as Record<string, unknown>;
      if (method === 'channel_missed' && Array.isArray(res.threads) && res.threads.length) {
        const { threads, ...rest } = res;
        return { ...rest, threadId: (threads as Array<{ threadId: string }>)[0].threadId };
      }
      return res;
    },
  });
  const h = serverFor(r.client);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();
  assert.match(h.wakes[0].content, /missed in #beta — more than a wake folds/);
  assert.equal(r.marked.filter((m) => m.channelId === B).length, 0);
});

test('a channel never marked read folds only what the relay counted as missed, not its whole history', async () => {
  const old = Array.from({ length: 300 }, (_, i) => msg(`o${i}`, B, S(i)));
  const missed = Array.from({ length: 5 }, (_, i) => msg(`n${i}`, B, S(400 + i)));
  const r = relayClient({ messages: [...old, ...missed] }); // no watermark for B
  // The relay started tallying at the first missed message.
  const call = (r.client as unknown as { call: (m: string, p: Record<string, unknown>) => Promise<unknown> }).call.bind(r.client);
  Object.assign(r.client, {
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'list_unread') return { channels: [{ channelId: B, count: 5, lastAt: S(404) }] };
      if (method === 'channel_missed') return { channelId: B, messages: 5, characters: 0, firstAt: S(400), lastAt: S(404), threads: [] };
      return call(method, params);
    },
  });
  const h = serverFor(r.client, { cap: 50 });
  ping(r.client, msg('a9', A, S(500), { content: '@P hi' }));
  await h.settle();
  const shownB = shownIds(h.wakes[0].content).filter((id) => /^[on]\d/.test(id));
  assert.deepEqual(shownB, ['n0', 'n1', 'n2', 'n3', 'n4'], 'the five missed, none of the older history');
  assert.doesNotMatch(h.wakes[0].content, /more unread message\(s\) in #beta/);
});

test('a never-read channel from a relay that does not say where counting started gets a note, not a history crawl', async () => {
  const r = relayClient({ messages: [msg('o1', B, S(1)), msg('n1', B, S(2))] });
  const call = (r.client as unknown as { call: (m: string, p: Record<string, unknown>) => Promise<unknown> }).call.bind(r.client);
  Object.assign(r.client, {
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'channel_missed') return { channelId: B, messages: 1, characters: 0, lastAt: S(2), threads: [] };
      return call(method, params);
    },
  });
  const h = serverFor(r.client);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();
  assert.match(h.wakes[0].content, /missed in #beta — more than a wake folds/);
  assert.equal(r.marked.filter((m) => m.channelId === B).length, 0);
});

test('a catch-up marks only the pings it shows; the rest come in the next catch-up', async () => {
  const pings = Array.from({ length: 5 }, (_, i) => msg(`p${i}`, A, S(i + 1), { content: `@P ${i}` }));
  const r = relayClient({ messages: [], pings });
  const h = serverFor(r.client, { cap: 3 });
  const internal = h.server as unknown as { catchUp(): Promise<void> };
  await internal.catchUp();
  await h.settle();
  const pingsIn = (c: string) => [...c.matchAll(/Bob: @P (\d)/g)].map((m) => `p${m[1]}`);
  assert.deepEqual(pingsIn(h.wakes[0].content), ['p2', 'p3', 'p4'], 'the newest fit');
  await internal.catchUp();
  await h.settle();
  assert.deepEqual(pingsIn(h.wakes[1].content), ['p0', 'p1'], 'the ones the cap left out are not skipped');
});

test("a persona's own posts aren't counted toward what a mark covers (the relay never tallied them)", async () => {
  const mine: PortalMessage = { ...msg('b2', B, S(2)), author: { kind: 'persona', personaId: 'p', displayName: 'P', avatarUrl: '' } };
  const r = relayClient({ messages: [msg('b1', B, S(1)), mine, msg('b3', B, S(3))], watermarks: { [B]: S(0) } });
  const h = serverFor(r.client);
  ping(r.client, msg('a9', A, S(9), { content: '@P hi' }));
  await h.settle();
  assert.equal(r.marked.find((m) => m.channelId === B)!.count, 2);
});

// ── Switch pins (#35 review, notes 9 and 10) ──

test('A→B→A: a ping already surfaced for A is not delivered again when switching back', async () => {
  const p1 = msg('p1', A, S(1), { content: '@pa one' });
  const ra = relayClient({ personaId: 'pa', messages: [], pings: [p1] });
  const rb = relayClient({ personaId: 'pb', messages: [] });
  const h = serverFor(ra.client);
  const internal = h.server as unknown as { catchUp(): Promise<void> };
  await internal.catchUp();
  await h.settle();
  assert.equal(h.wakes.length, 1);
  await h.server.swapSession(rb.client, new PortalAgent(rb.client, { state: new AgentState() }));
  await h.settle();
  // Back to A: a fresh session for the same persona; the relay still holds p1.
  const ra2 = relayClient({ personaId: 'pa', messages: [], pings: [p1] });
  await h.server.swapSession(ra2.client, new PortalAgent(ra2.client, { state: new AgentState() }));
  await h.settle();
  assert.equal(h.wakes.length, 1, "A's ping was delivered once");
});

test("a catch-up queued for A behind the switch to B is dropped, not run with A's pings while B is active", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ra = relayClient({ personaId: 'pa', messages: [], pings: [msg('p1', A, S(1), { content: '@pa queued' })], gate });
  const rb = relayClient({ personaId: 'pb', messages: [] });
  const h = serverFor(ra.client);
  ping(ra.client, msg('a0', A, S(0), { content: '@pa first' })); // holds the chain in list_unread
  await new Promise((r) => setImmediate(r));
  const swapped = h.server.swapSession(rb.client, new PortalAgent(rb.client, { state: new AgentState() }));
  ra.client.emit('ready', {} as never); // A's listener is still attached: its catch-up queues after the swap
  release();
  await swapped;
  await h.settle();
  assert.doesNotMatch(h.wakes.map((w) => w.content).join('\n'), /@pa queued/);
});

test('an in-flight wake is delivered before a switch it was queued ahead of', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ra = relayClient({ personaId: 'pa', messages: [], gate });
  const rb = relayClient({ personaId: 'pb', messages: [] });
  const h = serverFor(ra.client);
  const activeAtSend: string[] = [];
  const internal = h.server as unknown as { conn: unknown; client: { personaId: string } };
  internal.conn = { sendNotification: () => void activeAtSend.push(internal.client.personaId) };
  ping(ra.client, msg('a1', A, S(1), { content: '@pa hi' })); // held mid-fold
  await new Promise((r) => setImmediate(r));
  const swapped = h.server.swapSession(rb.client, new PortalAgent(rb.client, { state: new AgentState() }));
  release();
  await swapped;
  await h.settle();
  assert.deepEqual(activeAtSend, ['pa'], "A's wake went out while A was still the active persona");
});
