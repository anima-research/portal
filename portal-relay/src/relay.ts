/**
 * Orchestrator. Ties the Discord connection, identity, role/webhook pools, the
 * message store, and the WS gateway together:
 *   - inbound Discord events → addressed PortalEvents fanned out per persona
 *   - client RPC → capability-checked Discord actions via the pools
 */
import { randomBytes } from 'node:crypto';
import type {
  AddressReason,
  Capability,
  PortalChannel,
  PortalMessage,
  ReadyData,
  RegisterData,
  RegisteredData,
  RpcMethod,
  RpcParams,
  RpcRequest,
  RpcResponse,
} from '@animalabs/portal-protocol';
import type { InviteTemplate, PersonaIdentity, PersonaPolicy, RelayConfig, Scope } from './config.js';
import { DiscordBot, type ChannelMeta, type IncomingMessage } from './discord-bot.js';
import { splitPreservingMarkdown, type ChunkPiece } from './discord-markdown.js';
import { Gateway, type GatewayHooks, Session } from './gateway.js';
import { GuildAllowStore, type GuildAllowChange } from './guild-allowlist.js';
import { HistoryCache } from './history-cache.js';
import { IdentityStore, type IdentityChange, generateToken, hashToken } from './identity.js';
import { InviteStore } from './invites.js';
import { MessageStore, makeRelayId, parseRelayId, type MessageRef } from './message-store.js';
import { MirrorCache } from './mirror-cache.js';
import { PermissionsStore, type PermissionChange, computeCapabilities } from './permissions.js';
import { ReadStateStore } from './read-state.js';
import { RolePool } from './role-pool.js';
import { PartialSendError, WebhookPool, type WebhookSendOpts } from './webhook-pool.js';
import { AdminServer, type AdminDeps } from './admin/server.js';
import { AuditLog } from './admin/audit.js';

/** Discord's hard per-message content limit. */
const DISCORD_MSG_LIMIT = 2000;

/** How long to hold an own-webhook send echo waiting for the RPC to record its
 *  attribution before dispatching it anyway (safety net; normally flushed in
 *  milliseconds). Generous enough to ride out a slow multi-part send. */
const ECHO_HOLD_MS = 5000;

export class Relay implements GatewayHooks {
  private bot: DiscordBot;
  readonly identity: IdentityStore;
  readonly permissions: PermissionsStore;
  readonly invites?: InviteStore;
  /** Store-backed guild allow-list (PORTAL_GUILDS). Undefined ⇒ legacy env mode. */
  private guildAllow?: GuildAllowStore;
  private roles: RolePool;
  private webhooks: WebhookPool;
  private store: MessageStore;
  private readState: ReadStateStore;
  private history: HistoryCache;
  private gateway: Gateway;
  private mirror: MirrorCache;
  /** Own-webhook send echoes held until their RPC records attribution (the
   *  gateway event can beat the REST response). See onDiscordMessage. */
  private pendingEchoes = new Map<string, { inc: IncomingMessage; timer: NodeJS.Timeout }>();
  private admin?: AdminServer;
  /** Shared audit log (RFC-005). Present only when the admin panel is enabled;
   *  self-service ops (claim_invite / rotate_token) audit here too. */
  private audit?: AuditLog;

  constructor(private config: RelayConfig) {
    // Guild allow-list: store mode (PORTAL_GUILDS, editable, empty ⇒ deny all)
    // or legacy env mode (DISCORD_GUILD_ID snapshot, empty ⇒ allow all = null).
    if (config.guildAllowPath) this.guildAllow = new GuildAllowStore(config.guildAllowPath, config.guildIds);
    const allowedGuilds = (): string[] | null =>
      this.guildAllow ? this.guildAllow.list() : config.guildIds.length ? config.guildIds : null;
    this.bot = new DiscordBot(config.discordToken, allowedGuilds, {
      guildMembersIntent: config.guildMembersIntent,
      maxInlineTotalBytes: config.maxInlineFileBytes,
      allowPathFiles: config.allowPathFiles,
    });
    this.store = new MessageStore({ path: config.attributionPath });
    this.readState = new ReadStateStore({
      path: config.readStatePath,
      pingsCap: config.readStatePingsCap,
      channelsCap: config.readStateChannelsCap,
    });
    this.history = new HistoryCache(config.historyCacheTtlMs);
    this.identity = new IdentityStore(config.identityPath, config.avatarBaseUrl);
    this.permissions = new PermissionsStore(config.permissionsPath);
    // Mirror cache backs `mirrorRole` access-role scopes; inject the live lookup
    // so resolve() can ask Discord which channels a role can see (RFC-004 §5.5).
    this.mirror = new MirrorCache(this.bot);
    this.permissions.setMirrorVisibility((g, r) => this.mirror.visible(g, r));
    if (config.invitesPath) this.invites = new InviteStore(config.invitesPath);
    this.roles = new RolePool(this.bot, config.rolePool.size, config.rolePool.prefix);
    this.webhooks = new WebhookPool(this.bot, config.webhookPoolSize);
    this.gateway = new Gateway(this, config.heartbeatIntervalMs);
    // RFC-005: admin HTTP API. The deps object closes over the bot/gateway so the
    // admin module stays decoupled from discord.js and is unit-testable.
    if (config.admin) {
      this.audit = new AuditLog(config.admin.auditPath);
      const deps: AdminDeps = {
        config: config.admin,
        identity: this.identity,
        permissions: this.permissions,
        invites: this.invites,
        audit: this.audit,
        listGuilds: () => this.bot.listGuilds(),
        listAllGuilds: () => this.bot.listAllGuilds(),
        allowlist: {
          editable: !!this.guildAllow,
          list: () => (this.guildAllow ? this.guildAllow.list() : config.guildIds),
          allow: (gid) => this.guildAllow!.allow(gid),
          disallow: (gid) => this.guildAllow!.disallow(gid),
        },
        listRoles: (gid) => this.bot.listRoles(gid, config.rolePool.prefix),
        listChannels: (gid) =>
          this.bot.listChannelMetas(gid).map((c) => ({
            id: c.id,
            name: c.name ?? undefined,
            type: c.type,
          })),
        channelInGuild: (gid, cid) => this.bot.channelForPerms(cid)?.guildId === gid,
        closePersona: (personaId) => this.gateway.closePersona(personaId),
        applyClaim: (personaId, code) => this.applyInviteAugment(personaId, code),
        rotatePersonaToken: (personaId) => this.rotatePersonaToken(personaId),
        revokePersonaToken: (personaId) => this.revokePersonaToken(personaId),
        newInviteCode: () => `inv_${randomBytes(18).toString('base64url')}`,
      };
      this.admin = new AdminServer(deps);
    }
  }

