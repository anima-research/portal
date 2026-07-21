/**
 * @animalabs/portal-client — browser/WebView entry.
 *
 * Same client, but the default WebSocket factory is the platform-native
 * WHATWG WebSocket (adapted in `ws-browser.ts`) and credential persistence is
 * pluggable (`CredsStore`) instead of the Node fs store. No Node built-ins or
 * `ws` are reachable from this entry, so it bundles cleanly (Vite et al. pick
 * it via the `browser` export condition, or import
 * `@animalabs/portal-client/browser` explicitly).
 */
import { setDefaultWsFactory } from './ws-compat.js';
import { browserWsFactory } from './ws-browser.js';

setDefaultWsFactory(browserWsFactory);

export { PortalClient } from './client.js';
export type { PortalClientOptions, PortalClientEvents } from './client.js';
export { ClientCache } from './cache.js';
export { TypedEmitter } from './emitter.js';
export { enroll, loadOrEnroll, webStorageCredsStore } from './enroll.js';
export type { EnrollOptions, PortalCredentials, CredsStore } from './enroll.js';
export { fileFromBytes } from './files.js';
export { browserWsFactory, wrapBrowserWebSocket } from './ws-browser.js';
export type { BrowserWebSocket } from './ws-browser.js';
export { setDefaultWsFactory } from './ws-compat.js';
export type { WsFactory, WsLike } from './ws-compat.js';
