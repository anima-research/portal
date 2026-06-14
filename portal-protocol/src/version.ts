/**
 * Protocol version. Bumped on any breaking change to frames, events, or RPC.
 * The relay sends it in `hello`; clients send it in `identify`. A relay MAY
 * refuse an `identify` whose version it can't speak (→ `invalid_session`,
 * `resumable: false`).
 */
export const PORTAL_PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PORTAL_PROTOCOL_VERSION;