  async start(): Promise<void> {
    this.bot.on('message', (m) => this.onDiscordMessage(m));
    this.bot.on('messageEdit', (m) => this.onDiscordEdit(m));
    this.bot.on('messageDelete', (channelId, messageId) => this.onDiscordDelete(channelId, messageId));
    this.bot.on('reactionAdd', (r) => this.onReactionEvent('add', r));
    this.bot.on('reactionRemove', (r) => this.onReactionEvent('remove', r));
    this.bot.on('pinsUpdate', (channelId) => this.onPinsUpdate(channelId));
    // Mirror-cache invalidation (RFC-004 §5.5): role perms → by role; channel
    // overwrites → by guild (any role's visibility may shift); reconnect → flush.
    this.bot.on('roleChange', (guildId, roleId) => {
      this.mirror.invalidateRole(guildId, roleId);
      this.repushGuildCaps(guildId);
    });
    this.bot.on('channelChange', (meta) => {
      if (meta.guildId) {
        this.mirror.invalidateGuild(meta.guildId);
        this.repushGuildCaps(meta.guildId);
      }
    });
    this.bot.on('channelDelete', (_channelId, guildId) => {
      if (guildId) {
        this.mirror.invalidateGuild(guildId);
        this.repushGuildCaps(guildId);
      }
    });
    this.bot.on('ready', () => this.mirror.clear());
    // A pre-authorized guild (allow-listed before the bot joined) lights up the
    // moment the bot joins it; discord-bot only fires this for allowed guilds.
    this.bot.on('guildCreate', (guildId) => this.onGuildAllowChange({ added: [guildId], removed: [] }));
    // Live identity/permission changes → wire events.
    this.identity.onChange((c) => void this.onIdentityChange(c).catch((e) => console.error('[portal-relay] identity change:', (e as Error).message)));
    this.permissions.onChange((c) => this.onPermissionChange(c));
    this.guildAllow?.onChange((c) => this.onGuildAllowChange(c));
    if (this.config.watchConfig) {
      this.identity.startWatching();
      this.permissions.startWatching();
      this.invites?.startWatching();
      this.guildAllow?.startWatching();
    }
    if (this.invites) console.error('[portal-relay] self-registration enabled (invites)');
    await this.bot.connect();
    console.error(`[portal-relay] discord connected as ${this.bot.botUserId}`);
    this.gateway.listen(this.config.wsPort);
    await this.admin?.listen();
  }

  async stop(): Promise<void> {
    for (const held of this.pendingEchoes.values()) clearTimeout(held.timer);
    this.pendingEchoes.clear();
    this.identity.stopWatching();
    this.permissions.stopWatching();
    this.invites?.stopWatching();
    this.guildAllow?.stopWatching();
    this.store.flush();
    this.readState.flush();
    await this.admin?.close();
    await this.gateway.close();
    await this.bot.disconnect();
  }

  /** Resolve a relay id to a MessageRef: in-memory → persisted attribution →
   *  Discord re-fetch (C2). Returns null only if the message can't be found. */
  private async resolveRef(relayId: string): Promise<MessageRef | null> {
    const hit = this.store.getByRelayId(relayId);
    if (hit) return hit;
    const parsed = parseRelayId(relayId);
    if (!parsed) return null;
    const meta = await this.bot.fetchMessageMeta(parsed.channelId, parsed.discordMsgId);
    return meta ? this.store.record(meta) : null;
  }

  // ── Live config changes → wire events ──

  private async onIdentityChange(c: IdentityChange): Promise<void> {
    if (c.kind === 'remove') {
      this.gateway.closePersona(c.id);
      this.readState.forget(c.id);
      return;
    }
    const renamed = c.prev && c.prev.displayName !== c.next.displayName;
    if (renamed) await this.roles.rename(c.id, c.next.displayName);
    // Push the updated identity to the persona's live sessions.
    const persona = this.identity.toPersona(c.next, this.roles.roleByGuildFor(c.id));
    this.gateway.dispatch(c.id, { type: 'persona_update', persona });
  }

  private onPermissionChange(c: PermissionChange): void {
    if (this.gateway.sessionsOf(c.personaId).length === 0) return;
    let channels: ChannelMeta[];
    if (c.scope === 'channel' && c.channelId) {
      const meta = this.bot.channelMetaFromCache(c.channelId);
      channels = meta ? [meta] : [];
    } else if (c.scope === 'guild' && c.guildId) {
      channels = this.bot.listChannelMetas(c.guildId);
    } else {
      channels = this.bot.listGuilds().flatMap((g) => this.bot.listChannelMetas(g.id));
    }
    for (const meta of channels) {
      this.gateway.dispatch(c.personaId, {
        type: 'capabilities_update',
        channelId: meta.id,
        capabilities: this.capsFor(c.personaId, meta.id, meta.guildId),
      });
    }
  }

  /** Guild allow-list changed at runtime (admin edit, hot-reload, or the bot
   *  joining a pre-authorized guild). The bot's cache already holds every
   *  joined guild, so no Discord reconnect is involved — just tell sessions. */
  private onGuildAllowChange(c: GuildAllowChange): void {
    for (const gid of c.added) {
      this.mirror.invalidateGuild(gid);
      // Accessor is live: an allowed+joined guild shows up here. Not found ⇒
      // pre-authorized but not joined yet — dormant until guildCreate fires.
      const g = this.bot.listGuilds().find((x) => x.id === gid);
      if (!g) continue;
      const metas = this.bot.listChannelMetas(gid);
      for (const personaId of this.gateway.activePersonas()) {
        this.gateway.dispatch(personaId, {
          type: 'guild_create',
          guild: { id: g.id, native: g.id, name: g.name, memberCount: g.memberCount },
          channels: metas.map((m) => this.toPortalChannel(m, personaId)),
        });
      }
    }
    for (const gid of c.removed) {
      this.mirror.invalidateGuild(gid);
      this.repushGuildCaps(gid); // capsFor's allow-gate zeroes them out
      for (const personaId of this.gateway.activePersonas()) {
        this.gateway.dispatch(personaId, { type: 'guild_delete', guildId: gid });
      }
    }
  }

  /** Re-push capabilities for every connected persona across a guild's channels.
   *  Used when a role/channel change may have shifted mirrorRole visibility. */
  private repushGuildCaps(guildId: string): void {
    const metas = this.bot.listChannelMetas(guildId);
    if (!metas.length) return;
    for (const personaId of this.gateway.activePersonas()) {
      for (const meta of metas) {
        this.gateway.dispatch(personaId, {
          type: 'capabilities_update',
          channelId: meta.id,
          capabilities: this.capsFor(personaId, meta.id, guildId),
        });
      }
    }
  }

  // ── GatewayHooks ──

  authenticate(token: string, personaId: string): string | null {
    return this.identity.authenticate(token, personaId)?.id ?? null;
  }

