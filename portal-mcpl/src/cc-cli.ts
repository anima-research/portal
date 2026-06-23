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
 * (default ~/.portal/<persona-name>.creds.json, derived from PORTAL_PERSONA_NAME
 * so distinct names get distinct identities automatically); subsequent runs reuse
 * them, so the persona (and its Discord identity/role) is stable across restarts.
 *
 * Durable agent state (watermarks, pending pings, and channel SUBSCRIPTIONS) is
 * persisted at PORTAL_STATE (default ~/.portal/<personaId>.state.json). Channels
 * subscribed via the in-session tools (subscribe_channel) are saved here and
 * reapplied on every (re)connect — so PORTAL_SUBSCRIPTIONS is just an optional
 * first-run seed, not a per-launch requirement.
 *
 * Attention model: only *addressed* messages (mentions/replies) wake the agent.
 * Ambient messages in subscribed channels accumulate and are folded into the
 * next wake as prepended context (with a first-contact history backfill), capped
 * at PORTAL_CONTEXT_CAP messages (default 80; older are truncated — the agent can
 * fetch_history to scroll back). So the agent sees non-mention traffic without a
 * wake per message and without spending a turn on a fetch tool.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { McplConnection } from '@animalabs/mcpl-core';
import { PortalClient, loadOrEnrollCreds } from '@animalabs/portal-client';
import { PortalAgent } from './agent.js';
import { AgentState } from './agent-state.js';
import { PortalCcChannelServer } from './server-cc.js';

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const desiredName = process.env.PORTAL_PERSONA_NAME ?? 'claude-code';
  // Default creds/state filenames are derived from the persona name, so distinct
  // PORTAL_PERSONA_NAME values get distinct identities without needing an explicit
  // PORTAL_CREDENTIALS. PORTAL_CREDENTIALS still overrides when set.
  const credsPath =
    process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', `${slugName(desiredName)}.creds.json`);
  const invite = process.env.PORTAL_INVITE;
  const subscriptions = (process.env.PORTAL_SUBSCRIPTIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Load cached creds or enroll once via the invite template.
  const creds = await loadOrEnrollCreds({ url, credsPath, invite, desiredName });
  console.error(`[portal-cc] persona "${creds.personaId}" via ${url} (creds: ${credsPath})`);

  // Durable agent state (watermarks + pending pings + subscriptions). Keyed to
  // the persona so it survives restarts; subscriptions managed from inside the
  // session via tools are persisted here and reapplied on (re)connect.
  const statePath =
    process.env.PORTAL_STATE ?? join(dirname(credsPath), `${creds.personaId}.state.json`);
  let state: AgentState;
  try {
    state = existsSync(statePath)
      ? AgentState.fromJSON(JSON.parse(readFileSync(statePath, 'utf8')))
      : new AgentState();
  } catch (err) {
    console.error('[portal-cc] state load failed, starting fresh:', (err as Error).message);
    state = new AgentState();
  }

  // PORTAL_SUBSCRIPTIONS is a one-time seed: fold it into durable state, then the
  // state file is the source of truth from here on.
  for (const ch of subscriptions) state.subscribe(ch);

  // Persist state on change (debounced), plus a synchronous flush on exit.
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(writeTimer);
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state.toJSON(), null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[portal-cc] state write failed:', (err as Error).message);
    }
  };
  state.onChange(() => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 500);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { flush(); process.exit(0); });

  const client = new PortalClient({
    url,
    token: creds.token,
    personaId: creds.personaId,
    subscriptions: state.subscriptionList(), // identify replays these on (re)connect
  });
  const agent = new PortalAgent(client, { state });
  const server = new PortalCcChannelServer(client, agent);

  // Connect in the background; the MCP handshake proceeds regardless so Claude
  // Code's startup isn't blocked by a relay outage.
  client.connect().catch((err) => console.error('[portal-cc] relay connect failed:', err.message));

  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
}

/** Slug a persona name into a safe filename stem. */
function slugName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

main().catch((err) => {
  console.error('[portal-cc] fatal:', err);
  process.exit(1);
});
