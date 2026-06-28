/**
 * Protocol version. Bumped on any breaking change to frames, events, or RPC.
 * The relay sends it in `hello`; clients send it in `identify`. A relay MAY
 * refuse an `identify` whose version it can't speak (→ `invalid_session`,
 * `resumable: false`).
 */
// v2 (RFC-005): additive `claim_invite` + `rotate_token` RPC methods. Backward
// compatible — older clients simply never call them; the relay does not refuse a
// lower client version.
// v3: additive server-authoritative read-state RPC — `get_pending_pings`,
// `list_unread`, `mark_read`, `channel_missed`. Same compatibility contract:
// older clients never call them; the relay still accepts lower client versions.
export const PORTAL_PROTOCOL_VERSION = 3 as const;

export type ProtocolVersion = typeof PORTAL_PROTOCOL_VERSION;