  /**
   * Self-registration via an invite template. Validates the invite, mints a
   * fresh persona id + token, stamps the invite's capability profile as the
   * persona's default policy, and consumes one use. The agent persists the
   * returned token and uses normal `identify` thereafter.
   */
  async enroll(d: RegisterData): Promise<RegisteredData | { error: string }> {
    if (!this.invites) return { error: 'registration disabled' };
    const checked = this.invites.check(d.invite, Date.now());
    if (typeof checked === 'string') return { error: `invite ${checked}` };
    // RFC-005 §5.6: an augment-only invite cannot mint a new persona.
    if (checked.mode === 'augment') return { error: 'invite is augment-only' };

    const displayName = (d.desiredName || 'agent').slice(0, 80).trim() || 'agent';
    const personaId = this.mintPersonaId(checked.namePrefix ?? displayName);
    const token = generateToken(); // plaintext, returned to the agent
    const identity: PersonaIdentity = {
      id: personaId,
      displayName,
      avatar: d.avatar ?? '',
      token: hashToken(token), // stored hashed-at-rest (RFC-005 §5.9)
    };
    this.identity.upsert(identity);
    this.applyInviteGrant(personaId, checked);
    this.invites.consume(d.invite);

    // Carry the invite's default subscriptions through to this session.
    if (checked.subscriptions?.length) {
      d.subscriptions = [...new Set([...(d.subscriptions ?? []), ...checked.subscriptions])];
    }

    console.error(`[portal-relay] enrolled persona "${personaId}" via invite (${checked.label ?? d.invite})`);
    return { personaId, token, persona: this.identity.toPersona(identity) };
  }

  /**
   * Translate an invite into the new persona's permissions (RFC-004). Prefers
   * access roles (live resolution); else an inline scoped grant; else the
   * deprecated blanket `caps` (honoured as scope:{all} with a warning). A grant
   * with no scope-able guild, or an invite granting nothing, yields a
   * default-deny entry.
   */
  private applyInviteGrant(personaId: string, inv: InviteTemplate): void {
    if (inv.roles?.length) {
      this.permissions.setPersonaRoles(personaId, inv.roles);
      return;
    }
    let grant = inv.grant;
    if (!grant && inv.caps?.length) {
      console.error(
        `[portal-relay] invite "${inv.label ?? inv.code}" uses deprecated blanket caps; ` +
          `honouring as scope:{all}. Re-mint scoped (RFC-004).`,
      );
      grant = { caps: inv.caps, scope: { all: true } };
    }
    if (!grant) {
      this.permissions.setPersonaPolicy(personaId, { default: [] }); // nothing granted → deny
      return;
    }
    this.permissions.setPersonaPolicy(personaId, this.scopeToPolicy(inv.guildId, grant.scope, grant.caps));
  }

  /** Turn a (guild, scope, caps) grant into a default-deny PersonaPolicy. A
   *  `mirrorRole` scope is snapshotted to its currently-visible channels (use an
   *  access role for live mirroring). */
  private scopeToPolicy(guildId: string | undefined, scope: Scope, caps: Capability[]): PersonaPolicy {
    if ('all' in scope) return { default: caps };
    if (!guildId) {
      console.error('[portal-relay] scoped grant without guildId — denying (no channels in scope)');
      return { default: [] };
    }
    const channelIds =
      'channels' in scope
        ? scope.channels
        : 'mirrorRoles' in scope
          ? [...new Set(scope.mirrorRoles.flatMap((r) => [...this.bot.channelsVisibleToRole(guildId, r)]))]
          : [...this.bot.channelsVisibleToRole(guildId, scope.mirrorRole)];
    const channels: Record<string, Capability[]> = {};
    for (const id of channelIds) channels[id] = caps;
    return { default: [], guilds: { [guildId]: { default: [], channels } } };
  }

  /**
   * Augment an EXISTING persona with an invite's grant (RFC-005 §5.6). Shared by
   * the `claim_invite` op (actor = the persona) and admin-initiated claim (actor =
   * an admin). Validates the invite + its `mode`, unions roles / merges inline
   * grant, consumes a use, and returns the resulting role set. Throws rpcError on
   * any rejection. Auditing is the caller's responsibility (actor differs).
   */
  private applyInviteAugment(personaId: string, code: string): { roles: string[] } {
    if (!this.invites) throw rpcError('NOT_FOUND', 'invites not enabled');
    if (!this.identity.get(personaId)) throw rpcError('NOT_FOUND', 'no such persona');
    const checked = this.invites.check(code, Date.now());
    if (typeof checked === 'string') throw rpcError('INVALID_PARAMS', `invite ${checked}`);
    if (checked.mode !== 'augment' && checked.mode !== 'both') {
      throw rpcError('FORBIDDEN', 'invite is not claimable (mint-only)');
    }
    if (checked.roles?.length) {
      this.permissions.addPersonaRoles(personaId, checked.roles);
    } else {
      const grant = checked.grant ?? (checked.caps?.length ? { caps: checked.caps, scope: { all: true } as Scope } : undefined);
      if (grant) {
        const add = this.scopeToPolicy(checked.guildId, grant.scope, grant.caps);
        const base = this.permissions.getPolicy(personaId) ?? { default: [] };
        this.permissions.setPersonaPolicy(personaId, this.mergePolicy(base, add));
      }
    }
    this.invites.consume(code);
    return { roles: this.permissions.getRoleNames(personaId) };
  }

  /** Union two policies (most-permissive) for augment-merge. */
  private mergePolicy(base: PersonaPolicy, add: PersonaPolicy): PersonaPolicy {
    const out: PersonaPolicy = { default: [...new Set([...base.default, ...add.default])] };
    const guilds: Record<string, { default?: Capability[]; channels?: Record<string, Capability[]> }> = {
      ...(base.guilds ?? {}),
    };
    for (const [gid, gp] of Object.entries(add.guilds ?? {})) {
      const cur = guilds[gid] ?? {};
      const channels = { ...(cur.channels ?? {}) };
      for (const [cid, caps] of Object.entries(gp.channels ?? {})) {
        channels[cid] = [...new Set([...(channels[cid] ?? []), ...caps])];
      }
      guilds[gid] = {
        default: [...new Set([...(cur.default ?? []), ...(gp.default ?? [])])],
        ...(Object.keys(channels).length ? { channels } : {}),
      };
    }
    if (Object.keys(guilds).length) out.guilds = guilds;
    return out;
  }

  /** Mint a fresh token for a persona, store it hashed, return the plaintext.
   *  Sessions stay up (self-rotation is zero-downtime, RFC-005 §5.9). */
  private rotatePersonaToken(personaId: string): string {
    const cur = this.identity.get(personaId);
    if (!cur) throw rpcError('NOT_FOUND', 'no such persona');
    const token = generateToken();
    this.identity.upsert({ ...cur, token: hashToken(token) });
    return token;
  }

  /** Invalidate a persona's token (rotate to an undisclosed secret) and drop its
   *  live sessions — admin force-revoke for a compromised/rogue agent (§5.9). */
  private revokePersonaToken(personaId: string): void {
    const cur = this.identity.get(personaId);
    if (!cur) throw rpcError('NOT_FOUND', 'no such persona');
    this.identity.upsert({ ...cur, token: hashToken(generateToken()) });
    this.gateway.closePersona(personaId);
  }

  /** Slug a display name + short random suffix into a unique persona id. */
  private mintPersonaId(seed: string): string {
    const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
    for (let i = 0; i < 8; i++) {
      const id = `${base}-${randomBytes(3).toString('hex')}`;
      if (!this.identity.get(id)) return id;
    }
    return `${base}-${randomBytes(8).toString('hex')}`;
  }

