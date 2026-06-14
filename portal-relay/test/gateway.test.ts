import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Gateway, type GatewayHooks, type Session } from '../src/gateway.js';
import type { ReadyData, ServerFrame } from '@connectome/portal-protocol';

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
