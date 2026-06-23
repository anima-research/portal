/**
 * Admin HTTP API (RFC-005 §5.1). Binds 127.0.0.1 only; Caddy is the sole exposed
 * endpoint, TLS-terminating and proxying here (and serving the SPA). This is a
 * distinct, separately-hardened surface from the WS gateway (§7) — it can do far
 * more, so it never shares the gateway's auth path.
 *
 * P1 scope: OAuth login/callback, server-side sessions, super-admin + guild-admin
 * authorization, and read-only views (invites / roles / personas / channels /
 * audit). Mutations land in P2; the route table is shaped to receive them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AdminConfig } from '../config.js';
import type { IdentityStore } from '../identity.js';
import type { InviteStore } from '../invites.js';
import type { PermissionsStore } from '../permissions.js';
import type { AuditLog } from './audit.js';
import { canManageGuild } from './authz.js';
import { authorizeUrl, completeOAuth, type FetchLike } from './oauth.js';
import { SessionStore, type AdminSession } from './sessions.js';

const SESSION_COOKIE = 'portal_admin_session';
const STATE_COOKIE = 'portal_admin_state';

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
  /** A guild's Discord roles (for `mirrorRole` pickers). */
  listRoles(guildId: string): Array<{ id: string; guildId: string; name: string; pooled: boolean }>;
  /** A guild's channels (for `channels`-scope pickers). */
  listChannels(guildId: string): Array<{ id: string; name?: string; type?: string }>;
  /** True if the channel belongs to the guild (for clipping grants to G). */
  channelInGuild(guildId: string, channelId: string): boolean;
  /** Drop a persona's live sessions (revoke/force-rotate). */
  closePersona(personaId: string): void;
  /** Admin-initiated augment: apply an invite's grant to an existing persona.
   *  Mirrors the `claim_invite` op but actor = the admin. Returns role list. */
  applyClaim(personaId: string, code: string): { roles: string[] };
  /** Force-rotate a persona's token; returns the new plaintext (show once). */
  rotatePersonaToken(personaId: string): string;
  /** Force-revoke a persona's token + drop its sessions. */
  revokePersonaToken(personaId: string): void;
  /** Generate a unique invite code. */
  newInviteCode(): string;
}

export class AdminServer {
  private server?: Server;
  private sessions: SessionStore;
  private audit: AuditLog;

  constructor(
    private deps: AdminDeps,
    /** Injectable fetch — tests drive the OAuth callback without real network. */
    private fetchImpl: FetchLike = fetch,
  ) {
    this.sessions = new SessionStore(deps.config.sessionTtlMs);
    this.audit = deps.audit;
  }

