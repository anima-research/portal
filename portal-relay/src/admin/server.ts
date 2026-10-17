/**
 * Admin HTTP API (RFC-005 §5.1). Binds 127.0.0.1 only; Caddy is the sole exposed
 * endpoint, TLS-terminating and proxying here (and serving the SPA). This is a
 * distinct, separately-hardened surface from the WS gateway (§7) — it can do far
 * more, so it never shares the gateway's auth path.
 *
 * OAuth login/callback, server-side sessions, super-admin + guild-admin
 * authorization, guild-scoped reads and audited mutations.
 *
 * AUTHZ INVARIANTS — every change here keeps these true. Each has a test
 * named after it in test/admin.test.ts ('invariant I1' …).
 *
 *   I1  Every /admin/g/:gid route passes canManageGuild(session, G, served)
 *       first, in handle(), before the route reads anything.
 *   I2  Every non-GET request with a session passes the CSRF gate in handle()
 *       before any route runs or any body is read — POST /admin/logout too.
 *   I3  Every channel written under G passed channelInGuild(G) and is
 *       grantable (text, voice or forum; never a thread or a category), and
 *       the guild key written is the route's G (grantTargetError,
 *       checkInviteGrant, checkRoleDef).
 *   I4  Every access role a non-super assigns, revokes, mints or claims is
 *       bound to G (roleAssignError, hasForeignRole).
 *   I5  GET /admin/g/:gid responses name only G's channels and access roles
 *       (clipToGuild, rolesVisibleIn), and name personas only by their access
 *       in G or by directory fields.
 *   I8  Non-supers never write persona-wide state: the persona default, an
 *       invite for every channel (scope {all}), another guild's roles, tokens,
 *       avatars, the role catalog or the guild allow-list.
 *
 * (I6 and I7 are kept for later: invite codes shown only at mint or through an
 * audited reveal, and admin rights computed on every request.)
 *
 * GET routes never change anything.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccessRole, AdminConfig, GuildPolicy, PersonaIdentity, Scope } from '../config.js';
import type { Capability } from '@animalabs/portal-protocol';
import { ALL_CAPS, roleGrantsAccess } from '../permissions.js';
import {
  LEVEL_CAPS, accessSummary, countedLevel, explainFor, holdsAccess, isGrantable, levelOf, removeFromGuild, subjectOf, zeroCounts,
  type AccessDeps, type AccessSource, type Explained, type LevelCounts, type Subject,
} from '../access.js';
import type { IdentityStore } from '../identity.js';
import { inviteShapeProblem, type InviteStore } from '../invites.js';
import type { PermissionsStore } from '../permissions.js';
import type { AuditLog, AuditRecord } from './audit.js';
import { canManageGuild } from './authz.js';
import { clipToGuild, type ChannelLabel, type NameMaps, type RoleLabel } from './names.js';
import { authorizeUrl, completeOAuth, OAuthError, type FetchLike } from './oauth.js';
import { SessionStore, STATE_TTL_MS, type AdminSession } from './sessions.js';
import { LoginRateLimit, clientIp } from './login-limit.js';

/** What /admin/me reports as apiVersion. The panel compares it with its own
 *  PA.CLIENT_API and asks for a reload when the relay is newer; a panel newer
 *  than the relay says which views need the relay updated.
 *   2  direct grants by level, guild-wide as {guildDefault: true}, Unset and
 *      Deny guild-wide as their own operations
 *   3  the access views (…/access/summary, …/channels/:cid/access,
 *      …/personas/:pid/access), the persona directory, Remove from <guild>
 *      and Resync */
export const ADMIN_API_VERSION = 3;

/** Personas × channels the access summary counts at most. Past it the counts
 *  are left out (truncated) rather than stalling the event loop or refusing. */
export const ACCESS_CELL_CAP = 100_000;
/** How long a guild's access summary is reused. Any permissions change
 *  drops it at once; the rest (channels, the bot's permissions) can lag this
 *  much. */
const SUMMARY_TTL_MS = 5_000;
/** Rows the persona directory answers with, as slash autocomplete does. */
const DIRECTORY_ROWS = 25;
/** A bulk change's id, kept in the audit record of each of its writes. */
const BATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** How often one persona can be resynced from the panel (slash /resync has
 *  no limit: it is unchanged). */
export const RESYNC_EVERY_MS = 10_000;

/** New access-role names. Existing names that don't fit are kept (and can be
 *  replaced under the same name). */
const ROLE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const SESSION_COOKIE = 'portal_admin_session';
/** The sign-ins this browser has in flight: one cookie per OAuth state, named
 *  after it (stateCookieName) and holding it. A request writes or deletes only
 *  the cookies of the states it is about, never one rebuilt from what it read
 *  earlier, so two tabs' sign-ins can't erase each other's. A new sign-in past
 *  STATES_PER_BROWSER ends this browser's oldest. */
const STATE_COOKIE_PREFIX = 'portal_admin_state_';
const STATE_COOKIE_NAME = /^portal_admin_state_[0-9a-f]{16}$/;
const STATES_PER_BROWSER = 3;
/** At most this many state cookies are looked at in one request. */
const STATE_COOKIES_READ = 32;
/** The one state cookie of earlier versions (every state, joined with '.'):
 *  cleared when a browser still sends it. */
const LEGACY_STATE_COOKIE = 'portal_admin_state';
/** An OAuth state as issued: 32 random bytes, base64url. */
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Why a sign-in came back without a session: the only words a callback
 *  redirect ever adds to postLoginUrl (the panel has a sentence for each,
 *  PA.lib.loginErrorText). */
type LoginError = 'cancelled' | 'expired' | 'mismatch' | 'discord_error' | 'rate_limited' | 'not_admin';

/** The ?error= values Discord's authorize step may send (RFC 6749 §4.1.2.1,
 *  and OpenID's for prompt=none). Anything else is recorded as 'other'. */
const DISCORD_ERRORS = new Set([
  'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type', 'invalid_scope',
  'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required', 'consent_required',
]);

const UNKNOWN_ACTOR = { id: 'unknown', name: 'unknown', kind: 'admin' as const };

/** The slice of the relay the admin API needs. Built in relay.ts over the bot /
 *  gateway so this module stays decoupled and unit-testable. */
export interface AdminDeps {
  config: AdminConfig;
  identity: IdentityStore;
  permissions: PermissionsStore;
  invites?: InviteStore;
  /** Shared audit log — relay self-service ops (claim_invite) write here too. */
  audit: AuditLog;
  /** Allowed guilds (id + name + member count) — the bot's view. */
  listGuilds(): Array<{ id: string; name: string; memberCount: number }>;
  /** EVERY guild the bot is joined to, with the live allowed flag — feeds the
   *  super-admin allow-list editor's "joined but not allowed" picker. */
  listAllGuilds(): Array<{ id: string; name: string; memberCount: number; allowed: boolean }>;
  /** Guild allow-list ops. `editable` false ⇒ env-managed (legacy DISCORD_GUILD_ID
   *  snapshot); mutations are rejected with NOT_EDITABLE. */
  allowlist: {
    editable: boolean;
    list(): string[];
    allow(guildId: string): boolean;
    disallow(guildId: string): boolean;
  };
  /** A guild's Discord roles (for `mirrorRole` pickers). */
  listRoles(guildId: string): Array<{ id: string; guildId: string; name: string; pooled: boolean }>;
  /** A guild's channels (for `channels`-scope pickers). Threads carry their parent. */
  listChannels(guildId: string): Array<{ id: string; name?: string; type?: string; parentId?: string }>;
  /** Names for channel ids, including ones the gateway cache doesn't hold
   *  (archived threads, deleted channels). Optional: without it, names come
   *  from the allowed guilds' channel lists only. */
  resolveChannels?(ids: string[]): Promise<Map<string, ChannelLabel>>;
  /** A Discord role id's name + guild (any joined guild). Optional: without
   *  it, names come from the allowed guilds' role lists. */
  discordRole?(roleId: string): RoleLabel | null;
  /** True if the channel belongs to the guild (for clipping grants to G). */
  channelInGuild(guildId: string, channelId: string): boolean;
  /** Drop a persona's live sessions (revoke/force-rotate). */
  closePersona(personaId: string): void;
  /** Admin-initiated augment: apply an invite's grant to an existing persona.
   *  Mirrors the `claim_invite` op but actor = the admin. Returns role list. */
  applyClaim(personaId: string, code: string): { roles: string[]; liftedBans?: string[] };
  /** Force-rotate a persona's token; returns the new plaintext (show once). */
  rotatePersonaToken(personaId: string): string;
  /** Force-revoke a persona's token + drop its sessions. */
  revokePersonaToken(personaId: string): void;
  /** Generate a unique invite code. */
  newInviteCode(): string;
  /** What the relay enforces for a persona in a channel: Relay.capsFor. */
  capsFor(personaId: string, channelId: string, guildId: string): Capability[];
  /** What the relay's bot can do in a channel of G: computeCapabilities over
   *  every capability, for the bot's member in G — capsFor's Discord half. */
  botCaps(guildId: string, channelId: string): Capability[];
  /** The channel whose access the relay checks for `channelId`
   *  (Relay.permChannelId): a thread's parent, anything else itself. */
  permChannelId(channelId: string): string;
  /** Where each channel of G sits in Discord's sidebar (threads left out). */
  listChannelLayout(guildId: string): Array<{ id: string; categoryId: string | null; position: number; announcement: boolean }>;
  /** Whether a persona could have any capability in G (the relay's own test,
   *  PermissionsStore.couldAccessGuild over G's channels). */
  canAccessGuild(personaId: string, guildId: string): boolean;
  /** Re-send a persona's channel list to its running agent; channels pushed. */
  resync(personaId: string): number;
}

/** The access model's view of the relay (access.ts), as the admin API reads
 *  it: the relay's own stores and bot caps, and the served-guild test that
 *  canManageGuild uses. */
export function accessDepsOf(deps: AdminDeps): AccessDeps {
  const served = new Map<string, boolean>();
  return {
    identity: deps.identity,
    permissions: deps.permissions,
    botCaps: (guildId, channelId) => deps.botCaps(guildId, channelId),
    served: (guildId) => {
      let v = served.get(guildId);
      if (v === undefined) served.set(guildId, (v = deps.listGuilds().some((g) => g.id === guildId)));
      return v;
    },
  };
}

/** Limits a test can lower, and the clock it can drive. */
export interface AdminLimits {
  accessCellCap?: number;
  /** Milliseconds since the epoch (default Date.now). */
  clock?: () => number;
}

export class AdminServer {
  private server?: Server;
  private sessions: SessionStore;
  private audit: AuditLog;
  /** Callbacks per client address (never global). */
  private callbackLimit = new LoginRateLimit();
  /** Sign-ins started (/admin/login) per client address, apart from the
   *  callbacks: each start holds a state in memory until it is used. */
  private loginLimit = new LoginRateLimit();
  private limitTimer?: ReturnType<typeof setInterval>;
  /** Access summaries by guild, reused for SUMMARY_TTL_MS. */
  private summaries = new Map<string, { at: number; body: Record<string, unknown> }>();
  private accessCellCap: number;
  private clock: () => number;
  /** When each persona was last resynced from the panel (RESYNC_EVERY_MS). */
  private resynced = new Map<string, number>();
  /** The access model and capsFor disagreed once (said once, loudly). */
  private driftReported = false;

  constructor(
    private deps: AdminDeps,
    /** Injectable fetch — tests drive the OAuth callback without real network. */
    private fetchImpl: FetchLike = fetch,
    limits: AdminLimits = {},
  ) {
    this.sessions = new SessionStore(deps.config.sessionTtlMs);
    this.audit = deps.audit;
    this.accessCellCap = limits.accessCellCap ?? ACCESS_CELL_CAP;
    this.clock = limits.clock ?? Date.now;
    // Whoever changed it — this panel, slash, an invite, the file — a
    // summary counted before is no longer what the relay enforces.
    deps.permissions.onChange(() => this.summaries.clear());
  }

