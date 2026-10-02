import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Gateway, type GatewayHooks, type Session } from '../src/gateway.js';
import type { ReadyData, ServerFrame } from '@animalabs/portal-protocol';

const PORT = 8799;

function hooks(): GatewayHooks {
  return {
    authenticate: (token, personaId) => (token === 'secret' ? personaId : null),
    buildReady: async (session: Session): Promise<ReadyData> => ({
      sessionId: session.id,
      persona: { id: session.personaId, displayName: 'Test', avatarUrl: '' },
      guilds: [],
      channels: [],
      seq: 0,
    }),
    handleRpc: async (session, req) => {
      session.send({ op: 'rpc_result', d: { id: req.id, ok: true, result: { echo: req.method } } });
    },
  };
}

/** Collects server frames; `next(pred)` resolves with the first match. */
class Frames {
  private queue: ServerFrame[] = [];
  private waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
  constructor(ws: WebSocket) {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(f);
      else this.queue.push(f);
    });
  }
  next(pred: (f: ServerFrame) => boolean, timeoutMs = 2000): Promise<ServerFrame> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }
}

/** Open a socket, attaching the frame listener BEFORE 'open' so the immediate
 *  `hello` frame is never missed. */
async function open(): Promise<{ ws: WebSocket; frames: Frames }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const frames = new Frames(ws);
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, frames };
}

test('handshake, rpc, dispatch, and resume', async () => {
  const gw = new Gateway(hooks(), 30_000);
  gw.listen(PORT);
  try {
    // 1) connect → hello → identify → ready
    const { ws: ws1, frames: f1 } = await open();
    await f1.next((f) => f.op === 'hello');
    ws1.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 1, token: 'secret', personaId: 'p1' } }));
    const ready = (await f1.next((f) => f.op === 'ready')) as Extract<ServerFrame, { op: 'ready' }>;
    const sessionId = ready.d.sessionId;

    // 2) rpc round-trip
    ws1.send(JSON.stringify({ op: 'rpc', d: { id: 'r1', method: 'list_guilds', params: {} } }));
    const res = (await f1.next((f) => f.op === 'rpc_result')) as Extract<ServerFrame, { op: 'rpc_result' }>;
    assert.ok(res.d.ok);

    // 3) dispatch fans out with a seq
    gw.dispatch('p1', { type: 'message_delete', channelId: 'c1', messageId: 'm1' });
    const disp = (await f1.next((f) => f.op === 'dispatch')) as Extract<ServerFrame, { op: 'dispatch' }>;
    assert.equal(disp.seq, 1);

    // 4) drop, dispatch while away, then resume from seq 1 → replays the missed event
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));
    gw.dispatch('p1', { type: 'message_delete', channelId: 'c1', messageId: 'm2' });

    const { ws: ws2, frames: f2 } = await open();
    await f2.next((f) => f.op === 'hello');
    ws2.send(JSON.stringify({ op: 'resume', d: { sessionId, seq: 1 } }));
    const replayed = (await f2.next((f) => f.op === 'dispatch')) as Extract<ServerFrame, { op: 'dispatch' }>;
    assert.equal(replayed.seq, 2);
    const resumed = (await f2.next((f) => f.op === 'resumed')) as Extract<ServerFrame, { op: 'resumed' }>;
    assert.equal(resumed.d.replayedEvents, 1);
    ws2.close();
  } finally {
    await gw.close();
  }
});

