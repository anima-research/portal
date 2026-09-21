/**
 * Runtime identity management — mint new portal personas and switch between
 * them from inside a running portal-mcpl process, without restarting it.
 *
 * Why this is its own module: a portal identity is (personaId, token) plus the
 * persona's durable read-state, and everything downstream of it — the
 * PortalClient session, the PortalAgent, the AgentState file — is per-identity.
 * A switch is therefore a *session swap*: build a complete new session, connect
 * it, and only once the relay says `ready` hand it to the MCPL server and retire
 * the old one. A failed switch leaves the old session untouched.
 *
 * Authority is deliberately narrow:
 *   - Switching is limited to this instance's ROSTER: the identity it started
 *     as plus identities it minted itself. It is NOT "any creds file in
 *     ~/.portal" — that directory holds other residents' credentials, and a
 *     tool that could load them would be an impersonation primitive.
 *   - Minting needs an invite (PORTAL_INVITE, or one passed to the tool). The
 *     relay decides what that invite confers; nothing here widens it.
 *   - Tokens never leave this module: tool results carry names and persona ids
 *     only.
 *   - The surface rides its own feature set (`portal.identity`) so an MCPL host
 *     can refuse it, and PORTAL_IDENTITY_SWITCHING=0 turns it off per process.
 *
 * The roster (`<credsDir>/<root>.identities.json`, 0600) holds names, persona
 * ids and creds *paths* — never tokens — plus which identity is active, so a
 * restart comes back as whoever the agent last chose to be rather than silently
 * reverting to the configured name mid-conversation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  enroll as defaultEnroll,
  fileCredsStore,
  type EnrollOptions,
  type PortalClient,
  type PortalCredentials,
} from '@animalabs/portal-client';
import type { PortalAgent } from './agent.js';
import type { PortalFeatureSet } from './feature-sets.js';
import type { ToolDefinition } from './tools.js';

/** Slug a persona name into a safe filename stem / roster key. */
export function slugName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

/** Identity switching is ON by default; PORTAL_IDENTITY_SWITCHING=0 (false/no/off)
 *  turns it off for a process. Shared by both entry points. */
export function identitySwitchingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.PORTAL_IDENTITY_SWITCHING ?? '').trim());
}

/** One live identity: its transport, its agent surface, and how to retire it. */
export interface PortalSession {
  creds: PortalCredentials;
  client: PortalClient;
  agent: PortalAgent;
  /** Flush durable state and close the transport. Idempotent. */
  close(): void;
}

export interface IdentityRecord {
  /** Display name as minted/configured. */
  name: string;
  personaId: string;
  /** Where the creds live; null for a root identity supplied via PORTAL_TOKEN. */
  credsPath: string | null;
  /** The identity this process was configured to start as. */
  root?: boolean;
  mintedAt?: string;
}

interface RosterFile {
  version: 1;
  /** Roster key (slug) of the active identity. */
  active: string;
  identities: Record<string, IdentityRecord>;
}

export interface IdentityManagerOptions {
  url: string;
  /** Directory new creds files are written to (mode 0600). */
  credsDir: string;
  rosterPath: string;
  /** Default invite for minting (PORTAL_INVITE). A tool call may supply its own. */
  invite?: string;
  root: { name: string; creds: PortalCredentials; credsPath: string | null };
  /** Build a complete, NOT yet connected session for the given credentials. */
  createSession: (creds: PortalCredentials) => PortalSession;
  /** Upper bound on roster size — a backstop against a runaway mint loop. */
  maxIdentities?: number;
  connectTimeoutMs?: number;
  /** Test seam. */
  enroll?: (opts: EnrollOptions) => Promise<PortalCredentials>;
}

/** What the MCPL server needs from an identity manager. */
export interface IdentityToolHandler {
  handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export const IDENTITY_FEATURE_SET = 'portal.identity';

/** Declared only by servers that actually have identity switching attached —
 *  a declaration is testimony about what the server does (SPEC §6.1). */
export const identityFeatureSets: Readonly<Record<string, PortalFeatureSet>> = {
  [IDENTITY_FEATURE_SET]: {
    description:
      'Mint new portal personas and switch which persona this connection acts as, without a restart',
    uses: ['tools'],
    rollback: false,
  },
};

export const identityToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_identities',
    description:
      'List the portal identities (personas) available to you — the one you started as plus any ' +
      'you minted — and which one is active right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mint_identity',
    description:
      'Create a NEW portal persona with the given display name and add it to your identities. ' +
      'By default you switch to it immediately; pass switch=false to only create it. The new ' +
      "persona's channel access is whatever the invite grants, which may differ from your current one.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the new persona (1–80 chars)' },
        invite: {
          type: 'string',
          description: 'Invite code to enroll with. Omit to use the one this server was configured with.',
        },
        switch: { type: 'boolean', description: 'Switch to the new identity after minting (default true)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'switch_identity',
    description:
      'Switch which of your identities you act as. Takes effect immediately and persists across ' +
      'restarts. Everything you send afterwards is attributed to the new persona; channels it ' +
      'cannot see are closed, and pings it accrued while inactive are delivered as a catch-up.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name (or persona id) of an identity from list_identities' },
      },
      required: ['name'],
    },
  },
];

