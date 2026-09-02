/**
 * Orchestrator. Ties the Discord connection, identity, role/webhook pools, the
 * message store, and the WS gateway together:
 *   - inbound Discord events → addressed PortalEvents fanned out per persona
 *   - client RPC → capability-checked Discord actions via the pools
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  AddressReason,
  Capability,
  MintInviteParams,
  MintInviteResult,
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
import { Gateway, type GatewayHooks, Session } from './gateway.js';
import { GuildAllowStore, type GuildAllowChange } from './guild-allowlist.js';
import { HistoryCache } from './history-cache.js';
import { IdentityStore, type IdentityChange, generateToken, hashToken } from './identity.js';
import { InviteStore } from './invites.js';
import { MessageStore, makeRelayId, parseRelayId, type MessageRef } from './message-store.js';
import { MirrorCache } from './mirror-cache.js';
import { ALL_CAPS, PermissionsStore, type PermissionChange, computeCapabilities } from './permissions.js';
import { ReadStateStore } from './read-state.js';
import { RolePool } from './role-pool.js';
import { WebhookPool } from './webhook-pool.js';
import { AdminServer, type AdminDeps } from './admin/server.js';
import { AuditLog } from './admin/audit.js';
import { SlashHandler } from './slash.js';
import { VoiceBot, VoiceJoinError, type VoiceTranscript } from './voice-bot.js';

/** How young an unattributed owned-webhook post must be for displayName echo
 *  recovery to apply. The gateway-beats-REST race it repairs is seconds-wide;
 *  anything older is history, where the current roster is not evidence about
 *  who wrote it. Generous multiple of observed race width. */
