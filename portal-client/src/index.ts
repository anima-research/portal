/**
 * @connectome/portal-client
 *
 * General-purpose client for the portal relay: WS transport, client-side cache,
 * typed RPC, and transport-level reconnect/resume. No agent semantics — that's
 * portal-mcpl's job.
 */
export { PortalClient } from './client.js';
export type { PortalClientOptions, PortalClientEvents } from './client.js';
export { ClientCache } from './cache.js';
export { TypedEmitter } from './emitter.js';
export { enroll, loadOrEnrollCreds } from './enroll.js';
export type { EnrollOptions, PortalCredentials } from './enroll.js';
