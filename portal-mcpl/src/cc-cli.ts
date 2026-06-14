#!/usr/bin/env node
/**
 * portal-cc-channel — stdio entry point for a Claude Code *channel* backed by
 * portal. A new Claude Code instance spawns this; it self-enrolls a tokenless
 * persona through the shared relay bot (no Discord bot token of its own) and
 * surfaces its Discord channels as a push-driven Claude Code channel.
 *
 * Wire it in .mcp.json and launch with:
 *   claude --channels server:portal --dangerously-load-development-channels
 * (the dev flag is required while channels are in research preview; custom
 *  channels aren't on the official allowlist yet.)
 *
 * .mcp.json:
 *   {
 *     "mcpServers": {
 *       "portal": {
 *         "command": "node",
 *         "args": ["/abs/path/portal-mcpl/dist/src/cc-cli.js"],
 *         "env": {
 *           "PORTAL_URL": "ws://127.0.0.1:8790",
 *           "PORTAL_INVITE": "<invite code>",
 *           "PORTAL_PERSONA_NAME": "claude-code",
 *           "PORTAL_SUBSCRIPTIONS": "<chanId>,<chanId>"
 *         }
 *       }
 *     }
 *   }
 *
 * On first run it enrolls and caches credentials at PORTAL_CREDENTIALS
 * (default ~/.portal/cc-channel-creds.json); subsequent runs reuse them, so the
 * persona (and its Discord identity/role) is stable across restarts.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McplConnection } from '@animalabs/mcpl-core';
import { PortalClient, loadOrEnrollCreds } from '@connectome/portal-client';
import { PortalAgent } from './agent.js';
import { PortalCcChannelServer } from './server-cc.js';

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const credsPath =
    process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', 'cc-channel-creds.json');
  const invite = process.env.PORTAL_INVITE;
  const desiredName = process.env.PORTAL_PERSONA_NAME ?? 'claude-code';
  const subscriptions = (process.env.PORTAL_SUBSCRIPTIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Load cached creds or enroll once via the invite template.
  const creds = await loadOrEnrollCreds({ url, credsPath, invite, desiredName });
  console.error(`[portal-cc] persona "${creds.personaId}" via ${url} (creds: ${credsPath})`);

  const client = new PortalClient({
    url,
    token: creds.token,
    personaId: creds.personaId,
    subscriptions,
  });
  const agent = new PortalAgent(client);
  const server = new PortalCcChannelServer(client, agent);

  // Connect in the background; the MCP handshake proceeds regardless so Claude
  // Code's startup isn't blocked by a relay outage.
  client.connect().catch((err) => console.error('[portal-cc] relay connect failed:', err.message));

  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
}

main().catch((err) => {
  console.error('[portal-cc] fatal:', err);
  process.exit(1);
});