  async listen(): Promise<void> {
    this.sessions.start();
    // Refusals counted after an address's last login.rate_limited record go
    // into one more record once its minute is over.
    this.limitTimer = setInterval(() => {
      for (const { ip, count } of this.callbackLimit.sweep()) this.recordRateLimited(ip, count);
      for (const { ip, count } of this.loginLimit.sweep()) this.recordRateLimited(ip, count, 'login');
    }, 60_000);
    this.limitTimer.unref?.();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error('[portal-admin] request error:', (e as Error).message);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.deps.config.port, '127.0.0.1', () => {
        console.error(`[portal-admin] admin API listening on http://127.0.0.1:${this.deps.config.port}`);
        resolve();
      });
    });
  }

  /** The actually-bound port (useful when configured with port 0, e.g. tests). */
  get boundPort(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.deps.config.port;
  }

  async close(): Promise<void> {
    this.sessions.stop();
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = undefined;
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  // ── Routing ──

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Unauthenticated endpoints.
    if (method === 'GET' && path === '/admin/health') return sendJson(res, 200, { ok: true });
    if (method === 'GET' && path === '/admin/login') return this.onLogin(req, res, url);
    if (method === 'GET' && path === '/admin/callback') return this.onCallback(req, res, url);
    // Uploaded avatars are public images (Discord fetches them) — unauthenticated.
    if (method === 'GET' && path.startsWith('/admin/avatars/')) return this.serveAvatar(res, path);

    // Everything below requires a session.
    const session = this.sessions.get(getCookie(req, SESSION_COOKIE));
    if (!session) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'login required' } });

    // I2: one CSRF gate for every change, before any route runs or reads a
    // body — so no route can forget it, and a refused request changes nothing.
    if (method !== 'GET' && method !== 'HEAD' && !this.csrfOk(req, session)) {
      return sendJson(res, 403, err('CSRF', 'missing or invalid CSRF token'));
    }

    if (method === 'POST' && path === '/admin/logout') return this.onLogout(req, res, session);
    if (method === 'GET' && path === '/admin/me') return this.onMe(res, session);
    // The guilds the user may manage AND the bot is actually in (named) — the
    // scope selector uses this, so it lands on guilds that have data rather than
    // every guild the admin happens to own on Discord.
    if (method === 'GET' && path === '/admin/guilds') return this.onGuilds(res, session);

    // Guild allow-list editing — super-admin only. (The exact-GET above stays
    // first: it serves the scope selector for ALL admins.)
    if (path === '/admin/guilds' || path.startsWith('/admin/guilds/')) {
      return this.onGuildAllowlist(req, res, session, method, path);
    }

    // Global access-role catalog authoring — super-admin only (RFC-005 §5.3).
    if (path === '/admin/roles' || path.startsWith('/admin/roles/')) {
      return this.onRolesCatalog(req, res, session, method, path);
    }

    // Global Identities surface (super-admin only): the canonical persona
    // registry + per-persona detail + token lifecycle. Not guild-scoped — a token
    // is the persona's global credential, and only operators enumerate all
    // personas (RFC-005 §5.3, §5.9).
    if (path === '/admin/personas' || path.startsWith('/admin/personas/')) {
      if (!session.isSuper) return sendJson(res, 403, err('FORBIDDEN', 'global persona admin is super-admin only'));
      return this.onIdentitiesRoute(req, res, session, method, path, url);
    }

    // Guild-scoped routes: /admin/g/:gid/<...>
    const gm = /^\/admin\/g\/([^/]+)(\/.*)?$/.exec(path);
    if (gm) {
      const guildId = decodeURIComponent(gm[1]);
      const sub = gm[2] ?? '';
      if (!canManageGuild(session, guildId, (g) => this.isServed(g))) {
        this.audit.append({
          actor: { id: session.userId, name: session.userName, kind: 'admin' },
          action: 'authz.denied',
          guildId,
          ok: false,
          detail: { method, path },
        });
        // `reason` tells this refusal apart from a route's own FORBIDDEN
        // (a channel or role of another guild): the panel words them differently.
        return sendJson(res, 403, err('FORBIDDEN', 'not an admin of this guild', { reason: 'NOT_GUILD_ADMIN' }));
      }
      return this.onGuildRoute(req, res, session, guildId, method, sub, url);
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  }

  /** The SPA echoes the session's CSRF token in X-CSRF-Token on every change.
   *  Compared in constant time (after a length check, which timingSafeEqual
   *  needs; the length of a fixed-size token is no secret). */
  private csrfOk(req: IncomingMessage, session: AdminSession): boolean {
    const h = req.headers['x-csrf-token'];
    const got = Array.isArray(h) ? h[0] : h;
    if (typeof got !== 'string' || !got) return false;
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(session.csrf, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── Guild-scoped routing (reads + mutations) ──

  private async onGuildRoute(
    req: IncomingMessage,
    res: ServerResponse,
    session: AdminSession,
    guildId: string,
    method: string,
    sub: string,
    url: URL,
  ): Promise<void> {
    // Effective access (what the relay enforces, and why).
    if (method === 'GET') {
      if (sub === '/access/summary') return this.onAccessSummary(res, guildId);
      const chAccess = /^\/channels\/([^/]+)\/access$/.exec(sub);
      if (chAccess) return this.onChannelAccess(res, guildId, decodeURIComponent(chAccess[1]));
      const pAccess = /^\/personas\/([^/]+)\/access$/.exec(sub);
      if (pAccess) return this.onPersonaAccess(res, session, guildId, decodeURIComponent(pAccess[1]));
    }
    // Read: GET /admin/g/:gid/personas/:id  (drawer detail) — before the generic
    // single-segment read so it isn't shadowed.
    const personaDetail = /^\/personas\/([^/]+)$/.exec(sub);
    if (method === 'GET' && personaDetail) {
      return this.onPersonaDetail(res, session, guildId, decodeURIComponent(personaDetail[1]));
    }
    // Reads: GET /admin/g/:gid/<resource>  (searchable/paginated for lists)
    const readM = /^\/([^/]+)$/.exec(sub);
    if (method === 'GET' && readM) return this.onGuildRead(res, session, guildId, readM[1], url);

    // Mutations below: handle() has already checked the CSRF token (I2).

    // POST /admin/g/:gid/invites  (mint)
    if (method === 'POST' && sub === '/invites') {
      return this.mintInvite(res, session, guildId, await readJson(req));
    }
    // DELETE /admin/g/:gid/invites/:code  (revoke)
    const invDel = /^\/invites\/([^/]+)$/.exec(sub);
    if (method === 'DELETE' && invDel) {
      return this.revokeInvite(res, session, guildId, decodeURIComponent(invDel[1]));
    }
    // POST /admin/g/:gid/personas/:id/roles  (assign)
    const roleAdd = /^\/personas\/([^/]+)\/roles$/.exec(sub);
    if (method === 'POST' && roleAdd) {
      return this.assignRole(res, session, guildId, decodeURIComponent(roleAdd[1]), await readJson(req));
    }
    // DELETE /admin/g/:gid/personas/:id/roles/:role  (revoke)
    const roleDel = /^\/personas\/([^/]+)\/roles\/([^/]+)$/.exec(sub);
    if (method === 'DELETE' && roleDel) {
      return this.revokeRole(res, session, guildId, decodeURIComponent(roleDel[1]), decodeURIComponent(roleDel[2]));
    }
    // PUT /admin/g/:gid/personas/:id/grants  (set a direct grant or the
    // guild-wide level in G: one target, one operation)
    const grantSet = /^\/personas\/([^/]+)\/grants$/.exec(sub);
    if (method === 'PUT' && grantSet) {
      return this.setGrant(res, session, guildId, decodeURIComponent(grantSet[1]), await readJson(req));
    }
    // DELETE /admin/g/:gid/personas/:id/grants?channelId= | ?guildDefault=deny|unset
    // (optional JSON body: {expect, batchId})
    if (method === 'DELETE' && grantSet) {
      return this.clearGrant(res, session, guildId, decodeURIComponent(grantSet[1]), url.searchParams, await readJson(req));
    }
    // POST /admin/g/:gid/personas/:id/claim  (admin-initiated augment)
    const claim = /^\/personas\/([^/]+)\/claim$/.exec(sub);
    if (method === 'POST' && claim) {
      return this.claimForPersona(res, session, guildId, decodeURIComponent(claim[1]), await readJson(req));
    }
    // POST /admin/g/:gid/personas/:id/remove  (what slash /ban does in G)
    const remove = /^\/personas\/([^/]+)\/remove$/.exec(sub);
    if (method === 'POST' && remove) {
      return this.removePersonaFromGuild(res, session, guildId, decodeURIComponent(remove[1]));
    }
    // POST /admin/g/:gid/personas/:id/resync  (what slash /resync does, rate limited)
    const resync = /^\/personas\/([^/]+)\/resync$/.exec(sub);
    if (method === 'POST' && resync) {
      return this.resyncPersona(res, session, guildId, decodeURIComponent(resync[1]));
    }
    // NB: persona token lifecycle is intentionally NOT here — it's a global,
    // super-admin-only action at /admin/personas/:id/token (RFC-005 §5.9).

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  }

  // ── Auth flow ──

  /**
   * Start a sign-in: a fresh state, kept server-side and in a cookie of its
   * own in this browser, next to the (at most two) other live sign-ins it
   * has in flight, so a second tab doesn't break the first. Only this
   * browser's own state cookies are touched: the new one is set; ones the
   * server no longer has, and past the cap the oldest, are deleted by name.
   * ?reauth=1 only marks the login.ok record. Rate limited per client
   * address, and the state is counted against that address
   * (SessionStore.issueState), so no one can start enough sign-ins to push
   * out everyone else's.
   */
  private onLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const ip = clientIp(req);
    const take = this.loginLimit.take(ip);
    if (!take.ok) {
      if (take.report) this.recordRateLimited(ip, take.report.count, 'login');
      return this.loginFailed(res, 'rate_limited');
    }
    const state = this.sessions.issueState({ reauth: url.searchParams.get('reauth') === '1', client: ip });
    this.setStateCookie(res, state);
    const held = cookieStates(req);
    const live = held
      .filter((h) => h.state !== null && this.sessions.stateStatus(h.state) === 'live')
      .sort((a, b) => (this.sessions.stateIssueOrder(a.state!) ?? 0) - (this.sessions.stateIssueOrder(b.state!) ?? 0));
    const evict = live.slice(0, Math.max(0, live.length - (STATES_PER_BROWSER - 1)));
    for (const h of held) if (!live.includes(h) || evict.includes(h)) clearCookie(res, h.name, '/admin');
    if (getCookie(req, LEGACY_STATE_COOKIE) !== undefined) clearCookie(res, LEGACY_STATE_COOKIE, '/admin');
    redirect(res, authorizeUrl(this.deps.config.oauthClientId, this.deps.config.redirectUri, state));
  }

  /**
   * Discord sends the browser back here. Every outcome is a redirect to the
   * panel: postLoginUrl, or postLoginUrl with a LoginError. Nothing in the
   * redirect comes from the request.
   *
   * Login CSRF: a state is accepted only if this server issued it, it is
   * live and unused, AND this browser holds its HttpOnly state cookie.
   */
  private async onCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Per client address, before anything else is looked at.
    const ip = clientIp(req);
    const take = this.callbackLimit.take(ip);
    if (!take.ok) {
      if (take.report) this.recordRateLimited(ip, take.report.count);
      return this.loginFailed(res, 'rate_limited');
    }

    const q = url.searchParams;
    const state = q.get('state') || undefined;
    const code = q.get('code') || undefined;

    // 1. Discord says the sign-in didn't happen (Cancel on its consent
    //    screen, or its own error). No state cookie is touched: other tabs'
    //    sign-ins go on.
    const discordError = q.get('error');
    if (discordError !== null) {
      if (discordError === 'access_denied') {
        this.recordLoginFailed({ reason: 'cancelled' });
        return this.loginFailed(res, 'cancelled');
      }
      this.recordLoginFailed({ reason: 'discord_error', discordError: DISCORD_ERRORS.has(discordError) ? discordError : 'other' });
      return this.loginFailed(res, 'discord_error');
    }

    // 2. Back (or a reload) onto a callback already used, while signed in:
    //    home, as is. The code is never looked at, so a code sent from
    //    elsewhere can't replace a signed-in browser's session.
    const mine = hasStateCookie(req, state);
    const current = this.sessions.get(getCookie(req, SESSION_COOKIE));
    if (current && (!state || !mine || this.sessions.stateStatus(state) === 'unknown')) {
      return redirect(res, this.deps.config.postLoginUrl);
    }

    // 3. The state: started in this browser, by this server, recently. A
    //    failure touches no cookie, so a junk callback can't end another
    //    tab's sign-in.
    if (!state || !mine) {
      this.recordLoginFailed({ reason: 'mismatch' });
      return this.loginFailed(res, 'mismatch');
    }
    if (!code) {
      // Discord always sends a code or an error; keep the state for a retry.
      this.recordLoginFailed({ reason: 'discord_error', step: 'callback' });
      return this.loginFailed(res, 'discord_error');
    }
    // Unknown here: used already, never issued, or issued before a restart.
    const used = this.sessions.consumeState(state);
    if (!used.ok) {
      this.recordLoginFailed({ reason: 'expired', stateStatus: used.why });
      return this.loginFailed(res, 'expired');
    }

    // 4. Who is this, and what do they administer?
    let result;
    try {
      result = await completeOAuth(
        {
          clientId: this.deps.config.oauthClientId,
          clientSecret: this.deps.config.oauthClientSecret,
          redirectUri: this.deps.config.redirectUri,
          code,
        },
        this.fetchImpl,
      );
    } catch (e) {
      const why = e instanceof OAuthError
        ? { step: e.step, failure: e.failure, ...(e.status !== undefined ? { status: e.status } : {}) }
        : { step: 'unknown', failure: 'other' };
      this.recordLoginFailed({ reason: 'discord_error', ...why });
      return this.loginFailed(res, 'discord_error');
    }
    const userName = result.user.global_name || result.user.username;

    // 5. Eligibility.
    const isSuper = this.deps.config.superadmins.includes(result.user.id);
    // Per-guild operator allowlist (RFC-005 §5.3): grant guild-admin for guilds
    // that explicitly list this user, even when their live Discord perms don't
    // qualify (e.g. a role with most perms but not Manage Server). Scoped to the
    // named guilds only — strictly narrower than super-admin.
    const claimed = new Set(result.adminGuilds);
    const guildNames: Record<string, string> = { ...result.guildNames };
    for (const [gid, uids] of Object.entries(this.deps.config.guildAdmins ?? {})) {
      if (!uids.includes(result.user.id)) continue;
      claimed.add(gid);
      if (!guildNames[gid]) {
        const g = this.deps.listGuilds().find((x) => x.id === gid);
        if (g) guildNames[gid] = g.name;
      }
    }
    // Only guilds this relay SERVES count: Discord reports admin rights for
    // every server the user owns or runs, and none of those is administered
    // here. Someone who administers no served guild gets no session at all.
    // The session keeps everything the user administers; what it may manage is
    // checked LIVE against the served set (canManageGuild, onMe, onGuilds), so
    // a guild that becomes served mid-session appears without a re-login.
    const adminGuilds = claimed;
    if (!isSuper && ![...adminGuilds].some((gid) => this.isServed(gid))) {
      this.audit.append({
        actor: { id: result.user.id, name: userName, kind: 'admin' },
        action: 'login.denied',
        ok: false,
        detail: { reason: 'no_manageable_guild' },
      });
      return this.loginFailed(res, 'not_admin');
    }

    // 6. Signed in. The state is spent, and so is its cookie — only its own:
    //    a sign-in another tab started while Discord was answering keeps its
    //    cookie. A session this browser already had (the same admin signing
    //    in again, or another one) ends here.
    clearCookie(res, stateCookieName(state), '/admin');
    if (current) this.sessions.destroy(current.id);
    const session = this.sessions.create({
      userId: result.user.id,
      userName,
      adminGuilds,
      guildNames,
      isSuper,
    });
    setCookie(res, SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: this.deps.config.cookieSecure,
      sameSite: 'Lax',
      maxAge: Math.floor(this.deps.config.sessionTtlMs / 1000),
      path: '/admin',
    });
    this.audit.append({
      actor: { id: session.userId, name: session.userName, kind: 'admin' },
      action: 'login.ok',
      ok: true,
      detail: { isSuper, adminGuilds: [...adminGuilds], ...(used.reauth ? { reauth: true } : {}) },
    });
    redirect(res, this.deps.config.postLoginUrl);
  }

  /** `state`'s own cookie. Max-Age is a sign-in's lifetime (600 s). */
  private setStateCookie(res: ServerResponse, state: string): void {
    setCookie(res, stateCookieName(state), state, {
      httpOnly: true,
      secure: this.deps.config.cookieSecure,
      sameSite: 'Lax',
      maxAge: Math.floor(STATE_TTL_MS / 1000),
      path: '/admin',
    });
  }

  /** A callback that came back without a session. `detail` holds only fixed
   *  words and numbers (reason, step, failure, an HTTP status). */
  private recordLoginFailed(detail: Record<string, string | number>): void {
    this.audit.append({ actor: UNKNOWN_ACTOR, action: 'login.failed', ok: false, detail });
  }

  /** At most one a minute per address and step (LoginRateLimit decides
   *  when). A refused start of a sign-in says step 'login'; a refused
   *  callback says nothing more. */
  private recordRateLimited(ip: string, count: number, step?: 'login'): void {
    this.audit.append({ actor: UNKNOWN_ACTOR, action: 'login.rate_limited', ok: false, detail: { ip, count, ...(step ? { step } : {}) } });
  }

  private onLogout(req: IncomingMessage, res: ServerResponse, session: AdminSession): void {
    this.sessions.destroy(session.id);
    clearCookie(res, SESSION_COOKIE, '/admin');
    sendJson(res, 200, { ok: true });
  }

  private onMe(res: ServerResponse, session: AdminSession): void {
    sendJson(res, 200, {
      user: { id: session.userId, name: session.userName },
      isSuper: session.isSuper,
      guilds: [...session.adminGuilds]
        .filter((id) => session.isSuper || this.isServed(id))
        .map((id) => ({ id, name: session.guildNames[id] ?? id })),
      // CSRF token the SPA echoes in the X-CSRF-Token header on mutations.
      csrf: session.csrf,
      // The panel's model of the relay: levels and capabilities as the relay
      // defines them (it keeps a copy for an older relay), which optional
      // parts are switched on, and when this session ends.
      apiVersion: ADMIN_API_VERSION,
      levels: LEVEL_CAPS,
      caps: ALL_CAPS,
      features: {
        invites: !!this.deps.invites,
        avatarUploads: !!this.deps.config.avatarDir,
        allowlistEditable: this.deps.allowlist.editable,
      },
      session: { expiresAt: session.expiresAt },
    });
  }

  // ── Guild-scoped reads ──

  private async onGuildRead(res: ServerResponse, session: AdminSession, guildId: string, resource: string, url: URL): Promise<void> {
    const page = parsePage(url);
    switch (resource) {
      case 'invites': {
        const want = url.searchParams.get('status') ?? 'all';
        if (want !== 'all' && want !== 'active' && want !== 'spent') {
          return sendJson(res, 400, err('INVALID', 'status must be active, spent or all'));
        }
        const now = this.nowMs();
        const rows = this.invitesFor(guildId, page.q, session.isSuper)
          .reverse() // newest first: the store keeps them in the order they were made
          .map((inv) => ({ ...inv, status: this.inviteStatus(inv.code, now) }))
          .filter((inv) => want === 'all' || (want === 'active') === (inv.status === 'active'));
        const body = paginate(rows, page, 'invites');
        const scopes = (body.invites as any[]).map((inv) => inv?.grant?.scope);
        return sendJson(res, 200, { ...body, names: await this.scopeNames(scopes, guildId) });
      }
      case 'roles': {
        const catalog = this.deps.permissions.allRoles();
        // Names only when the Roles tab asks (`?names=1`) — pickers load this
        // endpoint too and don't show scopes. The catalog is global; a
        // guild-admin gets names for this guild's roles only (others stay ids).
        let names: NameMaps | undefined;
        if (url.searchParams.get('names') === '1') {
          const clip = session.isSuper ? undefined : guildId;
          const roles = (Object.values(catalog) as Array<{ scope?: unknown; guildId?: string }>)
            .filter((r) => !clip || r.guildId === clip);
          names = await this.scopeNames(roles.map((r) => r.scope), clip);
          names.guilds = this.guildNames(roles.map((r) => r.guildId), clip);
        }
        return sendJson(res, 200, {
          // The catalog is global; a guild-admin sees only G's own roles.
          catalog: session.isSuper
            ? catalog
            : Object.fromEntries(Object.entries(catalog).filter(([, r]) => (r as { guildId?: string }).guildId === guildId)),
          discordRoles: this.deps.listRoles(guildId),
          // Whether this admin may edit the catalog (super-admin only, §5.3).
          canAuthor: session.isSuper,
          ...(names ? { names } : {}),
        });
      }
      case 'personas':
        return sendJson(res, 200, paginate(this.personasFor(guildId, page.q, session.isSuper), page, 'personas'));
      case 'channels':
        return sendJson(res, 200, this.channelsView(guildId));
      case 'persona-directory':
        return this.onPersonaDirectory(res, guildId, url);
      case 'audit': {
        const records = this.audit.read({ guildId, limit: page.limit }).map((r) => this.auditView(r, guildId, session.isSuper));
        return sendJson(res, 200, { records, names: await this.auditNames(records, guildId) });
      }
      default:
        return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such resource' } });
    }
  }

  /** Drawer detail for one persona in a guild: roles + the G-scoped policy
   *  block, with names for the channels its ad-hoc grants target. */
  private async onPersonaDetail(res: ServerResponse, session: AdminSession, guildId: string, personaId: string): Promise<void> {
    const p = this.deps.identity.get(personaId);
    if (!p) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const entry = this.deps.permissions.getEntry(personaId);
    const guildPolicy = entry?.policy?.guilds?.[guildId] ?? null;
    const labels = await this.channelLabels(Object.keys(guildPolicy?.channels ?? {}));
    sendJson(res, 200, {
      id: p.id,
      displayName: p.displayName,
      roles: this.rolesVisibleIn(guildId, entry?.roles ?? [], session.isSuper),
      ...(session.isSuper ? { otherGuildRoleCount: this.otherGuildRoleCount(guildId, entry?.roles ?? []) } : {}),
      guildPolicy,
      // Removed from G with /ban: nothing it holds applies in G until an
      // admin of G gives it access again.
      banned: this.deps.permissions.isBanned(personaId, guildId),
      names: { channels: clipToGuild(labels, guildId) } satisfies NameMaps,
    });
  }

  // ── Effective access (access.ts): what the relay enforces, and why ──

  /** G's channels with their place in Discord's sidebar (category, position,
   *  announcement), whether each can hold a direct grant, and the categories. */
  private channelsView(guildId: string) {
    const layout = new Map(this.deps.listChannelLayout(guildId).map((l) => [l.id, l] as const));
    const channels = this.deps.listChannels(guildId).map((c) => {
      const l = layout.get(c.id);
      return { ...c, categoryId: l?.categoryId ?? null, position: l?.position ?? 0, announcement: !!l?.announcement, grantable: isGrantable(c.type) };
    });
    const categories = channels.filter((c) => c.type === 'category').map((c) => ({ id: c.id, name: c.name ?? null, position: c.position }));
    return { channels, categories };
  }

  /** The personas an access read looks at in G: everyone who could have
   *  anything there, and everyone with a setting there (a deny, a block, a
   *  /ban) — never anyone else. */
  private candidates(guildId: string): PersonaIdentity[] {
    return this.deps.identity.all().filter(
      (p) => this.deps.permissions.getPolicy(p.id)?.guilds?.[guildId] !== undefined || this.deps.canAccessGuild(p.id, guildId),
    );
  }

  /** One persona in one channel, as the relay enforces it: the model's
   *  explanation, whose `effective` is checked against capsFor itself. They
   *  agree (test/access.test.ts); if they ever don't, the relay's answer is
   *  what is shown, and it is said loudly once. */
  private enforced(a: AccessDeps, s: Subject, channelId: string, bot: ReadonlySet<Capability>): Explained {
    const ex = explainFor(a, s, channelId, bot);
    const relay = this.deps.capsFor(s.personaId, channelId, s.guildId);
    if (sameCaps(ex.effective, relay)) return ex;
    if (!this.driftReported) {
      this.driftReported = true;
      console.error(`[portal-admin] effective access drifted from capsFor (persona ${s.personaId}, channel ${channelId}): showing capsFor; please report`);
    }
    const effective = ALL_CAPS.filter((c) => relay.includes(c));
    return { ...ex, effective, ...levelOf(effective) };
  }

  /** What a grant change's answer says the persona can do now: in the
   *  channel, or (guild-wide) how many of G's channels at each level, and
   *  how many of those through a direct grant.
   *
   *  In a channel it is read where the relay checks it: a thread's actions
   *  are checked against its parent (permChannelId), so a thread answers
   *  with its parent's explanation and says so (parentId). A channel that
   *  isn't one of G's channels in Discord's cache now (deleted, say) answers
   *  {missing: true}: there is no channel to explain, and capsFor's answer
   *  without one (the policy-only edit/delete own) would read as access in
   *  a channel that isn't there. */
  private effectAfter(
    personaId: string,
    guildId: string,
    channelId: string | undefined,
  ): (Explained & { parentId?: string }) | { missing: true } | { guildWide: true; channels: number; counts: LevelCounts; direct: LevelCounts } {
    const a = accessDepsOf(this.deps);
    const s = subjectOf(a, personaId, guildId);
    if (channelId !== undefined) {
      const at = this.deps.permChannelId(channelId);
      if (!this.deps.listChannels(guildId).some((c) => c.id === at)) return { missing: true };
      const ex = this.enforced(a, s, at, new Set(this.deps.botCaps(guildId, at)));
      return at === channelId ? ex : { ...ex, parentId: at };
    }
    const counts = zeroCounts();
    const direct = zeroCounts();
    let channels = 0;
    for (const ch of this.deps.listChannels(guildId)) {
      if (!holdsAccess(ch.type)) continue;
      channels++;
      const ex = this.enforced(a, s, ch.id, new Set(this.deps.botCaps(guildId, ch.id)));
      const level = countedLevel(ex.effective);
      if (!level) continue;
      counts[level]++;
      if (ex.direct?.length) direct[level]++;
    }
    return { guildWide: true, channels, counts, direct };
  }

  /**
   * GET …/access/summary — for each channel of G with access of its own
   * (holdsAccess: any kind but a thread or a category, kinds the panel can't
   * give access on included), how many personas can act there at each level
   * (counted where they can see it, as /list counts), and the bot's own
   * ceiling there and what of Write it lacks; for each persona, in how many
   * channels. Reused for SUMMARY_TTL_MS, dropped by any permissions
   * change. Past ACCESS_CELL_CAP personas × channels the counts are left out.
   */
  private onAccessSummary(res: ServerResponse, guildId: string): void {
    const t0 = performance.now();
    const now = this.nowMs();
    const hit = this.summaries.get(guildId);
    if (hit && now - hit.at < SUMMARY_TTL_MS && now >= hit.at) return sendJson(res, 200, hit.body, timing(t0));
    const channelIds = this.deps.listChannels(guildId).filter((c) => holdsAccess(c.type)).map((c) => c.id);
    const personaIds = this.candidates(guildId).map((p) => p.id);
    const body = {
      ...accessSummary(accessDepsOf(this.deps), guildId, channelIds, personaIds, this.accessCellCap),
      computedAt: new Date(now).toISOString(),
    };
    this.summaries.set(guildId, { at: now, body });
    sendJson(res, 200, body, timing(t0));
  }

  /**
   * GET …/channels/:cid/access — who can act in one channel of G, at what
   * level and why. A thread answers with its parent (it uses the parent's
   * access), a category with its channels (it grants nothing). A channel
   * that isn't G's — deleted, hidden from the bot, another guild's — is the
   * same 404.
   */
  private async onChannelAccess(res: ServerResponse, guildId: string, channelId: string): Promise<void> {
    const t0 = performance.now();
    const list = this.deps.listChannels(guildId);
    const ch = list.find((c) => c.id === channelId);
    if (!ch) return sendJson(res, 404, err('NOT_FOUND', 'no such channel in this guild'), timing(t0));
    const view = this.channelsView(guildId);
    const channel = view.channels.find((c) => c.id === channelId)!;
    const label = (id: string | null | undefined): Record<string, ChannelLabel> => {
      const c = id ? list.find((x) => x.id === id) : undefined;
      return c ? { [c.id]: { id: c.id, name: c.name ?? null, type: c.type as ChannelLabel['type'], guildId, ...(c.parentId ? { parentId: c.parentId } : {}) } } : {};
    };
    const own = { ...label(ch.id), ...label(ch.parentId), ...label(channel.categoryId) };
    if (ch.type === 'thread') {
      return sendJson(res, 200, { channel, inert: 'thread', parentId: ch.parentId ?? null, names: { channels: own } }, timing(t0));
    }
    if (ch.type === 'category') {
      const inside = view.channels.filter((c) => c.categoryId === ch.id).sort((x, y) => x.position - y.position || cmp(x.id, y.id));
      const names: Record<string, ChannelLabel> = { ...own };
      for (const c of inside) Object.assign(names, label(c.id));
      return sendJson(res, 200, { channel, inert: 'category', channels: inside.map((c) => c.id), names: { channels: names } }, timing(t0));
    }
    const a = accessDepsOf(this.deps);
    const botList = this.deps.botCaps(guildId, channelId);
    const bot = new Set(botList);
    const rows = [];
    const mirrored = new Set<string>();
    for (const p of this.candidates(guildId)) {
      const ex = this.enforced(a, subjectOf(a, p.id, guildId), channelId, bot);
      if (!ex.effective.length && ex.direct === null) continue;
      for (const id of mirrorIds(ex.sources)) mirrored.add(id);
      rows.push({ personaId: p.id, displayName: p.displayName, avatarUrl: this.deps.identity.avatarUrl(p), ...rowOf(ex) });
    }
    rows.sort((x, y) => cmp(x.displayName.toLowerCase(), y.displayName.toLowerCase()) || cmp(x.personaId, y.personaId));
    sendJson(res, 200, {
      channel,
      botCaps: ALL_CAPS.filter((c) => bot.has(c)),
      botBase: levelOf(botList).base,
      rows,
      names: { channels: own, discordRoles: this.roleLabels(mirrored, guildId) } satisfies NameMaps,
    }, timing(t0));
  }

  /**
   * GET …/personas/:pid/access — one persona in G: its guild-wide setting
   * and persona default (as caps here), what it can do in each channel with
   * access of its own (holdsAccess — a kind the panel can't give access on
   * too, where a direct grant stored there is a row) and why, the direct
   * grants that do nothing (on a thread,
   * a category, a channel G no longer has, or a block with nothing to
   * block), and the access roles of G it holds, with in how many channels
   * each gives something.
   */
  private async onPersonaAccess(res: ServerResponse, session: AdminSession, guildId: string, personaId: string): Promise<void> {
    const t0 = performance.now();
    const p = this.deps.identity.get(personaId);
    if (!p) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'), timing(t0));
    const a = accessDepsOf(this.deps);
    const s = subjectOf(a, personaId, guildId);
    const list = this.deps.listChannels(guildId);
    const byId = new Map(list.map((c) => [c.id, c] as const));
    const pol = s.entry?.policy;
    const g = pol?.guilds?.[guildId];
    const rows = [];
    const roleChannels = new Map<string, number>();
    for (const ch of list) {
      if (!holdsAccess(ch.type)) continue;
      const ex = this.enforced(a, s, ch.id, new Set(this.deps.botCaps(guildId, ch.id)));
      for (const src of ex.sources) if (src.kind === 'role') roleChannels.set(src.name, (roleChannels.get(src.name) ?? 0) + 1);
      if (!ex.effective.length && ex.direct === null) continue;
      rows.push({ channelId: ch.id, ...rowOf(ex) });
    }
    // Direct grants that do nothing. A channel not in G's list may be an
    // archived thread: the name resolver knows (and says nothing of another
    // guild's channel).
    const away = Object.keys(g?.channels ?? {}).filter((cid) => !byId.has(cid));
    const labels = clipToGuild(await this.channelLabels(away), guildId);
    // Anything not known to be G's reads alike: deleted, hidden, elsewhere.
    for (const cid of away) if (labels[cid]?.guildId !== guildId) labels[cid] = { id: cid, name: null, unavailable: true };
    const blocks = blocksSomething(g, pol);
    const inactive: Array<{ channelId: string; caps: Capability[]; reason: InactiveReason }> = [];
    for (const [cid, caps] of Object.entries(g?.channels ?? {})) {
      const reason = inactiveReason(caps, byId.get(cid)?.type ?? labels[cid]?.type, byId.has(cid), blocks);
      if (reason) inactive.push({ channelId: cid, caps, reason });
    }
    const roles = (s.entry?.roles ?? [])
      .filter((name, i, all) => all.indexOf(name) === i && this.deps.permissions.getRole(name)?.guildId === guildId)
      .map((name) => {
        const r = this.deps.permissions.getRole(name)!;
        return { name, caps: r.caps, scope: r.scope, guildId: r.guildId, ...(r.mirrorCaps ? { mirrorCaps: true } : {}), channels: roleChannels.get(name) ?? 0 };
      });
    const names: Record<string, ChannelLabel> = { ...labels };
    const scoped = new Set<string>([...rows.map((r) => r.channelId), ...inactive.map((x) => x.channelId)]);
    const mirrored = new Set<string>();
    for (const r of roles) {
      const sc = r.scope as { channels?: string[]; mirrorRole?: string; mirrorRoles?: string[] };
      for (const cid of sc.channels ?? []) scoped.add(cid);
      for (const id of sc.mirrorRoles ?? (sc.mirrorRole ? [sc.mirrorRole] : [])) mirrored.add(id);
    }
    for (const cid of scoped) {
      const c = byId.get(cid);
      if (c) names[cid] = { id: c.id, name: c.name ?? null, type: c.type as ChannelLabel['type'], guildId, ...(c.parentId ? { parentId: c.parentId, parentName: byId.get(c.parentId)?.name ?? null } : {}) };
      else if (!names[cid]) names[cid] = { id: cid, name: null, unavailable: true };
    }
    const fileDefault = this.deps.permissions.getFileDefault();
    sendJson(res, 200, {
      persona: { id: p.id, displayName: p.displayName, avatarUrl: this.deps.identity.avatarUrl(p) },
      // Removed from G with /ban: nothing it holds applies in G.
      removed: !!s.entry?.bans?.includes(guildId),
      guildWide: g?.default === undefined ? null : g.default.length ? g.default : 'deny',
      // The persona default applies in every guild; here only its caps are shown.
      personaDefault: pol?.default?.length ? pol.default : null,
      relayDefault: !s.entry && fileDefault.length ? fileDefault : null,
      rows,
      inactive,
      roles,
      ...(session.isSuper ? { otherGuildRoleCount: this.otherGuildRoleCount(guildId, s.entry?.roles ?? []) } : {}),
      names: { channels: names, discordRoles: this.roleLabels(mirrored, guildId) } satisfies NameMaps,
    }, timing(t0));
  }

  /**
   * GET …/persona-directory?q= — personas to pick from (to add one to G):
   * the people slash /add autocomplete offers, at most 25, with only id,
   * name, picture, whether it has access in G already, and `removed: true`
   * for one removed from G with /ban (giving it access here lifts that).
   * Matches id or name anywhere (any case): an exact id first, then names
   * starting with q, then the rest, each alphabetically. No q: the first 25
   * alphabetically.
   *
   * ?ids=a,b — those personas instead (at most 25, in that order; unknown
   * ids are left out): a form put back after "Sign in again" kept only ids.
   */
  private onPersonaDirectory(res: ServerResponse, guildId: string, url: URL): void {
    const t0 = performance.now();
    const ids = url.searchParams.get('ids');
    let found: PersonaIdentity[];
    if (ids !== null) {
      found = [...new Set(ids.split(','))]
        .slice(0, DIRECTORY_ROWS)
        .map((id) => (id ? this.deps.identity.get(id) : undefined))
        .filter((p): p is PersonaIdentity => !!p);
    } else {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100).toLowerCase();
      const alpha = (x: PersonaIdentity, y: PersonaIdentity) =>
        cmp(x.displayName.toLowerCase(), y.displayName.toLowerCase()) || cmp(x.id, y.id);
      const rank = (p: PersonaIdentity) => (p.id.toLowerCase() === q ? 0 : p.displayName.toLowerCase().startsWith(q) ? 1 : 2);
      found = this.deps.identity
        .all()
        .filter((p) => !q || p.id.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q))
        .sort((x, y) => (q ? rank(x) - rank(y) : 0) || alpha(x, y))
        .slice(0, DIRECTORY_ROWS);
    }
    sendJson(res, 200, {
      personas: found.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        avatarUrl: this.deps.identity.avatarUrl(p),
        hasAccessHere: this.deps.canAccessGuild(p.id, guildId),
        ...(this.deps.permissions.isBanned(p.id, guildId) ? { removed: true } : {}),
      })),
    }, timing(t0));
  }

  /** Invites scoped to a guild (those whose `guildId` matches), optional
   *  search over code and label — in the store's order, oldest first. */
  private invitesFor(guildId: string, q?: string, isSuper = true): any[] {
    const all = this.deps.invites?.all() ?? [];
    return all
      .filter((inv) => inv.guildId === guildId)
      .filter((inv) => isSuper || !this.hasForeignRole(inv.roles ?? [], guildId))
      .filter((inv) => !q || matches(q, inv.code, inv.label));
  }

  /** Active, used up, or expired — as the relay judges an invite when it is
   *  used (InviteStore.check: an unreadable expiry counts as expired, and
   *  expiry is checked before uses). */
  private inviteStatus(code: string, now: number): 'active' | 'used' | 'expired' {
    const c = this.deps.invites?.check(code, now);
    return c === 'expired' || c === 'unknown' || c === undefined ? 'expired' : c === 'exhausted' ? 'used' : 'active';
  }

  /** Access roles a persona holds that belong to another guild than G
   *  (a super-admin's '+N roles in other guilds'). */
  private otherGuildRoleCount(guildId: string, roles: string[]): number {
    return roles.filter((r) => {
      const g = this.deps.permissions.getRole(r)?.guildId;
      return g !== undefined && g !== guildId;
    }).length;
  }

  /** Personas with any possible access in the guild (trimmed for the table),
   *  with what the list flags: a guild-wide deny, and how many of its direct
   *  grants here do nothing (as …/personas/:pid/access lists them). */
  private personasFor(guildId: string, q?: string, isSuper = false): any[] {
    const byId = new Map(this.deps.listChannels(guildId).map((c) => [c.id, c] as const));
    const inGuild = (cid: string) => byId.has(cid);
    const out: any[] = [];
    for (const p of this.deps.identity.all()) {
      if (!this.deps.permissions.couldAccessGuild(p.id, guildId, inGuild)) continue;
      if (q && !matches(q, p.id, p.displayName)) continue;
      const entry = this.deps.permissions.getEntry(p.id);
      const g = entry?.policy?.guilds?.[guildId];
      const directGrants = directGrantsIn(g);
      const blocks = blocksSomething(g, entry?.policy);
      const inactiveGrants = Object.entries(g?.channels ?? {})
        .filter(([cid, caps]) => inactiveReason(caps, byId.get(cid)?.type, byId.has(cid), blocks) !== null).length;
      out.push({
        id: p.id,
        displayName: p.displayName,
        avatarUrl: this.deps.identity.avatarUrl(p),
        roles: this.rolesVisibleIn(guildId, entry?.roles ?? [], isSuper),
        ...(isSuper ? { otherGuildRoleCount: this.otherGuildRoleCount(guildId, entry?.roles ?? []) } : {}),
        // A grant that gives something here, in a channel or guild-wide.
        hasOverride: directGrants === 'grants',
        directGrants,
        guildWideDenied: Array.isArray(g?.default) && g.default.length === 0,
        inactiveGrants,
      });
    }
    return out;
  }

  // ── Mutations (guild-scoped, CSRF-checked, audited) ──

  private actorOf(session: AdminSession) {
    return { id: session.userId, name: session.userName, kind: 'admin' as const };
  }

  /** A guild-admin may assign/mint only roles bound to their guild; a super-admin
   *  may use any catalog role. Returns an error string, or null if allowed. */
  private roleAssignError(session: AdminSession, guildId: string, name: string): string | null {
    const role = this.deps.permissions.getRole(name);
    if (!role) {
      return this.deps.permissions.isQuarantined(name)
        ? `role ${name} can't be read (it was set aside when the relay loaded it), so the relay's operator must fix it first`
        : `unknown role ${name}`;
    }
    if (session.isSuper) return null;
    if (role.guildId !== guildId) return `role ${name} is not bound to this guild`;
    return null;
  }

  private mintInvite(res: ServerResponse, session: AdminSession, guildId: string, body: any): void {
    if (!this.deps.invites) return sendJson(res, 400, err('DISABLED', 'invites not enabled'));
    // Roles, a grant, a mode, a count, subscriptions or expiresInDays sent as
    // null, '' or false, or roles sent as 0, count as not sent and are left
    // out. Otherwise roles and expiresInDays are checked here, and a mode,
    // count or subscriptions goes in as sent for the shape check below, which
    // refuses a wrong type by name and reads a mode or subscriptions of 0 as
    // none. Dropped instead, a count sent as "5" would be stored as unlimited,
    // a misspelled mode as mint-only, roles that aren't a list as none, and an
    // expiry given as anything but a number of days as never. A grant is read
    // only when no roles are given, and a label that isn't a string becomes
    // 'invite'.
    const given = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false;
    if (given(body?.roles) && body.roles !== 0 && !Array.isArray(body.roles)) {
      return sendJson(res, 400, err('INVALID', 'roles must be a list of access role names'));
    }
    const roles: string[] = Array.isArray(body?.roles) ? body.roles : [];
    // The grant is REBUILT from validated fields, never stored as sent: what an
    // invite confers is applied at enroll/claim time, so anything a caller
    // could smuggle into it here would be granted later.
    let grant: { caps: Capability[]; scope: Scope } | undefined;
    if (!roles.length && given(body?.grant)) {
      const checked = this.checkInviteGrant(session, guildId, body.grant);
      if (typeof checked === 'string') {
        const [, code, message] = /^([A-Z_]+): (.*)$/s.exec(checked) ?? [, 'INVALID', checked];
        return sendJson(res, code === 'FORBIDDEN' ? 403 : 400, err(code!, message!));
      }
      grant = checked;
    }
    if (!roles.length && !grant) return sendJson(res, 400, err('INVALID', 'invite needs roles or a grant'));

    // Guild-admins may only grant access bound to their own guild (§5.3).
    for (const r of roles) {
      const e = this.roleAssignError(session, guildId, r);
      if (e) return sendJson(res, 403, err('FORBIDDEN', e));
    }
    let expiresAt: string | undefined;
    if (given(body?.expiresInDays)) {
      const days = body.expiresInDays;
      if (typeof days !== 'number' || !(days > 0)) {
        return sendJson(res, 400, err('INVALID', 'expiresInDays must be a number of days above 0, or left out for an invite that never expires'));
      }
      const at = new Date(this.nowMs() + days * 86_400_000);
      if (Number.isNaN(at.getTime())) return sendJson(res, 400, err('INVALID', 'expiresInDays is too far ahead to be a date'));
      expiresAt = at.toISOString();
    }
    const template: any = {
      code: this.deps.newInviteCode(),
      label: typeof body?.label === 'string' ? body.label : 'invite',
      guildId,
      uses: 0,
      ...(roles.length ? { roles } : { grant: grant! }),
      ...(given(body?.mode) ? { mode: body.mode } : {}),
      ...(given(body?.maxUses) ? { maxUses: body.maxUses } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(given(body?.subscriptions) ? { subscriptions: body.subscriptions } : {}),
    };
    // A shape a claim would refuse isn't stored: a count of 0 or below would be
    // a dead invite reported as minted, and a non-string channel id would
    // fail every enrollment through it.
    const shape = inviteShapeProblem(template);
    if (shape) return sendJson(res, 400, err('INVALID', shape));
    let inv;
    try {
      inv = this.deps.invites.mint(template);
    } catch (e) {
      return sendJson(res, 409, err('CONFLICT', (e as Error).message));
    }
    this.audit.append({ actor: this.actorOf(session), action: 'invite.mint', target: inv.code, guildId, ok: true, after: inv });
    sendJson(res, 200, { code: inv.code, invite: inv });
  }

  private revokeInvite(res: ServerResponse, session: AdminSession, guildId: string, code: string): void {
    const inv = this.deps.invites?.get(code);
    if (!inv || inv.guildId !== guildId) return sendJson(res, 404, err('NOT_FOUND', 'no such invite in this guild'));
    if (!session.isSuper && this.hasForeignRole(inv.roles ?? [], guildId)) {
      return sendJson(res, 404, err('NOT_FOUND', 'no such invite in this guild'));
    }
    this.deps.invites!.revoke(code);
    this.audit.append({ actor: this.actorOf(session), action: 'invite.revoke', target: code, guildId, ok: true, before: inv });
    sendJson(res, 200, { ok: true });
  }

  private assignRole(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const name = body?.role;
    if (typeof name !== 'string' || !name) return sendJson(res, 400, err('INVALID', 'role required'));
    const e = this.roleAssignError(session, guildId, name);
    if (e) return sendJson(res, 403, err('FORBIDDEN', e));
    // An admin granting access in the role's guild ends a /ban there — only
    // when asked to ({liftBan: true}); otherwise 409 BANNED, nothing given,
    // so a pick made in a view loaded before the removal can't lift it.
    const role = this.deps.permissions.getRole(name);
    const lifts = !!role?.guildId && roleGrantsAccess(role) && this.deps.permissions.isBanned(personaId, role.guildId);
    if (lifts && body?.liftBan !== true) {
      return sendJson(res, 409, err('BANNED', 'this persona was removed from this guild (slash /ban or Remove in the panel); this role lifts that — send liftBan: true to do it'));
    }
    const liftedBan = lifts ? this.deps.permissions.liftBan(personaId, role!.guildId!) : false;
    const roles = this.deps.permissions.addPersonaRoles(personaId, [name]);
    this.audit.append({ actor: this.actorOf(session), action: 'persona.role.assign', target: personaId, guildId, ok: true, after: { role: name, ...(liftedBan ? { liftedBan } : {}) } });
    sendJson(res, 200, { roles: this.rolesVisibleIn(guildId, roles, session.isSuper), banned: this.deps.permissions.isBanned(personaId, guildId) });
  }

  private revokeRole(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, role: string): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    // A guild-admin may only revoke roles bound to their guild (super: any). A
    // role set aside at load is still held by name, so it can be revoked too,
    // by an admin of the guild its entry names.
    const setAside = !this.deps.permissions.getRole(role) && this.deps.permissions.isQuarantined(role);
    const e = setAside
      ? (session.isSuper || this.deps.permissions.quarantinedGuildId(role) === guildId ? null : `role ${role} is not bound to this guild`)
      : this.roleAssignError(session, guildId, role);
    if (e) return sendJson(res, 403, err('FORBIDDEN', e));
    const roles = this.deps.permissions.removePersonaRole(personaId, role);
    this.audit.append({ actor: this.actorOf(session), action: 'persona.role.revoke', target: personaId, guildId, ok: true, before: { role } });
    sendJson(res, 200, { roles: this.rolesVisibleIn(guildId, roles, session.isSuper) });
  }

  /**
   * Set a direct grant on one channel of G, or G's guild-wide level. The body
   * names exactly one target — {channelId} or {guildDefault: true} — and one
   * operation: {level: read|write|full} (slash's levels), {caps: [...]} (a
   * non-empty set of known capabilities), or {deny: true} (an explicit
   * deny, stored as []). Nothing that would store a grant that does nothing
   * is accepted: empty caps, threads (they use their parent's access) and
   * categories (they grant nothing) are refused with a code the panel words.
   *
   * Optional: {expect} — what the panel last saw there (caps, or null for
   * nothing set); anything else there now is 409 CONFLICT {current}, and
   * nothing is written. {batchId} ties a bulk action's writes together in
   * the audit. The answer says what the persona can do now (`effective`):
   * in that channel, or — guild-wide — how many channels at each level.
   *
   * A persona removed from G (slash /ban, or Remove in the panel) gets
   * access there again only when an admin chooses to lift that: a grant
   * that gives something is refused (409 BANNED, nothing written) unless
   * the request says {liftBan: true}. A write sent from a view loaded before
   * the removal — an Undo, a queued change, another admin's /ban meanwhile —
   * can then never lift it unasked. A deny ({deny: true}) needs no lift.
   */
  private setGrant(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const target = grantTarget(body);
    if ('error' in target) return sendJson(res, 400, target);
    const op = grantOperation(body);
    if ('error' in op) return sendJson(res, 400, op);
    const meta = changeMeta(body);
    if ('error' in meta) return sendJson(res, 400, meta);
    const { channelId } = target;
    if (channelId !== undefined) {
      // The in-guild test runs first, so the type test below only ever
      // describes a channel already proven to be G's (I3).
      const bad = this.grantTargetError(guildId, channelId);
      if (bad) return sendJson(res, bad.status, bad.body);
    }
    const caps = op.caps;
    const before = this.grantAt(personaId, guildId, channelId);
    if (meta.expect !== undefined && !sameCaps(meta.expect, before)) {
      return sendJson(res, 409, err('CONFLICT', 'this was changed since it was loaded', { current: before }));
    }
    // An admin granting access here ends a /ban here (an explicit deny
    // doesn't) — only when the admin was asked and chose to.
    if (caps.length > 0 && !meta.liftBan && this.deps.permissions.isBanned(personaId, guildId)) {
      return sendJson(res, 409, err('BANNED', 'this persona was removed from this guild (slash /ban or Remove in the panel); a grant lifts that — send liftBan: true to do it'));
    }
    const liftedBan = caps.length > 0 && this.deps.permissions.liftBan(personaId, guildId);
    // The guild key written is always the route's G (I3).
    if (channelId !== undefined) this.deps.permissions.setChannel(personaId, guildId, channelId, caps);
    else this.deps.permissions.setGuildDefault(personaId, guildId, caps);
    const guildPolicy = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId] ?? null;
    const where = channelId !== undefined ? { channelId } : { guildDefault: true };
    this.audit.append({
      actor: this.actorOf(session), action: 'persona.grant.set', target: personaId, guildId, ok: true,
      before: { ...where, caps: before },
      after: { ...where, caps, ...(op.level ? { level: op.level } : {}), ...(liftedBan ? { liftedBan } : {}) },
      ...(meta.batchId ? { detail: { batchId: meta.batchId } } : {}),
    });
    const effective = this.effectAfter(personaId, guildId, channelId);
    sendJson(res, 200, {
      guildPolicy,
      banned: this.deps.permissions.isBanned(personaId, guildId),
      // This grant ended a /ban here: the persona's access changed in every channel of G.
      ...(liftedBan ? { liftedBan: true } : {}),
      effective,
      ...this.answerNames(effective, guildId),
    });
  }

  /**
   * Remove a direct grant, or say what G's guild-wide setting becomes:
   *   ?channelId=<id>        remove that channel's direct grant (404 if none)
   *   ?guildDefault=deny     an explicit deny: blocks the persona default in G
   *   ?guildDefault=unset    no guild-wide setting: channels fall back to the
   *                          persona default (404 if none is set)
   * Exactly one of them; a bare DELETE is refused (it used to mean deny).
   *
   * A persona removed from G with /ban has nothing in G, whatever is unset:
   * unsetting would say "falls back to the persona default" and change
   * nothing. So for a banned persona Unset is refused (409 BANNED) unless
   * the request also says &liftBan=1 — the admin, asked, chose to lift it —
   * and then it lifts the ban and unsets, recorded as liftedBan.
   *
   * The optional JSON body takes {expect, batchId}, as setGrant does, and the
   * answer carries `effective` the same way.
   */
  private clearGrant(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, params: URLSearchParams, body: unknown = {}): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const channelId = params.get('channelId');
    const gd = params.get('guildDefault');
    if ((channelId === null) === (gd === null)) {
      return sendJson(res, 400, err('TARGET_REQUIRED', 'give exactly one of ?channelId= or ?guildDefault=deny|unset'));
    }
    if (gd !== null && gd !== 'deny' && gd !== 'unset') {
      return sendJson(res, 400, err('INVALID', 'guildDefault must be deny or unset'));
    }
    const meta = changeMeta(body);
    if ('error' in meta) return sendJson(res, 400, meta);
    const g = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId];
    const where = channelId !== null ? { channelId } : { guildDefault: true };
    const before = this.grantAt(personaId, guildId, channelId ?? undefined);
    if (meta.expect !== undefined && !sameCaps(meta.expect, before)) {
      return sendJson(res, 409, err('CONFLICT', 'this was changed since it was loaded', { current: before }));
    }
    let liftedBan = false;
    if (channelId !== null) {
      // Only a grant that exists can be removed — and only then audited. (An
      // arbitrary id would otherwise land in the audit log, where the panel
      // looks its name up on Discord.)
      if (!Object.prototype.hasOwnProperty.call(g?.channels ?? {}, channelId)) {
        return sendJson(res, 404, err('NOT_FOUND', 'no grant on that channel for this persona in this guild'));
      }
      this.deps.permissions.clearChannel(personaId, guildId, channelId);
    } else if (gd === 'unset') {
      if (g?.default === undefined) {
        return sendJson(res, 404, err('NOT_FOUND', 'this persona has no guild-wide setting in this guild'));
      }
      if (this.deps.permissions.isBanned(personaId, guildId)) {
        if (params.get('liftBan') !== '1') {
          return sendJson(res, 409, err('BANNED', 'this persona was removed from this guild (slash /ban or Remove in the panel); unsetting lifts that — send liftBan=1 to do it'));
        }
        liftedBan = this.deps.permissions.liftBan(personaId, guildId);
      }
      this.deps.permissions.unsetGuildDefault(personaId, guildId);
    } else {
      this.deps.permissions.setGuildDefault(personaId, guildId, []);
    }
    const guildPolicy = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId] ?? null;
    this.audit.append({
      actor: this.actorOf(session), action: 'persona.grant.clear', target: personaId, guildId, ok: true,
      before: { ...where, caps: before },
      // null: nothing set there any more; []: an explicit deny.
      after: { ...where, caps: gd === 'deny' ? [] : null, ...(liftedBan ? { liftedBan } : {}) },
      ...(meta.batchId ? { detail: { batchId: meta.batchId } } : {}),
    });
    const effective = this.effectAfter(personaId, guildId, channelId ?? undefined);
    sendJson(res, 200, {
      guildPolicy,
      banned: this.deps.permissions.isBanned(personaId, guildId),
      effective,
      ...this.answerNames(effective, guildId),
    });
  }

  /** The names a change's answer needs when it explains a channel: the
   *  Discord roles its mirror sources follow (G's only), so the panel never
   *  shows a role it hadn't seen as an id. */
  private answerNames(effective: ReturnType<AdminServer['effectAfter']>, guildId: string): { names?: NameMaps } {
    if (!('sources' in effective)) return {};
    return { names: { discordRoles: this.roleLabels(mirrorIds(effective.sources), guildId) } };
  }

  /** What a persona's own setting at one target of G is now: a channel's
   *  direct grant, or (no channel) G's guild-wide level; null when unset. */
  private grantAt(personaId: string, guildId: string, channelId: string | undefined): Capability[] | null {
    const g = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId];
    if (channelId === undefined) return g?.default ?? null;
    return g?.channels && Object.prototype.hasOwnProperty.call(g.channels, channelId) ? g.channels[channelId] : null;
  }

  /**
   * Why `channelId` can't hold access in G, or null. In-guild first (403, the
   * same answer for a channel of another guild and one that doesn't exist),
   * then its kind: a thread uses its parent's access (THREAD_TARGET, with
   * the parent to give access on instead), a category grants nothing
   * (CATEGORY_TARGET), and anything but text, voice or forum is NOT_GRANTABLE.
   */
  private grantTargetError(guildId: string, channelId: string): { status: number; body: ReturnType<typeof err> } | null {
    if (!this.deps.channelInGuild(guildId, channelId)) {
      return { status: 403, body: err('FORBIDDEN', 'channel is not in this guild') };
    }
    const ch = this.deps.listChannels(guildId).find((c) => c.id === channelId);
    if (ch?.type === 'thread') {
      return {
        status: 400,
        body: err('THREAD_TARGET', 'a thread uses its parent channel’s access — give access there', ch.parentId ? { parentId: ch.parentId } : {}),
      };
    }
    if (ch?.type === 'category') return { status: 400, body: err('CATEGORY_TARGET', 'a category grants nothing — pick its channels') };
    if (!ch || !isGrantable(ch.type)) {
      return { status: 400, body: err('NOT_GRANTABLE', 'access can only be given on a text, voice or forum channel') };
    }
    return null;
  }

  private claimForPersona(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const code = body?.code;
    if (typeof code !== 'string' || !code) return sendJson(res, 400, err('INVALID', 'code required'));
    const inv = this.deps.invites?.get(code);
    if (!inv || inv.guildId !== guildId) return sendJson(res, 404, err('NOT_FOUND', 'no such invite in this guild'));
    // A guild-admin acts within G only: an invite carrying another guild's
    // roles (a super-admin can mint one) is not theirs to apply.
    if (!session.isSuper && this.hasForeignRole(inv.roles ?? [], guildId)) {
      return sendJson(res, 404, err('NOT_FOUND', 'no such invite in this guild'));
    }
    // The claim refuses an invite it can't read, and the ban check below reads
    // its roles first, so the refusal comes here, by name.
    const shape = inviteShapeProblem(inv);
    if (shape) return sendJson(res, 400, err('INVALID', `${shape} — whoever minted it must mint a new one`));
    // An admin's claim lifts the persona's removal wherever the invite gives
    // access — only when the admin chose to ({liftBan: true}).
    if (body?.liftBan !== true && this.inviteLiftsBan(personaId, inv)) {
      return sendJson(res, 409, err('BANNED', 'this persona was removed from this guild (slash /ban or Remove in the panel); this invite lifts that — send liftBan: true to do it'));
    }
    let result;
    try {
      result = this.deps.applyClaim(personaId, code);
    } catch (e) {
      return sendJson(res, 400, err('INVALID', (e as Error).message));
    }
    this.audit.append({ actor: this.actorOf(session), action: 'persona.claim', target: personaId, guildId, ok: true, after: { code, roles: result.roles, ...(result.liftedBans ? { liftedBans: result.liftedBans } : {}) } });
    sendJson(res, 200, { roles: this.rolesVisibleIn(guildId, result.roles, session.isSuper), banned: this.deps.permissions.isBanned(personaId, guildId) });
  }

  /** Would applying `inv` lift a removal of the persona: does it give
   *  access (its grant, or a role that grants something) in a guild the
   *  persona was removed from? As the relay's claim decides it. */
  private inviteLiftsBan(personaId: string, inv: { guildId?: string; grant?: unknown; caps?: Capability[]; roles?: string[] }): boolean {
    const grantsIn = new Set<string>();
    if ((inv.grant || inv.caps?.length) && inv.guildId) grantsIn.add(inv.guildId);
    for (const name of inv.roles ?? []) {
      const role = this.deps.permissions.getRole(name);
      if (role?.guildId && roleGrantsAccess(role)) grantsIn.add(role.guildId);
    }
    return [...grantsIn].some((g) => this.deps.permissions.isBanned(personaId, g));
  }

  /**
   * Remove a persona from G: exactly what slash /ban does there (one shared
   * function, access.ts removeFromGuild) — G's access roles off, every direct
   * grant in G dropped, G's guild-wide level pinned to deny, and the removal
   * recorded, so the persona can't give itself access in G again (claiming an
   * invite won't); only an admin of G can, by giving it access. Nothing in
   * another guild changes. ok in the audit record is the relay's own check
   * that nothing resolves for it in G any more.
   */
  private removePersonaFromGuild(res: ServerResponse, session: AdminSession, guildId: string, personaId: string): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const guildPolicy = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId] ?? null;
    const done = removeFromGuild(this.deps.permissions, (p, g) => this.deps.canAccessGuild(p, g), personaId, guildId);
    this.audit.append({
      actor: this.actorOf(session), action: 'persona.guild.remove', target: personaId, guildId, ok: done.accessFullyRevoked,
      before: { roles: done.rolesRemoved, guildPolicy },
      after: { accessFullyRevoked: done.accessFullyRevoked },
    });
    sendJson(res, 200, { rolesRemoved: done.rolesRemoved, accessFullyRevoked: done.accessFullyRevoked });
  }

  /**
   * Re-send a persona's channel list to its running agent (slash /resync).
   * It changes no rights. At most once per RESYNC_EVERY_MS per persona (429
   * RATE_LIMITED {retryAfterMs}), so it can't be used to churn agents; how
   * many channels went out — counted over every guild the relay serves — is
   * told to super-admins only.
   */
  private resyncPersona(res: ServerResponse, session: AdminSession, guildId: string, personaId: string): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const now = this.nowMs();
    const last = this.resynced.get(personaId);
    if (last !== undefined && now >= last && now - last < RESYNC_EVERY_MS) {
      return sendJson(res, 429, err('RATE_LIMITED', 'this persona was resynced a moment ago', { retryAfterMs: RESYNC_EVERY_MS - (now - last) }));
    }
    if (this.resynced.size > 1000) {
      for (const [pid, at] of this.resynced) if (now - at >= RESYNC_EVERY_MS || now < at) this.resynced.delete(pid);
    }
    this.resynced.set(personaId, now);
    const pushed = this.deps.resync(personaId);
    // The count is left out of the record: a guild's audit is read by its admins.
    this.audit.append({ actor: this.actorOf(session), action: 'persona.resync', target: personaId, guildId, ok: true });
    sendJson(res, 200, { ok: true, ...(session.isSuper ? { pushed } : {}) });
  }

  /** Global persona-token lifecycle (super-admin only; no guildId — it's not a
   *  guild-scoped action). RFC-005 §5.9. */
  private personaToken(res: ServerResponse, session: AdminSession, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const action = body?.action;
    if (action === 'rotate') {
      const token = this.deps.rotatePersonaToken(personaId);
      this.audit.append({ actor: this.actorOf(session), action: 'persona.token.rotate', target: personaId, ok: true });
      return sendJson(res, 200, { token });
    }
    if (action === 'revoke') {
      this.deps.revokePersonaToken(personaId);
      this.audit.append({ actor: this.actorOf(session), action: 'persona.token.revoke', target: personaId, ok: true });
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 400, err('INVALID', "action must be 'rotate' or 'revoke'"));
  }

  // ── Global access-role catalog authoring (super-admin only, §5.3) ──

  private async onRolesCatalog(
    req: IncomingMessage,
    res: ServerResponse,
    session: AdminSession,
    method: string,
    path: string,
  ): Promise<void> {
    if (!session.isSuper) return sendJson(res, 403, err('FORBIDDEN', 'role authoring is super-admin only'));
    // POST /admin/roles {name, role, replace?, expectedGuildId?} — define an
    // access role. A name already in use is refused (409 EXISTS) unless the
    // request says replace AND names the guild the existing role belongs to,
    // so a role of another guild (and every holder's access) can't be
    // rewritten by typing its name. Replacing never moves a role to another
    // guild. A name set aside at load is in use too; an entry whose guild
    // isn't a string with something in it has none to keep, so replacing it
    // needs only replace and binds it to the request's guild. The role is rebuilt from
    // validated fields, never stored as sent.
    if (method === 'POST' && path === '/admin/roles') {
      const body = await readJson(req);
      const name = body?.name;
      const role = body?.role;
      if (typeof name !== 'string' || !name || !role || typeof role !== 'object') {
        return sendJson(res, 400, err('INVALID', 'name + role{caps,scope,guildId} required'));
      }
      if (typeof role.guildId !== 'string' || !role.guildId) {
        return sendJson(res, 400, err('INVALID', 'roles are guild-scoped: role.guildId required'));
      }
      const live = this.deps.permissions.getRole(name);
      // A name set aside at load is taken too: its entry is on disk for the
      // relay's operator to repair, and its holders hold it by name.
      const setAside = !live && this.deps.permissions.isQuarantined(name);
      const existing: unknown = live ?? (setAside ? this.deps.permissions.quarantinedEntry(name) : undefined);
      if (live || setAside) {
        const existingGuild = live ? live.guildId : this.deps.permissions.quarantinedGuildId(name);
        if (body.replace !== true) {
          return sendJson(res, 409, err('EXISTS', `an access role named ${name} already exists${setAside ? ", set aside at load because it can't be read" : ''}`,
            { existing: { guildId: existingGuild, ...(setAside ? { setAside: true } : {}) } }));
        }
        // An entry naming no guild that can be read has none to keep.
        if (existingGuild !== undefined && (body.expectedGuildId !== existingGuild || role.guildId !== existingGuild)) {
          return sendJson(res, 409, err('GUILD_MISMATCH', `access role ${name} belongs to another guild`, { existing: { guildId: existingGuild } }));
        }
      } else if (!ROLE_NAME.test(name)) {
        return sendJson(res, 400, err('INVALID_NAME', 'a new access role name is 1–64 of a-z, 0-9, dot, dash or underscore, starting with a letter or digit'));
      }
      const checked = this.checkRoleDef(role);
      if ('error' in checked) return sendJson(res, 400, checked);
      this.deps.permissions.setRole(name, checked);
      this.audit.append({ actor: this.actorOf(session), action: 'role.set', target: name, ok: true, ...(live || setAside ? { before: existing } : {}), after: checked });
      return sendJson(res, 200, { ok: true, catalog: this.deps.permissions.allRoles() });
    }
    const del = /^\/admin\/roles\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && del) {
      const name = decodeURIComponent(del[1]);
      const ok = this.deps.permissions.removeRole(name);
      this.audit.append({ actor: this.actorOf(session), action: 'role.delete', target: name, ok });
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : err('NOT_FOUND', 'no such role'));
    }
    sendJson(res, 404, err('NOT_FOUND', 'no such route'));
  }

  // ── Guild allow-list editing (super-admin) ──

  private async onGuildAllowlist(
    req: IncomingMessage,
    res: ServerResponse,
    session: AdminSession,
    method: string,
    path: string,
  ): Promise<void> {
    if (!session.isSuper) {
      this.audit.append({
        actor: this.actorOf(session),
        action: 'authz.denied',
        ok: false,
        detail: { method, path },
      });
      return sendJson(res, 403, err('FORBIDDEN', 'guild allow-list is super-admin only'));
    }
    // GET /admin/guilds/all — every joined guild + allowed flag, plus allowed-
    // but-not-joined (dormant pre-authorizations). `allowlist` lets the UI
    // distinguish env-empty (allow-all) from store-empty (deny-all).
    if (method === 'GET' && path === '/admin/guilds/all') {
      const bot = this.deps.listAllGuilds();
      const known = new Set(bot.map((g) => g.id));
      const notJoined = this.deps.allowlist
        .list()
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: null, memberCount: null, allowed: true, present: false }));
      return sendJson(res, 200, {
        editable: this.deps.allowlist.editable,
        allowlist: this.deps.allowlist.list(),
        guilds: [...bot.map((g) => ({ ...g, present: true })), ...notJoined],
      });
    }
    if (method !== 'GET' && !this.deps.allowlist.editable) {
      return sendJson(
        res,
        409,
        err('NOT_EDITABLE', 'allow-list is env-managed (DISCORD_GUILD_ID); set PORTAL_GUILDS to enable editing'),
      );
    }
    // POST /admin/guilds {guildId} — allow. Accepts snowflake-shaped ids the
    // bot isn't in yet (pre-authorize, then invite the bot).
    if (method === 'POST' && path === '/admin/guilds') {
      const body = await readJson(req);
      const gid = typeof body?.guildId === 'string' ? body.guildId.trim() : '';
      if (!/^\d{5,25}$/.test(gid)) return sendJson(res, 400, err('INVALID', 'guildId must be a Discord snowflake'));
      const added = this.deps.allowlist.allow(gid);
      const present = this.deps.listAllGuilds().some((g) => g.id === gid);
      this.audit.append({
        actor: this.actorOf(session),
        action: 'guild.allow',
        target: gid,
        guildId: gid,
        ok: true,
        detail: { added, present },
      });
      return sendJson(res, 200, {
        ok: true,
        added,
        present,
        allowlist: this.deps.allowlist.list(),
        ...(present ? {} : { warning: 'bot is not in this guild yet — invite it, or the entry stays dormant' }),
      });
    }
    // DELETE /admin/guilds/:gid — disallow. Digits-only ⇒ never matches /all.
    const del = /^\/admin\/guilds\/(\d{5,25})$/.exec(path);
    if (method === 'DELETE' && del) {
      if (!this.deps.allowlist.disallow(del[1])) return sendJson(res, 404, err('NOT_FOUND', 'guild not in allow-list'));
      this.audit.append({ actor: this.actorOf(session), action: 'guild.disallow', target: del[1], guildId: del[1], ok: true });
      return sendJson(res, 200, {
        ok: true,
        allowlist: this.deps.allowlist.list(),
        denyAll: this.deps.allowlist.list().length === 0,
      });
    }
    sendJson(res, 404, err('NOT_FOUND', 'no such route'));
  }

  // ── Global Identities (super-admin): registry + detail + token lifecycle ──

  private async onIdentitiesRoute(
    req: IncomingMessage,
    res: ServerResponse,
    session: AdminSession,
    method: string,
    path: string,
    url: URL,
  ): Promise<void> {
    // GET /admin/personas — registry (searchable, paginated).
    if (method === 'GET' && path === '/admin/personas') {
      const page = parsePage(url);
      const rows = this.deps.identity
        .all()
        .filter((p) => !page.q || matches(page.q, p.id, p.displayName))
        .map((p) => ({
          id: p.id,
          displayName: p.displayName,
          avatarUrl: this.deps.identity.avatarUrl(p),
          roles: this.deps.permissions.getRoleNames(p.id),
          guildCount: this.guildsWithAccess(p.id).length,
        }));
      return sendJson(res, 200, paginate(rows, page, 'personas'));
    }
    // GET /admin/personas/:id — global detail (which guilds it can act in).
    const detail = /^\/admin\/personas\/([^/]+)$/.exec(path);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const p = this.deps.identity.get(id);
      if (!p) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
      const entry = this.deps.permissions.getEntry(id);
      // Resolve role names to their definitions so the UI can show *what* access
      // each role confers (caps + scope + the guild it's bound to).
      const roles = (entry?.roles ?? []).map((name) => ({ name, ...this.deps.permissions.getRole(name) }));
      // Names for everything the drawer shows: ad-hoc grant channels in every
      // guild, role scopes, and guild names (super-admin view: unclipped).
      const policyGuilds = entry?.policy?.guilds ?? {};
      const grantChannels = Object.values(policyGuilds).flatMap((g) => Object.keys(g?.channels ?? {}));
      const names = await this.scopeNames(roles.map((r) => (r as { scope?: unknown }).scope), undefined, grantChannels);
      names.guilds = this.guildNames([
        ...Object.keys(policyGuilds),
        ...roles.map((r) => (r as { guildId?: string }).guildId),
        ...(entry?.bans ?? []),
      ]);
      return sendJson(res, 200, {
        id: p.id,
        displayName: p.displayName,
        avatar: p.avatar,
        avatarUrl: this.deps.identity.avatarUrl(p),
        roles,
        // Inline per-persona policy (ad-hoc grants), if any.
        policy: entry?.policy ?? null,
        // Guilds it was removed from with /ban (nothing applies there).
        bans: entry?.bans ?? [],
        // Guilds (named) where this persona can act, and how.
        guilds: this.guildsWithAccess(id).map((gid) => ({ id: gid, name: this.guildName(gid) })),
        names,
      });
    }
    // POST /admin/personas/:id/token — rotate/revoke (CSRF-checked).
    const tok = /^\/admin\/personas\/([^/]+)\/token$/.exec(path);
    if (method === 'POST' && tok) {
      return this.personaToken(res, session, decodeURIComponent(tok[1]), await readJson(req));
    }
    // PUT /admin/personas/:id/avatar — set the persona's profile picture (global
    // identity, super-admin). Value is an image URL, or a bare filename when the
    // relay has PORTAL_AVATAR_BASE_URL; empty clears it. Applies to new messages.
    const av = /^\/admin\/personas\/([^/]+)\/avatar$/.exec(path);
    if (method === 'PUT' && av) {
      const id = decodeURIComponent(av[1]);
      const cur = this.deps.identity.get(id);
      if (!cur) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
      const body = await readJson(req);
      const avatar = typeof body?.avatar === 'string' ? body.avatar.trim() : '';
      // Accept: empty (clear), an http(s) URL, or a safe bare filename (no paths).
      if (!(avatar === '' || /^https?:\/\/.+/i.test(avatar) || /^[A-Za-z0-9._-]+$/.test(avatar))) {
        return sendJson(res, 400, err('INVALID', 'avatar must be an http(s) URL or a plain filename'));
      }
      this.deps.identity.upsert({ ...cur, avatar });
      const next = this.deps.identity.get(id)!;
      this.audit.append({ actor: this.actorOf(session), action: 'persona.avatar.set', target: id, ok: true, after: { avatar } });
      return sendJson(res, 200, { avatar: next.avatar, avatarUrl: this.deps.identity.avatarUrl(next) });
    }
    // POST /admin/personas/:id/avatar/upload — store an uploaded image (raw bytes)
    // and point the persona's avatar at it. Served back at /admin/avatars/<file>.
    const upl = /^\/admin\/personas\/([^/]+)\/avatar\/upload$/.exec(path);
    if (method === 'POST' && upl) {
      const dir = this.deps.config.avatarDir;
      if (!dir) return sendJson(res, 503, err('UNAVAILABLE', 'avatar uploads not configured (set PORTAL_AVATAR_DIR)'));
      const id = decodeURIComponent(upl[1]);
      const cur = this.deps.identity.get(id);
      if (!cur) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
      const ext = IMG_EXT[(req.headers['content-type'] ?? '').toString().split(';')[0].trim()];
      if (!ext) return sendJson(res, 400, err('INVALID', 'content-type must be image/png, image/jpeg, image/webp or image/gif'));
      let bytes: Buffer;
      try {
        bytes = await readBytes(req, 2 * 1024 * 1024);
      } catch {
        return sendJson(res, 400, err('INVALID', 'image too large (max 2 MiB)'));
      }
      if (!isImage(bytes, ext)) return sendJson(res, 400, err('INVALID', 'body is not a valid image'));
      mkdirSync(dir, { recursive: true });
      const fname = `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${randomBytes(6).toString('hex')}.${ext}`;
      writeFileSync(join(dir, fname), bytes);
      const prev = cur.avatar;
      this.deps.identity.upsert({ ...cur, avatar: fname });
      // Best-effort cleanup of the persona's previous uploaded file (our dir only).
      if (prev && /^[A-Za-z0-9._-]+$/.test(prev) && prev !== fname && existsSync(join(dir, prev))) {
        try { unlinkSync(join(dir, prev)); } catch { /* ignore */ }
      }
      const next = this.deps.identity.get(id)!;
      this.audit.append({ actor: this.actorOf(session), action: 'persona.avatar.upload', target: id, ok: true, after: { avatar: fname, bytes: bytes.length } });
      return sendJson(res, 200, { avatar: next.avatar, avatarUrl: this.deps.identity.avatarUrl(next) });
    }
    sendJson(res, 404, err('NOT_FOUND', 'no such route'));
  }

  /** Serve an uploaded avatar (public — Discord fetches these). Filename is
   *  validated to a flat safe set, so no path traversal out of the avatar dir. */
  private serveAvatar(res: ServerResponse, path: string): void {
    const dir = this.deps.config.avatarDir;
    if (!dir) return sendJson(res, 404, err('NOT_FOUND', 'avatars not configured'));
    const file = decodeURIComponent(path.slice('/admin/avatars/'.length));
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return sendJson(res, 400, err('INVALID', 'bad filename'));
    const full = join(dir, file);
    if (!existsSync(full)) return sendJson(res, 404, err('NOT_FOUND', 'no such avatar'));
    res.writeHead(200, { 'content-type': IMG_CT[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'public, max-age=300' });
    res.end(readFileSync(full));
  }

  // ── Names for ids (the panel shows names; ids only in tooltips) ──

  /** Channel labels — via the resolver when wired (names archived threads and
   *  deleted channels), else from the allowed guilds' channel lists. */
  private async channelLabels(ids: Iterable<string>): Promise<Map<string, ChannelLabel>> {
    const list = [...new Set([...ids].filter((id) => typeof id === 'string' && id))];
    if (!list.length) return new Map();
    if (this.deps.resolveChannels) return this.deps.resolveChannels(list);
    const known = new Map<string, ChannelLabel>();
    for (const g of this.deps.listGuilds()) {
      for (const c of this.deps.listChannels(g.id)) {
        known.set(c.id, { id: c.id, name: c.name ?? null, type: c.type as ChannelLabel['type'], guildId: g.id, ...(c.parentId ? { parentId: c.parentId } : {}) });
      }
    }
    const out = new Map<string, ChannelLabel>();
    for (const id of list) {
      const l = known.get(id);
      if (!l) { out.set(id, { id, name: null }); continue; }
      out.set(id, l.parentId ? { ...l, parentName: known.get(l.parentId)?.name ?? null } : l);
    }
    return out;
  }

  /** Discord role names; with `clip`, only roles of that guild are named. */
  private roleLabels(ids: Iterable<string | undefined>, clip?: string): Record<string, RoleLabel> {
    const out: Record<string, RoleLabel> = {};
    for (const id of new Set(ids)) {
      if (!id) continue;
      let l = this.deps.discordRole?.(id) ?? null;
      if (!l && !this.deps.discordRole) {
        for (const g of this.deps.listGuilds()) {
          const r = this.deps.listRoles(g.id).find((x) => x.id === id);
          if (r) { l = { name: r.name, guildId: r.guildId }; break; }
        }
      }
      if (l && (!clip || l.guildId === clip)) out[id] = l;
    }
    return out;
  }

  /** Guild names from the bot's view (joined guilds); with `clip`, only that guild. */
  private guildNames(ids: Iterable<string | undefined>, clip?: string): Record<string, string> {
    const byId = new Map(this.deps.listAllGuilds().map((g) => [g.id, g.name] as const));
    for (const g of this.deps.listGuilds()) if (!byId.has(g.id)) byId.set(g.id, g.name);
    const out: Record<string, string> = {};
    for (const id of new Set(ids)) {
      if (!id || (clip && id !== clip)) continue;
      const n = byId.get(id);
      if (n) out[id] = n;
    }
    return out;
  }

  /** Names for the channels + Discord roles that grant/role scopes reference
   *  (plus any extra channel ids). With `clip`, other guilds' stay unnamed. */
  private async scopeNames(scopes: unknown[], clip?: string, extraChannels: string[] = []): Promise<NameMaps> {
    const channels = new Set<string>(extraChannels);
    const roles = new Set<string>();
    for (const sc of scopes) {
      if (!sc || typeof sc !== 'object') continue;
      const s = sc as { channels?: unknown; mirrorRole?: unknown; mirrorRoles?: unknown };
      if (Array.isArray(s.channels)) for (const c of s.channels) if (typeof c === 'string') channels.add(c);
      if (typeof s.mirrorRole === 'string') roles.add(s.mirrorRole);
      if (Array.isArray(s.mirrorRoles)) for (const r of s.mirrorRoles) if (typeof r === 'string') roles.add(r);
    }
    const labels = await this.channelLabels(channels);
    return {
      channels: clip ? clipToGuild(labels, clip) : Object.fromEntries(labels),
      discordRoles: this.roleLabels(roles, clip),
    };
  }

  /** Names for an audit page: persona targets, and channels in record details. */
  private async auditNames(records: Array<Record<string, any>>, guildId: string): Promise<NameMaps> {
    const personas: Record<string, string> = {};
    const channels = new Set<string>();
    for (const r of records) {
      if (typeof r.target === 'string') {
        const p = this.deps.identity.get(r.target);
        if (p) personas[p.id] = p.displayName;
      }
      for (const k of ['detail', 'after', 'before']) {
        const cid = r[k]?.channelId;
        if (typeof cid === 'string') channels.add(cid);
      }
    }
    return {
      personas,
      channels: clipToGuild(await this.channelLabels(channels), guildId),
      guilds: this.guildNames(records.map((r) => r.target), guildId),
    };
  }

  /** Land a failed or refused login on the panel with a fixed reason code
   *  (the SPA maps codes to messages; nothing from the request is echoed). */
  private loginFailed(res: ServerResponse, code: LoginError): void {
    // The code goes in the query, before any #fragment (the SPA reads
    // location.search).
    const to = this.deps.config.postLoginUrl;
    const hash = to.indexOf('#');
    const base = hash < 0 ? to : to.slice(0, hash);
    const frag = hash < 0 ? '' : to.slice(hash);
    redirect(res, `${base}${base.includes('?') ? '&' : '?'}login_error=${code}${frag}`);
  }

  /** Some role isn't one of `guildId`'s own. A role that doesn't resolve
   *  (deleted, or quarantined) counts as foreign: it may have been another
   *  guild's, and a name can come back. Such an invite is refused at use
   *  anyway (the relay won't apply a role that doesn't exist), so hiding it
   *  from a guild admin hides nothing live; a super-admin still sees it. */
  private hasForeignRole(roles: string[], guildId: string): boolean {
    // Roles that aren't a list (a hand edit) can't be read, so they count as
    // foreign too, rather than throwing for the guild's whole invite list.
    if (!Array.isArray(roles)) return true;
    return roles.some((r) => this.deps.permissions.getRole(r)?.guildId !== guildId);
  }

  /**
   * A record as a guild's audit view shows it. Invite codes are bearer
   * credentials (an unauthenticated register claims them), so every reader
   * sees only a prefix — enough to match a record to an invite; the invite
   * list is where a code is shown, to whoever may see it. A guild-admin also
   * doesn't see other guilds' access-role names.
   */
  private auditView(rec: AuditRecord, guildId: string, isSuper: boolean): AuditRecord {
    const r = structuredClone(rec);
    // Relay-made codes are inv_ + 24 random characters: 12 shown leave 96
    // bits unknown. A shorter (hand-chosen) code is hidden outright, since a
    // prefix of it could be most of it. Already-shortened ones stay as they are.
    const short = (c: unknown) =>
      typeof c !== 'string' || c.endsWith('…') ? c : c.length >= 28 ? `${c.slice(0, 12)}…` : '(code hidden)';
    if (r.action.startsWith('invite.') || r.action === 'slash.invite') r.target = short(r.target) as string | undefined;
    // For a guild admin: another guild's role names are dropped; a role that
    // no longer exists is shown as such (its name may have been another
    // guild's, so it isn't shown).
    const label = (name: unknown): string | null => {
      if (isSuper || typeof name !== 'string') return name as string;
      const g = this.deps.permissions.getRole(name)?.guildId;
      return g === guildId ? name : g === undefined ? '(deleted role)' : null;
    };
    for (const k of ['before', 'after', 'detail'] as const) {
      const o = r[k] as Record<string, unknown> | undefined;
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      if ('code' in o) o.code = short(o.code);
      if (Array.isArray(o.roles)) o.roles = o.roles.map(label).filter((n) => n !== null);
      if ('role' in o) o.role = label(o.role) ?? '(another server’s role)';
    }
    return r;
  }

  /** The role names a guild view may show: all of them to a super-admin, only
   *  G's own to a guild-admin (another guild's roles are not theirs to see). */
  private rolesVisibleIn(guildId: string, roles: string[], isSuper: boolean): string[] {
    return isSuper ? roles : roles.filter((r) => this.deps.permissions.getRole(r)?.guildId === guildId);
  }

  /** A guild this relay serves: the bot has joined it and the allow-list admits it. */
  private isServed(guildId: string): boolean {
    return this.deps.listGuilds().some((g) => g.id === guildId);
  }

  /**
   * Validate an invite grant for guild G and return a clean copy, or an error
   * string ("<CODE>: …", e.g. "FORBIDDEN: …", "INVALID: …", "THREAD_TARGET: …").
   * Caps must be known capability names; the scope must be exactly one of:
   * channels of G that can hold access (not threads or categories), a
   * Discord role of G to mirror, several roles of G to mirror — or, for
   * super-admins only, `all` (every channel of G; see Relay.scopeToPolicy).
   */
  private checkInviteGrant(session: AdminSession, guildId: string, raw: unknown): { caps: Capability[]; scope: Scope } | string {
    if (!raw || typeof raw !== 'object') return 'INVALID: grant must be an object';
    const g = raw as { caps?: unknown; scope?: unknown };
    if (!Array.isArray(g.caps) || g.caps.length === 0) return 'INVALID: grant.caps must list at least one capability';
    const known = new Set<string>(ALL_CAPS);
    const caps = [...new Set(g.caps)];
    for (const c of caps) if (typeof c !== 'string' || !known.has(c)) return `INVALID: unknown capability ${String(c)}`;
    const scope = (g.scope ?? {}) as Record<string, unknown>;
    const keys = Object.keys(scope);
    if (keys.length !== 1) return 'INVALID: grant.scope must have exactly one of channels, mirrorRole, mirrorRoles, all';
    const guildRoles = new Set(this.deps.listRoles(guildId).map((r) => r.id));
    if (Array.isArray(scope.channels)) {
      const channels = [...new Set(scope.channels)];
      if (!channels.length) return 'INVALID: grant.scope.channels is empty';
      for (const cid of channels) {
        if (typeof cid !== 'string' || !this.deps.channelInGuild(guildId, cid)) return `FORBIDDEN: channel ${String(cid)} is not in this guild`;
        // I3: and a channel that can hold access (not a thread or category).
        const bad = this.grantTargetError(guildId, cid);
        if (bad) return `${bad.body.error.code}: ${bad.body.error.message}`;
      }
      return { caps: caps as Capability[], scope: { channels: channels as string[] } };
    }
    if (typeof scope.mirrorRole === 'string') {
      if (!guildRoles.has(scope.mirrorRole)) return `FORBIDDEN: role ${scope.mirrorRole} is not a role of this guild`;
      return { caps: caps as Capability[], scope: { mirrorRole: scope.mirrorRole } };
    }
    if (Array.isArray(scope.mirrorRoles)) {
      const ids = [...new Set(scope.mirrorRoles)];
      if (!ids.length) return 'INVALID: grant.scope.mirrorRoles is empty';
      for (const id of ids) if (typeof id !== 'string' || !guildRoles.has(id)) return `FORBIDDEN: role ${String(id)} is not a role of this guild`;
      return { caps: caps as Capability[], scope: { mirrorRoles: ids as string[] } };
    }
    if (scope.all === true) {
      if (!session.isSuper) return 'FORBIDDEN: only a super-admin may grant every channel of a guild';
      return { caps: caps as Capability[], scope: { all: true } };
    }
    return 'INVALID: grant.scope must have exactly one of channels, mirrorRole, mirrorRoles, all';
  }

  /**
   * An access role as the catalog may hold it, rebuilt from `raw`: known,
   * non-empty caps; exactly one scope — channels of the role's guild that
   * can hold access, Discord roles of that guild (not the relay's pooled
   * addressing roles), or all: true; mirrorCaps only on a mirror, as a
   * boolean. Or the error to answer with.
   */
  private checkRoleDef(raw: Record<string, unknown>): AccessRole | ReturnType<typeof err> {
    const guildId = raw.guildId as string;
    if (!Array.isArray(raw.caps)) return err('INVALID', 'role.caps must be a list of capabilities');
    const caps = checkCaps(raw.caps);
    if ('error' in caps) return caps;
    const scope = (raw.scope && typeof raw.scope === 'object' ? raw.scope : {}) as Record<string, unknown>;
    if (Object.keys(scope).length !== 1) return err('INVALID', 'role.scope must have exactly one of channels, mirrorRole, mirrorRoles, all');
    const mirrorable = new Set(this.deps.listRoles(guildId).filter((r) => !r.pooled).map((r) => r.id));
    const mirrorRole = (id: unknown) =>
      typeof id === 'string' && mirrorable.has(id) ? null : err('INVALID', `${String(id)} is not a Discord role of that guild that can be mirrored`);
    let out: AccessRole;
    if (scope.all !== undefined) {
      if (scope.all !== true) return err('INVALID', 'role.scope.all must be true');
      out = { caps: caps.caps, scope: { all: true }, guildId };
    } else if (scope.channels !== undefined) {
      if (!Array.isArray(scope.channels) || !scope.channels.length) return err('INVALID', 'role.scope.channels must list at least one channel');
      const channels = [...new Set(scope.channels)];
      for (const cid of channels) {
        if (typeof cid !== 'string' || !cid) return err('INVALID', 'role.scope.channels must list channel ids');
        const bad = this.grantTargetError(guildId, cid);
        if (bad) return bad.status === 403 ? err('INVALID', `channel ${cid} is not in that guild`) : bad.body;
      }
      out = { caps: caps.caps, scope: { channels: channels as string[] }, guildId };
    } else if (scope.mirrorRole !== undefined) {
      const bad = mirrorRole(scope.mirrorRole);
      if (bad) return bad;
      out = { caps: caps.caps, scope: { mirrorRole: scope.mirrorRole as string }, guildId };
    } else if (scope.mirrorRoles !== undefined) {
      if (!Array.isArray(scope.mirrorRoles) || !scope.mirrorRoles.length) return err('INVALID', 'role.scope.mirrorRoles must list at least one role');
      const ids = [...new Set(scope.mirrorRoles)];
      for (const id of ids) {
        const bad = mirrorRole(id);
        if (bad) return bad;
      }
      out = { caps: caps.caps, scope: { mirrorRoles: ids as string[] }, guildId };
    } else {
      return err('INVALID', 'role.scope must have exactly one of channels, mirrorRole, mirrorRoles, all');
    }
    if (raw.mirrorCaps !== undefined) {
      if (typeof raw.mirrorCaps !== 'boolean') return err('INVALID', 'role.mirrorCaps must be true or false');
      if (!('mirrorRole' in out.scope) && !('mirrorRoles' in out.scope)) {
        if (raw.mirrorCaps) return err('INVALID', 'mirrorCaps applies only to a role that mirrors Discord roles');
      } else out.mirrorCaps = raw.mirrorCaps;
    }
    return out;
  }

  /** Guild ids a persona can possibly act in (across the bot's known guilds). */
  private guildsWithAccess(personaId: string): string[] {
    return this.deps
      .listGuilds()
      .map((g) => g.id)
      .filter((gid) => this.deps.permissions.couldAccessGuild(personaId, gid, (cid) => this.deps.channelInGuild(gid, cid)));
  }

  /** Human guild name from the bot's view, falling back to the id. */
  private guildName(guildId: string): string {
    return this.deps.listGuilds().find((g) => g.id === guildId)?.name ?? guildId;
  }

  /** Guilds the bot is in that this admin may manage (named) — drives the scope
   *  selector. Super-admins get every bot guild; guild-admins get the
   *  intersection with their Discord-derived admin set. */
  private onGuilds(res: ServerResponse, session: AdminSession): void {
    const guilds = this.deps
      .listGuilds()
      .filter((g) => session.isSuper || session.adminGuilds.has(g.id))
      .map((g) => ({ id: g.id, name: g.name }));
    sendJson(res, 200, { guilds });
  }

  private nowMs(): number {
    return this.clock();
  }
}

