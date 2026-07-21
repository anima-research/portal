/**
 * WebSocket compatibility layer.
 *
 * PortalClient/enroll only touch a tiny slice of a socket's surface — `WsLike`
 * names it. The Node `ws` WebSocket satisfies it structurally; browsers need
 * the thin wrapper in `ws-browser.ts` (event objects vs bare payloads).
 *
 * The *default* factory is registered by the entry module actually imported
 * (`index.ts` → Node `ws`, `index.browser.ts` → native WebSocket), so the core
 * modules never import `ws` and stay bundleable for the browser.
 */

/** The minimal socket surface the portal client uses. */
export interface WsLike {
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly OPEN: number;
}

export type WsFactory = (url: string) => WsLike;

let defaultFactory: WsFactory | undefined;

/** Called by the package entry (Node or browser) to register its default. */
export function setDefaultWsFactory(factory: WsFactory): void {
  defaultFactory = factory;
}

/** Resolve the factory to use: explicit option wins, else the entry's default. */
export function resolveWsFactory(explicit?: WsFactory): WsFactory {
  const factory = explicit ?? defaultFactory;
  if (!factory) {
    throw new Error(
      "no WebSocket factory available: pass `wsFactory` in options, or import '@animalabs/portal-client' via its package entry (Node or browser) so a default is registered",
    );
  }
  return factory;
}