  async buildReady(session: Session): Promise<ReadyData> {
    const cfg = this.identity.get(session.personaId)!;
    const guilds = this.bot.listGuilds();
    const channels: PortalChannel[] = [];
    for (const g of guilds) {
      for (const meta of this.bot.listChannelMetas(g.id)) {
        channels.push(this.toPortalChannel(meta, session.personaId));
      }
    }
    // Pre-bind a role in each guild the persona can actually act in, so it's
    // addressable immediately. Skip guilds where it has no rights — no point
    // minting (and leaking) a Discord addressing role there.
    const roleByGuild: Record<string, string> = {};
    for (const g of guilds) {
      if (!this.personaCanAccessGuild(cfg.id, g.id)) continue;
      try {
        roleByGuild[g.id] = await this.roles.bind(g.id, cfg.id, cfg.displayName);
      } catch (err) {
        console.error(`[portal-relay] role bind failed (${g.id}/${cfg.id}):`, (err as Error).message);
      }
    }
    return {
      sessionId: session.id,
      persona: this.identity.toPersona(cfg, roleByGuild),
      guilds: guilds.map((g) => ({ id: g.id, native: g.id, name: g.name, memberCount: g.memberCount })),
      channels,
      seq: this.gateway.seqOf(session.personaId),
    };
  }

  async handleRpc(session: Session, req: RpcRequest): Promise<void> {
    try {
      const result = await this.dispatchRpc(session, req.method, req.params);
      session.send({ op: 'rpc_result', d: { id: req.id, ok: true, result } as RpcResponse });
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = (e.code as never) ?? 'INTERNAL';
      session.send({
        op: 'rpc_result',
        d: { id: req.id, ok: false, error: { code, message: e.message } },
      });
    }
  }

  // ── RPC dispatch ──

  private async dispatchRpc(
    session: Session,
    method: RpcMethod,
    params: unknown,
  ): Promise<unknown> {
    const personaId = session.personaId;
    switch (method) {
      case 'send_message': {
        const p = params as RpcParams<'send_message'>;
        return this.sendMessage(personaId, p);
      }
      case 'edit_message': {
        const p = params as RpcParams<'edit_message'>;
        const ref = await this.resolveRef(p.messageId);
        if (!ref) throw rpcError('NOT_FOUND', 'unknown message');
        if (ref.personaId !== personaId) throw rpcError('FORBIDDEN', 'not your message');
        if (!ref.webhookId) throw rpcError('NOT_FOUND', 'no webhook recorded for message');
        this.requireCap(personaId, ref.channelId, 'EDIT_OWN');
        await this.webhooks.ensureLoaded(ref.channelId); // adopt webhooks post-restart
        const primary = this.primaryOf(ref);
        // All parts of a split went out on one webhook; a rehydrated primary
        // missing its webhookId can safely borrow the addressed part's.
        if (!primary.webhookId) primary.webhookId = ref.webhookId;
        await this.editMessage(primary, p.content);
        return {};
      }
      case 'delete_message': {
        const p = params as RpcParams<'delete_message'>;
        const ref = await this.resolveRef(p.messageId);
        if (!ref) throw rpcError('NOT_FOUND', 'unknown message');
        const primary = this.primaryOf(ref);
        const partIds = primary.parts ?? [primary.discordMsgId];
        let del: (id: string) => Promise<void>;
        if (ref.personaId === personaId && ref.webhookId) {
          // Own webhook message → delete via the webhook (every part of a split).
          this.requireCap(personaId, ref.channelId, 'DELETE_OWN');
          await this.webhooks.ensureLoaded(ref.channelId);
          const webhookId = ref.webhookId;
          del = (id) => this.webhooks.delete(webhookId, id, ref.threadId);
        } else {
          // Someone else's message → moderation delete (bot-level), gated by the
          // MANAGE_MESSAGES capability (and the bot's Discord Manage Messages perm).
          this.requireCap(personaId, ref.channelId, 'MANAGE_MESSAGES');
          del = (id) => this.bot.deleteAnyMessage(ref.threadId ?? ref.channelId, id);
        }
        // Attempt every part before failing so one bad part doesn't strand the
        // rest — but a failure must still surface, not report success.
        const failed: Error[] = [];
        for (const id of partIds) {
          try {
            await del(id);
          } catch (err) {
            failed.push(err as Error);
          }
        }
        if (failed.length) {
          throw rpcError(
            'DISCORD_ERROR',
            `failed to delete ${failed.length}/${partIds.length} message part(s): ${failed[0].message}`,
          );
        }
        return {};
      }
      case 'react': {
        const p = params as RpcParams<'react'>;
        return this.react(personaId, p.messageId, p.emoji, p.visible, p.native ?? false);
      }
      case 'unreact': {
        const p = params as RpcParams<'unreact'>;
        const ref = await this.resolveRef(p.messageId);
        if (ref) {
          this.gateway.dispatch(personaId, {
            type: 'reaction_remove',
            channelId: ref.channelId,
            threadId: ref.threadId,
            messageId: ref.relayId,
            emoji: p.emoji,
            actor: { kind: 'persona', id: personaId, name: this.displayName(personaId) },
          });
          // Optionally drop the shared bot's native reaction (best-effort — the
          // structured pseudo-remove above is authoritative for agents/UI).
          if (p.native) {
            try {
              await this.bot.removeReaction(ref.threadId ?? ref.channelId, ref.discordMsgId, p.emoji);
            } catch (err) {
              console.error('[portal-relay] native unreact failed:', (err as Error).message);
            }
          }
        }
        return {};
      }
      case 'fetch_history': {
        const p = params as RpcParams<'fetch_history'>;
        this.requireCap(personaId, p.channelId, 'READ_HISTORY');
        const before = this.cursorToSnowflake(p.before);
        const after = this.cursorToSnowflake(p.after);
        const limit = p.limit ?? 50;
        let raw = this.history.get(p.channelId, limit, before, after);
        if (!raw) {
          raw = await this.bot.fetchHistory(p.channelId, limit, before, after);
          this.history.set(p.channelId, limit, before, after, raw);
        }
        const messages = raw.map((m) => this.buildPortalMessage(m).message);
        return { messages };
      }
      case 'list_guilds':
        return { guilds: this.bot.listGuilds().map((g) => ({ ...g, native: g.id })) };
      case 'list_channels': {
        const p = params as RpcParams<'list_channels'>;
        const channels = this.bot
          .listChannelMetas(p.guildId)
          .map((meta) => this.toPortalChannel(meta, personaId));
        return { channels };
      }
      case 'create_thread': {
        const p = params as RpcParams<'create_thread'>;
        this.requireCap(personaId, p.channelId, 'CREATE_THREADS');
        const meta = await this.bot.createThread(p.channelId, p.name);
        return { channel: this.toPortalChannel(meta, personaId) };
      }
      case 'create_text_channel': {
        const p = params as RpcParams<'create_text_channel'>;
        const meta = await this.bot.createTextChannel(p.guildId, p.name, p.categoryId);
        return { channel: this.toPortalChannel(meta, personaId) };
      }
      case 'delete_channel': {
        const p = params as RpcParams<'delete_channel'>;
        this.requireCap(personaId, p.channelId, 'MANAGE_CHANNELS');
        await this.bot.deleteChannel(p.channelId);
        return {};
      }
      case 'subscribe_channel': {
        const p = params as RpcParams<'subscribe_channel'>;
        // Gate subscription on the same VIEW_CHANNEL capability every other
        // channel RPC enforces. Without this a persona could subscribe to a
        // channel it cannot view and receive its live dispatch — an info leak.
        this.requireCap(personaId, p.channelId, 'VIEW_CHANNEL');
        session.subscriptions.add(p.channelId);
        return {};
      }
      case 'unsubscribe_channel': {
        const p = params as RpcParams<'unsubscribe_channel'>;
        session.subscriptions.delete(p.channelId);
        return {};
      }
      case 'list_subscriptions':
        return { channelIds: [...session.subscriptions] };
      case 'list_members': {
        const p = params as RpcParams<'list_members'>;
        return {
          members: this.bot.listMembers(p.guildId, p.query, p.limit ?? 100),
          membersAvailable: this.bot.hasMembersIntent,
        };
      }
      case 'resolve_mentions': {
        const p = params as RpcParams<'resolve_mentions'>;
        return { resolved: this.bot.resolveHandles(p.guildId, p.handles) };
      }
      case 'list_roles': {
        const p = params as RpcParams<'list_roles'>;
        return { roles: this.bot.listRoles(p.guildId, this.config.rolePool.prefix) };
      }
      case 'list_emojis': {
        const p = params as RpcParams<'list_emojis'>;
        const emojis = (await this.bot.listEmojis(p.guildId)).map((e) => ({
          id: e.id,
          name: e.name,
          animated: e.animated,
          guildId: e.guildId,
          guildName: e.guildName,
          token: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
          reactionArg: `:${e.name}:`,
        }));
        return { emojis };
      }
      case 'list_pins': {
        const p = params as RpcParams<'list_pins'>;
        this.requireCap(personaId, p.channelId, 'READ_HISTORY');
        const raw = await this.bot.listPins(p.channelId);
        return { messages: raw.map((m) => this.buildPortalMessage(m).message) };
      }
      case 'set_typing': {
        const p = params as RpcParams<'set_typing'>;
        await this.bot.sendTyping(p.threadId ?? p.channelId);
        return {};
      }
      case 'get_pending_pings':
        return { pings: this.readState.pendingPings(personaId) };
      case 'list_unread':
        return { channels: this.readState.unread(personaId) };
      case 'mark_read': {
        const p = params as RpcParams<'mark_read'>;
        this.readState.markRead(personaId, p.channelId, p.uptoCreatedAt);
        return {};
      }
      case 'channel_missed': {
        const p = params as RpcParams<'channel_missed'>;
        return this.readState.missed(personaId, p.channelId);
      }
      case 'claim_invite': {
        const p = params as RpcParams<'claim_invite'>;
        const result = this.applyInviteAugment(personaId, p.code);
        this.audit?.append({
          actor: { id: personaId, name: this.displayName(personaId), kind: 'persona' },
          action: 'claim_invite',
          target: p.code,
          ok: true,
          after: { roles: result.roles },
        });
        return result;
      }
      case 'rotate_token': {
        const token = this.rotatePersonaToken(personaId);
        this.audit?.append({
          actor: { id: personaId, name: this.displayName(personaId), kind: 'persona' },
          action: 'rotate_token',
          target: personaId,
          ok: true,
        });
        return { token };
      }
      default:
        throw rpcError('INVALID_PARAMS', `unknown method ${String(method)}`);
    }
  }

