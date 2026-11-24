import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalChannel, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState } from '../src/agent-state.js';
import { PortalAgent } from '../src/agent.js';
import { PortalCcChannelServer } from '../src/server-cc.js';
import { PortalMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';
import { CODEX_WAKE_MAX_CHARS, CodexQueueSink, renderCodexWake, type WakeCut, type WakePayload, type WakeSink } from '../src/wake-sink.js';

const CH = '1526659685036331058';
const OTHER = '1526659685036331059';
const channel = (id: string, name: string): PortalChannel => ({
  id, guildId: 'g1', name, type: 'text', capabilities: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'],
});

function msg(id: string, minute: number, channelId = CH): PortalMessage {
  return {
    id, nativeId: id, channelId, guildId: 'g1',
    author: { kind: 'user', userId: 'u1', username: 'bob', displayName: 'Bob', bot: false },
    content: `@P message ${id}`, cleanContent: `@P message ${id}`, attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [], createdAt: `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

function relay(personaId = 'p') {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId });
  client.cache.hydrate({
    sessionId: 's', persona: { id: personaId, displayName: 'P', avatarUrl: '' },
    guilds: [{ id: 'g1', name: 'G' }], channels: [channel(CH, 'portables'), channel(OTHER, 'other')], seq: 0,
  });
  const control: { pending: PortalMessage[]; unreadable?: boolean; held?: { entered: () => void; until: Promise<void> } } = { pending: [] };
  const holdNextRead = () => {
    const entered = gate();
    const release = gate();
    control.held = { entered: entered.open, until: release.opened };
    return { entered: entered.opened, release: release.open };
  };
  Object.assign(client, {
    async fetchHistory() {
      return { messages: [] };
    },
    async call(method: string) {
      switch (method) {
        case 'list_unread':
          return { channels: [] };
        case 'mark_read':
          return {};
        case 'get_pending_pings': {
          if (control.unreadable) throw new Error('relay not ready');
          const held = control.held;
          if (held) {
            control.held = undefined;
            held.entered();
            await held.until;
          }
          return { pings: control.pending.map((m) => ({ message: m, reasons: ['role_mention'], at: m.createdAt })) };
        }
        default:
          throw new Error(`unexpected rpc ${method}`);
      }
    },
  });
  return { client, control, holdNextRead };
}

type Wake = { content: string; meta: Record<string, string> };

function ccProcess(saved?: unknown, opts: { wakeSink?: WakeSink; personaId?: string } = {}) {
  const { client, control, holdNextRead } = relay(opts.personaId);
  const state = saved ? AgentState.fromJSON(JSON.parse(JSON.stringify(saved))) : new AgentState();
  const agent = new PortalAgent(client, { state });
  const server = new PortalCcChannelServer(client, agent, { wakeSink: opts.wakeSink });
  const wakes: Wake[] = [];
  const internal = server as unknown as {
    conn: unknown; wireClient(): void; catchUp(): Promise<void>; wakeChain: Promise<void>;
  };
  internal.conn = { sendNotification: (_m: string, p: Wake) => void wakes.push(p) };
  internal.wireClient();
  const settle = async () => {
    await internal.wakeChain;
    await new Promise((r) => setImmediate(r));
  };
  const mention = (m: PortalMessage) => client.emit('message', { message: m, addressedToMe: true, reasons: ['role_mention'] });
  const ambient = (m: PortalMessage) => client.emit('message', { message: m, addressedToMe: false, reasons: [] });
  return { client, control, holdNextRead, state, agent, server, internal, wakes, settle, mention, ambient };
}

async function nextCatchUp(saved: unknown, pending: PortalMessage[]) {
  const next = ccProcess(saved);
  next.control.pending = pending;
  await next.internal.catchUp();
  await next.settle();
  assert.equal(next.wakes.length, 1, 'a pending mention still wakes');
  return next.wakes[0];
}

const savedSent = (state: AgentState): string[] => (state.toJSON() as { sent?: string[] }).sent ?? [];
const head = (wake: Wake) => wake.content.split('\n')[0];
const lineOf = (wake: Wake, id: string) => wake.content.split('\n').find((l) => l.includes(`message ${id}`)) ?? '';
const NEW_HEAD = '[catch-up] 1 message(s) addressed to you while you were away:';
const EARLIER_HEAD =
  '[catch-up] nothing new was addressed to you while you were away. 1 message(s) sent to you before are still pending:';

function recordingSink(answer: () => Promise<WakeCut | void>) {
  const delivered: WakePayload[] = [];
  const sink: WakeSink = {
    kind: 'test',
    deliver: (p) => {
      delivered.push(p);
      return answer();
    },
  };
  return { sink, delivered };
}

test('the agent state saves the sent ids, tells its listener of each change, and an older saved state has none', () => {
  const state = new AgentState();
  let changes = 0;
  state.onChange(() => changes++);
  state.noteSent(['m1']);
  state.noteSent(['m1']);
  assert.equal(changes, 1, 'an id already saved changes nothing');
  assert.equal(AgentState.fromJSON(JSON.parse(JSON.stringify(state.toJSON()))).wasSent('m1'), true);
  state.forgetSent(['m1']);
  state.forgetSent(['m1']);
  assert.equal(changes, 2);
  assert.equal(state.wasSent('m1'), false);
  assert.equal(AgentState.fromJSON({ watermarks: {}, pings: [] }).wasSent('m1'), false);
});

test('a mention sent to an earlier process reads "nothing new", marked "(sent before)", with no new attribute', async () => {
  const m1 = msg('m1', 1);
  const first = ccProcess();
  first.mention(m1);
  await first.settle();
  assert.equal(first.wakes.length, 1);
  assert.doesNotMatch(first.wakes[0].content, /\[message /, 'a live wake names no ids');

  const wake = await nextCatchUp(first.state.toJSON(), [m1]);
  assert.equal(head(wake), EARLIER_HEAD);
  assert.match(lineOf(wake, 'm1'), /\(sent before\)/);
  assert.deepEqual(Object.keys(wake.meta).sort(), ['addressed', 'author', 'catchup', 'channelId', 'messageId', 'source']);
});

test('a catch-up counts the new mentions and the ones sent before, and marks only the latter', async () => {
  const m1 = msg('m1', 1);
  const m2 = msg('m2', 2);
  const first = ccProcess();
  first.mention(m1);
  await first.settle();

  const wake = await nextCatchUp(first.state.toJSON(), [m1, m2]);
  assert.equal(head(wake), '[catch-up] 1 message(s) addressed to you while you were away, and 1 sent to you before and still pending:');
  assert.match(lineOf(wake, 'm1'), /\(sent before\) \[message m1\]/);
  assert.doesNotMatch(lineOf(wake, 'm2'), /sent before/);
  assert.match(lineOf(wake, 'm2'), /\[message m2\]/);
});

test('with nothing sent before, the catch-up has no sent-before head and no mark', async () => {
  const wake = await nextCatchUp(undefined, [msg('m1', 1)]);
  assert.equal(head(wake), NEW_HEAD);
  assert.doesNotMatch(wake.content, /sent (before|to you)/);
});

test('a sent id leaves the saved state once the relay no longer lists its mention', async () => {
  const m1 = msg('m1', 1);
  const first = ccProcess();
  first.mention(m1);
  await first.settle();
  assert.deepEqual(savedSent(first.state), ['m1']);

  const next = ccProcess(first.state.toJSON());
  next.control.pending = [];
  await next.internal.catchUp();
  await next.settle();
  assert.deepEqual(savedSent(next.state), []);
});

test('an id saved while a catch-up waits on the relay is not dropped by that catch-up', async () => {
  const next = ccProcess();
  const { entered, release } = next.holdNextRead();
  const catchUp = next.internal.catchUp();
  await entered;
  next.state.noteSent(['m9']);
  release();
  await catchUp;
  assert.deepEqual(savedSent(next.state), ['m9']);
});

test('a live wake prunes the saved ids against the pending list it reads', async () => {
  const m1 = msg('m1', 1);
  const first = ccProcess();
  first.state.noteSent(['gone']);
  first.control.pending = [m1];
  first.mention(m1);
  await first.settle();
  assert.deepEqual(savedSent(first.state), ['m1']);
});

test('a live wake that cannot read the pending list prunes nothing', async () => {
  const m1 = msg('m1', 1);
  const first = ccProcess();
  first.state.noteSent(['earlier']);
  first.control.unreadable = true;
  first.mention(m1);
  await first.settle();
  assert.equal(first.wakes.length, 1);
  assert.deepEqual(savedSent(first.state), ['earlier', 'm1']);
});

test('a wake that fails at its sink is not saved, so the next process reads the mention as new', async () => {
  const m1 = msg('m1', 1);
  const { sink, delivered } = recordingSink(async () => { throw new Error('queue refused'); });
  const first = ccProcess(undefined, { wakeSink: sink });
  first.mention(m1);
  await first.settle();
  await new Promise((r) => setImmediate(r));
  assert.equal(delivered.length, 1, 'the sink was asked');

  const wake = await nextCatchUp(first.state.toJSON(), [m1]);
  assert.equal(head(wake), NEW_HEAD);
});

test('a sink wake is saved only once its delivery succeeds', async () => {
  const m1 = msg('m1', 1);
  const done = gate();
  const { sink, delivered } = recordingSink(() => done.opened);
  const first = ccProcess(undefined, { wakeSink: sink });
  first.mention(m1);
  await first.settle();
  assert.equal(delivered.length, 1);
  assert.deepEqual(savedSent(first.state), [], 'nothing is saved while the sink is delivering');
  done.open();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(savedSent(first.state), ['m1']);
});

test('a wake that its sink delivered only in part saves nothing', async () => {
  const m1 = msg('m1', 1);
  const { sink, delivered } = recordingSink(async () => ({ omittedChars: 40 }));
  const first = ccProcess(undefined, { wakeSink: sink });
  first.mention(m1);
  await first.settle();
  await new Promise((r) => setImmediate(r));
  assert.equal(delivered.length, 1);
  assert.deepEqual(savedSent(first.state), []);
});

test('the codex sink answers when it cut a wake, and says nothing when it sent all of it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-wake-'));
  try {
    const file = join(dir, 'p.wake.json');
    writeFileSync(file, JSON.stringify({ codexBin: '/bin/codex', threadId: 't1' }));
    const sent: string[] = [];
    const sink = new CodexQueueSink(file, async (_bin, args) => void sent.push(args[args.length - 1]));
    const meta = { channelId: CH, author: 'Bob' };
    assert.equal(await sink.deliver({ content: 'short', meta }), undefined);
    const cut = await sink.deliver({ content: 'x'.repeat(CODEX_WAKE_MAX_CHARS + 25), meta });
    assert.deepEqual(cut, { omittedChars: 25 });
    assert.match(sent[1], /\[25 chars of earlier context omitted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live wake whose context cap left out its trigger saves nothing', async () => {
  const saved = process.env.PORTAL_CONTEXT_CAP;
  process.env.PORTAL_CONTEXT_CAP = '1';
  try {
    const m1 = msg('m1', 1);
    const first = ccProcess();
    const { entered, release } = first.holdNextRead();
    first.mention(m1);
    await entered;
    first.ambient(msg('a2', 2, OTHER));
    release();
    await first.settle();
    assert.equal(first.wakes.length, 1);
    assert.equal(lineOf(first.wakes[0], 'm1'), '', 'the cap left the trigger out');
    assert.deepEqual(savedSent(first.state), []);
  } finally {
    if (saved === undefined) delete process.env.PORTAL_CONTEXT_CAP;
    else process.env.PORTAL_CONTEXT_CAP = saved;
  }
});

test('a mention whose wake was never handed over reads as new at the next start', async () => {
  const m1 = msg('m1', 1);
  const first = ccProcess();
  const { entered } = first.holdNextRead();
  first.mention(m1);
  await entered;
  assert.equal(first.wakes.length, 0);

  const wake = await nextCatchUp(first.state.toJSON(), [m1]);
  assert.equal(head(wake), NEW_HEAD);
});

test('a wake dropped by an identity switch is saved in neither persona', async () => {
  const m1 = msg('m1', 1);
  const m2 = msg('m2', 2);
  const a = ccProcess();
  const { entered, release } = a.holdNextRead();
  a.mention(m1);
  await entered;
  const b = relay('q');
  const stateB = new AgentState();
  const switched = a.server.swapSession(b.client, new PortalAgent(b.client, { state: stateB }));
  a.mention(m2);
  release();
  await switched;
  await a.settle();

  assert.equal(a.wakes.length, 1);
  assert.deepEqual(savedSent(a.state), ['m1'], 'the wake handed over before the switch is saved');
  assert.deepEqual(savedSent(stateB), []);
});

type Push = { payload: { content: Array<{ text: string }> } };

function hostProcess(saved: unknown, answer: unknown, opts: { open?: boolean } = {}) {
  const { client, control } = relay();
  const state = saved ? AgentState.fromJSON(JSON.parse(JSON.stringify(saved))) : new AgentState();
  const server = new PortalMcplServer(client, new PortalAgent(client, { state, hostOwnsChannelLifecycle: true }));
  const requests: Array<{ method: string; params: unknown }> = [];
  const internal = server as unknown as {
    conn: unknown; wireClient(): void; catchUp(): Promise<void>; mcplEnabled: boolean; openChannels: Set<string>;
    policy: { applyRequest(params: unknown): unknown };
  };
  internal.conn = {
    sendRequest: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return answer;
    },
    sendNotification() {},
  };
  internal.mcplEnabled = true;
  internal.policy.applyRequest({
    effectiveCapabilities: [...new Set(Object.values(featureSets).flatMap((set) => set.uses as string[]))],
  });
  if (opts.open) internal.openChannels.add(CH);
  internal.wireClient();
  const mention = async (m: PortalMessage) => {
    client.emit('message', { message: m, addressedToMe: true, reasons: ['role_mention'] });
    for (let turn = 0; turn < 100 && requests.length === 0; turn++) await new Promise((r) => setImmediate(r));
    assert.equal(requests.length, 1, 'the binding sent the mention to the host');
    await new Promise((r) => setImmediate(r));
  };
  return { client, control, state, internal, requests, mention };
}

test('a host push is saved when the host accepts it, and not when the host declines it', async () => {
  for (const accepted of [true, false]) {
    const m1 = msg('m1', 1);
    const first = hostProcess(undefined, { accepted });
    await first.mention(m1);
    assert.equal(first.requests[0].method, 'push/event');

    const next = hostProcess(first.state.toJSON(), { accepted: true });
    next.control.pending = [m1];
    await next.internal.catchUp();
    const text = (next.requests[0].params as Push).payload.content[0].text;
    const lines = text.split('\n');
    if (accepted) {
      assert.equal(lines[0], EARLIER_HEAD);
      assert.match(lines.find((l) => l.includes('message m1')) ?? '', /\(sent before\) \[message m1\]/);
    } else {
      assert.equal(lines[0], NEW_HEAD);
      assert.doesNotMatch(text, /sent (before|to you)/);
    }
  }
});

test('a mention that the host accepts prunes the saved ids against the pending list, and keeps its own id', async () => {
  for (const open of [false, true]) {
    const answer = open ? { results: [{ messageId: 'm1', accepted: true }] } : { accepted: true };
    const first = hostProcess(undefined, answer, { open });
    first.state.noteSent(['gone']);
    first.control.pending = [];
    await first.mention(msg('m1', 1));
    for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(savedSent(first.state), ['m1'], open ? 'channels/incoming' : 'push/event');
  }
});

test('a host push is saved only once the host has answered it', async () => {
  for (const method of ['push/event', 'channels/incoming']) {
    const answered = gate();
    const answer = answered.opened.then(() =>
      method === 'push/event' ? { accepted: true } : { results: [{ messageId: 'm1', accepted: true }] },
    );
    const first = hostProcess(undefined, answer, { open: method === 'channels/incoming' });
    await first.mention(msg('m1', 1));
    assert.equal(first.requests[0].method, method);
    assert.equal(first.state.wasSent('m1'), false, `${method}: nothing is saved while the host has not answered`);
    answered.open();
    await new Promise((r) => setImmediate(r));
    assert.equal(first.state.wasSent('m1'), true, method);
  }
});

test('in an open channel, a mention is saved only when the host accepts that message', async () => {
  const cases: Array<[unknown, boolean]> = [
    [{ results: [{ messageId: 'm1', accepted: true }] }, true],
    [{ results: [{ messageId: 'm1', accepted: false }] }, false],
    [{ results: [{ messageId: 'another', accepted: true }] }, false],
    [{ accepted: true }, false],
  ];
  for (const [answer, saved] of cases) {
    const first = hostProcess(undefined, answer, { open: true });
    await first.mention(msg('m1', 1));
    assert.equal(first.requests[0].method, 'channels/incoming');
    assert.equal(first.state.wasSent('m1'), saved, JSON.stringify(answer));
  }
});

test('a host catch-up is saved when the host accepts it, and not when it declines', async () => {
  for (const accepted of [true, false]) {
    const next = hostProcess(undefined, { accepted });
    next.control.pending = [msg('m1', 1)];
    await next.internal.catchUp();
    await new Promise((r) => setImmediate(r));
    assert.equal(next.requests.length, 1);
    assert.equal(next.state.wasSent('m1'), accepted);
  }
});

test('a catch-up through a wake sink tells it when every mention was sent before', async () => {
  const m1 = msg('m1', 1);
  const m2 = msg('m2', 2);
  const first = ccProcess();
  first.mention(m1);
  await first.settle();

  for (const pending of [[m1], [m1, m2]]) {
    const { sink, delivered } = recordingSink(async () => {});
    const next = ccProcess(first.state.toJSON(), { wakeSink: sink });
    next.control.pending = pending;
    await next.internal.catchUp();
    await next.settle();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].allSentBefore, pending.length === 1 ? true : undefined);
  }
});

test('the codex wake says the mentions are still pending from an earlier session only when every one was sent before', () => {
  const meta = { catchup: 'true', channelId: CH };
  const earlier: WakePayload = { content: 'x', meta, allSentBefore: true };
  assert.match(renderCodexWake(earlier), /^\[portal\] Messages addressed to you are still pending from an earlier session — reply where each came from with send_message\./);
  assert.match(renderCodexWake({ content: 'x', meta }), /^\[portal\] Messages addressed to you arrived while you were away/);
});
