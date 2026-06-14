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
} from '@connectome/portal-protocol';
import type { PersonaIdentity, RelayConfig } from './config.js';
import { DiscordBot, type ChannelMeta, type IncomingMessage } from './discord-bot.js';
import { Gateway, type GatewayHooks, Session } from './gateway.js';
import { HistoryCache } from './history-cache.js';
import { IdentityStore, type IdentityChange } from './identity.js';
import { InviteStore } from './invites.js';
import { MessageStore, makeRelayId, parseRelayId, type MessageRef } from './message-store.js';
import { PermissionsStore, type PermissionChange, computeCapabilities } from './permissions.js';
import { RolePool } from './role-pool.js';
import { WebhookPool } from './webhook-pool.js';

export class Relay implements GatewayHooks {
  private bot: DiscordBot;
  readonly identity: IdentityStore;
  readonly permissions: PermissionsStore;
  readonly invites?: InviteStore;
  private roles: RolePool;
  private webhooks: WebhookPool;
  private store: MessageStore;
  private history: HistoryCache;
  private gateway: Gateway;

  constructor(private config: RelayConfig) {
    this.bot = new DiscordBot(config.discordToken, config.guildIds, {
      guildMembersIntent: config.guildMembersIntent,
    });
    this.store = new MessageStore({ path: config.attributionPath });
    this.history = new HistoryCache(config.historyCacheTtlMs);
    this.identity = new IdentityStore(config.identityPath, config.avatarBaseUrl);
    this.permissions = new PermissionsStore(config.permissionsPath);
    if (config.invitesPath) this.invites = new InviteStore(config.invitesPath);
    this.roles = new RolePool(this.bot, config.rolePool.size, config.rolePool.prefix);
    this.webhooks = new WebhookPool(this.bot, config.webhookPoolSize);
    this.gateway = new Gateway(this, config.heartbeatIntervalMs);
  }

  async start(): Promise<void> {
    this.bot.on('message', (m) => this.onDiscordMessage(m));
    this.bot.on('messageEdit', (m) => this.onDiscordEdit(m));
    this.bot.on('messageDelete', (channelId, messageId) => this.onDiscordDelete(channelId, messageId));
    this.bot.on('reactionAdd', (r) => this.onReactionEvent('add', r));
    this.bot.on('reactionRemove', (r) => this.onReactionEvent('remove', r));
    this.bot.on('pinsUpdate', (channelId) => this.onPinsUpdate(channelId));
    // Live identity/permission changes → wire events.
    this.identity.onChange((c) => void this.onIdentityChange(c).catch((e) => console.error('[portal-relay] identity change:', (e as Error).message)));
    this.permissions.onChange((c) => this.onPermissionChange(c));
    if (this.config.watchConfig) {
      this.identity.startWatching();
      this.permissions.startWatching();
      this.invites?.startWatching();
    }
    if (this.invites) console.error('[portal-relay] self-registration enabled (invites)');
    await this.bot.connect();
    console.error(`[portal-relay] discord connected as ${this.bot.botUserId}`);
    this.gateway.listen(this.config.wsPort);
  }