  private async sendMessage(
    personaId: string,
    p: RpcParams<'send_message'>,
  ): Promise<{ messageId: string; messageIds?: string[] }> {
    const cfg = this.identity.get(personaId)!;
    const target = await this.bot.resolveTarget(p.channelId);
    if (!target) throw rpcError('NOT_FOUND', 'channel not found');
    this.requireCap(personaId, p.channelId, target.threadId ? 'SEND_IN_THREADS' : 'SEND_MESSAGES');

    const meta = await this.bot.getChannelMeta(target.parentChannelId);
    const guildId = meta?.guildId ?? null;

    let content = p.content ?? '';
    content = this.bot.resolveOutgoingMentions(guildId, content);

    // Resolve persona @-addressing into bound role mentions.
    if (p.mentionPersonaIds?.length && guildId) {
      const tags: string[] = [];
      for (const pid of p.mentionPersonaIds) {
        const target2 = this.identity.get(pid);
        if (!target2) continue;
        // Don't mint an addressing role for a persona with no rights in this guild.
        if (!this.personaCanAccessGuild(pid, guildId)) continue;
        const roleId = await this.roles.bind(guildId, pid, target2.displayName);
        tags.push(`<@&${roleId}>`);
      }
      if (tags.length) content = `${tags.join(' ')} ${content}`.trim();
    }

    // Reply degrades to a quoted jump-link (webhooks can't carry native replies).
    // Suppressible via PORTAL_REPLY_LINK=false.
    if (p.replyToId && this.config.replyLink) {
      const ref = await this.resolveRef(p.replyToId);
      if (ref && ref.guildId) {
        const link = `https://discord.com/channels/${ref.guildId}/${ref.threadId ?? ref.channelId}/${ref.discordMsgId}`;
        content = `> ↪ ${link}\n${content}`;
      }
    }

    const base = {
      threadId: target.threadId,
      username: cfg.displayName,
      avatarURL: this.identity.avatarUrl(cfg),
    };

    if (content.length <= DISCORD_MSG_LIMIT) {
      const { messageId, webhookId } = await this.webhooks.send(target.parentChannelId, personaId, {
        ...base,
        content,
        files: p.files,
      });
      const ref = this.store.record({
        channelId: target.parentChannelId,
        threadId: target.threadId,
        guildId,
        discordMsgId: messageId,
        personaId,
        webhookId,
      });
      this.flushEcho(messageId);
      return { messageId: ref.relayId };
    }

    // Over-long send → markdown-preserving split into several Discord messages.
    // Files ride on the last part so they land under the complete text.
    const { chunks } = splitPreservingMarkdown(content, DISCORD_MSG_LIMIT);
    const optsList: WebhookSendOpts[] = chunks.map((c, i) => ({
      ...base,
      content: c.text,
      files: i === chunks.length - 1 ? p.files : undefined,
    }));
    // Record each part the moment it is posted (not after the whole batch):
    // a part's gateway echo arrives while later parts are still sending, and
    // it must already find the bridge metadata and attribution.
    const partIds: string[] = [];
    const refs: MessageRef[] = [];
    const onSent = (i: number, discordMsgId: string, webhookId: string): void => {
      partIds.push(discordMsgId);
      refs.push(
        this.store.record({
          channelId: target.parentChannelId,
          threadId: target.threadId,
          guildId,
          discordMsgId,
          personaId,
          webhookId,
          bridgeOpen: chunks[i].bridgeOpen,
          bridgeClose: chunks[i].bridgeClose,
          partOf: i > 0 ? partIds[0] : undefined,
        }),
      );
      this.flushEcho(discordMsgId);
    };
    let sent: { messageIds: string[]; webhookId: string };
    try {
      sent = await this.webhooks.sendMany(target.parentChannelId, personaId, optsList, onSent);
    } catch (err) {
      // Parts that DID land are already recorded by onSent; stamp the (partial)
      // part-set on the first so edit/delete still cover the whole set, and
      // name them in the error so the caller can clean up or continue.
      if (err instanceof PartialSendError && err.sentIds.length) {
        this.store.setSplitMeta(err.sentIds[0], splitMetaFor(err.sentIds, 0, chunks));
        throw rpcError(
          'DISCORD_ERROR',
          `split send failed after ${err.sentIds.length}/${chunks.length} parts ` +
            `(${err.reason.message}); posted parts: ${refs.map((r) => r.relayId).join(', ')} ` +
            `— delete them before retrying, or send the remainder separately`,
        );
      }
      throw rpcError('DISCORD_ERROR', `split send failed: ${(err as Error).message}`);
    }
    // The full part list is only known now — stamp it on the first part.
    this.store.setSplitMeta(sent.messageIds[0], splitMetaFor(sent.messageIds, 0, chunks));
    return { messageId: refs[0].relayId, messageIds: refs.map((r) => r.relayId) };
  }

