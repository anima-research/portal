/**
 * Browser-entry tests: the WHATWG→ws-like shim and the pluggable creds store.
 *
 * A fake WHATWG WebSocket (addEventListener + event objects, the browser API
 * surface) stands in for the real thing; `globalThis.WebSocket` is pointed at
 * it so the browser entry's *default* factory path is what's exercised —
 * exactly what runs inside a WebView.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The browser entry registers browserWsFactory as the default on import.
import { PortalClient, enroll, loadOrEnroll, webStorageCredsStore } from '../src/index.browser.js';

type Listener = (e: unknown) => void;

/** Minimal WHATWG WebSocket: event objects, addEventListener, readyState. */
class FakeBrowserWs {
  static instances: FakeBrowserWs[] = [];
  static OPEN = 1;
  readyState = 1;
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeBrowserWs.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.dispatch('close', { code: code ?? 1000 });
  }
  // Test helpers: deliver events the way a browser would (wrapped in objects).
  dispatch(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  serverSend(frame: unknown): void {
    this.dispatch('message', { data: JSON.stringify(frame) });
  }
  lastFrame(): { op: string; d: Record<string, unknown> } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function installGlobalWs(): void {
  FakeBrowserWs.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeBrowserWs;
}

test('browser default factory: enroll speaks hello→register→registered via WHATWG events', async () => {
  installGlobalWs();
  const credsPromise = enroll({ url: 'wss://relay.test', invite: 'inv', desiredName: 'glasses' });
  const ws = FakeBrowserWs.instances[0];
  assert.ok(ws, 'socket constructed via globalThis.WebSocket');
  assert.equal(ws.url, 'wss://relay.test');

  ws.serverSend({ op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 30000 } });
  const reg = ws.lastFrame();
  assert.equal(reg.op, 'register');
  assert.equal(reg.d.invite, 'inv');
  assert.equal(reg.d.desiredName, 'glasses');

  ws.serverSend({ op: 'registered', d: { personaId: 'p1', token: 't1', persona: {} } });
  assert.deepEqual(await credsPromise, { personaId: 'p1', token: 't1' });
});

test('loadOrEnroll + webStorageCredsStore: enrolls once, then loads from storage', async () => {
  installGlobalWs();
  const backing = new Map<string, string>();
  const storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  };
  const store = webStorageCredsStore(storage);

  const first = loadOrEnroll(store, { url: 'wss://relay.test', invite: 'inv', desiredName: 'g' });
  // loadOrEnroll awaits store.load() before opening the socket — yield until it has.
  while (FakeBrowserWs.instances.length === 0) await new Promise((r) => setImmediate(r));
  const ws = FakeBrowserWs.instances[0];
  ws.serverSend({ op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 30000 } });
  ws.serverSend({ op: 'registered', d: { personaId: 'p9', token: 't9', persona: {} } });
  assert.deepEqual(await first, { personaId: 'p9', token: 't9' });
  assert.ok(backing.get('portal-credentials')?.includes('p9'), 'persisted to storage');

  // Second call must not open a socket at all.
  const before = FakeBrowserWs.instances.length;
  const second = await loadOrEnroll(store, { url: 'wss://relay.test' });
  assert.deepEqual(second, { personaId: 'p9', token: 't9' });
  assert.equal(FakeBrowserWs.instances.length, before, 'no new connection');
});

test('PortalClient over the browser shim: hello→identify→ready, RPC round-trip, close mapping', async () => {
  installGlobalWs();
  const client = new PortalClient({ url: 'wss://relay.test', token: 'tok', personaId: 'p1' });
  const readyP = client.connect();
  const ws = FakeBrowserWs.instances[0];

  ws.serverSend({ op: 'hello', d: { protocolVersion: 3, heartbeatIntervalMs: 30000 } });
  const identify = ws.lastFrame();
  assert.equal(identify.op, 'identify');
  assert.equal(identify.d.token, 'tok');
  assert.equal(identify.d.personaId, 'p1');

  ws.serverSend({
    op: 'ready',
    d: { sessionId: 's1', seq: 0, persona: { id: 'p1', displayName: 'x', avatarUrl: '' }, guilds: [], channels: [], capabilities: {}, subscriptions: [] },
  });
  await readyP;

  // Typed RPC over the shim: request goes out as a frame, result resolves it.
  const rpcP = client.sendMessage({ channelId: 'c1', content: 'hi from the fake browser' });
  const rpc = ws.lastFrame();
  assert.equal(rpc.op, 'rpc');
  const rpcD = rpc.d as { id: string; method: string };
  assert.equal(rpcD.method, 'send_message');
  ws.serverSend({ op: 'rpc_result', d: { id: rpcD.id, ok: true, result: { messageId: 'm1', channelId: 'c1' } } });
  assert.deepEqual(await rpcP, { messageId: 'm1', channelId: 'c1' });

  // Browser CloseEvent.code must reach the client's close handler as a number.
  const closeInfo = new Promise<{ code: number; willReconnect: boolean }>((r) => client.on('close', r));
  client.close(); // closedByUser → no reconnect
  const info = await closeInfo;
  assert.equal(info.code, 1000);
  assert.equal(info.willReconnect, false);
});
