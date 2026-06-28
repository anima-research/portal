#!/usr/bin/env node
/**
 * Portal relay — CLI entry point.
 *
 * Environment:
 *   DISCORD_TOKEN           Required. The single bot token fronting all personas.
 *   PORTAL_IDENTITY         Required. Path to the identity JSON (id/displayName/avatar/token).
 *   PORTAL_PERMISSIONS      Required. Path to the permissions JSON (per-persona capability policy).
 *   PORTAL_INVITES          Optional. Path to the invites JSON. When set, agents may
 *                           self-register via `register` (invite = access-rights template).
 *   PORTAL_AVATAR_BASE_URL  Base URL for relative persona avatar filenames.
 *   PORTAL_WATCH_CONFIG     Hot-reload identity/permissions on file edit (default true).
 *   PORTAL_ROLE_POOL_SIZE / PORTAL_ROLE_POOL_PREFIX  Per-guild role pool (default 50 / "portal-").
 *   PORTAL_WS_PORT          WS gateway port (default 8790, bound to 127.0.0.1).
 *   PORTAL_WEBHOOK_POOL     Webhooks per hot channel (default 1).
 *   PORTAL_HEARTBEAT_MS     Heartbeat interval (default 30000).
 *   DISCORD_GUILD_ID        Optional comma-separated guild allow-list.
 *   PORTAL_READSTATE        Optional path to persist per-persona read-state
 *                           (watermarks, pending pings, ambient tallies). Enables
 *                           offline catch-up surviving restarts. Tune retention with
 *                           PORTAL_READSTATE_PINGS_CAP (default 500) and
 *                           PORTAL_READSTATE_CHANNELS_CAP (default 1000).
 *
 *   Admin panel / HTTP API (RFC-005) — all gated on PORTAL_ADMIN_ENABLED=true:
 *   PORTAL_ADMIN_ENABLED         Set "true" to enable the admin HTTP API.
 *   PORTAL_ADMIN_PORT            Admin API port, bound to 127.0.0.1 (default 8791).
 *   PORTAL_OAUTH_CLIENT_ID       Discord OAuth2 app client id (required).
 *   PORTAL_OAUTH_CLIENT_SECRET   Discord OAuth2 app client secret (required).
 *   PORTAL_OAUTH_REDIRECT_URI    Exact OAuth redirect URI (required).
 *   PORTAL_ADMIN_POST_LOGIN_URL  Where to send the browser post-login (default "/").
 *   PORTAL_SUPERADMINS           Comma-separated Discord user ids (operator super-admins).
 *   PORTAL_ADMIN_SESSION_TTL_MS  Session TTL in ms (default 1800000 = 30 min).
 *   PORTAL_ADMIN_AUDIT           Append-only audit log path, JSONL (required).
 *   PORTAL_ADMIN_COOKIE_INSECURE Set "true" to drop the cookie Secure flag (local dev only).
 */
import { loadConfig } from './config.js';
import { Relay } from './relay.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const relay = new Relay(config);
  await relay.start();

  const shutdown = () => {
    console.error('[portal-relay] shutting down');
    relay.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[portal-relay] fatal:', err);
  process.exit(1);
});
