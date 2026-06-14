/**
 * Relay configuration. Identity and permissions are now *separate* files, each
 * owned by its own live-reloadable store (see identity.ts / permissions.ts).
 *
 *   PORTAL_IDENTITY     who:  [{ id, displayName, avatar, token }]
 *   PORTAL_PERMISSIONS  what: per-persona, guild/channel-aware capability policy
 *
 * Both are hot-reloaded on edit and mutable at runtime via the stores' APIs.
 */
import type { Capability } from '@connectome/portal-protocol';

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

export interface PermissionsFile {
  /** Fallback applied to personas with no entry of their own (default: deny). */
  default?: Capability[];
  personas: Record<string, PersonaPolicy>;
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
  /** Capability profile applied as the new persona's default policy. */
  caps: Capability[];
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
}

export interface InvitesFile {
  invites: InviteTemplate[];
}

export interface RolePoolConfig {
  size: number;
  prefix: string;
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
  rolePool: RolePoolConfig;
  webhookPoolSize: number;
  heartbeatIntervalMs: number;
  guildMembersIntent: boolean;
  /** Watch the identity/permissions files for external edits (default true). */
  watchConfig: boolean;
  /** TTL (ms) for the fetch_history page cache; 0 disables (default 5000). */
  historyCacheTtlMs: number;
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
    rolePool: {
      size: parseInt(process.env.PORTAL_ROLE_POOL_SIZE ?? '50', 10),
      prefix: process.env.PORTAL_ROLE_POOL_PREFIX ?? 'portal-',
    },
    webhookPoolSize: parseInt(process.env.PORTAL_WEBHOOK_POOL ?? '1', 10),
    heartbeatIntervalMs: parseInt(process.env.PORTAL_HEARTBEAT_MS ?? '30000', 10),
    guildMembersIntent: process.env.PORTAL_GUILD_MEMBERS_INTENT !== 'false',
    watchConfig: process.env.PORTAL_WATCH_CONFIG !== 'false',
    historyCacheTtlMs: parseInt(process.env.PORTAL_HISTORY_CACHE_MS ?? '5000', 10),
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