  async stop(): Promise<void> {
    this.identity.stopWatching();
    this.permissions.stopWatching();
    this.invites?.stopWatching();
    this.store.flush();
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

    const displayName = (d.desiredName || 'agent').slice(0, 80).trim() || 'agent';
    const personaId = this.mintPersonaId(checked.namePrefix ?? displayName);
    const token = `pt_${randomBytes(24).toString('base64url')}`;
    const identity: PersonaIdentity = {
      id: personaId,
      displayName,
      avatar: d.avatar ?? '',
      token,
    };
    this.identity.upsert(identity);
    this.permissions.setPersonaDefault(personaId, checked.caps);
    this.invites.consume(d.invite);

    // Carry the invite's default subscriptions through to this session.
    if (checked.subscriptions?.length) {
      d.subscriptions = [...new Set([...(d.subscriptions ?? []), ...checked.subscriptions])];
    }

    console.error(`[portal-relay] enrolled persona "${personaId}" via invite (${checked.label ?? d.invite})`);
    return { personaId, token, persona: this.identity.toPersona(identity) };
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
    // Pre-bind a role in each guild so the persona is addressable immediately.
    const roleByGuild: Record<string, string> = {};
    for (const g of guilds) {
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
        await this.webhooks.edit(ref.webhookId, ref.discordMsgId, p.content, ref.threadId);
        return {};
      }
      case 'delete_message': {
        const p = params as RpcParams<'delete_message'>;
        const ref = await this.resolveRef(p.messageId);
        if (!ref) throw rpcError('NOT_FOUND', 'unknown message');
        if (ref.personaId !== personaId) throw rpcError('FORBIDDEN', 'not your message');
        if (!ref.webhookId) throw rpcError('NOT_FOUND', 'no webhook recorded for message');
        this.requireCap(personaId, ref.channelId, 'DELETE_OWN');
        await this.webhooks.ensureLoaded(ref.channelId);
        await this.webhooks.delete(ref.webhookId, ref.discordMsgId, ref.threadId);
        return {};
      }
      case 'react': {
        const p = params as RpcParams<'react'>;
        return this.react(personaId, p.messageId, p.emoji, p.visible);
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
      default:
        throw rpcError('INVALID_PARAMS', `unknown method ${String(method)}`);
    }
  }

  private async sendMessage(
    personaId: string,
    p: RpcParams<'send_message'>,
  ): Promise<{ messageId: string }> {
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
        const roleId = await this.roles.bind(guildId, pid, target2.displayName);
        tags.push(`<@&${roleId}>`);
      }
      if (tags.length) content = `${tags.join(' ')} ${content}`.trim();
    }

    // Reply degrades to a quoted jump-link (webhooks can't carry native replies).
    if (p.replyToId) {
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
    for (const personaId of this.gateway.activePersonas()) {
      if (authorPersonaId && personaId === authorPersonaId) continue; // not your own message
      const reasons: AddressReason[] = [];
      if (message.mentions.personas.includes(personaId)) reasons.push('role_mention');
      if (message.replyToId) {
        const ref = this.store.getByRelayId(message.replyToId);
        if (ref?.personaId === personaId) reasons.push('reply');
      }
      const addressedToMe = reasons.length > 0;
      const subscribed = this.gateway.personaSubscribed(personaId, message.channelId);
      if (!addressedToMe && !subscribed) continue;
      if (subscribed && !addressedToMe) reasons.push('subscription');
      this.gateway.dispatch(personaId, { type, message, addressedToMe, reasons });
    }
  }

  /** Native (human) reaction add/remove → dispatch to channel subscribers + the
   *  reacted message's author persona. */
  private onReactionEvent(kind: 'add' | 'remove', r: import('./discord-bot.js').IncomingReaction): void {
    const relayId = makeRelayId(r.threadId ?? r.channelId, r.messageId);
    const ownerRef = this.store.getByRelayId(relayId);
    const targets = new Set<string>();
    for (const p of this.gateway.activePersonas()) {
      if (this.gateway.personaSubscribed(p, r.channelId)) targets.add(p);
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
      if (this.gateway.personaSubscribed(personaId, channelId)) {
        this.gateway.dispatch(personaId, { type: 'pins_update', channelId });
      }
    }
  }

  private onDiscordDelete(channelId: string, messageId: string): void {
    this.history.invalidate(channelId);
    const ref = this.store.getByDiscordId(messageId);
    const relayId = ref?.relayId ?? messageId;
    this.store.remove(messageId);
    for (const personaId of this.gateway.activePersonas()) {
      this.gateway.dispatch(personaId, {
        type: 'message_delete',
        channelId: ref?.channelId ?? channelId,
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
      content: inc.content,
      cleanContent: inc.cleanContent,
      attachments: inc.attachments,
      mentions: {
        personas,
        roles: inc.mentionRoleIds,
        users: inc.mentionUserIds,
        everyone: inc.mentionsEveryone,
      },
      replyToId,
      reactions: [],
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

  private capsFor(personaId: string, channelId: string, guildId: string | null): Capability[] {
    if (!this.identity.get(personaId)) return [];
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