  /** The first part of a split send (edits/deletes operate on the whole set).
   *  For a standalone message this is the ref itself. */
  private primaryOf(ref: MessageRef): MessageRef {
    if (!ref.partOf) return ref;
    return this.store.getByDiscordId(ref.partOf) ?? ref;
  }

  /** Edit a (possibly split) persona message. The new content is re-split and
   *  written across the existing Discord messages; surplus parts are deleted.
   *  Growing beyond the original part count is refused — Discord offers no way
   *  to insert messages in place. */
  private async editMessage(primary: MessageRef, content: string): Promise<void> {
    const partIds = primary.parts ?? [primary.discordMsgId];
    const webhookId = primary.webhookId!;
    if (content.length <= DISCORD_MSG_LIMIT && partIds.length === 1) {
      await this.webhooks.edit(webhookId, primary.discordMsgId, content, primary.threadId);
      return;
    }
    const { chunks } = splitPreservingMarkdown(content, DISCORD_MSG_LIMIT);
    if (chunks.length > partIds.length) {
      throw rpcError(
        'INVALID_PARAMS',
        `edited content needs ${chunks.length} messages but the original send has ` +
          `${partIds.length} — shorten it, or delete and resend`,
      );
    }
    const keptIds = partIds.slice(0, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      await this.webhooks.edit(webhookId, partIds[i], chunks[i].text, primary.threadId);
      // Update this part's bridge metadata immediately — a concurrent
      // fetch_history between edits must not strip with stale markers.
      this.store.setSplitMeta(partIds[i], splitMetaFor(keptIds, i, chunks));
    }
    for (const id of partIds.slice(chunks.length)) {
      try {
        await this.webhooks.delete(webhookId, id, primary.threadId);
        // Store cleanup is left to the gateway's delete echo (onDiscordDelete),
        // exactly like delete_message — removing the ref here would strip that
        // echo of its relay id and channel attribution.
      } catch (err) {
        // Keep the ref — the message is still live in Discord; dropping the
        // store row would orphan it beyond any future edit/delete.
        console.error('[portal-relay] surplus part delete failed:', (err as Error).message);
      }
    }
  }

  private async react(
    personaId: string,
    relayMsgId: string,
    emoji: string,
    visible: boolean,
    native: boolean,
  ): Promise<Record<string, never>> {
    const ref = await this.resolveRef(relayMsgId);
    if (!ref) throw rpcError('NOT_FOUND', 'unknown message');
    this.requireCap(personaId, ref.channelId, 'ADD_REACTIONS');
    // Structured pseudo-reaction for agents / a real UI.
    this.gateway.dispatch(personaId, {
      type: 'reaction_add',
      channelId: ref.channelId,
      threadId: ref.threadId,
      messageId: ref.relayId,
      reaction: {
        emoji,
        count: 1,
        kind: 'pseudo',
        by: [{ kind: 'persona', id: personaId, name: this.displayName(personaId) }],
      },
    });
    // Optionally add a real Discord reaction (attributed to the shared bot).
    // Best-effort: the structured pseudo-reaction above is authoritative for
    // agents/UI, so a Discord failure here must not drop it.
    if (native) {
      try {
        await this.bot.addReaction(ref.threadId ?? ref.channelId, ref.discordMsgId, emoji);
      } catch (err) {
        console.error('[portal-relay] native react failed:', (err as Error).message);
      }
    }
    // Optionally make it visible to humans in Discord.
    if (visible) {
      const cfg = this.identity.get(personaId)!;
      const { messageId, webhookId } = await this.webhooks.send(ref.channelId, personaId, {
        threadId: ref.threadId,
        username: cfg.displayName,
        avatarURL: this.identity.avatarUrl(cfg),
        content: `↳ ${emoji}`,
      });
      this.store.record({
        channelId: ref.channelId,
        threadId: ref.threadId,
        guildId: ref.guildId,
        discordMsgId: messageId,
        personaId,
        webhookId,
      });
    }
    return {};
  }

  // ── Inbound Discord → PortalEvents ──

  private onDiscordMessage(inc: IncomingMessage): void {
    if (process.env.PORTAL_DEBUG) {
      console.error('[relay] inbound', JSON.stringify({
        channelId: inc.channelId, parent: inc.parentChannelId, guildId: inc.guildId,
        webhookId: inc.webhookId, own: inc.webhookId ? this.bot.ownsWebhook(inc.webhookId) : false,
        roles: inc.mentionRoleIds, content: inc.content.slice(0, 40),
        active: this.gateway.activePersonas(),
      }));
    }
    this.history.invalidate(inc.channelId); // new message changes the latest page
    // Our own webhook's create echo can beat the sending RPC's store.record
    // (gateway push vs REST response race — near-certain for split sends, where
    // part 1's echo lands while later parts are still posting). Dispatching now
    // would leak unstripped bridge markers and misattribute the author, so hold
    // the echo; the send path flushes it the moment attribution is recorded.
    // The timer is a safety net for webhook messages that never get recorded.
    if (inc.webhookId && this.bot.ownsWebhook(inc.webhookId) && !this.store.getByDiscordId(inc.id)) {
      const timer = setTimeout(() => {
        this.pendingEchoes.delete(inc.id);
        this.dispatchDiscordMessage(inc);
      }, ECHO_HOLD_MS);
      this.pendingEchoes.set(inc.id, { inc, timer });
      return;
    }
    this.dispatchDiscordMessage(inc);
  }

  private dispatchDiscordMessage(inc: IncomingMessage): void {
    this.history.invalidate(inc.channelId); // new message changes the latest page
    const { message, authorPersonaId } = this.buildPortalMessage(inc);
    this.deliverMessage('message_create', message, authorPersonaId);
  }

  /** Release a held own-send echo now that its attribution is recorded. */
  private flushEcho(discordMsgId: string): void {
    const held = this.pendingEchoes.get(discordMsgId);
    if (!held) return;
    clearTimeout(held.timer);
    this.pendingEchoes.delete(discordMsgId);
    this.dispatchDiscordMessage(held.inc);
  }

