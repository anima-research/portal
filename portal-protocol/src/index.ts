/**
 * @connectome/portal-protocol
 *
 * The wire contract shared by the portal relay (one Discord bot fronting many
 * webhook personas) and the portal client. Pure types + lightweight guards,
 * no runtime dependencies.
 *
 * Layers that bind to this:
 *   relay   — owns the Discord connection, webhook/role pools, permissions,
 *             and the WS gateway. Speaks ServerFrame.
 *   client  — WS transport + cache + typed RPC. Speaks ClientFrame.
 *   mcpl    — agent-facing state (watermarks, pending pings) over the client.
 */
export * from './version.js';
export * from './ids.js';
export * from './persona.js';
export * from './channel.js';
export * from './message.js';
export * from './members.js';
export * from './events.js';
export * from './rpc.js';
export * from './frames.js';
export * from './guards.js';