const ECHO_RECOVERY_MAX_AGE_MS = 5 * 60_000;

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
  /**
   * Last capabilities delivered to each persona, keyed persona → channel →
   * caps-key (issue #5). Pure dedup for live rights propagation: rights-change
   * repushes walk whole guilds, and without this every walk would spam
   * no-op `capabilities_update` events into persona streams (churning the
   * bounded resume buffer). Seeded at ready; updated by every channel-bearing
   * dispatch. Not authoritative — capsFor() remains the source of truth.
   */
  private deliveredCaps = new Map<string, Map<string, string>>();
  private admin?: AdminServer;
  private slash: SlashHandler;
  /** Voice listener (Scribe transcription). Null when ELEVENLABS_KEY is unset —
   *  voice RPCs then fail with UNAVAILABLE and everything else is unaffected. */
  private voice: VoiceBot | null = null;
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
    this.permissions.setMirrorLookup((g, r) => this.mirror.lookup(g, r));
    if (config.invitesPath) this.invites = new InviteStore(config.invitesPath);
    this.roles = new RolePool(this.bot, config.rolePool.size, config.rolePool.prefix, config.rolePool.persistPath);
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
    // In-Discord admin: slash commands over the same stores the panel uses.
    // Gate = Manage-Server in the guild OR a configured superadmin; every
    // invocation audits alongside panel actions.
    this.slash = new SlashHandler({
      identity: this.identity,
      permissions: this.permissions,
      invites: this.invites,
      audit: this.audit,
      superadmins: config.admin?.superadmins ?? [],
      guildAdmins: config.admin?.guildAdmins ?? {},
      capsFor: (personaId, channelId, guildId) => this.capsFor(personaId, channelId, guildId),
      canAccessGuild: (personaId, guildId) => this.personaCanAccessGuild(personaId, guildId),
      resync: (personaId) => this.resyncPersona(personaId),
      newInviteCode: () => `inv_${randomBytes(18).toString('base64url')}`,
    });
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
    this.bot.on('channelChange', (meta, kind) => this.onBotChannelChange(meta, kind));
    this.bot.on('channelDelete', (channelId, guildId) => this.onBotChannelDelete(channelId, guildId));
    this.bot.on('slashCommand', (inv) => this.slash.handle(inv));
    this.bot.on('slashAutocomplete', (req) => this.slash.autocomplete(req));
    this.bot.on('ready', () => this.mirror.clear());
    if (this.config.elevenLabsKey) {
      this.attachVoice(new VoiceBot(this.bot.rawClient, this.config.elevenLabsKey,
        (m) => console.error(`[portal-relay] ${m}`)));
      console.error('[portal-relay] voice transcription enabled (Scribe v2 realtime)');
    }
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

  /** Wire the voice listener's events into delivery. Separate from the
   *  constructor so tests can attach a fake listener. */
  attachVoice(voice: VoiceBot): void {
    this.voice = voice;
    voice.on('transcript', (t) => this.deliverTranscript(t));
    voice.on('status', (channelId, guildId, joined) => {
      // Sequenced like any durable event: a resuming session should learn the
      // listener came or went even if it was offline at the time. Same
      // subscription + VIEW_CHANNEL gate as transcripts — the fact that a
      // channel is being listened to is channel information too.
      for (const personaId of this.gateway.activePersonas()) {
        if (!this.gateway.personaSubscribed(personaId, channelId)) continue;
        if (!this.personaCanViewChannel(personaId, channelId, guildId)) continue;
        this.gateway.dispatch(personaId, { type: 'voice_status', channelId, guildId, joined });
      }
    });
  }

  async stop(): Promise<void> {
    // Leave voice channels first: a relay that exits while connected leaves
    // the bot visibly "listening" in Discord until the gateway session lapses.
    this.voice?.destroy();
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
      this.gateway.dropStream(c.id);
      this.readState.forget(c.id);
      this.deliveredCaps.delete(c.id);
      void this.roles.unbindAll(c.id).catch((e) => console.error('[portal-relay] unbind on remove:', (e as Error).message));
      return;
    }
    const renamed = c.prev && c.prev.displayName !== c.next.displayName;
    if (renamed) await this.roles.rename(c.id, c.next.displayName);
    // Push the updated identity to the persona's live sessions.
    const persona = this.identity.toPersona(c.next, this.roles.roleByGuildFor(c.id));
    this.gateway.dispatch(c.id, { type: 'persona_update', persona });
  }

  private onPermissionChange(c: PermissionChange): void {
    // Stream-retained, not live-session — a change during a brief drop must
    // land in the resume buffer (see streamPersonas). No stream ⇒ the persona
    // never identified since boot; its next identify rehydrates everything.
    if (!this.gateway.hasStream(c.personaId)) return;
    let channels: ChannelMeta[];
    if (c.scope === 'channel' && c.channelId) {
      const meta = this.bot.channelMetaFromCache(c.channelId);
      channels = meta ? [meta] : [];
    } else if (c.scope === 'guild' && c.guildId) {
      channels = this.bot.listChannelMetas(c.guildId);
    } else {
      channels = this.bot.listGuilds().flatMap((g) => this.bot.listChannelMetas(g.id));
    }
    for (const meta of channels) this.pushCaps(c.personaId, meta.id, meta.guildId);

    for (const g of this.bot.listGuilds())
      void this.reconcilePersonaGuild(c.personaId, g.id).catch((e) => console.error('[portal-relay] reconcile:', (e as Error).message));
  }

  /** Guild allow-list changed at runtime (admin edit, hot-reload, or the bot
   *  joining a pre-authorized guild). The bot's cache already holds every
   *  joined guild, so no Discord reconnect is involved — just tell sessions. */
  private onGuildAllowChange(c: GuildAllowChange): void {
    for (const gid of c.added) {
      this.mirror.invalidateGuild(gid);
      void this.bot.syncSlashCommands(gid).catch((e) => console.error('[portal-relay] slash sync:', (e as Error).message));
      // Accessor is live: an allowed+joined guild shows up here. Not found ⇒
      // pre-authorized but not joined yet — dormant until guildCreate fires.
      const g = this.bot.listGuilds().find((x) => x.id === gid);
      if (!g) continue;
      void this.reconcileGuild(gid).catch((e) => console.error('[portal-relay] reconcile:', (e as Error).message));
      const metas = this.bot.listChannelMetas(gid);
      for (const personaId of this.gateway.streamPersonas()) {
        const channels = metas.map((m) => this.toPortalChannel(m, personaId));
        for (const c of channels) this.rememberCaps(personaId, c.id, c.capabilities);
        this.gateway.dispatch(personaId, {
          type: 'guild_create',
          guild: { id: g.id, native: g.id, name: g.name, memberCount: g.memberCount },
          channels,
        });
      }
    }
    for (const gid of c.removed) {
      this.mirror.invalidateGuild(gid);
      this.repushGuildCaps(gid); // capsFor's allow-gate zeroes them out
      // Explicit (not only via repushGuildCaps): still runs when the bot was
      // kicked and the channel cache is empty, so bindings/persisted state die.
      void this.reconcileGuild(gid).catch((e) => console.error('[portal-relay] reconcile:', (e as Error).message));
      for (const personaId of this.gateway.streamPersonas()) {
        this.gateway.dispatch(personaId, { type: 'guild_delete', guildId: gid });
      }
      // Hygiene: drop the guild's channels from the dedup baseline so a future
      // re-allow reseeds instead of matching stale keys. (If the bot was kicked
      // the cache is empty and this is a no-op — rememberCaps overwrites on
      // reseed anyway, so staleness is harmless, just untidy.)
      for (const meta of this.bot.listChannelMetas(gid)) this.forgetChannelCaps(meta.id);
    }
  }

  /** A guild channel/thread appeared or changed on Discord's side. */
  private onBotChannelChange(meta: ChannelMeta, kind: 'create' | 'update'): void {
    if (!meta.guildId) return;
    this.mirror.invalidateGuild(meta.guildId);
    // Materialize the changed channel for every connected persona (issue #5).
    // A bare capabilities_update can't do this — clients can't invent a
    // channel from a caps array — so new channels were invisible until the
    // next full identify (i.e. an agent restart).
    // Stream-retained personas, not just live ones: a briefly-dropped agent
    // must find this event in its resume replay, or the channel stays
    // invisible until a full re-identify (and the dedup baseline would
    // suppress the correcting caps push forever).
    const create = kind === 'create';
    for (const personaId of this.gateway.streamPersonas()) {
      const channel = this.toPortalChannel(meta, personaId);
      this.rememberCaps(personaId, meta.id, channel.capabilities);
      this.gateway.dispatch(personaId, meta.isThread
        ? { type: create ? 'thread_create' : 'thread_update', channel }
        : { type: create ? 'channel_create' : 'channel_update', channel });
    }
    // A permission-overwrite change on one channel can shift mirror-derived
    // caps on siblings; re-derive the rest of the guild (dedup'd, so
    // untouched channels cost nothing on the wire).
    this.repushGuildCaps(meta.guildId);
  }

  /** A guild channel/thread was deleted on Discord's side. */
  private onBotChannelDelete(channelId: string, guildId: string | null): void {
    if (!guildId) return;
    this.mirror.invalidateGuild(guildId);
    this.forgetChannelCaps(channelId);
    for (const personaId of this.gateway.streamPersonas()) {
      this.gateway.dispatch(personaId, { type: 'channel_delete', channelId, guildId });
    }
    this.repushGuildCaps(guildId);
  }

  /** Re-push capabilities for every connected persona across a guild's channels.
   *  Used when a role/channel change may have shifted mirrorRole visibility.
   *  Dedup'd against deliveredCaps — only actual changes hit the wire. */
  private repushGuildCaps(guildId: string): void {
    const metas = this.bot.listChannelMetas(guildId);
    if (!metas.length) return;
    for (const personaId of this.gateway.streamPersonas()) {
      for (const meta of metas) this.pushCaps(personaId, meta.id, guildId);
    }

    void this.reconcileGuild(guildId).catch((e) => console.error('[portal-relay] reconcile:', (e as Error).message));
  }

  /** Dispatch a capabilities_update iff the caps differ from what this persona
   *  last received for the channel (any channel-bearing dispatch counts). */
  private pushCaps(personaId: string, channelId: string, guildId: string | null): void {
    const caps = this.capsFor(personaId, channelId, guildId);
    if (!this.rememberCaps(personaId, channelId, caps)) return;
    this.gateway.dispatch(personaId, { type: 'capabilities_update', channelId, capabilities: caps });
  }

  /** Record caps as delivered; returns true when they changed since last delivery. */
  private rememberCaps(personaId: string, channelId: string, caps: readonly string[]): boolean {
    let byChannel = this.deliveredCaps.get(personaId);
    if (!byChannel) this.deliveredCaps.set(personaId, (byChannel = new Map()));
    const key = caps.join(',');
    if (byChannel.get(channelId) === key) return false;
    byChannel.set(channelId, key);
    return true;
  }

  private forgetChannelCaps(channelId: string): void {
    for (const byChannel of this.deliveredCaps.values()) byChannel.delete(channelId);
  }

  /**
   * Force-push the full channel set (with current caps) to one persona's
   * stream (/resync). Upserts fix missing channels and stale caps; it cannot
   * remove stale extras the client invented — a fresh identify does that.
   * No-op for personas with no retained stream (never identified since boot):
   * dispatch() would CREATE a stream, silently flipping them into the
   * stream-retained fan-out set.
   */
  resyncPersona(personaId: string): number {
    if (!this.gateway.hasStream(personaId)) return 0;
    let pushed = 0;
    for (const g of this.bot.listGuilds()) {
      for (const meta of this.bot.listChannelMetas(g.id)) {
        const channel = this.toPortalChannel(meta, personaId);
        this.rememberCaps(personaId, channel.id, channel.capabilities);
        this.gateway.dispatch(
          personaId,
          meta.isThread ? { type: 'thread_update', channel } : { type: 'channel_update', channel },
        );
        pushed++;
      }
    }
    return pushed;
  }

  /** Ensure every connected persona has an addressing role wherever it can act,
   *  and none where it cannot. Called on any role/channel/permission/allow-list
   *  change so the pool tracks live access instead of only binding at connect. */
  private async reconcileGuild(guildId: string): Promise<void> {
    for (const personaId of this.gateway.activePersonas()) {
      await this.reconcilePersonaGuild(personaId, guildId);
    }
  }

  /** Bind (or delete) one persona's addressing role in a guild to match whether
   *  it currently has any capability there. Idempotent; only calls Discord when
   *  the bound state actually differs from access. */
  private async reconcilePersonaGuild(personaId: string, guildId: string): Promise<void> {
    const cfg = this.identity.get(personaId);
    if (!cfg) return;
    const canAccess = this.bot.isGuildAllowed(guildId) && this.personaCanAccessGuild(personaId, guildId);
    const bound = !!this.roles.getRoleFor(guildId, personaId);
    if (canAccess === bound) return;
    try {
      if (canAccess) await this.roles.bind(guildId, personaId, cfg.displayName);
      else await this.roles.unbind(guildId, personaId);
    } catch (e) {
      console.error(`[portal-relay] addressing-role reconcile (${personaId}/${guildId}):`, (e as Error).message);
      return;
    }
    this.gateway.dispatch(personaId, {
      type: 'persona_update',
      persona: this.identity.toPersona(cfg, this.roles.roleByGuildFor(personaId)),
    });
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
    // Machine mints re-verify the subset rule against the minter's CURRENT
    // rights — a revoked/demoted spawner's outstanding codes die here.
    const staleMint = this.recheckMachineMint(checked);
    if (staleMint) return { error: staleMint };

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
    if (isMirrorScope(grant.scope)) {
      const role = this.materializeMirrorGrant(inv.guildId, grant.scope, grant.caps);
      if (!role) {
        this.permissions.setPersonaPolicy(personaId, { default: [] }); // malformed mirror grant → deny
        return;
      }
      this.permissions.addPersonaRoles(personaId, [role]);
      return;
    }
    this.permissions.setPersonaPolicy(personaId, this.scopeToPolicy(inv.guildId, grant.scope, grant.caps));
  }

  /**
   * An inline mirror grant becomes a shared access role so it resolves LIVE —
   * the point of a mirror is tracking Discord visibility over time, and the
   * old enroll-time snapshot quietly broke that: channels created after
   * enrollment stayed invisible to the persona until someone hand-edited its
   * policy. The role name is derived from the grant's content, so identical
   * grants (every use of one invite, or two invites minted alike) share one
   * catalog entry instead of accreting duplicates. Returns the role name, or
   * null for a malformed grant (no guild — mirrors are guild-scoped).
   */
  private materializeMirrorGrant(
    guildId: string | undefined,
    scope: { mirrorRole: string } | { mirrorRoles: string[] },
    caps: Capability[],
  ): string | null {
    if (!guildId) {
      console.error('[portal-relay] mirror grant without guildId — denying (no channels in scope)');
      return null;
    }
    const roleIds = [...new Set('mirrorRoles' in scope ? scope.mirrorRoles : [scope.mirrorRole])].sort();
    const sortedCaps = [...new Set(caps)].sort();
    const hash = createHash('sha256')
      .update(JSON.stringify({ guildId, roleIds, caps: sortedCaps }))
      .digest('hex')
      .slice(0, 8);
    const name = `mirror-${hash}`;
    if (!this.permissions.getRole(name)) {
      this.permissions.setRole(name, {
        caps: sortedCaps,
        scope: roleIds.length === 1 ? { mirrorRole: roleIds[0] } : { mirrorRoles: roleIds },
        guildId,
      });
    }
    return name;
  }

  /** Turn a (guild, scope, caps) grant into a default-deny PersonaPolicy.
   *  Static scopes only — mirror shapes go through materializeMirrorGrant so
   *  they resolve live; reaching here with one is a caller bug (deny). */
  private scopeToPolicy(guildId: string | undefined, scope: Scope, caps: Capability[]): PersonaPolicy {
    if ('all' in scope) return { default: caps };
    if (!guildId || !('channels' in scope)) {
      console.error('[portal-relay] scoped grant without guildId or with a mirror shape — denying');
      return { default: [] };
    }
    const channels: Record<string, Capability[]> = {};
    for (const id of scope.channels) channels[id] = caps;
    return { default: [], guilds: { [guildId]: { default: [], channels } } };
  }

  /**
   * Machine-mint a single-use, short-lived, channel-scoped invite (the
   * daemon/spawner door — the admin API is OAuth-session-only). Authorization:
   *   1. PORTAL_INVITE_MINTERS allowlist (empty ⇒ RPC disabled, fail closed).
   *   2. Subset-of-own-rights: every delegated cap must be one the minter
   *      EFFECTIVELY holds (capsFor — policy ∩ Discord) on that exact channel.
   *      You cannot delegate what you don't have; the minter's reach is the
   *      ceiling of its hands' reach. Re-verified at claim (recheckMachineMint)
   *      so revoking the minter revokes its outstanding codes.
   *   3. Channels-only scope — no `all`, no mirror shapes in machine grants.
   *   4. Forced maxUses:1 (explicit ≠1 is REJECTED, not coerced) + expiry
   *      clamped to [1, 60] minutes (default 15).
   *   5. Guild allow-list gate; every channel must belong to the named guild.
   * Every attempt — including rejections — audits with actor.kind 'persona'.
   */
  private mintInviteRpc(personaId: string, p: MintInviteParams): MintInviteResult {
    const reject: (code: 'FORBIDDEN' | 'INVALID_PARAMS', message: string) => never = (code, message) => {
      this.audit?.append({
        actor: { id: personaId, name: this.displayName(personaId), kind: 'persona' },
        action: 'invite.mint',
        guildId: typeof p?.guildId === 'string' ? p.guildId : undefined,
        ok: false,
        detail: { via: 'rpc', reason: message },
      });
      throw rpcError(code, message);
    };
    if (!this.invites) reject('FORBIDDEN', 'invites not enabled on this relay');
    if (!(this.config.inviteMinters ?? []).includes(personaId)) {
      reject('FORBIDDEN', 'persona is not an authorized invite minter (PORTAL_INVITE_MINTERS)');
    }
    // Rate limit (token bucket, per minter): a compromised or looping spawner
    // must not drive unbounded store rewrites / persona floods. Consumed per
    // authorized ATTEMPT so validation-storms are throttled too.
    if (!this.takeMintToken(personaId)) {
      reject('FORBIDDEN', 'mint rate limit exceeded — retry shortly');
    }
    // Every param pathology routes through reject() so the audited-attempt
    // guarantee is real (raw throws would escape unaudited as INTERNAL).
    if (!p || typeof p !== 'object') reject('INVALID_PARAMS', 'params object required');
    const scope = p.grant?.scope as Record<string, unknown> | undefined;
    if (!scope || !Array.isArray(scope.channels) || Object.keys(scope).length !== 1) {
      reject('INVALID_PARAMS', 'machine-minted grants are channels-scoped only (scope: {channels})');
    }
    if (!(p.grant.scope.channels as unknown[]).every((c) => typeof c === 'string')) {
      reject('INVALID_PARAMS', 'scope.channels must be channel-id strings');
    }
    const channels = [...new Set(p.grant.scope.channels)];
    if (channels.length === 0 || channels.length > 32) {
      reject('INVALID_PARAMS', 'scope.channels must name 1–32 channels');
    }
    if (!Array.isArray(p.grant?.caps)) reject('INVALID_PARAMS', 'grant.caps must be an array');
    const caps = [...new Set(p.grant.caps)];
    if (caps.length === 0) reject('INVALID_PARAMS', 'grant.caps must be non-empty');
    const unknown = caps.filter((c) => !ALL_CAPS.includes(c));
    if (unknown.length) reject('INVALID_PARAMS', `unknown caps: ${unknown.join(', ')}`);
    if (p.maxUses !== undefined && p.maxUses !== 1) {
      reject('INVALID_PARAMS', 'machine-minted invites are single-use (maxUses must be 1 or omitted)');
    }
    if (p.expiresInMinutes !== undefined && !Number.isFinite(p.expiresInMinutes)) {
      reject('INVALID_PARAMS', 'expiresInMinutes must be a finite number');
    }
    const minutes = Math.min(60, Math.max(1, Math.round(p.expiresInMinutes ?? 15)));
    if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > 120)) {
      reject('INVALID_PARAMS', 'label must be a string of at most 120 characters');
    }
    // Guild containment.
    if (typeof p.guildId !== 'string' || !p.guildId || !this.bot.isGuildAllowed(p.guildId)) {
      reject('FORBIDDEN', 'guild is not on the relay allow-list');
    }
    for (const cid of channels) {
      if (this.bot.channelForPerms(cid)?.guildId !== p.guildId) {
        reject('INVALID_PARAMS', `channel ${cid} is not in guild ${p.guildId}`);
      }
    }
    // Subset-of-own-effective-rights, per channel.
    for (const cid of channels) {
      const own = new Set(this.capsFor(personaId, cid, p.guildId));
      const excess = caps.filter((c) => !own.has(c));
      if (excess.length) {
        reject('FORBIDDEN', `cannot delegate ${excess.join(', ')} on channel ${cid} — minter does not hold them`);
      }
    }
    // Outstanding-mint cap: a minter may hold at most 20 live unclaimed codes.
    const now = Date.now();
    const outstanding = this.invites.all().filter((inv) => {
      if (inv.mintedBy !== personaId) return false;
      if (inv.maxUses !== undefined && (inv.uses ?? 0) >= inv.maxUses) return false;
      if (inv.expiresAt) {
        const at = Date.parse(inv.expiresAt);
        if (!Number.isFinite(at) || at <= now) return false;
      }
      return true;
    }).length;
    if (outstanding >= 20) {
      reject('FORBIDDEN', 'too many outstanding unclaimed invites for this minter (max 20)');
    }

    const code = `inv_${randomBytes(18).toString('base64url')}`;
    const expiresAt = new Date(now + minutes * 60_000).toISOString();
    this.invites.mint({
      code,
      label: p.label ?? `machine-minted by ${personaId}`,
      grant: { caps, scope: { channels } },
      guildId: p.guildId,
      maxUses: 1,
      expiresAt,
      mode: 'mint',
      mintedBy: personaId,
    });
    this.audit?.append({
      actor: { id: personaId, name: this.displayName(personaId), kind: 'persona' },
      action: 'invite.mint',
      // Redacted: the code is a live bearer credential claimable by an
      // UNAUTHENTICATED register — the audit stream (panel, shippers,
      // backups) must not enable front-running the claim. A 12-char prefix
      // correlates with invites.json for forensics.
      target: `${code.slice(0, 12)}…`,
      guildId: p.guildId,
      ok: true,
      detail: { via: 'rpc', channels, caps, expiresAt, label: p.label },
    });
    return { code, expiresAt };
  }

  /** Token bucket per minter: burst 5, refill 10/min. In-memory (resets on
   *  restart) — this throttles machine loops, it is not billing-grade. */
  private mintBuckets = new Map<string, { tokens: number; last: number }>();
  private takeMintToken(personaId: string): boolean {
    const now = Date.now();
    const bucket = this.mintBuckets.get(personaId) ?? { tokens: 5, last: now };
    bucket.tokens = Math.min(5, bucket.tokens + ((now - bucket.last) / 60_000) * 10);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.mintBuckets.set(personaId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.mintBuckets.set(personaId, bucket);
    return true;
  }

  /**
   * Machine-minted invites (mintedBy) re-verify the subset rule at CLAIM time:
   * the minter must still exist, still be an authorized minter, and still hold
   * every delegated cap on every scoped channel. This is what makes revoking a
   * spawner revoke its outstanding unclaimed codes — the expiry alone would
   * leave a minutes-wide orphaned-delegation window. Returns a rejection
   * reason, or null to proceed.
   */
  private recheckMachineMint(inv: InviteTemplate): string | null {
    if (!inv.mintedBy) return null;
    // Re-validate what will actually be APPLIED, not what we expect to be
    // there: applyInviteGrant short-circuits on roles (and legacy caps) BEFORE
    // it looks at grant, so a hand-edited invite carrying mintedBy + roles
    // would pass a grant-only recheck and then receive roles the subset rule
    // never examined (roles can carry scope:{all}/mirror shapes — exactly
    // what machine mints forbid).
    if (inv.roles?.length || inv.caps?.length) {
      return 'malformed machine mint (roles/blanket caps are not permitted in machine-minted invites)';
    }
    if (!inv.grant || !('channels' in inv.grant.scope)) return 'malformed machine mint';
    if (!this.identity.get(inv.mintedBy)) return 'invite minter no longer exists';
    if (!(this.config.inviteMinters ?? []).includes(inv.mintedBy)) return 'invite minter no longer authorized';
    for (const cid of inv.grant.scope.channels) {
      const own = new Set(this.capsFor(inv.mintedBy, cid, inv.guildId ?? null));
      if (inv.grant.caps.some((c) => !own.has(c))) {
        // Fail-closed covers both real demotion AND an unresolvable channel
        // (evicted cache / archived thread zeroes Discord-gated caps) — name
        // both so the operator checks the right thing.
        return `invite minter's delegated rights could not be re-verified on channel ${cid} (rights changed, or channel not currently resolvable)`;
      }
    }
    return null;
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
    // Mode gate FIRST: machine mints are mode:'mint', so a holder of someone
    // else's code gets a flat "not claimable" here instead of learning (via
    // the recheck's distinct messages) whether the minter still exists / is
    // still allowlisted / still holds rights. The recheck below is NOT dead
    // code — it is load-bearing for hand-edited mintedBy + mode:'both' invites.
    if (checked.mode !== 'augment' && checked.mode !== 'both') {
      throw rpcError('FORBIDDEN', 'invite is not claimable (mint-only)');
    }
    const staleMint = this.recheckMachineMint(checked);
    if (staleMint) throw rpcError('FORBIDDEN', staleMint);
    if (checked.roles?.length) {
      this.permissions.addPersonaRoles(personaId, checked.roles);
    } else {
      const grant = checked.grant ?? (checked.caps?.length ? { caps: checked.caps, scope: { all: true } as Scope } : undefined);
      if (grant && isMirrorScope(grant.scope)) {
        // Same live-role materialization as enroll; a silent snapshot here is
        // strictly worse because an augmented persona has no reason to suspect
        // its shiny new scope is already fossilizing. Missing guildId is a
        // hard reject (augment already throws on malformed invites).
        const role = this.materializeMirrorGrant(checked.guildId, grant.scope, grant.caps);
        if (!role) throw rpcError('INVALID_PARAMS', 'invite mirror grant is missing guildId');
        this.permissions.addPersonaRoles(personaId, [role]);
      } else if (grant) {
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
    // Pre-bind a role in each guild the persona can actually act in, so it's
    // addressable immediately. Skip guilds where it has no rights — no point
    // minting (and leaking) a Discord addressing role there.
    //
    // ORDER MATTERS: these binds await real Discord calls, and the session is
    // already registered — a rights change landing mid-await dispatches into
    // this session/stream AND updates the deliveredCaps baseline. The
    // channel/caps snapshot below is therefore taken AFTER all awaits, in one
    // synchronous block with seqOf, so ready can never carry state older than
    // an already-dispatched event (which hydrate would clobber back in while
    // the baseline suppresses every future repush of the true value).
    const roleByGuild: Record<string, string> = {};
    for (const g of this.bot.listGuilds()) {
      if (!this.personaCanAccessGuild(cfg.id, g.id)) continue;
      try {
        roleByGuild[g.id] = await this.roles.bind(g.id, cfg.id, cfg.displayName);
      } catch (err) {
        console.error(`[portal-relay] role bind failed (${g.id}/${cfg.id}):`, (err as Error).message);
      }
    }
    // ── Synchronous from here to return: snapshot, baseline, seq. ──
    const current = this.identity.get(session.personaId) ?? cfg; // may have changed mid-await
    const guilds = this.bot.listGuilds();
    const channels: PortalChannel[] = [];
    for (const g of guilds) {
      for (const meta of this.bot.listChannelMetas(g.id)) {
        const channel = this.toPortalChannel(meta, session.personaId);
        // Baseline for the caps-dedup filter: ready IS a delivery.
        this.rememberCaps(session.personaId, channel.id, channel.capabilities);
        channels.push(channel);
      }
    }
    return {
      sessionId: session.id,
      persona: this.identity.toPersona(current, roleByGuild),
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
        await this.webhooks.edit(ref.webhookId, ref.discordMsgId, p.content, ref.threadId);
        return {};
      }
      case 'delete_message': {
        const p = params as RpcParams<'delete_message'>;
        const ref = await this.resolveRef(p.messageId);
        if (!ref) throw rpcError('NOT_FOUND', 'unknown message');
        if (ref.personaId === personaId && ref.webhookId) {
          // Own webhook message → delete via the webhook.
          this.requireCap(personaId, ref.channelId, 'DELETE_OWN');
          await this.webhooks.ensureLoaded(ref.channelId);
          await this.webhooks.delete(ref.webhookId, ref.discordMsgId, ref.threadId);
        } else {
          // Someone else's message → moderation delete (bot-level), gated by the
          // MANAGE_MESSAGES capability (and the bot's Discord Manage Messages perm).
          this.requireCap(personaId, ref.channelId, 'MANAGE_MESSAGES');
          await this.bot.deleteAnyMessage(ref.threadId ?? ref.channelId, ref.discordMsgId);
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
        const target = await this.resolveContainer(p.channelId, p.threadId);
        if (!target) throw rpcError('NOT_FOUND', 'channel not found');
        this.requireCap(personaId, target.parentChannelId, 'READ_HISTORY');
        const before = this.cursorToSnowflake(p.before);
        const after = this.cursorToSnowflake(p.after);
        const limit = p.limit ?? 50;
        // The cache key is the actual container being read — a thread and its
        // parent are distinct pages (live invalidation already keys this way:
        // convert() reports a thread message's channelId as the thread id).
        const container = target.threadId ?? target.parentChannelId;
        let raw = this.history.get(container, limit, before, after);
        if (!raw) {
          raw = await this.bot.fetchHistory(container, limit, before, after);
          this.history.set(container, limit, before, after, raw);
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
      case 'voice_join': {
        const p = params as RpcParams<'voice_join'>;
        if (!this.voice) throw rpcError('UNAVAILABLE', 'voice transcription not configured (ELEVENLABS_KEY unset)');
        this.requireCap(personaId, p.channelId, 'VOICE_LISTEN');
        // Joining implies wanting the transcripts: auto-subscribe this session,
        // same as it could do explicitly (capability already checked above —
        // VOICE_LISTEN requires Connect, which subsumes the viewing intent;
        // VIEW_CHANNEL is still re-checked per-delivery). Subscribe BEFORE the
        // join so the joiner receives the `voice_status` the join emits.
        const wasSubscribed = session.subscriptions.has(p.channelId);
        session.subscriptions.add(p.channelId);
        try {
          await this.voice.join(p.channelId);
        } catch (e) {
          if (!wasSubscribed) session.subscriptions.delete(p.channelId);
          if (e instanceof VoiceJoinError) throw rpcError(e.code, e.message);
          throw rpcError('DISCORD_ERROR', `voice join failed: ${(e as Error).message}`);
        }
        return { listening: true };
      }
      case 'voice_leave': {
        const p = params as RpcParams<'voice_leave'>;
        if (!this.voice) throw rpcError('UNAVAILABLE', 'voice transcription not configured (ELEVENLABS_KEY unset)');
        this.requireCap(personaId, p.channelId, 'VOICE_LISTEN');
        this.voice.leave(p.channelId);
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
      case 'mint_invite': {
        const p = params as RpcParams<'mint_invite'>;
        return this.mintInviteRpc(personaId, p);
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

  /** Resolve the protocol's two thread address forms into one container:
   *  `{channelId}` alone (a channel or a bare thread id), or
   *  `{channelId, threadId}` with the thread under that channel. A threadId
   *  that is not actually a thread under channelId resolves to null rather
   *  than falling through to the parent — that silent fall-through is how
   *  thread targeting broke unnoticed: sends landed in the parent channel
   *  and deliveries honestly carried no threadId (portal#17). */
  private async resolveContainer(
    channelId: string,
    threadId?: string,
  ): Promise<{ parentChannelId: string; threadId?: string } | null> {
    if (!threadId) return this.bot.resolveTarget(channelId);
    const meta = await this.bot.getChannelMeta(threadId);
    if (!meta?.isThread || meta.parentId !== channelId) return null;
    return { parentChannelId: channelId, threadId };
  }

  private async sendMessage(
    personaId: string,
    p: RpcParams<'send_message'>,
  ): Promise<{ messageId: string }> {
    const cfg = this.identity.get(personaId)!;
    const target = await this.resolveContainer(p.channelId, p.threadId);
    if (!target) throw rpcError('NOT_FOUND', 'channel not found');
    // Capabilities live on the parent channel; a thread never carries its own
    // grant rows, so checking the raw passed id (which may BE a thread id)
    // refuses personas whose parent-channel rights are complete.
    this.requireCap(
      personaId,
      target.parentChannelId,
      target.threadId ? 'SEND_IN_THREADS' : 'SEND_MESSAGES',
    );

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

    const { messageId, webhookId } = await this.webhooks.send(target.parentChannelId, personaId, {
      threadId: target.threadId,
      username: cfg.displayName,
      avatarURL: this.identity.avatarUrl(cfg),
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
    return { messageId: ref.relayId };
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
    const { message, authorPersonaId } = this.buildPortalMessage(inc);
    this.deliverMessage('message_create', message, authorPersonaId);
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

  /**
   * Voice transcript delivery. Same subscription + VIEW_CHANNEL gate as
   * deliverMessage's ambient branch, but no addressing (speech mentions nobody
   * structurally) and no read-state accumulation — voice is live perception,
   * not unread inventory. Partials ride the ephemeral path (unsequenced,
   * unreplayed); finals are sequenced.
   */
  private deliverTranscript(t: VoiceTranscript): void {
    const event = {
      type: 'voice_transcript' as const,
      channelId: t.channelId,
      guildId: t.guildId,
      utteranceId: t.utteranceId,
      speaker: {
        kind: 'user' as const,
        userId: t.userId,
        username: t.username,
        displayName: t.displayName,
        bot: t.bot,
      },
      text: t.text,
      partial: t.partial,
      startedAt: t.startedAt,
      at: Date.now(),
    };
    for (const personaId of this.gateway.activePersonas()) {
      if (!this.gateway.personaSubscribed(personaId, t.channelId)) continue;
      if (!this.personaCanViewChannel(personaId, t.channelId, t.guildId)) continue;
      if (t.partial) this.gateway.dispatchEphemeral(personaId, event);
      else this.gateway.dispatch(personaId, event);
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
          messageSnippet: r.messageSnippet ?? undefined,
        });
      } else {
        this.gateway.dispatch(personaId, {
          type: 'reaction_remove',
          channelId: r.channelId,
          threadId: r.threadId,
          messageId: relayId,
          emoji: r.emoji,
          actor,
          messageSnippet: r.messageSnippet ?? undefined,
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
    let echoPersonaId = ref.personaId;
    if (inc.webhookId && this.bot.ownsWebhook(inc.webhookId) && !echoPersonaId) {
      // The gateway echo of our own webhook post can arrive before the send
      // RPC's REST response records attribution — the ref exists but carries
      // no personaId yet, and the delivery would go out as the per-channel
      // webhook pseudo-user (portal#18). The username on an owned-webhook
      // post is the persona's displayName stamped at send time; when exactly
      // one persona matches it, that recovers the author. Ambiguity (two
      // personas sharing a displayName) falls through to the honest
      // webhook-user shape rather than guessing.
      //
      // Age gate (#19 review note 2): the race this recovers from is
      // seconds-wide, but this path also runs for OLD posts surfaced via
      // fetch_history with no store row — where matching against the
      // CURRENT roster can durably mis-attribute a message written before a
      // rename or a name reassignment. Recovery therefore applies only to
      // messages young enough to be the race; older unattributed webhook
      // posts keep the honest webhook-user shape.
      const ageMs = Date.now() - inc.timestamp.getTime();
      const named =
        ageMs <= ECHO_RECOVERY_MAX_AGE_MS
          ? this.identity.all().filter((c) => c.displayName === inc.authorName)
          : [];
      if (named.length === 1) {
        echoPersonaId = named[0].id;
        this.store.record({
          channelId: inc.parentChannelId,
          threadId: inc.threadId,
          guildId: inc.guildId,
          discordMsgId: inc.id,
          personaId: echoPersonaId,
          webhookId: inc.webhookId,
        });
      }
    }
    if (inc.webhookId && this.bot.ownsWebhook(inc.webhookId) && echoPersonaId) {
      authorPersonaId = echoPersonaId;
      const cfg = this.identity.get(echoPersonaId);
      author = {
        kind: 'persona',
        personaId: echoPersonaId,
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
      content: inc.content,
      // Render custom-emoji tokens (<:name:id> / <a:name:id>) down to :name: in
      // the human-readable field so message text reads legibly for the model.
      // The raw `content` keeps the full tokens for correlation/round-tripping.
      cleanContent: renderCustomEmojis(inc.cleanContent),
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

function isMirrorScope(scope: Scope): scope is { mirrorRole: string } | { mirrorRoles: string[] } {
  return 'mirrorRole' in scope || 'mirrorRoles' in scope;
}

function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Render custom-emoji tokens ('<:name:id>' / '<a:name:id>') down to ':name:'
 *  so message text reads legibly for the model. Unicode emoji are untouched. */
function renderCustomEmojis(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`);
}
