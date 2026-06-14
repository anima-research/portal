#!/usr/bin/env node
/**
 * portal-mcpl stdio entry point — what connectome-host spawns.
 *
 * mcpl-servers.json (connectome-host):
 *   {
 *     "mcplServers": {
 *       "portal": {
 *         "command": "node",
 *         "args": ["/abs/path/portal-mcpl/dist/src/server-cli.js"],
 *         "env": {
 *           "PORTAL_URL": "ws://127.0.0.1:8790",
 *           "PORTAL_TOKEN": "<persona token>",
 *           "PORTAL_PERSONA": "mythos",
 *           "PORTAL_SUBSCRIPTIONS": "<chanId>,<chanId>"
 *         }
 *       }
 *     }
 *   }
 *
 * The relay must be running and reachable at PORTAL_URL.
 */
import { McplConnection } from '@connectome/mcpl-core';
import { PortalClient } from '@connectome/portal-client';
import { PortalAgent } from './agent.js';
import { PortalMcplServer } from './server.js';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[portal-mcpl] ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const token = reqEnv('PORTAL_TOKEN');
  const personaId = reqEnv('PORTAL_PERSONA');
  const subscriptions = (process.env.PORTAL_SUBSCRIPTIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const client = new PortalClient({ url, token, personaId, subscriptions });
  const agent = new PortalAgent(client);
  const server = new PortalMcplServer(client, agent);

  // Connect to the relay in the background; the MCPL handshake can proceed and
  // channels register once `ready` fires. A relay outage degrades to empty
  // channels + failing tool calls rather than blocking the host handshake.
  client.connect().catch((err) => console.error('[portal-mcpl] relay connect failed:', err.message));

  // stdout is the MCPL protocol channel; logs go to stderr.
  console.error(`[portal-mcpl] serving persona "${personaId}" via ${url}`);
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
}

main().catch((err) => {
  console.error('[portal-mcpl] fatal:', err);
  process.exit(1);
});
