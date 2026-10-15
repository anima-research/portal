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
 *   - Switching is limited to this instance's ROSTER FILE — in practice the
 *     identity it started as plus identities it minted itself, because only
 *     mint writes to it. The roster is the trust root: whoever can edit that
 *     file can point a record at another resident's creds path (same-user
 *     file integrity, not a boundary we hold). The tools themselves never
 *     widen it — there is no "load any creds file in ~/.portal", because that
 *     directory holds other residents' credentials and a tool that could load
 *     them would be an impersonation primitive.
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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
import { TOOL_CLASS_META_KEY } from './tool-classes.js';

/** Slug a persona name into a safe filename stem / roster key. */
export function slugName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

/** Whether a process is alive (EPERM: alive, just not ours to signal). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reserve a creds file for a mint with an exclusive create. The reservation
 * names its process, so one left behind by a process that died mid-enroll (or
 * older than any enrollment) is taken over rather than blocking the name for
 * good. Anything else already there is someone's creds file: false.
 */
function reserveCredsFile(path: string): boolean {
  const mark = () => JSON.stringify({ reserving: true, pid: process.pid, at: new Date().toISOString() }) + '\n';
  // Under the directory's mint lock: the check that a reservation is abandoned
  // and its replacement happen as one step, so two processes can't both take
  // over the same one (the second deleting the first's fresh reservation and
  // both going on to save credentials into one file).
  let reserved = false;
  withFileLock(join(dirname(path), '.mint.lock'), 'credentials directory', () => {
    // (held for a write or two — a short wait is plenty)
    try {
      writeFileSync(path, mark(), { flag: 'wx', mode: 0o600 });
      reserved = true;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let held: { reserving?: boolean; pid?: number; at?: string } | null = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    const abandoned =
      held?.reserving === true &&
      ((typeof held.pid === 'number' && !pidAlive(held.pid)) ||
        (typeof held.at === 'string' && Date.now() - Date.parse(held.at) > 10 * 60_000));
    if (!abandoned) return;
    unlinkSync(path);
    writeFileSync(path, mark(), { flag: 'wx', mode: 0o600 });
    reserved = true;
  }, 2000);
  return reserved;
}

/**
 * Run `fn` holding an exclusive lock file. The file names its holder's pid,
 * so a lock whose process has died is taken over at once (and one older than
 * 10s — longer than any holder keeps it — regardless). Throws after
 * `waitMs` if a live process keeps holding it.
 */
export function withFileLock(lock: string, what: string, fn: () => void, waitMs = 5000): void {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const holder = Number(readFileSync(lock, 'utf8').trim());
        if ((holder > 0 && !pidAlive(holder)) || Date.now() - statSync(lock).mtimeMs > 10_000) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the read
      }
      if (Date.now() > deadline) throw new Error(`the ${what} is locked by another process`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
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

/** The MCPL feature set name is a wire contract hosts grant by, so it keeps
 *  its original name even though the tools now speak of personas. */
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

/** RFC-008: identity tools change who this connection IS — a control-plane
 *  act with no message content in or out — so they are `control`. They live
 *  outside tool-classes.ts's table because that table is checked against the
 *  base surface; the class is stamped here instead. */
const CONTROL = { [TOOL_CLASS_META_KEY]: ['control'] };

/**
 * The persona tools. Portal has one kind of speaker — a persona — and these
 * tools manage the personas this process holds credentials for. (They were
 * `*_identity` until 2026-10-15; those names are still accepted, see
 * LEGACY_TOOL_NAMES, but no longer advertised.)
 */
export const identityToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_personas',
    _meta: CONTROL,
    description:
      'List the portal personas you can act as — the one you started as plus any you minted — ' +
      'and which one is active right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mint_persona',
    _meta: CONTROL,
    description:
      'Create a NEW portal persona with the given display name and add it to the personas you can act as. ' +
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
        switch: { type: 'boolean', description: 'Switch to the new persona after minting (default true)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'switch_persona',
    _meta: CONTROL,
    description:
      'Switch which of your personas you act as. Takes effect immediately and persists across ' +
      'restarts. Everything you send afterwards is attributed to the new persona; channels it ' +
      'cannot see are closed, and pings it accrued while inactive are delivered as a catch-up.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name (or persona id) of a persona from list_personas' },
      },
      required: ['name'],
    },
  },
];

/** The pre-2026-10-15 tool names, still accepted (agents learned them), never
 *  advertised. */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
  list_identities: 'list_personas',
  mint_identity: 'mint_persona',
  switch_identity: 'switch_persona',
};

/** Every name a persona tool answers to (current and legacy) → its feature
 *  set; both bindings route tool calls through this. */