  /** Inbound (human/bot) edit → message_update to interested personas. */
  private onDiscordEdit(inc: IncomingMessage): void {
    this.history.invalidate(inc.channelId);
    const { message, authorPersonaId } = this.buildPortalMessage(inc);
    this.deliverMessage('message_update', message, authorPersonaId);
  }

  /** Shared per-persona delivery + addressing for create/update. */
  private deliverMessage(
    type: 'message_create' | 'message_update',
    message: PortalMessage,
    authorPersonaId?: string,
  ): void {
    // Durable, server-authoritative accumulation for EVERY persona (online or
    // not) — the substrate for offline catch-up. Only on create, so edits don't
    // double-count.
    if (type === 'message_create') this.accumulateReadState(message, authorPersonaId);

    // Live dispatch: connected sessions only, addressed OR live-subscribed.
    for (const personaId of this.gateway.activePersonas()) {
      if (authorPersonaId && personaId === authorPersonaId) continue; // not your own message
      const reasons = this.reasonsFor(message, personaId);
      const addressedToMe = reasons.length > 0;
      const subscribed = this.gateway.personaSubscribed(personaId, message.channelId);
      if (!addressedToMe && !subscribed) continue;
      // Defense-in-depth: a subscription can outlive the persona's access (e.g.
      // a role revoked after subscribe). Re-check VIEW_CHANNEL on the ambient
      // branch so live dispatch never leaks a channel the persona can no longer
      // view — mirroring the durable read-state gate in accumulateReadState.
      if (subscribed && !addressedToMe &&
          !this.personaCanViewChannel(personaId, message.channelId, message.guildId)) {
        continue;
      }
      if (subscribed && !addressedToMe) reasons.push('subscription');
      this.gateway.dispatch(personaId, { type, message, addressedToMe, reasons });
    }
  }

  /** Why a message is addressed to a persona: role mention and/or reply. */
  private reasonsFor(message: PortalMessage, personaId: string): AddressReason[] {
    const reasons: AddressReason[] = [];
    if (message.mentions.personas.includes(personaId)) reasons.push('role_mention');
    if (message.replyToId) {
      const ref = this.store.getByRelayId(message.replyToId);
      if (ref?.personaId === personaId) reasons.push('reply');
    }
    return reasons;
  }

  /**
   * Fold a new message into every persona's durable read-state. Addressed
   * messages are recorded for any persona regardless of subscription; ambient
   * messages only for personas that can actually view the channel (so an
   * offline persona's unread reflects all channels it can read — the "all
   * personas, all channels" policy — without leaking channels it can't see).
   */
  private accumulateReadState(message: PortalMessage, authorPersonaId?: string): void {
    for (const cfg of this.identity.all()) {
      const personaId = cfg.id;
      if (authorPersonaId && personaId === authorPersonaId) continue;
      const reasons = this.reasonsFor(message, personaId);
      const addressedToMe = reasons.length > 0;
      if (!addressedToMe && !this.personaCanViewChannel(personaId, message.channelId, message.guildId)) {
        continue;
      }
      this.readState.record(personaId, message, addressedToMe, reasons);
    }
  }

  /** Whether a persona can see a channel (gates ambient accumulation). Cheap
   *  guild pre-filter first, then the VIEW_CHANNEL capability. */
  private personaCanViewChannel(
    personaId: string,
    channelId: string,
    guildId: string | null,
  ): boolean {
    if (!guildId) return false;
    if (!this.personaCanAccessGuild(personaId, guildId)) return false;
    return this.capsFor(personaId, channelId, guildId).includes('VIEW_CHANNEL');
  }

  /** Same view-gate as personaCanViewChannel, but derives the guild from the
   *  channel (for subscription-driven dispatch paths that only hold a channelId,
   *  e.g. reactions/pins/deletes). Mirrors how requireCap resolves the guild. */
  private personaCanViewChannelId(personaId: string, channelId: string): boolean {
    const guildId = this.bot.channelForPerms(channelId)?.guildId ?? null;
    return this.personaCanViewChannel(personaId, channelId, guildId);
  }

  /** Native (human) reaction add/remove → dispatch to channel subscribers + the
   *  reacted message's author persona. */
  private onReactionEvent(kind: 'add' | 'remove', r: import('./discord-bot.js').IncomingReaction): void {
    const relayId = makeRelayId(r.threadId ?? r.channelId, r.messageId);
    const ownerRef = this.store.getByRelayId(relayId);
    const targets = new Set<string>();
    for (const p of this.gateway.activePersonas()) {
      // Subscription-driven reaction delivery must respect VIEW_CHANNEL; the
      // reacted message's author (ownerRef, added below) is notified regardless.
      if (this.gateway.personaSubscribed(p, r.channelId) &&
          this.personaCanViewChannelId(p, r.channelId)) targets.add(p);
    }
    if (ownerRef?.personaId) targets.add(ownerRef.personaId);
    const actor = { kind: 'user' as const, id: r.userId, name: r.userName };
    for (const personaId of targets) {
      if (kind === 'add') {
        this.gateway.dispatch(personaId, {
          type: 'reaction_add',
          channelId: r.channelId,
          threadId: r.threadId,
          messageId: relayId,
          reaction: { emoji: r.emoji, count: 1, kind: 'native', by: [actor] },
        });
      } else {
        this.gateway.dispatch(personaId, {
          type: 'reaction_remove',
          channelId: r.channelId,
          threadId: r.threadId,
          messageId: relayId,
          emoji: r.emoji,
          actor,
        });
      }
    }
  }

  private onPinsUpdate(channelId: string): void {
    for (const personaId of this.gateway.activePersonas()) {
      if (this.gateway.personaSubscribed(personaId, channelId) &&
          this.personaCanViewChannelId(personaId, channelId)) {
        this.gateway.dispatch(personaId, { type: 'pins_update', channelId });
      }
    }
  }

  private onDiscordDelete(channelId: string, messageId: string): void {
    this.history.invalidate(channelId);
    const ref = this.store.getByDiscordId(messageId);
    const relayId = ref?.relayId ?? messageId;
    const targetChannel = ref?.channelId ?? channelId;
    this.store.remove(messageId);
    // Gate like message/reaction delivery: only notify personas subscribed to the
    // channel (or whose own message was deleted). Without this, every persona
    // received delete events for every channel — context-eroding noise for
    // channels they don't even follow.
    for (const personaId of this.gateway.activePersonas()) {
      const subscribed = this.gateway.personaSubscribed(personaId, targetChannel);
      const owner = ref?.personaId === personaId;
      if (!subscribed && !owner) continue;
      // Owner is always told their own message was deleted; subscription-driven
      // delete notices respect VIEW_CHANNEL like every other ambient signal.
      if (subscribed && !owner &&
          !this.personaCanViewChannelId(personaId, targetChannel)) continue;
      this.gateway.dispatch(personaId, {
        type: 'message_delete',
        channelId: targetChannel,
        threadId: ref?.threadId,
        messageId: relayId,
      });
    }
  }

  // ── Builders / helpers ──

