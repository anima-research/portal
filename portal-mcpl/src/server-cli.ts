#!/usr/bin/env node
/**
 * portal-mcpl stdio entry point — what connectome-host spawns.
 *
 * Credentials (either path):
 *   - Explicit:   PORTAL_TOKEN + PORTAL_PERSONA (persona id). No enrollment.
 *   - Self-enroll: PORTAL_INVITE + PORTAL_PERSONA_NAME — enrolls a webhook
 *                  persona on first run and caches creds at PORTAL_CREDENTIALS
 *                  (default ~/.portal/<persona-name>.creds.json); later runs reuse
 *                  them, so the identity is stable across restarts.
 *
 * Durable agent state (watermarks + pending pings + channel SUBSCRIPTIONS) is
 * persisted at PORTAL_STATE (default <creds-dir>/<personaId>.state.json) — the
 * portal analogue of discord-mcpl's subscriptions/watermark files. Subscriptions
 * made via tools are reapplied on every (re)connect, so PORTAL_SUBSCRIPTIONS is
 * just an optional first-run seed.
 *
 * connectome-host recipe (mcpServers entry):
 *   "portal": {
 *     "command": "node",
 *     "args": ["/abs/path/portal-mcpl/dist/src/server-cli.js"],
 *     "env": {
 *       "PORTAL_URL": "wss://portal.animalabs.ai",
 *       "PORTAL_INVITE": "<invite code>",
 *       "PORTAL_PERSONA_NAME": "Lena46",
 *       "PORTAL_SUBSCRIPTIONS": "<chanId>,<chanId>"
 *     },
 *     "channelSubscription": "auto",
 *     "enabledFeatureSets": ["portal.*"]
 *   }
 *
 * The relay must be reachable at PORTAL_URL.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { McplConnection } from '@animalabs/mcpl-core';
import { PortalClient, loadOrEnrollCreds } from '@animalabs/portal-client';
import { PortalAgent } from './agent.js';
import { AgentState } from './agent-state.js';
import { PortalMcplServer } from './server.js';

/** Slug a persona name into a safe filename stem. */
function slugName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

async function resolveCreds(url: string): Promise<{ personaId: string; token: string }> {
  const token = process.env.PORTAL_TOKEN;
  const persona = process.env.PORTAL_PERSONA;
  if (token && persona) return { personaId: persona, token };

  // Self-enroll path (cached → reused; idempotent).
  const desiredName = process.env.PORTAL_PERSONA_NAME;
  const invite = process.env.PORTAL_INVITE;
  const credsPath =
    process.env.PORTAL_CREDENTIALS ??
    (desiredName ? join(homedir(), '.portal', `${slugName(desiredName)}.creds.json`) : undefined);
  if (!credsPath) {
    console.error('[portal-mcpl] need PORTAL_TOKEN+PORTAL_PERSONA, or PORTAL_PERSONA_NAME(+PORTAL_INVITE)');
    process.exit(1);
  }
  return loadOrEnrollCreds({ url, credsPath, invite, desiredName });
}

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const { personaId, token } = await resolveCreds(url);

  // Durable agent state (watermarks + pending pings + subscriptions). Keyed to
  // the persona so it survives restarts. The relay is now authoritative for
  // read-state, but local subscriptions still drive what ambient traffic the
  // relay delivers — so we persist + reapply them on every (re)connect.
  const credsDir =
    process.env.PORTAL_CREDENTIALS ? dirname(process.env.PORTAL_CREDENTIALS) : join(homedir(), '.portal');
  const statePath = process.env.PORTAL_STATE ?? join(credsDir, `${personaId}.state.json`);
  let state: AgentState;
  try {
    state = existsSync(statePath)
      ? AgentState.fromJSON(JSON.parse(readFileSync(statePath, 'utf8')))
      : new AgentState();
  } catch (err) {
    console.error('[portal-mcpl] state load failed, starting fresh:', (err as Error).message);
    state = new AgentState();
  }

  // PORTAL_SUBSCRIPTIONS is a one-time seed; the state file is the source of truth after.
  for (const ch of (process.env.PORTAL_SUBSCRIPTIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    state.subscribe(ch);
  }

  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(writeTimer);
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state.toJSON(), null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[portal-mcpl] state write failed:', (err as Error).message);
    }
  };
  state.onChange(() => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 500);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { flush(); process.exit(0); });

  const client = new PortalClient({ url, token, personaId, subscriptions: state.subscriptionList() });
  const agent = new PortalAgent(client, { state });
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
