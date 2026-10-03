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
 *
 * Runtime identities (on by default; PORTAL_IDENTITY_SWITCHING=0 disables): the
 * `portal.identity` feature set — list_identities / mint_identity /
 * switch_identity — lets the resident mint personas (with PORTAL_INVITE or an
 * invite passed to the tool) and switch between them WITHOUT a restart. The
 * roster lives at PORTAL_IDENTITIES (default <creds-dir>/<name>.identities.json)
 * and remembers the active identity across restarts; PORTAL_IDENTITY_MAX caps
 * its size (default 12). See identity.ts for the authority model.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McplConnection } from '@animalabs/mcpl-core';
import { loadOrEnrollCreds, type PortalCredentials } from '@animalabs/portal-client';
import { fileOptionsFromEnv } from './files.js';
import { PortalMcplServer } from './server.js';
import { IdentityManager, identitySwitchingEnabled, slugName, type PortalSession } from './identity.js';
import { buildSession } from './session.js';

interface RootIdentity {
  name: string;
  creds: PortalCredentials;
  /** null when the identity came from PORTAL_TOKEN/PORTAL_PERSONA. */
  credsPath: string | null;
}

async function resolveRoot(url: string): Promise<RootIdentity> {
  const token = process.env.PORTAL_TOKEN;
  const persona = process.env.PORTAL_PERSONA;
  if (token && persona) {
    return { name: process.env.PORTAL_PERSONA_NAME ?? persona, creds: { personaId: persona, token }, credsPath: null };
  }

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
  const creds = await loadOrEnrollCreds({ url, credsPath, invite, desiredName });
  return { name: desiredName ?? creds.personaId, creds, credsPath };
}

async function main(): Promise<void> {
  const url = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
  const root = await resolveRoot(url);
  const credsDir =
    process.env.PORTAL_CREDENTIALS ? dirname(process.env.PORTAL_CREDENTIALS) : join(homedir(), '.portal');

  // PORTAL_SUBSCRIPTIONS is a bootstrap seed for the CONFIGURED identity. Once
  // the host acknowledges the registration, Chronicle becomes the source of
  // truth for channel lifecycle. PORTAL_STATE likewise names the root's file.
  const seedSubscriptions = (process.env.PORTAL_SUBSCRIPTIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // The MCPL host owns channel lifecycle in Chronicle. Existing file-backed
  // subscriptions are advertised once as `initiallyOpen`, then removed after
  // the host acknowledges channels/register; the remaining state stays local.
  const sessionFor = (creds: PortalCredentials): PortalSession =>
    buildSession(creds, {
      url,
      stateDir: credsDir,
      agent: { hostOwnsChannelLifecycle: true, files: fileOptionsFromEnv() },
      ...(creds.personaId === root.creds.personaId
        ? { statePath: process.env.PORTAL_STATE, seedSubscriptions }
        : {}),
    });

  // Runtime identity minting/switching (default on; PORTAL_IDENTITY_SWITCHING=0
  // disables) lets the resident create Discord-visible personas on its own.
  const identity = identitySwitchingEnabled()
    ? new IdentityManager({
        url,
        credsDir,
        rosterPath:
          process.env.PORTAL_IDENTITIES ?? join(credsDir, `${slugName(root.name)}.identities.json`),
        invite: process.env.PORTAL_INVITE,
        root,
        createSession: sessionFor,
        maxIdentities: Number(process.env.PORTAL_IDENTITY_MAX) || undefined,
      })
    : undefined;

  const session = sessionFor(identity ? identity.startupCreds() : root.creds);
  const server = new PortalMcplServer(session.client, session.agent, { identity });
  identity?.bind(session, (next) => server.swapSession(next.client, next.agent));

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      (identity?.session ?? session).close();
      process.exit(0);
    });
  }

  // Connect to the relay in the background; the MCPL handshake can proceed and
  // channels register once `ready` fires. A relay outage degrades to empty
  // channels + failing tool calls rather than blocking the host handshake.
  session.client.connect().catch((err) => console.error('[portal-mcpl] relay connect failed:', err.message));

  // stdout is the MCPL protocol channel; logs go to stderr.
  console.error(
    `[portal-mcpl] serving persona "${session.creds.personaId}" via ${url}` +
      (identity ? ' (identity switching enabled)' : ''),
  );
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
}

main().catch((err) => {
  console.error('[portal-mcpl] fatal:', err);
  process.exit(1);
});