  private buildPortalMessage(inc: IncomingMessage): {
    message: PortalMessage;
    authorPersonaId?: string;
  } {
    const ref = this.store.ensureForDiscord(inc.id, () => ({
      channelId: inc.parentChannelId,
      threadId: inc.threadId,
      guildId: inc.guildId,
      discordMsgId: inc.id,
    }));

    // Resolve author. Our own webhook posts map back to a persona via the store.
    let authorPersonaId: string | undefined;
    let author: PortalMessage['author'];
    if (inc.webhookId && this.bot.ownsWebhook(inc.webhookId) && ref.personaId) {
      authorPersonaId = ref.personaId;
      const cfg = this.identity.get(ref.personaId);
      author = {
        kind: 'persona',
        personaId: ref.personaId,
        displayName: cfg?.displayName ?? inc.authorName,
        avatarUrl: cfg ? this.identity.avatarUrl(cfg) : '',
      };
    } else {
      author = {
        kind: 'user',
        userId: inc.webhookId ?? inc.authorId,
        username: inc.authorName,
        displayName: inc.authorDisplayName,
        bot: inc.isBot || !!inc.webhookId,
      };
    }

    const personas: string[] = [];
    if (inc.guildId) {
      for (const roleId of inc.mentionRoleIds) {
        const pid = this.roles.resolveRole(inc.guildId, roleId);
        if (pid) personas.push(pid);
      }
    }

    // Reply target lives in the same container; its id is deterministic, so we
    // can derive it without a store lookup (works across restarts).
    const replyToId = inc.replyToId
      ? makeRelayId(inc.threadId ?? inc.parentChannelId, inc.replyToId)
      : undefined;

    const message: PortalMessage = {
      id: ref.relayId,
      nativeId: inc.id,
      channelId: inc.parentChannelId,
      threadId: inc.threadId,
      guildId: inc.guildId,
      author,
      // Strip the synthetic bridge markers a split send injected, so agents
      // (history, live events, pins) see their original unbroken markdown.
      content: stripBridges(inc.content, ref),
      // Render custom-emoji tokens (<:name:id> / <a:name:id>) down to :name: in
      // the human-readable field so message text reads legibly for the model.
      // The raw `content` keeps the full tokens for correlation/round-tripping.
      cleanContent: renderCustomEmojis(stripBridges(inc.cleanContent, ref)),
      attachments: inc.attachments,
      mentions: {
        personas,
        roles: inc.mentionRoleIds,
        users: inc.mentionUserIds,
        everyone: inc.mentionsEveryone,
      },
      replyToId,
      reactions: inc.reactions.map((r) => ({
        emoji: r.emoji,
        count: r.count,
        kind: 'native' as const,
        by: [],
      })),
      createdAt: inc.timestamp.toISOString(),
      partOf: ref.partOf ? makeRelayId(ref.threadId ?? ref.channelId, ref.partOf) : undefined,
    };
    return { message, authorPersonaId };
  }

  /** Decode a fetch_history cursor: relay id (live or post-restart) or raw
   *  Discord snowflake. */
  private cursorToSnowflake(c?: string): string | undefined {
    if (!c) return undefined;
    const ref = this.store.getByRelayId(c);
    if (ref) return ref.discordMsgId;
    const parsed = parseRelayId(c);
    if (parsed) return parsed.discordMsgId;
    return /^\d+$/.test(c) ? c : undefined;
  }

  private toPortalChannel(meta: ChannelMeta, personaId: string): PortalChannel {
    return {
      id: meta.id,
      native: meta.id,
      guildId: meta.guildId,
      name: meta.name,
      type: meta.type,
      parentId: meta.parentId,
      archived: meta.archived,
      capabilities: this.capsFor(personaId, meta.id, meta.guildId),
    };
  }

  /** Whether a persona has any rights in a guild — gates addressing-role minting
   *  so we don't create Discord roles in guilds the persona can't touch. */
  private personaCanAccessGuild(personaId: string, guildId: string): boolean {
    return this.permissions.couldAccessGuild(
      personaId,
      guildId,
      (channelId) => this.bot.channelForPerms(channelId)?.guildId === guildId,
    );
  }

  private capsFor(personaId: string, channelId: string, guildId: string | null): Capability[] {
    if (!this.identity.get(personaId)) return [];
    // Allow-list gate: no capabilities in guilds the relay doesn't serve, even
    // for scope:{all} personas addressing raw channel ids (fail closed).
    if (guildId && !this.bot.isGuildAllowed(guildId)) return [];
    const allowed = this.permissions.resolve(personaId, guildId, channelId);
    const channel = this.bot.channelForPerms(channelId);
    const me = guildId ? this.bot.meIn(guildId) : null;
    return computeCapabilities(allowed, channel, me);
  }

  private requireCap(personaId: string, channelId: string, cap: Capability): void {
    const guildId = this.bot.channelForPerms(channelId)?.guildId ?? null;
    if (!this.capsFor(personaId, channelId, guildId).includes(cap)) {
      throw rpcError('FORBIDDEN', `missing capability ${cap}`);
    }
  }

  private displayName(personaId: string): string {
    return this.identity.get(personaId)?.displayName ?? personaId;
  }
}

function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Split-send metadata for part `i` of a part-id set: bridge strings for later
 *  stripping, `parts` on the first part, `partOf` back-links on continuations.
 *  Shared by initial sends (recordParts) and re-split edits (setSplitMeta). */
function splitMetaFor(
  ids: string[],
  i: number,
  chunks: ChunkPiece[],
): Pick<MessageRef, 'bridgeOpen' | 'bridgeClose' | 'parts' | 'partOf'> {
  return {
    bridgeOpen: chunks[i]?.bridgeOpen,
    bridgeClose: chunks[i]?.bridgeClose,
    parts: i === 0 && ids.length > 1 ? [...ids] : undefined,
    partOf: i > 0 ? ids[0] : undefined,
  };
}

/** Render custom-emoji tokens ('<:name:id>' / '<a:name:id>') down to ':name:'
 *  so message text reads legibly for the model. Unicode emoji are untouched. */
function renderCustomEmojis(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`);
}

/** Remove the synthetic reopener/closer a split send injected into this part.
 *  Exact match first; a fence reopener also tolerates a rewritten info string
 *  (Discord normalizes mentions/emojis in `cleanContent`) by matching on the
 *  fence marker run alone and dropping that first line. */
export function stripBridges(text: string, ref: { bridgeOpen?: string; bridgeClose?: string }): string {
  let out = text;
  if (ref.bridgeOpen) {
    if (out.startsWith(ref.bridgeOpen)) {
      out = out.slice(ref.bridgeOpen.length);
    } else {
      const fence = /^(`{3,}|~{3,})/.exec(ref.bridgeOpen)?.[1];
      if (fence && out.startsWith(fence)) {
        const nl = out.indexOf('\n');
        out = nl === -1 ? '' : out.slice(nl + 1);
      }
    }
  }
  if (ref.bridgeClose && out.endsWith(ref.bridgeClose)) {
    out = out.slice(0, out.length - ref.bridgeClose.length);
  }
  return out;
}