export const IDENTITY_TOOL_FEATURE_SETS: Readonly<Record<string, string>> = Object.fromEntries(
  identityToolDefinitions.map((tool) => [tool.name, IDENTITY_FEATURE_SET]),
);

export class IdentityManager implements IdentityToolHandler {
  private roster: RosterFile;
  private current: PortalSession | null = null;
  private onSwitch: ((next: PortalSession) => Promise<void>) | null = null;
  /** Serializes mint/switch — a second call waits rather than interleaving. */
  private busy: Promise<unknown> = Promise.resolve();
  private readonly enrollFn: (opts: EnrollOptions) => Promise<PortalCredentials>;
  private readonly maxIdentities: number;
  private readonly connectTimeoutMs: number;
  private readonly rootKey: string;

  constructor(private readonly opts: IdentityManagerOptions) {
    this.enrollFn = opts.enroll ?? defaultEnroll;
    this.maxIdentities = opts.maxIdentities ?? 12;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
    this.rootKey = slugName(opts.root.name);
    this.roster = this.loadRoster();
  }

  /** The session currently serving tool calls (for signal-time flushing). */
  get session(): PortalSession | null {
    return this.current;
  }

  /**
   * Credentials to start the process as: the roster's active identity when it
   * is still loadable, else the configured root. Never throws — a broken roster
   * entry must not keep the resident offline.
   */
  startupCreds(): PortalCredentials {
    const record = this.roster.identities[this.roster.active];
    if (record && !record.root) {
      try {
        const creds = this.loadCreds(record);
        console.error(`[portal-mcpl] resuming as "${record.name}" (active identity from roster)`);
        return creds;
      } catch (err) {
        console.error(
          `[portal-mcpl] active identity "${record.name}" unusable (${(err as Error).message}); starting as root`,
        );
        this.roster.active = this.rootKey;
        this.saveRoster();
      }
    }
    return this.opts.root.creds;
  }