test('register: enroll mints creds, then ready; disabled when no enroll hook', async () => {
  const PORT2 = PORT + 1;

  // (a) enroll hook present → register returns `registered` then `ready`.
  const withEnroll: GatewayHooks = {
    ...hooks(),
    enroll: async (d) => {
      if (d.invite !== 'good') return { error: 'invite unknown' };
      return {
        personaId: 'minted-1',
        token: 'tok-1',
        persona: { id: 'minted-1', displayName: d.desiredName, avatarUrl: '' },
      };
    },
  };
  const gw = new Gateway(withEnroll, 30_000);
  gw.listen(PORT2);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
    const frames = new Frames(ws);
    await new Promise<void>((r) => ws.on('open', () => r()));
    await frames.next((f) => f.op === 'hello');
    ws.send(JSON.stringify({ op: 'register', d: { protocolVersion: 1, invite: 'good', desiredName: 'Claude Code' } }));
    const reg = (await frames.next((f) => f.op === 'registered')) as Extract<ServerFrame, { op: 'registered' }>;
    assert.equal(reg.d.personaId, 'minted-1');
    assert.equal(reg.d.token, 'tok-1');
    const ready = (await frames.next((f) => f.op === 'ready')) as Extract<ServerFrame, { op: 'ready' }>;
    assert.equal(ready.d.persona.id, 'minted-1');

    // minted session is identified → RPC works immediately
    ws.send(JSON.stringify({ op: 'rpc', d: { id: 'r1', method: 'list_guilds', params: {} } }));
    const res = (await frames.next((f) => f.op === 'rpc_result')) as Extract<ServerFrame, { op: 'rpc_result' }>;
    assert.ok(res.d.ok);

    // bad invite → invalid_session
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT2}`);
    const f2 = new Frames(ws2);
    await new Promise<void>((r) => ws2.on('open', () => r()));
    await f2.next((f) => f.op === 'hello');
    ws2.send(JSON.stringify({ op: 'register', d: { protocolVersion: 1, invite: 'bad', desiredName: 'x' } }));
    const bad = (await f2.next((f) => f.op === 'invalid_session')) as Extract<ServerFrame, { op: 'invalid_session' }>;
    assert.match(bad.d.reason, /invite unknown/);
    ws.close();
    ws2.close();
  } finally {
    await gw.close();
  }

  // (b) no enroll hook → registration disabled.
  const gw2 = new Gateway(hooks(), 30_000);
  gw2.listen(PORT2);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
    const frames = new Frames(ws);
    await new Promise<void>((r) => ws.on('open', () => r()));
    await frames.next((f) => f.op === 'hello');
    ws.send(JSON.stringify({ op: 'register', d: { protocolVersion: 1, invite: 'good', desiredName: 'x' } }));
    const disabled = (await frames.next((f) => f.op === 'invalid_session')) as Extract<ServerFrame, { op: 'invalid_session' }>;
    assert.match(disabled.d.reason, /registration disabled/);
    ws.close();
  } finally {
    await gw2.close();
  }
});

test('resume past the buffer window is rejected → client falls back to fresh identify', async () => {
  const gw = new Gateway(hooks(), 30_000);
  const port = PORT + 1;
  gw.listen(port);
  try {
    const wsA = new WebSocket(`ws://127.0.0.1:${port}`);
    const fA = new Frames(wsA);
    await new Promise<void>((resolve) => wsA.on('open', () => resolve()));
    await fA.next((f) => f.op === 'hello');
    wsA.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 1, token: 'secret', personaId: 'pg' } }));
    const ready = (await fA.next((f) => f.op === 'ready')) as Extract<ServerFrame, { op: 'ready' }>;
    const sessionId = ready.d.sessionId;
    wsA.close();
    await new Promise<void>((resolve) => wsA.on('close', () => resolve()));

    // Overflow the bounded buffer while the session is away: events 1..1005,
    // of which only 6..1005 remain buffered.
    for (let i = 0; i < 1005; i++) {
      gw.dispatch('pg', { type: 'pins_update', channelId: `c${i}` } as never);
    }

    // Resume from seq 0 — events 1..5 are unrecoverable; a silent partial
    // replay would leave the client convinced it is current. Must reject.
    const wsB = new WebSocket(`ws://127.0.0.1:${port}`);
    const fB = new Frames(wsB);
    await new Promise<void>((resolve) => wsB.on('open', () => resolve()));
    await fB.next((f) => f.op === 'hello');
    wsB.send(JSON.stringify({ op: 'resume', d: { sessionId, seq: 0 } }));
    const rejected = (await fB.next((f) => f.op === 'invalid_session')) as Extract<
      ServerFrame,
      { op: 'invalid_session' }
    >;
    assert.equal(rejected.d.resumable, false);

    // From inside the window the same session resumes fine (seq 1000 → 5 replays).
    wsB.send(JSON.stringify({ op: 'resume', d: { sessionId, seq: 1000 } }));
    const resumed = (await fB.next((f) => f.op === 'resumed')) as Extract<ServerFrame, { op: 'resumed' }>;
    assert.equal(resumed.d.replayedEvents, 5);
    wsB.close();
  } finally {
    await gw.close();
  }
});