// ── Search + pagination (simple; sized for low hundreds, not virtualized) ──

interface Page {
  q?: string;
  limit: number;
  offset: number;
}

function parsePage(url: URL): Page {
  const q = url.searchParams.get('q')?.trim() || undefined;
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  return { q, limit, offset };
}

function clampInt(v: string | null, dflt: number, min: number, max: number): number {
  const n = v == null ? dflt : parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Window an array and wrap it with paging metadata under `key`. */
function paginate<T>(items: T[], page: Page, key: string): Record<string, unknown> {
  return {
    [key]: items.slice(page.offset, page.offset + page.limit),
    total: items.length,
    limit: page.limit,
    offset: page.offset,
  };
}

/** Case-insensitive substring match of `q` against any provided field. */
function matches(q: string, ...fields: Array<string | undefined>): boolean {
  const needle = q.toLowerCase();
  return fields.some((f) => f != null && f.toLowerCase().includes(needle));
}

// Accepted upload content-types → file extension, and extension → served type.
const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};
const IMG_CT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

/** Validate magic bytes so a wrong/forged content-type can't write arbitrary data. */
function isImage(b: Buffer, ext: string): boolean {
  if (b.length < 12) return false;
  if (ext === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === 'jpg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === 'gif') return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  if (ext === 'webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

/** Read a raw request body up to `max` bytes; throws if exceeded. */
async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function err(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A grant request's target: exactly one of {channelId} or {guildDefault: true}.
 *  A body naming neither (a panel from before this check sent a bare caps
 *  list for guild-wide) is refused loudly rather than read some other way. */
function grantTarget(body: unknown): { channelId?: string } | ReturnType<typeof err> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const hasChannel = b.channelId !== undefined;
  const hasGuild = b.guildDefault !== undefined;
  if (hasChannel === hasGuild) return err('TARGET_REQUIRED', 'give exactly one target: channelId, or guildDefault: true');
  if (hasGuild) return b.guildDefault === true ? {} : err('INVALID', 'guildDefault must be true');
  if (typeof b.channelId !== 'string' || !b.channelId) return err('INVALID', 'channelId must be a channel id');
  return { channelId: b.channelId };
}

/** A grant request's operation: exactly one of {level}, {caps} or {deny: true}. */
function grantOperation(body: unknown): { caps: Capability[]; level?: string } | ReturnType<typeof err> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const given = (['level', 'caps', 'deny'] as const).filter((k) => b[k] !== undefined);
  if (!given.length) return err('EMPTY_CAPS', 'pick a level, or use Remove');
  if (given.length > 1) return err('INVALID', 'give exactly one of level, caps or deny');
  if (given[0] === 'level') {
    const level = b.level;
    if (typeof level !== 'string' || !has(LEVEL_CAPS, level)) return err('INVALID', 'level must be read, write or full');
    return { caps: [...LEVEL_CAPS[level]], level };
  }
  if (given[0] === 'deny') return b.deny === true ? { caps: [] } : err('INVALID', 'deny must be true');
  if (!Array.isArray(b.caps)) return err('INVALID', 'caps must be a list of capabilities');
  return checkCaps(b.caps);
}

/** A non-empty list of known capability names, without repeats. */
function checkCaps(raw: unknown[]): { caps: Capability[] } | ReturnType<typeof err> {
  if (!raw.length) return err('EMPTY_CAPS', 'pick a level, or use Remove');
  const known = new Set<string>(ALL_CAPS);
  for (const c of raw) if (typeof c !== 'string' || !known.has(c)) return err('UNKNOWN_CAP', `unknown capability ${String(c)}`);
  return { caps: [...new Set(raw as Capability[])] };
}

/** What a guild's persona row says about its direct grants there:
 *  'grants' — some channel grant or the guild-wide level gives something;
 *  'denied' — guild-wide is an explicit deny and nothing gives anything;
 *  'none'   — neither (no entry, or only empty channel grants). */
function directGrantsIn(g: GuildPolicy | undefined): 'none' | 'grants' | 'denied' {
  if (!g) return 'none';
  const gives = (g.default?.length ?? 0) > 0 || Object.values(g.channels ?? {}).some((caps) => caps.length > 0);
  if (gives) return 'grants';
  return Array.isArray(g.default) ? 'denied' : 'none';
}

type InactiveReason = 'thread' | 'category' | 'missing' | 'blocks-nothing';

/** Would an empty direct grant (a block) in G block anything: is there a
 *  guild-wide level, or else a persona default, that gives something? */
function blocksSomething(g: GuildPolicy | undefined, pol: { default?: Capability[] } | undefined): boolean {
  return ((g?.default ?? pol?.default) ?? []).length > 0;
}

/** Why a direct grant in G does nothing, or null when it does something: on
 *  a thread (it uses its parent's access), a category (it grants nothing), a
 *  channel G doesn't have now (`known` false), or a block with nothing to
 *  block. `type` is the channel's kind, when known. */
function inactiveReason(caps: Capability[], type: string | undefined, known: boolean, blocks: boolean): InactiveReason | null {
  if (type === 'thread' || type === 'category') return type;
  if (!known) return 'missing';
  if (!caps.length && holdsAccess(type) && !blocks) return 'blocks-nothing';
  return null;
}

/** A grant change's optional fields: `expect` — what the panel last saw at
 *  the target (caps, or null for nothing set) — `batchId`, and `liftBan`:
 *  the admin was asked, and chose to lift the persona's removal from G. */
function changeMeta(body: unknown): { expect?: Capability[] | null; batchId?: string; liftBan?: true } | ReturnType<typeof err> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: { expect?: Capability[] | null; batchId?: string; liftBan?: true } = {};
  if (b.liftBan !== undefined) {
    if (typeof b.liftBan !== 'boolean') return err('INVALID', 'liftBan must be true or false');
    if (b.liftBan) out.liftBan = true;
  }
  if (b.expect !== undefined) {
    const ok = b.expect === null || (Array.isArray(b.expect) && b.expect.length <= 64 && b.expect.every((c) => typeof c === 'string'));
    if (!ok) return err('INVALID', 'expect must be a list of capabilities, or null for nothing set');
    out.expect = b.expect as Capability[] | null;
  }
  if (b.batchId !== undefined) {
    if (typeof b.batchId !== 'string' || !BATCH_ID.test(b.batchId)) return err('INVALID', 'batchId must be 1–32 letters, digits, dashes or underscores');
    out.batchId = b.batchId;
  }
  return out;
}