  /** Attach the live session and the server-side swap hook. */
  bind(session: PortalSession, onSwitch: (next: PortalSession) => Promise<void>): void {
    this.current = session;
    this.onSwitch = onSwitch;
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list_identities':
        return this.describe();
      case 'mint_identity':
        return this.exclusive(() =>
          this.mint(reqStr(args.name, 'name'), optStr(args.invite), args.switch !== false),
        );
      case 'switch_identity':
        return this.exclusive(() => this.switchTo(reqStr(args.name, 'name')));
      default:
        throw new Error(`unknown identity tool ${name}`);
    }
  }

  // ── Operations ──

  private describe(): unknown {
    return {
      active: this.roster.identities[this.roster.active]?.name ?? this.roster.active,
      identities: Object.entries(this.roster.identities).map(([key, record]) => ({
        name: record.name,
        personaId: record.personaId,
        active: key === this.roster.active,
        ...(record.root ? { root: true } : {}),
        ...(record.mintedAt ? { mintedAt: record.mintedAt } : {}),
      })),
      canMintWithoutInvite: Boolean(this.opts.invite),
    };
  }

  private async mint(rawName: string, invite: string | undefined, thenSwitch: boolean): Promise<unknown> {
    const name = rawName.trim();
    if (!name || name.length > 80) throw new Error('name must be 1–80 characters');
    const key = slugName(name);
    if (this.roster.identities[key]) {
      throw new Error(`you already have an identity named "${this.roster.identities[key].name}" — switch to it instead`);
    }
    if (Object.keys(this.roster.identities).length >= this.maxIdentities) {
      throw new Error(`identity limit reached (${this.maxIdentities}); ask an operator to raise PORTAL_IDENTITY_MAX`);
    }
    const credsPath = join(this.opts.credsDir, `${key}.creds.json`);
    // A creds file we did not mint belongs to someone else. loadOrEnrollCreds
    // would silently ADOPT it — exactly the impersonation this module refuses.
    if (existsSync(credsPath)) {
      throw new Error(`the name "${name}" is already taken on this host — choose another`);
    }
    const code = invite ?? this.opts.invite;
    if (!code) throw new Error('no invite available — pass `invite`, or configure PORTAL_INVITE');

    const creds = await this.enrollFn({ url: this.opts.url, invite: code, desiredName: name });
    try {
      // `wx`-equivalent guard was the existsSync above; the store writes 0600.
      await fileCredsStore(credsPath).save(creds);
    } catch (err) {
      // The persona now exists on the relay but we could not keep its token.
      throw new Error(
        `minted persona ${creds.personaId} but failed to save its credentials: ${(err as Error).message}`,
      );
    }
    this.roster.identities[key] = {
      name,
      personaId: creds.personaId,
      credsPath,
      mintedAt: new Date().toISOString(),
    };
    this.saveRoster();
    console.error(`[portal-mcpl] minted identity "${name}" (${creds.personaId})`);

    if (!thenSwitch) return { minted: { name, personaId: creds.personaId }, active: this.activeName() };
    const switched = await this.switchTo(name);
    return { minted: { name, personaId: creds.personaId }, ...(switched as object) };
  }

  private async switchTo(nameOrId: string): Promise<unknown> {
    const found = this.find(nameOrId);
    if (!found) {
      const known = Object.values(this.roster.identities).map((r) => r.name).join(', ');
      throw new Error(`no identity "${nameOrId}" — you have: ${known}`);
    }
    const [key, record] = found;
    if (!this.current || !this.onSwitch) throw new Error('identity switching is not attached to a live session');
    if (this.current.creds.personaId === record.personaId) {
      return { active: record.name, personaId: record.personaId, changed: false };
    }

    const next = this.opts.createSession(this.loadCreds(record));
    try {
      await withTimeout(next.client.connect(), this.connectTimeoutMs, 'relay did not accept the identity in time');
    } catch (err) {
      next.close(); // also stops the client's reconnect loop
      throw new Error(`could not connect as "${record.name}": ${(err as Error).message} — still ${this.activeName()}`);
    }

    // Point of no return: the new session is live. Hand it to the server, then
    // retire the old one (flushes its read-state, closes its socket).
    const previous = this.current;
    this.current = next;
    try {
      await this.onSwitch(next);
    } finally {
      previous.close();
      this.roster.active = key;
      this.saveRoster();
    }
    console.error(`[portal-mcpl] now acting as "${record.name}" (${record.personaId})`);
    return {
      active: record.name,
      personaId: record.personaId,
      changed: true,
      visibleChannels: next.client.cache.allChannels().length,
    };
  }

  // ── Roster ──

  private activeName(): string {
    return this.roster.identities[this.roster.active]?.name ?? this.roster.active;
  }

  private find(nameOrId: string): [string, IdentityRecord] | undefined {
    const wanted = nameOrId.trim();
    const byKey = this.roster.identities[slugName(wanted)];
    if (byKey) return [slugName(wanted), byKey];
    return Object.entries(this.roster.identities).find(([, record]) => record.personaId === wanted);
  }

  private loadCreds(record: IdentityRecord): PortalCredentials {
    if (record.root) return this.opts.root.creds;
    if (!record.credsPath) throw new Error('no credentials path recorded');
    const creds = fileCredsStore(record.credsPath).load() as PortalCredentials | null;
    if (!creds) throw new Error(`credentials missing at ${record.credsPath}`);
    if (creds.personaId !== record.personaId) {
      // The file was replaced underneath us; it is no longer the identity we minted.
      throw new Error(`credentials at ${record.credsPath} are for a different persona`);
    }
    return creds;
  }

  private loadRoster(): RosterFile {
    const rootRecord: IdentityRecord = {
      name: this.opts.root.name,
      personaId: this.opts.root.creds.personaId,
      credsPath: this.opts.root.credsPath,
      root: true,
    };
    let roster: RosterFile = { version: 1, active: this.rootKey, identities: {} };
    try {
      if (existsSync(this.opts.rosterPath)) {
        const parsed = JSON.parse(readFileSync(this.opts.rosterPath, 'utf8')) as Partial<RosterFile>;
        if (parsed.version === 1 && parsed.identities && typeof parsed.identities === 'object') {
          roster = { version: 1, active: String(parsed.active ?? this.rootKey), identities: {} };
          for (const [key, record] of Object.entries(parsed.identities)) {
            if (record && typeof record.name === 'string' && typeof record.personaId === 'string') {
              roster.identities[key] = { ...record, root: false };
            }
          }
        }
      }
    } catch (err) {
      console.error('[portal-mcpl] identity roster unreadable, starting from root only:', (err as Error).message);
    }
    // The root entry always reflects the CURRENT configuration, never the file.
    // A stale entry under the root's key (root renamed / re-enrolled) loses too.
    for (const [key, record] of Object.entries(roster.identities)) {
      if (key === this.rootKey || record.personaId === rootRecord.personaId) delete roster.identities[key];
    }
    roster.identities = { [this.rootKey]: rootRecord, ...roster.identities };
    if (!roster.identities[roster.active]) roster.active = this.rootKey;
    return roster;
  }

  private saveRoster(): void {
    try {
      mkdirSync(dirname(this.opts.rosterPath), { recursive: true });
      const tmp = `${this.opts.rosterPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.roster, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.opts.rosterPath);
    } catch (err) {
      console.error('[portal-mcpl] identity roster write failed:', (err as Error).message);
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }
}

function reqStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required`);
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