  async listen(): Promise<void> {
    this.sessions.start();
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
    if (method === 'GET' && path === '/admin/login') return this.onLogin(res);
    if (method === 'GET' && path === '/admin/callback') return this.onCallback(req, res, url);

    // Everything below requires a session.
    const session = this.sessions.get(getCookie(req, SESSION_COOKIE));
    if (!session) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'login required' } });

    if (method === 'POST' && path === '/admin/logout') return this.onLogout(req, res, session);
    if (method === 'GET' && path === '/admin/me') return this.onMe(res, session);
    // The guilds the user may manage AND the bot is actually in (named) — the
    // scope selector uses this, so it lands on guilds that have data rather than
    // every guild the admin happens to own on Discord.
    if (method === 'GET' && path === '/admin/guilds') return this.onGuilds(res, session);

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
      if (!canManageGuild(session, guildId)) {
        this.audit.append({
          actor: { id: session.userId, name: session.userName, kind: 'admin' },
          action: 'authz.denied',
          guildId,
          ok: false,
          detail: { method, path },
        });
        return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'not an admin of this guild' } });
      }
      return this.onGuildRoute(req, res, session, guildId, method, sub, url);
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  }

  /** CSRF guard for mutations: the SPA echoes the session csrf in a header. */
  private csrfOk(req: IncomingMessage, session: AdminSession): boolean {
    const h = req.headers['x-csrf-token'];
    const got = Array.isArray(h) ? h[0] : h;
    return !!got && got === session.csrf;
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
    // Read: GET /admin/g/:gid/personas/:id  (drawer detail) — before the generic
    // single-segment read so it isn't shadowed.
    const personaDetail = /^\/personas\/([^/]+)$/.exec(sub);
    if (method === 'GET' && personaDetail) {
      return this.onPersonaDetail(res, guildId, decodeURIComponent(personaDetail[1]));
    }
    // Reads: GET /admin/g/:gid/<resource>  (searchable/paginated for lists)
    const readM = /^\/([^/]+)$/.exec(sub);
    if (method === 'GET' && readM) return this.onGuildRead(res, session, guildId, readM[1], url);

    // All mutations below require a valid CSRF token.
    if (method !== 'GET' && !this.csrfOk(req, session)) {
      return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing or invalid CSRF token' } });
    }

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
    // PUT /admin/g/:gid/personas/:id/grants  (set ad-hoc caps, clipped to G)
    const grantSet = /^\/personas\/([^/]+)\/grants$/.exec(sub);
    if (method === 'PUT' && grantSet) {
      return this.setGrant(res, session, guildId, decodeURIComponent(grantSet[1]), await readJson(req));
    }
    // DELETE /admin/g/:gid/personas/:id/grants[?channelId=]  (clear)
    if (method === 'DELETE' && grantSet) {
      return this.clearGrant(res, session, guildId, decodeURIComponent(grantSet[1]), url.searchParams.get('channelId'));
    }
    // POST /admin/g/:gid/personas/:id/claim  (admin-initiated augment)
    const claim = /^\/personas\/([^/]+)\/claim$/.exec(sub);
    if (method === 'POST' && claim) {
      return this.claimForPersona(res, session, guildId, decodeURIComponent(claim[1]), await readJson(req));
    }
    // NB: persona token lifecycle is intentionally NOT here — it's a global,
    // super-admin-only action at /admin/personas/:id/token (RFC-005 §5.9).

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  }

  // ── Auth flow ──

  private onLogin(res: ServerResponse): void {
    const state = this.sessions.issueState();
    setCookie(res, STATE_COOKIE, state, {
      httpOnly: true,
      secure: this.deps.config.cookieSecure,
      sameSite: 'Lax',
      maxAge: 600,
      path: '/admin',
    });
    redirect(res, authorizeUrl(this.deps.config.oauthClientId, this.deps.config.redirectUri, state));
  }

  private async onCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    const cookieState = getCookie(req, STATE_COOKIE);

    // Double-submit + single-use: query state must match the cookie AND be live.
    if (!code || !state || state !== cookieState || !this.sessions.consumeState(state)) {
      this.audit.append({
        actor: { id: 'unknown', name: 'unknown', kind: 'admin' },
        action: 'login.failed',
        ok: false,
        detail: { reason: 'state/code validation failed' },
      });
      clearCookie(res, STATE_COOKIE, '/admin');
      return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid oauth state' } });
    }
    clearCookie(res, STATE_COOKIE, '/admin');

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
      this.audit.append({
        actor: { id: 'unknown', name: 'unknown', kind: 'admin' },
        action: 'login.failed',
        ok: false,
        detail: { reason: (e as Error).message },
      });
      return sendJson(res, 502, { error: { code: 'OAUTH_FAILED', message: 'discord login failed' } });
    }

    const isSuper = this.deps.config.superadmins.includes(result.user.id);
    const session = this.sessions.create({
      userId: result.user.id,
      userName: result.user.global_name || result.user.username,
      adminGuilds: new Set(result.adminGuilds),
      guildNames: result.guildNames,
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
      detail: { isSuper, adminGuilds: result.adminGuilds },
    });
    redirect(res, this.deps.config.postLoginUrl);
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
      guilds: [...session.adminGuilds].map((id) => ({ id, name: session.guildNames[id] ?? id })),
      // CSRF token the SPA echoes in the X-CSRF-Token header on mutations (P2+).
      csrf: session.csrf,
    });
  }

  // ── Guild-scoped reads ──

  private onGuildRead(res: ServerResponse, session: AdminSession, guildId: string, resource: string, url: URL): void {
    const page = parsePage(url);
    switch (resource) {
      case 'invites':
        return sendJson(res, 200, paginate(this.invitesFor(guildId), page, 'invites'));
      case 'roles':
        return sendJson(res, 200, {
          catalog: this.deps.permissions.allRoles(),
          discordRoles: this.deps.listRoles(guildId),
          // Whether this admin may edit the catalog (super-admin only, §5.3).
          canAuthor: session.isSuper,
        });
      case 'personas':
        return sendJson(res, 200, paginate(this.personasFor(guildId, page.q), page, 'personas'));
      case 'channels':
        return sendJson(res, 200, { channels: this.deps.listChannels(guildId) });
      case 'audit':
        return sendJson(res, 200, { records: this.audit.read({ guildId, limit: page.limit }) });
      default:
        return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such resource' } });
    }
  }

  /** Drawer detail for one persona in a guild: roles + the G-scoped policy block. */
  private onPersonaDetail(res: ServerResponse, guildId: string, personaId: string): void {
    const p = this.deps.identity.get(personaId);
    if (!p) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const entry = this.deps.permissions.getEntry(personaId);
    sendJson(res, 200, {
      id: p.id,
      displayName: p.displayName,
      roles: entry?.roles ?? [],
      guildPolicy: entry?.policy?.guilds?.[guildId] ?? null,
    });
  }

  /** Invites scoped to a guild (those whose `guildId` matches), optional search. */
  private invitesFor(guildId: string, q?: string): any[] {
    const all = this.deps.invites?.all() ?? [];
    return all
      .filter((inv) => inv.guildId === guildId)
      .filter((inv) => !q || matches(q, inv.code, inv.label));
  }

  /** Personas with any possible access in the guild (trimmed for the table). */
  private personasFor(guildId: string, q?: string): any[] {
    const channelIds = new Set(this.deps.listChannels(guildId).map((c) => c.id));
    const inGuild = (cid: string) => channelIds.has(cid);
    const out: any[] = [];
    for (const p of this.deps.identity.all()) {
      if (!this.deps.permissions.couldAccessGuild(p.id, guildId, inGuild)) continue;
      if (q && !matches(q, p.id, p.displayName)) continue;
      const entry = this.deps.permissions.getEntry(p.id);
      out.push({
        id: p.id,
        displayName: p.displayName,
        roles: entry?.roles ?? [],
        hasOverride: !!entry?.policy?.guilds?.[guildId],
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
    if (!role) return `unknown role ${name}`;
    if (session.isSuper) return null;
    if (role.guildId !== guildId) return `role ${name} is not bound to this guild`;
    return null;
  }

  private mintInvite(res: ServerResponse, session: AdminSession, guildId: string, body: any): void {
    if (!this.deps.invites) return sendJson(res, 400, err('DISABLED', 'invites not enabled'));
    const roles: string[] = Array.isArray(body?.roles) ? body.roles : [];
    const grant = body?.grant;
    if (!roles.length && !grant) return sendJson(res, 400, err('INVALID', 'invite needs roles or a grant'));

    // Guild-admins may only grant access bound to their own guild (§5.3).
    for (const r of roles) {
      const e = this.roleAssignError(session, guildId, r);
      if (e) return sendJson(res, 403, err('FORBIDDEN', e));
    }
    if (grant?.scope?.channels) {
      for (const cid of grant.scope.channels as string[]) {
        if (!this.deps.channelInGuild(guildId, cid)) {
          return sendJson(res, 403, err('FORBIDDEN', `channel ${cid} is not in this guild`));
        }
      }
    }
    const mode = ['mint', 'augment', 'both'].includes(body?.mode) ? body.mode : undefined;
    const expiresAt =
      typeof body?.expiresInDays === 'number' && body.expiresInDays > 0
        ? new Date(this.nowMs() + body.expiresInDays * 86_400_000).toISOString()
        : undefined;
    const template: any = {
      code: this.deps.newInviteCode(),
      label: typeof body?.label === 'string' ? body.label : 'invite',
      guildId,
      uses: 0,
      ...(roles.length ? { roles } : { grant }),
      ...(mode ? { mode } : {}),
      ...(typeof body?.maxUses === 'number' ? { maxUses: body.maxUses } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(Array.isArray(body?.subscriptions) ? { subscriptions: body.subscriptions } : {}),
    };
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
    const roles = this.deps.permissions.addPersonaRoles(personaId, [name]);
    this.audit.append({ actor: this.actorOf(session), action: 'persona.role.assign', target: personaId, guildId, ok: true, after: { role: name } });
    sendJson(res, 200, { roles });
  }

  private revokeRole(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, role: string): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    // A guild-admin may only revoke roles bound to their guild (super: any).
    const e = this.roleAssignError(session, guildId, role);
    if (e) return sendJson(res, 403, err('FORBIDDEN', e));
    const roles = this.deps.permissions.removePersonaRole(personaId, role);
    this.audit.append({ actor: this.actorOf(session), action: 'persona.role.revoke', target: personaId, guildId, ok: true, before: { role } });
    sendJson(res, 200, { roles });
  }

  private setGrant(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const caps: string[] = Array.isArray(body?.caps) ? body.caps : [];
    const channelId: string | undefined = typeof body?.channelId === 'string' ? body.channelId : undefined;
    // Strictly clipped to G: a per-channel grant must target a channel in G.
    if (channelId && !this.deps.channelInGuild(guildId, channelId)) {
      return sendJson(res, 403, err('FORBIDDEN', 'channel is not in this guild'));
    }
    if (channelId) this.deps.permissions.setChannel(personaId, guildId, channelId, caps as any);
    else this.deps.permissions.setGuildDefault(personaId, guildId, caps as any);
    const guildPolicy = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId] ?? null;
    this.audit.append({ actor: this.actorOf(session), action: 'persona.grant.set', target: personaId, guildId, ok: true, after: { channelId, caps } });
    sendJson(res, 200, { guildPolicy });
  }

  private clearGrant(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, channelId: string | null): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    if (channelId) this.deps.permissions.clearChannel(personaId, guildId, channelId);
    else this.deps.permissions.setGuildDefault(personaId, guildId, [] as any);
    const guildPolicy = this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[guildId] ?? null;
    this.audit.append({ actor: this.actorOf(session), action: 'persona.grant.clear', target: personaId, guildId, ok: true, before: { channelId } });
    sendJson(res, 200, { guildPolicy });
  }

  private claimForPersona(res: ServerResponse, session: AdminSession, guildId: string, personaId: string, body: any): void {
    if (!this.deps.identity.get(personaId)) return sendJson(res, 404, err('NOT_FOUND', 'no such persona'));
    const code = body?.code;
    if (typeof code !== 'string' || !code) return sendJson(res, 400, err('INVALID', 'code required'));
    const inv = this.deps.invites?.get(code);
    if (!inv || inv.guildId !== guildId) return sendJson(res, 404, err('NOT_FOUND', 'no such invite in this guild'));
    let result;
    try {
      result = this.deps.applyClaim(personaId, code);
    } catch (e) {
      return sendJson(res, 400, err('INVALID', (e as Error).message));
    }
    this.audit.append({ actor: this.actorOf(session), action: 'persona.claim', target: personaId, guildId, ok: true, after: { code, roles: result.roles } });
    sendJson(res, 200, { roles: result.roles });
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
    if (method !== 'GET' && !this.csrfOk(req, session)) {
      return sendJson(res, 403, err('CSRF', 'missing or invalid CSRF token'));
    }
    if (method === 'POST' && path === '/admin/roles') {
      const body = await readJson(req);
      const name = body?.name;
      const role = body?.role;
      if (typeof name !== 'string' || !name || !role || !Array.isArray(role.caps) || !role.scope) {
        return sendJson(res, 400, err('INVALID', 'name + role{caps,scope} required'));
      }
      this.deps.permissions.setRole(name, role);
      this.audit.append({ actor: this.actorOf(session), action: 'role.set', target: name, ok: true, after: role });
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
      return sendJson(res, 200, {
        id: p.id,
        displayName: p.displayName,
        roles,
        // Inline per-persona policy (ad-hoc grants), if any.
        policy: entry?.policy ?? null,
        // Guilds (named) where this persona can act, and how.
        guilds: this.guildsWithAccess(id).map((gid) => ({ id: gid, name: this.guildName(gid) })),
      });
    }
    // POST /admin/personas/:id/token — rotate/revoke (CSRF-checked).
    const tok = /^\/admin\/personas\/([^/]+)\/token$/.exec(path);
    if (method === 'POST' && tok) {
      if (!this.csrfOk(req, session)) return sendJson(res, 403, err('CSRF', 'missing or invalid CSRF token'));
      return this.personaToken(res, session, decodeURIComponent(tok[1]), await readJson(req));
    }
    sendJson(res, 404, err('NOT_FOUND', 'no such route'));
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
    return Date.now();
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

function err(code: string, message: string) {
  return { error: { code, message } };
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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
