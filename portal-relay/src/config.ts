/**
 * Relay configuration. Identity and permissions are now *separate* files, each
 * owned by its own live-reloadable store (see identity.ts / permissions.ts).
 *
 *   PORTAL_IDENTITY     who:  [{ id, displayName, avatar, token }]
 *   PORTAL_PERMISSIONS  what: per-persona, guild/channel-aware capability policy
 *
 * Both are hot-reloaded on edit and mutable at runtime via the stores' APIs.
 */
import type { Capability } from '@animalabs/portal-protocol';

// ── Identity file ──

export interface PersonaIdentity {
  id: string;
  displayName: string;
  /** Avatar filename (resolved under avatarBaseUrl) or absolute URL. */
  avatar: string;
  /** Shared secret the client presents in `identify`. */
  token: string;
}

export interface IdentityFile {
  personas: PersonaIdentity[];
}

// ── Permissions file ──

/** Per-guild policy: a guild-wide default plus per-channel overrides. */
export interface GuildPolicy {
  default?: Capability[];
  channels?: Record<string, Capability[]>;
}

/** A persona's full policy: global default + per-guild refinements. */
export interface PersonaPolicy {
  default: Capability[];
  guilds?: Record<string, GuildPolicy>;
}

/**
 * A grant's *scope* — which channels it applies in (RFC-004). Caps answer the
 * "what may be done"; scope answers "where".
 *   { channels }    — explicit allow-list
 *   { mirrorRole }  — a Discord role id; scope = the channels that role can view
 *   { mirrorRoles } — several role ids; scope = the union of channels they can view
 *   { all }         — every channel (admin-ish; use sparingly)
 */
export type Scope =
  | { channels: string[] }
  | { mirrorRole: string }       // a Discord role id; scope = the channels it can view
  | { mirrorRoles: string[] }    // several role ids; scope = union of channels they can view
  | { all: true };

/**
 * A named, reusable scoped-policy template (RFC-004 §5.4). Personas are assigned
 * roles; effective permissions are the union (most-permissive) of their roles.
 */
export interface AccessRole {
  caps: Capability[];
  scope: Scope;
  /** Bind to a guild — required for `mirrorRole`; omit for global. */
  guildId?: string;
}

/**
 * A persona's permissions entry. Either references reusable access roles, carries
 * a legacy inline policy, or both (unioned). Backward-compatible: a bare
 * `PersonaPolicy` (with `default`/`guilds`) in the file is read as `{ policy }`.
 */
export interface PersonaEntry {
  roles?: string[];
  policy?: PersonaPolicy;
}

/** What a persona looks like on disk — new entry shape or a legacy inline policy. */
export type PersonaFileEntry = PersonaEntry | PersonaPolicy;

export interface PermissionsFile {
  /** Fallback applied to personas with no entry of their own (default: deny). */
  default?: Capability[];
  /** Reusable access-role catalog (RFC-004 §5.4). */
  roles?: Record<string, AccessRole>;
  personas: Record<string, PersonaFileEntry>;
}

// ── Invites file ──

/**
 * An invite is an access-rights *template*: a reusable code that mints new
 * personas, each stamped with the same capability profile. Bounded by an
 * optional max-uses count and/or expiry. This is how new agents (e.g. Claude
 * Code instances) self-register without an admin pre-provisioning each one.
 */
export interface InviteTemplate {
  /** The secret code an enrolling agent presents. */
  code: string;
  /** Human label for the invite (e.g. "claude-code"). Optional. */
  label?: string;
  /**
   * Access-role names granted to the new persona (RFC-004, preferred). Mutually
   * exclusive with `grant`. Resolution is live, so `mirrorRole` roles track
   * Discord visibility over time.
   */
  roles?: string[];
  /**
   * Inline scoped grant (RFC-004). Mutually exclusive with `roles`. A
   * `mirrorRole` scope here is snapshotted at enroll time into a channel list;
   * use `roles` for live mirroring.
   */
  grant?: { caps: Capability[]; scope: Scope };
  /** Guild the inline `grant`/scope applies to (required for non-`all` scopes). */
  guildId?: string;
  /**
   * @deprecated Blanket capability profile applied to *every* channel. Honoured
   * as `grant: { caps, scope: { all: true } }` with a warning — re-mint scoped.
   */
  caps?: Capability[];
  /** Channels the new persona is auto-subscribed to on enroll. */
  subscriptions?: string[];
  /** Prefix for minted persona ids (default derived from the display name). */
  namePrefix?: string;
  /** Max number of personas this invite may mint. Omit for unlimited. */
  maxUses?: number;
  /** How many personas have been minted so far (relay-maintained). */
  uses?: number;
  /** ISO timestamp after which the invite is rejected. Omit for no expiry. */
  expiresAt?: string;
  /**
   * What the invite may do (RFC-005 §5.6). Default `'mint'` (today's behaviour):
   *   'mint'    — an unauthenticated agent enrolls a NEW persona (`register`).
   *   'augment' — an AUTHENTICATED persona claims it to add its roles/grant to
   *               itself (`claim_invite`).
   *   'both'    — either path is allowed.
   */
  mode?: 'mint' | 'augment' | 'both';
}