test('ephemeral dispatch: fans out live, never sequenced, never replayed', async () => {
  const gw = new Gateway(hooks(), 30_000);
  gw.listen(PORT);
  try {
    const { ws: ws1, frames: f1 } = await open();
    await f1.next((f) => f.op === 'hello');
    ws1.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p1' } }));
    const ready = (await f1.next((f) => f.op === 'ready')) as Extract<ServerFrame, { op: 'ready' }>;
    const sessionId = ready.d.sessionId;

    // A partial fans out on the ephemeral op with no seq…
    const partial = {
      type: 'voice_transcript' as const,
      channelId: 'c1', guildId: 'g1', utteranceId: 'u1',
      speaker: { kind: 'user' as const, userId: 'u', username: 'antra', displayName: 'antra', bot: false },
      text: 'hel', partial: true, startedAt: 1, at: 2,
    };
    gw.dispatchEphemeral('p1', partial);
    const eph = (await f1.next((f) => f.op === 'dispatch_ephemeral')) as Extract<ServerFrame, { op: 'dispatch_ephemeral' }>;
    assert.equal((eph.d as typeof partial).text, 'hel');
    assert.ok(!('seq' in eph), 'ephemeral frames carry no seq');

    // …and the durable final is seq 1: the partial consumed nothing.
    gw.dispatch('p1', { ...partial, text: 'hello there', partial: false });
    const fin = (await f1.next((f) => f.op === 'dispatch')) as Extract<ServerFrame, { op: 'dispatch' }>;
    assert.equal(fin.seq, 1);

    // Resume from 0 replays exactly the final — partials are gone by design.
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));
    const { ws: ws2, frames: f2 } = await open();
    await f2.next((f) => f.op === 'hello');
    ws2.send(JSON.stringify({ op: 'resume', d: { sessionId, seq: 0 } }));
    const replayed = (await f2.next((f) => f.op === 'dispatch')) as Extract<ServerFrame, { op: 'dispatch' }>;
    assert.equal(replayed.seq, 1);
    assert.equal((replayed.d as typeof partial).partial, false);
    const resumed = (await f2.next((f) => f.op === 'resumed')) as Extract<ServerFrame, { op: 'resumed' }>;
    assert.equal(resumed.d.replayedEvents, 1);
    ws2.close();
  } finally {
    await gw.close();
  }
});