/** Two settings are the same: both unset (null), or the same capabilities in any order. */
function sameCaps(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((c) => y.has(c));
}

/** An access row's fields from an explanation. */
function rowOf(ex: Explained) {
  return {
    effective: ex.effective, level: ex.level, base: ex.base, extra: ex.extra,
    direct: ex.direct, sources: ex.sources, botLimited: ex.botLimited, botLacks: ex.botLacks,
  };
}

/** The Discord roles mirror sources follow. */
function mirrorIds(sources: AccessSource[]): string[] {
  return sources.flatMap((s) => (s.kind === 'role' && s.mirror ? s.mirror.map((m) => m.id) : []));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The Server-Timing header of an access read: how long it took here. */
function timing(t0: number): Record<string, string> {
  return { 'server-timing': `access;dur=${(performance.now() - t0).toFixed(1)}` };
}

// ── HTTP helpers ──

/** Read and JSON-parse a request body (bounded). Returns {} on empty/invalid. */
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw Object.assign(new Error('body too large'), { code: 'INVALID' });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

interface CookieOpts {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number; // seconds
  path?: string;
}

function setCookie(res: ServerResponse, name: string, value: string, opts: CookieOpts): void {
  const parts = [`${name}=${value}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  appendSetCookie(res, parts.join('; '));
}

function clearCookie(res: ServerResponse, name: string, path: string): void {
  appendSetCookie(res, `${name}=; Path=${path}; Max-Age=0`);
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  list.push(cookie);
  res.setHeader('set-cookie', list);
}

/** The name of `state`'s cookie: the prefix and 16 hex digits of its SHA-256
 *  (exported for tests). */
export function stateCookieName(state: string): string {
  return STATE_COOKIE_PREFIX + createHash('sha256').update(state).digest('hex').slice(0, 16);
}

/** Does this browser hold `state`'s cookie (it started this sign-in)? */
function hasStateCookie(req: IncomingMessage, state: string | undefined): state is string {
  return !!state && STATE_FORMAT.test(state) && getCookie(req, stateCookieName(state)) === state;
}

/** This browser's state cookies (at most STATE_COOKIES_READ): each one's name,
 *  and its state — null when it doesn't hold a well-formed state under its
 *  own name. */
function cookieStates(req: IncomingMessage): Array<{ name: string; state: string | null }> {
  const header = req.headers.cookie;
  if (!header) return [];
  const out: Array<{ name: string; state: string | null }> = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!STATE_COOKIE_NAME.test(name) || out.some((h) => h.name === name)) continue;
    const v = part.slice(eq + 1).trim();
    out.push({ name, state: STATE_FORMAT.test(v) && stateCookieName(v) === name ? v : null });
    if (out.length >= STATE_COOKIES_READ) break;
  }
  return out;
}

function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