export interface InvitesFile {
  invites: InviteTemplate[];
}

export interface RolePoolConfig {
  size: number;
  prefix: string;
}

/**
 * Admin panel / HTTP API config (RFC-005). Present only when the admin surface is
 * enabled (`PORTAL_ADMIN_ENABLED=true`). The API binds localhost; Caddy fronts it
 * with TLS and serves the SPA. Discord OAuth derives which guilds an admin may
 * manage from their live Discord permissions; `superadmins` is the operator
 * override list (Discord user ids).
 */
export interface AdminConfig {
  /** HTTP port, bound to 127.0.0.1 (default 8791). Caddy proxies to it. */
  port: number;
  /** Discord OAuth2 application client id. */
  oauthClientId: string;
  /** Discord OAuth2 application client secret. */
  oauthClientSecret: string;
  /** Exact OAuth redirect URI (must match the Discord app + our allowlist). */
  redirectUri: string;
  /** Where to send the browser after a successful login (the SPA root). */
  postLoginUrl: string;
  /** Operator super-admins: Discord user ids with global authority. */
  superadmins: string[];
  /** Per-guild operator allowlist: guildId → Discord user ids granted guild-admin
   *  for THAT guild only, regardless of their live Discord permissions. Narrower
   *  than `superadmins` (global). Sourced from PORTAL_GUILD_ADMINS (JSON). */
  guildAdmins: Record<string, string[]>;
  /** Server-side session TTL (ms). Short — admin rights are re-derived on login. */
  sessionTtlMs: number;
  /** Append-only audit log path (JSONL). */
  auditPath: string;
  /** Set the `Secure` flag on cookies (default true; false only for local dev). */
  cookieSecure: boolean;
}

export interface RelayConfig {
  discordToken: string;
  wsPort: number;
  avatarBaseUrl: string;
  guildIds: string[];
  identityPath: string;
  permissionsPath: string;
  /** Optional invites file. When set, agents may self-register via `register`. */
  invitesPath?: string;
  /** Optional path to persist message attribution (id→persona/webhook). Enables
   *  per-persona edit/delete ownership of pre-restart messages. */
  attributionPath?: string;
  /** Optional path to persist per-persona read-state (watermarks, pending pings,
   *  ambient tallies). Enables offline catch-up that survives relay restarts. */
  readStatePath?: string;
  /** Max pending pings retained per persona (oldest dropped). Default 500. */
  readStatePingsCap?: number;
  /** Max channels with a live unread tally per persona (least-recent dropped).
   *  Default 1000. */
  readStateChannelsCap?: number;
  rolePool: RolePoolConfig;
  webhookPoolSize: number;
  heartbeatIntervalMs: number;
  guildMembersIntent: boolean;
  /** Watch the identity/permissions files for external edits (default true). */
  watchConfig: boolean;
  /** TTL (ms) for the fetch_history page cache; 0 disables (default 5000). */
  historyCacheTtlMs: number;
  /** Max total decoded bytes of inline (base64) attachments per message
   *  (default 8 MiB — the Discord non-boosted ceiling). Bounds the WS frame
   *  and relay memory. */
  maxInlineFileBytes: number;
  /** Allow path-based attachments (the relay reads a client-supplied path off
   *  its own disk). Default false — a filesystem-disclosure vector on a shared
   *  relay. Enable only for trusted single-tenant deployments. */
  allowPathFiles: boolean;
  /** Prepend a quoted jump-link when a persona replies (webhooks can't carry a
   *  native Discord reply). Default true; set false to suppress the header. */
  replyLink: boolean;
  /** Admin panel / HTTP API (RFC-005). Undefined ⇒ disabled. */
  admin?: AdminConfig;
}

