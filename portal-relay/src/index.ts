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