test('session lifecycle is logged: identify timing, auth reject, resume, close, failed ready', async () => {
  const lines: string[] = [];
  let failReady = false;
  const h = hooks();
  const baseReady = h.buildReady;
  h.buildReady = async (s) => {
    if (failReady) throw new Error('discord unavailable');
    return baseReady(s);
  };
  const gw = new Gateway(h, 30_000, { log: (l) => lines.push(l) });
  gw.listen(PORT);
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  /** Close events arrive asynchronously; wait for the line instead of sleeping. */
  const until = async (re: RegExp, extra?: () => boolean): Promise<void> => {
    const t0 = Date.now();
    while (!(has(re) && (!extra || extra()))) {
      if (Date.now() - t0 > 2000) assert.fail(`no line matching ${re}:\n${lines.join('\n')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    // identify → one line with ready time, persona, and the live count
    const { ws: ws1, frames: f1 } = await open();
    await f1.next((f) => f.op === 'hello');
    ws1.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p1' } }));
    const ready = (await f1.next((f) => f.op === 'ready')) as Extract<ServerFrame, { op: 'ready' }>;
    assert.ok(has(/session identify persona=p1 sess=\S+ ready-ms=\d+ since-connect-ms=\d+ channels=0 subs=0 live=1\/1/), lines.join('\n'));

    // close → code and age, live count back to zero
    ws1.close(1000, 'bye');
    await until(/session close persona=p1 .*code=1000 reason="bye" age-s=\d+ live=0\/0/);
    assert.equal(lines.filter((l) => / close /.test(l)).length, 1, 'one close line per socket');

    // resume → replay count
    const { ws: ws2, frames: f2 } = await open();
    await f2.next((f) => f.op === 'hello');
    ws2.send(JSON.stringify({ op: 'resume', d: { sessionId: ready.d.sessionId, seq: 0 } }));
    await f2.next((f) => f.op === 'resumed');
    assert.ok(has(/session resume persona=p1 .*replayed=0/), lines.join('\n'));
    ws2.close();

    // unknown resume + bad auth → rejected lines; the claimed id is sanitized and no token is logged
    const { ws: ws3, frames: f3 } = await open();
    await f3.next((f) => f.op === 'hello');
    ws3.send(JSON.stringify({ op: 'resume', d: { sessionId: 'sess_nope', seq: 0 } }));
    await f3.next((f) => f.op === 'invalid_session');
    assert.ok(has(/session resume-rejected persona=- .*reason="unknown session"/), lines.join('\n'));
    ws3.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'WRONG-TOKEN', personaId: 'evil\n[portal-relay] forged' } }));
    await f3.next((f) => f.op === 'invalid_session');
    assert.ok(has(/session identify-rejected persona=- .*claimed="evil\?\[portal-relay\] forged" reason="auth failed"/), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('\n')), 'one event, one line');
    // auth failure closes the socket; its close line carries the rejection count
    await until(/session close-unidentified persona=- .*code=4001 reason="auth failed" rejections=2 age-s=\d+/);

    // a `"` in a client string is escaped, so it can't pose as extra fields
    const { ws: ws3b, frames: f3b } = await open();
    await f3b.next((f) => f.op === 'hello');
    ws3b.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'x', personaId: 'a" live=9/9 b' } }));
    await f3b.next((f) => f.op === 'invalid_session');
    assert.ok(has(/claimed="a\\" live=9\/9 b" reason="auth failed"/), lines.join('\n'));

    // pre-auth rejections that leave the socket open are capped: 3 lines, the rest only counted on the close line
    const { ws: ws3c, frames: f3c } = await open();
    await f3c.next((f) => f.op === 'hello');
    for (let i = 0; i < 12; i++) {
      ws3c.send(JSON.stringify({ op: 'resume', d: { sessionId: `sess_nope${i}`, seq: 0 } }));
      await f3c.next((f) => f.op === 'invalid_session');
    }
    const before = lines.length;
    ws3c.close();
    await until(/ close-unidentified .*rejections=12 age-s=\d+/, () => lines.slice(before).some((l) => / close-unidentified /.test(l)));
    const closeLine = lines.slice(before).find((l) => / close-unidentified /.test(l))!;
    const sess = closeLine!.match(/sess=(\S+)/)![1];
    assert.equal(lines.filter((l) => l.includes(`sess=${sess}`) && / resume-rejected /.test(l)).length, 3, 'rejection lines capped per socket');
    assert.ok(!lines.some((l) => l.includes('WRONG-TOKEN') || l.includes('secret')), 'tokens never reach the log');

    // buildReady throws → logged, and the socket is closed instead of left waiting for ready
    failReady = true;
    const { ws: ws4, frames: f4 } = await open();
    await f4.next((f) => f.op === 'hello');
    const closed = new Promise<number>((resolve) => ws4.on('close', (code) => resolve(code)));
    ws4.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p2' } }));
    assert.equal(await closed, 1011);
    assert.ok(has(/session identify-failed persona=p2 .*ready-ms=\d+ error="discord unavailable"/), lines.join('\n'));

    // Wait for the server-side close log too: the client close above can
    // arrive first, and that late line belongs to gw, not the throwing sink.
    await until(/session close persona=p2 .*code=1011/);

    // a throwing log sink neither kills the session nor skips the 1011 close
    const sinkLines = lines.length;
    const gwThrow = new Gateway(h, 30_000, { log: () => { throw new Error('sink down'); } });
    gwThrow.listen(PORT + 1);
    try {
      const ws5 = new WebSocket(`ws://127.0.0.1:${PORT + 1}`);
      const f5 = new Frames(ws5);
      await new Promise<void>((resolve) => ws5.on('open', () => resolve()));
      await f5.next((f) => f.op === 'hello');
      const closed5 = new Promise<number>((resolve) => ws5.on('close', (code) => resolve(code)));
      ws5.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p3' } }));
      assert.equal(await closed5, 1011);
      failReady = false;
      const ws6 = new WebSocket(`ws://127.0.0.1:${PORT + 1}`);
      const f6 = new Frames(ws6);
      await new Promise<void>((resolve) => ws6.on('open', () => resolve()));
      await f6.next((f) => f.op === 'hello');
      ws6.send(JSON.stringify({ op: 'identify', d: { protocolVersion: 4, token: 'secret', personaId: 'p3' } }));
      await f6.next((f) => f.op === 'ready');
      ws6.close();
    } finally {
      await gwThrow.close();
    }
    assert.equal(lines.length, sinkLines, 'throwing sink produced no lines and no crash');
  } finally {
    await gw.close();
  }
});