export function loadConfig(): RelayConfig {
  return {
    discordToken: requireEnv('DISCORD_TOKEN'),
    wsPort: parseInt(process.env.PORTAL_WS_PORT ?? '8790', 10),
    avatarBaseUrl: (process.env.PORTAL_AVATAR_BASE_URL ?? '').replace(/\/$/, ''),
    guildIds: splitCsv(process.env.DISCORD_GUILD_ID),
    identityPath: requireEnv('PORTAL_IDENTITY'),
    permissionsPath: requireEnv('PORTAL_PERMISSIONS'),
    invitesPath: process.env.PORTAL_INVITES || undefined,
    attributionPath: process.env.PORTAL_ATTRIBUTION || undefined,
    readStatePath: process.env.PORTAL_READSTATE || undefined,
    readStatePingsCap: process.env.PORTAL_READSTATE_PINGS_CAP
      ? parseInt(process.env.PORTAL_READSTATE_PINGS_CAP, 10)
      : undefined,
    readStateChannelsCap: process.env.PORTAL_READSTATE_CHANNELS_CAP
      ? parseInt(process.env.PORTAL_READSTATE_CHANNELS_CAP, 10)
      : undefined,
    rolePool: {
      size: parseInt(process.env.PORTAL_ROLE_POOL_SIZE ?? '50', 10),
      prefix: process.env.PORTAL_ROLE_POOL_PREFIX ?? 'portal-',
    },
    webhookPoolSize: parseInt(process.env.PORTAL_WEBHOOK_POOL ?? '1', 10),
    heartbeatIntervalMs: parseInt(process.env.PORTAL_HEARTBEAT_MS ?? '30000', 10),
    guildMembersIntent: process.env.PORTAL_GUILD_MEMBERS_INTENT !== 'false',
    watchConfig: process.env.PORTAL_WATCH_CONFIG !== 'false',
    historyCacheTtlMs: parseInt(process.env.PORTAL_HISTORY_CACHE_MS ?? '5000', 10),
    maxInlineFileBytes: parseInt(process.env.PORTAL_MAX_INLINE_BYTES ?? String(8 * 1024 * 1024), 10),
    allowPathFiles: process.env.PORTAL_ALLOW_PATH_FILES === 'true',
    replyLink: process.env.PORTAL_REPLY_LINK !== 'false',
    admin: loadAdminConfig(),
  };
}

/** Build the admin config from env, or undefined when the panel is disabled.
 *  Enabling it (`PORTAL_ADMIN_ENABLED=true`) requires the OAuth credentials. */
function loadAdminConfig(): AdminConfig | undefined {
  if (process.env.PORTAL_ADMIN_ENABLED !== 'true') return undefined;
  return {
    port: parseInt(process.env.PORTAL_ADMIN_PORT ?? '8791', 10),
    oauthClientId: requireEnv('PORTAL_OAUTH_CLIENT_ID'),
    oauthClientSecret: requireEnv('PORTAL_OAUTH_CLIENT_SECRET'),
    redirectUri: requireEnv('PORTAL_OAUTH_REDIRECT_URI'),
    postLoginUrl: process.env.PORTAL_ADMIN_POST_LOGIN_URL ?? '/',
    superadmins: splitCsv(process.env.PORTAL_SUPERADMINS),
    guildAdmins: parseGuildAdmins(process.env.PORTAL_GUILD_ADMINS),
    sessionTtlMs: parseInt(process.env.PORTAL_ADMIN_SESSION_TTL_MS ?? String(30 * 60 * 1000), 10),
    auditPath: requireEnv('PORTAL_ADMIN_AUDIT'),
    cookieSecure: process.env.PORTAL_ADMIN_COOKIE_INSECURE !== 'true',
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

function splitCsv(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse PORTAL_GUILD_ADMINS — a JSON object mapping guild id → array of Discord
 * user ids granted guild-admin for that guild. Malformed/absent → {} (fail-closed:
 * grants no extra admins). Non-string ids and empty arrays are dropped.
 */
function parseGuildAdmins(v: string | undefined): Record<string, string[]> {
  if (!v || !v.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [gid, uids] of Object.entries(parsed as Record<string, unknown>)) {
    if (!gid || !Array.isArray(uids)) continue;
    const ids = uids.filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (ids.length) out[gid] = ids;
  }
  return out;
}