export const IDENTITY_TOOL_FEATURE_SETS: Readonly<Record<string, string>> = Object.fromEntries(
  [...identityToolDefinitions.map((tool) => tool.name), ...Object.keys(LEGACY_TOOL_NAMES)].map((name) => [
    name,
    IDENTITY_FEATURE_SET,
  ]),
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
    switch (LEGACY_TOOL_NAMES[name] ?? name) {
      case 'list_personas':
        return this.describe();
      case 'mint_persona':
        return this.exclusive(() =>
          this.mint(reqStr(args.name, 'name'), optStr(args.invite), args.switch !== false),
        );
      case 'switch_persona':
        return this.exclusive(() => this.switchTo(reqStr(args.name, 'name')));
      default:
        throw new Error(`unknown persona tool ${name}`);
    }
  }

  // ── Operations ──

  private describe(): unknown {
    return {
      active: this.roster.identities[this.roster.active]?.name ?? this.roster.active,
      personas: Object.entries(this.roster.identities).map(([key, record]) => ({
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
    this.refreshRoster();
    if (this.roster.identities[key]) {
      throw new Error(`you already have a persona named "${this.roster.identities[key].name}" — switch to it instead`);
    }
    if (Object.keys(this.roster.identities).length >= this.maxIdentities) {
      throw new Error(`persona limit reached (${this.maxIdentities}); ask an operator to raise PORTAL_IDENTITY_MAX`);
    }
    const code = invite ?? this.opts.invite;
    if (!code) throw new Error('no invite available — pass `invite`, or configure PORTAL_INVITE');
    const credsPath = join(this.opts.credsDir, `${key}.creds.json`);
    // Reserve the creds file BEFORE enrolling, with an exclusive create: two
    // processes sharing this directory, or two names that slug alike ("Écho",
    // "Cho"), can't both mint into it and have the second overwrite the first's
    // token. A file we didn't create belongs to someone else — loadOrEnrollCreds
    // would silently ADOPT it, exactly the impersonation this module refuses.
    mkdirSync(this.opts.credsDir, { recursive: true });
    if (!reserveCredsFile(credsPath)) {
      throw new Error(
        `a persona file for "${name}" already exists on this host (${basename(credsPath)}) — choose a different name`,
      );
    }

    // uniqueName: the name came from the model, so channel text can steer it —
    // the relay also refuses one that reads like an existing persona's.
    let creds: PortalCredentials;
    try {
      creds = await this.enrollFn({ url: this.opts.url, invite: code, desiredName: name, uniqueName: true });
    } catch (err) {
      try { unlinkSync(credsPath); } catch { /* best effort: release the reservation */ }
      throw err;
    }
    try {
      // Fills the reservation (ours); the store writes 0600.
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
    // A roster that can't be written would lose this identity at restart (and
    // its creds file would then block minting it again) — say so, don't report
    // success. It stays usable in this process and is saved with the next change.
    const saved = this.saveRoster();
    if (!saved.ok) {
      throw new Error(
        `minted "${name}" (${creds.personaId}) but could not record it in the identity roster (${saved.error}); ` +
          'it is usable until restart and will be recorded with the next roster change',
      );
    }
    console.error(`[portal-mcpl] minted identity "${name}" (${creds.personaId})`);

    if (!thenSwitch) return { minted: { name, personaId: creds.personaId }, active: this.activeName() };
    const switched = await this.switchTo(name);
    return { minted: { name, personaId: creds.personaId }, ...(switched as object) };
  }

  private async switchTo(nameOrId: string): Promise<unknown> {
    const found = this.find(nameOrId);
    if (!found) {
      const known = Object.values(this.roster.identities).map((r) => r.name).join(', ');
      throw new Error(`no persona "${nameOrId}" — you have: ${known}`);
    }
    const [key, record] = found;
    if (!this.current || !this.onSwitch) throw new Error('persona switching is not attached to a live session');
    if (this.current.creds.personaId === record.personaId) {
      return { active: record.name, personaId: record.personaId, changed: false };
    }

    const next = this.opts.createSession(this.loadCreds(record));
    try {
      await withTimeout(next.client.connect(), this.connectTimeoutMs, 'relay did not accept the persona in time');
    } catch (err) {
      next.close(); // also stops the client's reconnect loop
      throw new Error(`could not connect as "${record.name}": ${(err as Error).message} — still ${this.activeName()}`);
    }

    // Hand the live session to the server. Only once that succeeds is the
    // switch real: retire the old session and persist the new one as active.
    // If the server refuses, the new session is torn down and the old one is
    // still what serves tool calls — never a half-swapped process with the old
    // socket gone.
    const previous = this.current;
    try {
      await this.onSwitch(next);
    } catch (err) {
      next.close();
      throw new Error(`switch to "${record.name}" failed: ${(err as Error).message} — still ${this.activeName()}`);
    }
    this.current = next;
    previous.close();
    this.roster.active = key;
    this.saveRoster();
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
    const look = (): [string, IdentityRecord] | undefined => {
      const wanted = nameOrId.trim();
      const byKey = this.roster.identities[slugName(wanted)];
      if (byKey) return [slugName(wanted), byKey];
      return Object.entries(this.roster.identities).find(([, record]) => record.personaId === wanted);
    };
    const hit = look();
    if (hit) return hit;
    this.refreshRoster(); // another process sharing this roster may have minted it
    return look();
  }

  /** Adopt identities another process sharing this roster has added since we
   *  loaded it (the in-memory copy otherwise only ever sees our own mints). */
  private refreshRoster(): void {
    const disk = this.loadRoster();
    for (const [key, record] of Object.entries(disk.identities)) {
      if (!this.roster.identities[key]) this.roster.identities[key] = record;
    }
  }

  /** Run `fn` holding the roster's lock file, so two processes don't both
   *  read-merge-write it at once. */
  private withRosterLock(fn: () => void): void {
    withFileLock(`${this.opts.rosterPath}.lock`, 'identity roster', fn);
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

  /** Write the roster — merged, under the lock, with whatever another process
   *  sharing it has added, so its records aren't dropped by our whole-file
   *  write (it would then be unable to switch to, or re-mint, its identities).
   *  `active` is this process's own. */
  private saveRoster(): { ok: true } | { ok: false; error: string } {
    try {
      mkdirSync(dirname(this.opts.rosterPath), { recursive: true });
      this.withRosterLock(() => {
        this.refreshRoster();
        const tmp = `${this.opts.rosterPath}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.roster, null, 2) + '\n', { mode: 0o600 });
        renameSync(tmp, this.opts.rosterPath);
      });
      return { ok: true };
    } catch (err) {
      console.error('[portal-mcpl] identity roster write failed:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
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
