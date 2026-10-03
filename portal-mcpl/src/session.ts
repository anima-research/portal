/**
 * One identity's complete session: durable state file, relay client and agent
 * surface. Shared by both entry points (server-cli → MCPL host, cc-cli → Claude
 * Code channel). Everything built here is per-persona, which is why an identity
 * switch (identity.ts) builds a second session rather than mutating the first.
 */
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PortalClient, type PortalCredentials } from '@animalabs/portal-client';
import { PortalAgent, type PortalAgentOptions } from './agent.js';
import { AgentState } from './agent-state.js';
import type { PortalSession } from './identity.js';

export interface BuildSessionOptions {
  url: string;
  /** Default home of `<personaId>.state.json`. */
  stateDir: string;
  /** Explicit state file (PORTAL_STATE) — only meaningful for the root identity. */
  statePath?: string;
  /** One-time subscription seed (PORTAL_SUBSCRIPTIONS), folded into durable state. */
  seedSubscriptions?: string[];
  /** Agent behaviour for this binding; `state` is supplied here. */
  agent?: Omit<PortalAgentOptions, 'state'>;
  logPrefix?: string;
}

/** Build a session. NOT connected — the caller decides when. */
export function buildSession(creds: PortalCredentials, opts: BuildSessionOptions): PortalSession {
  const tag = opts.logPrefix ?? '[portal-mcpl]';
  const statePath = opts.statePath ?? join(opts.stateDir, `${creds.personaId}.state.json`);
  let state: AgentState;
  try {
    state = existsSync(statePath)
      ? AgentState.fromJSON(JSON.parse(readFileSync(statePath, 'utf8')))
      : new AgentState();
  } catch (err) {
    console.error(`${tag} state load failed, starting fresh:`, (err as Error).message);
    state = new AgentState();
  }
  for (const ch of opts.seedSubscriptions ?? []) state.subscribe(ch);

  // Persist on change (debounced), plus a synchronous flush on close.
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = (): void => {
    clearTimeout(writeTimer);
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state.toJSON(), null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`${tag} state write failed:`, (err as Error).message);
    }
  };
  state.onChange(() => {
    if (closed) return; // a retired identity must not keep rewriting its file
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 500);
  });

  const client = new PortalClient({
    url: opts.url,
    token: creds.token,
    personaId: creds.personaId,
    subscriptions: state.subscriptionList(), // identify replays these on (re)connect
  });
  const agent = new PortalAgent(client, { ...opts.agent, state });
  return {
    creds,
    client,
    agent,
    close(): void {
      if (closed) return;
      flush();
      closed = true;
      client.close();
    },
  };
}
