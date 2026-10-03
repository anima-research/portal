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
 * Wake transport: Claude Code's channel notification by default. PORTAL_WAKE=codex
 * instead queues the wake as a user turn into a running codex session (`codex
 * queue`), targeting the thread named in the PORTAL_WAKE_FILE sidecar (default
 * ~/.portal/<personaId>.wake.json, written by the launcher) — see wake-sink.ts.
 *
 * Public-activity beacon: every post/reaction/edit this persona makes touches
 * ~/.portal/<personaId>.activity (PORTAL_ACTIVITY_FILE), so a supervisor that
 * only subscribes to a few channels can still tell an active hand from an idle one.
 *
 * Attention model: only *addressed* messages (mentions/replies) wake the agent.
 * Ambient messages in subscribed channels accumulate and are folded into the
 * next wake as prepended context (with a first-contact history backfill), capped
 * at PORTAL_CONTEXT_CAP messages (default 80; older are truncated — the agent can
 * fetch_history to scroll back). So the agent sees non-mention traffic without a
 * wake per message and without spending a turn on a fetch tool.
 *
 * Runtime identities (on by default; PORTAL_IDENTITY_SWITCHING=0 disables):
 * list_identities / mint_identity / switch_identity let the session mint personas (with
 * PORTAL_INVITE or an invite passed to the tool) and switch between them WITHOUT
 * restarting Claude Code. See identity.ts for the authority model. The activity
 * beacon and the wake sink stay keyed to the CONFIGURED persona across switches:
 * both describe this host process to whoever launched it (cc-spawner watches
 * <personaId>.activity and writes <personaId>.wake.json for the id it spawned).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { McplConnection } from '@animalabs/mcpl-core';
import { loadOrEnrollCreds, type PortalCredentials } from '@animalabs/portal-client';
import { fileOptionsFromEnv } from './files.js';
import { IdentityManager, identitySwitchingEnabled, slugName, type PortalSession } from './identity.js';
import { PortalCcChannelServer } from './server-cc.js';
import { buildSession } from './session.js';
import { wakeSinkFromEnv } from './wake-sink.js';

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const desiredName = process.env.PORTAL_PERSONA_NAME ?? 'claude-code';
  // Default creds/state filenames are derived from the persona name, so distinct
  // PORTAL_PERSONA_NAME values get distinct identities without needing an explicit
  // PORTAL_CREDENTIALS. PORTAL_CREDENTIALS still overrides when set.
  const credsPath =
    process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', `${slugName(desiredName)}.creds.json`);
  const credsDir = dirname(credsPath);
  const invite = process.env.PORTAL_INVITE;
  // PORTAL_SUBSCRIPTIONS is a one-time seed for the configured identity: folded
  // into durable state, after which the state file is the source of truth.
  const seedSubscriptions = (process.env.PORTAL_SUBSCRIPTIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Load cached creds or enroll once via the invite template.
  const rootCreds = await loadOrEnrollCreds({ url, credsPath, invite, desiredName });
  console.error(`[portal-cc] persona "${rootCreds.personaId}" via ${url} (creds: ${credsPath})`);

  // Host-process artefacts — keyed to the CONFIGURED persona on purpose (see
  // the header): whoever launched us knows us by that id, whoever we act as.
  const rootStateDir = process.env.PORTAL_STATE ? dirname(process.env.PORTAL_STATE) : credsDir;
  // Public-activity beacon (throttled; the reader only cares about mtime).
  const activityPath =
    process.env.PORTAL_ACTIVITY_FILE ?? join(rootStateDir, `${rootCreds.personaId}.activity`);
  let lastBeacon = 0;
  const onPublicActivity = (): void => {
    const now = Date.now();
    if (now - lastBeacon < 5_000) return;
    lastBeacon = now;
    try {
      writeFileSync(activityPath, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('[portal-cc] activity beacon write failed:', (err as Error).message);
    }
  };
  const wakeSink = wakeSinkFromEnv(process.env, { stateDir: rootStateDir, personaId: rootCreds.personaId });
  if (wakeSink) console.error(`[portal-cc] wake sink: ${wakeSink.kind}`);

  // Durable agent state (watermarks + pending pings + subscriptions) is keyed
  // to the persona, so each identity keeps its own across switches and restarts.
  const sessionFor = (creds: PortalCredentials): PortalSession =>
    buildSession(creds, {
      url,
      stateDir: credsDir,
      logPrefix: '[portal-cc]',
      agent: { files: fileOptionsFromEnv(), onPublicActivity },
      ...(creds.personaId === rootCreds.personaId
        ? { statePath: process.env.PORTAL_STATE, seedSubscriptions }
        : {}),
    });

  const identity = identitySwitchingEnabled()
    ? new IdentityManager({
        url,
        credsDir,
        rosterPath: process.env.PORTAL_IDENTITIES ?? join(credsDir, `${slugName(desiredName)}.identities.json`),
        invite,
        root: { name: desiredName, creds: rootCreds, credsPath },
        createSession: sessionFor,
        maxIdentities: Number(process.env.PORTAL_IDENTITY_MAX) || undefined,
      })
    : undefined;

  const session = sessionFor(identity ? identity.startupCreds() : rootCreds);
  const server = new PortalCcChannelServer(session.client, session.agent, { wakeSink, identity });
  identity?.bind(session, (next) => server.swapSession(next.client, next.agent));
  if (identity) console.error(`[portal-cc] identity switching enabled (acting as ${session.creds.personaId})`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      (identity?.session ?? session).close();
      process.exit(0);
    });
  }

  // Connect in the background; the MCP handshake proceeds regardless so Claude
  // Code's startup isn't blocked by a relay outage.
  session.client.connect().catch((err) => console.error('[portal-cc] relay connect failed:', err.message));

  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
}

main().catch((err) => {
  console.error('[portal-cc] fatal:', err);
  process.exit(1);
});
