/**
 * Browser default WebSocket factory — adapts the native (WHATWG) WebSocket to
 * the Node-`ws`-flavoured `WsLike` surface the client uses.
 *
 * The differences are small but real: browsers deliver payloads wrapped in
 * event objects (`MessageEvent.data`, `CloseEvent.code`) where Node `ws` hands
 * over bare values, and browser error events carry no Error instance.
 */
import type { WsFactory, WsLike } from './ws-compat.js';

/** Structural type for a WHATWG WebSocket (native in browsers/WebViews). */
export interface BrowserWebSocket {
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', cb: (e: { code: number }) => void): void;
  addEventListener(type: 'error', cb: (e: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** Wrap an already-constructed WHATWG WebSocket as a `WsLike`. */
export function wrapBrowserWebSocket(ws: BrowserWebSocket): WsLike {
  return {
    on(event: string, cb: (...args: never[]) => void): void {
      if (event === 'message') {
        ws.addEventListener('message', (e) => (cb as (d: unknown) => void)(e.data));
      } else if (event === 'close') {
        ws.addEventListener('close', (e) => (cb as (c: number) => void)(e.code));
      } else if (event === 'error') {
        // Browser error events are opaque (no Error object, no message).
        ws.addEventListener('error', () => (cb as (e: Error) => void)(new Error('websocket error')));
      }
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
    OPEN: 1, // WebSocket.OPEN per the WHATWG spec
  };
}

/** Default factory for browser/WebView environments: uses the global WebSocket. */
export const browserWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => BrowserWebSocket }).WebSocket;
  if (!Ctor) throw new Error('no global WebSocket constructor in this environment');
  return wrapBrowserWebSocket(new Ctor(url));
};
