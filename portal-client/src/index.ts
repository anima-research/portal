/**
 * @animalabs/portal-client
 *
 * General-purpose client for the portal relay: WS transport, client-side cache,
 * typed RPC, and transport-level reconnect/resume. No agent semantics — that's
 * portal-mcpl's job.
 *
 * This is the Node entry: it registers Node `ws` as the default WebSocket
 * factory and exports the fs-backed credential store. Browser/WebView code
 * gets `./index.browser.ts` instead (via the `browser` export condition or the
 * `/browser` subpath).
 */
import { setDefaultWsFactory } from './ws-compat.js';
import { nodeWsFactory } from './ws-node.js';

setDefaultWsFactory(nodeWsFactory);

export { PortalClient } from './client.js';
export type { PortalClientOptions, PortalClientEvents } from './client.js';
export { ClientCache } from './cache.js';
export { TypedEmitter } from './emitter.js';
export { enroll, loadOrEnroll, webStorageCredsStore } from './enroll.js';
export type { EnrollOptions, PortalCredentials, CredsStore } from './enroll.js';
export { fileCredsStore, loadOrEnrollCreds } from './creds-node.js';
export { fileFromBytes } from './files.js';
export { nodeWsFactory } from './ws-node.js';
export { setDefaultWsFactory } from './ws-compat.js';
export type { WsFactory, WsLike } from './ws-compat.js';
