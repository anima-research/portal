/**
 * discord.js wrapper for the portal relay. Holds the *single* bot connection
 * and implements the Discord-side operations the pools need (WebhookOps,
 * RoleOps) plus inbound event surfacing and queries.
 *
 * Builds on the patterns proven in discord-mcpl/discord-adapter.ts (intents,
 * member-cache warming, outgoing @name resolution, paginated history).
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type Webhook,
  type User,
  type PartialUser,
  type MessageReaction,
  type PartialMessageReaction,
  type GuildBasedChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { RoleOps } from './role-pool.js';
import type { WebhookOps, WebhookSendOpts } from './webhook-pool.js';

export interface ChannelMeta {
  id: string;
  name: string | null;
  type: 'text' | 'voice' | 'category' | 'thread' | 'forum' | 'unknown';
  /** Parent channel id for threads (where the webhook lives). */
  parentId?: string;
  guildId: string | null;
  archived?: boolean;
  isThread: boolean;
}

export interface IncomingAttachment {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface IncomingMessage {
  id: string;
  content: string;
  cleanContent: string;
  authorId: string;
  authorName: string;
  authorDisplayName: string;
  isBot: boolean;
  /** Set when the message was delivered via a webhook (one of ours or foreign). */
  webhookId?: string;
  /** The channel the message arrived in (thread id when in a thread). */
  channelId: string;
  parentChannelId: string;
  threadId?: string;
  guildId: string | null;
  channelName: string | null;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  mentionsEveryone: boolean;
  replyToId?: string;
  replyToUserId?: string | null;
  attachments: IncomingAttachment[];
  timestamp: Date;
}

/** A native (human/bot) reaction event. */
export interface IncomingReaction {
  messageId: string;
  /** Parent (non-thread) channel id. */
  channelId: string;
  threadId?: string;
  guildId: string | null;
  /** Unicode emoji or `name:id` for a custom emoji. */
  emoji: string;
  userId: string;
  userName: string;
  isBot: boolean;
}

export interface MemberInfo {
  userId: string;
  username: string;
  displayName: string;
  nickname: string | null;
  bot: boolean;
  roles: string[];
}

type Handlers = {
  ready?: () => void;
  message?: (m: IncomingMessage) => void;
  /** Inbound (human/bot) edit — full converted message. */
  messageEdit?: (m: IncomingMessage) => void;
  messageDelete?: (channelId: string, messageId: string) => void;
  reactionAdd?: (r: IncomingReaction) => void;
  reactionRemove?: (r: IncomingReaction) => void;
  pinsUpdate?: (channelId: string, guildId: string | null) => void;
  guildCreate?: (guildId: string, name: string, channels: ChannelMeta[]) => void;
  channelChange?: (channel: ChannelMeta) => void;
  channelDelete?: (channelId: string, guildId: string | null) => void;
};

const MAX_ATTACH = 10;

export class DiscordBot implements WebhookOps, RoleOps {
  private client: Client;
  private handlers: Handlers = {};
  private webhookCache = new Map<string, Webhook>(); // webhookId → Webhook

  private guildMembersIntent: boolean;

  constructor(
    private token: string,
    private guildIds: string[],
    opts: { guildMembersIntent?: boolean } = {},
  ) {
    // GuildMembers is privileged and must be enabled in the dev portal. It only
    // powers eager @name → <@id> resolution for inactive members, so it's
    // optional — without it the member cache fills opportunistically from
    // messages. Default on (real deploys should enable it); opt out for bots
    // that don't have it, or login fails with "disallowed intents".
    this.guildMembersIntent = opts.guildMembersIntent ?? true;
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildWebhooks,
    ];
    if (this.guildMembersIntent) intents.push(GatewayIntentBits.GuildMembers);
    this.client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
    this.wire();
  }

  on<K extends keyof Handlers>(event: K, fn: Handlers[K]): void {
    this.handlers[event] = fn;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.client.isReady()) return resolve();
      this.client.once('ready', () => resolve());
      this.client.login(this.token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  get botUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  private guildAllowed(guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    return this.guildIds.length === 0 || this.guildIds.includes(guildId);
  }

  // ── WebhookOps ──

  async ensureWebhooks(parentChannelId: string, marker: string, count: number): Promise<string[]> {
    const channel = await this.client.channels.fetch(parentChannelId);
    if (!channel || !('fetchWebhooks' in channel)) {
      throw new Error(`Channel ${parentChannelId} has no webhooks`);
    }
    const tc = channel as TextChannel;
    const existing = await tc.fetchWebhooks();
    const ours = [...existing.values()].filter(
      (w) => w.owner?.id === this.client.user?.id && (w.name?.includes(marker) ?? false),
    );
    const ids: string[] = [];
    for (const w of ours) {
      this.webhookCache.set(w.id, w);
      ids.push(w.id);
      if (ids.length >= count) break;
    }
    while (ids.length < count) {
      const w = await tc.createWebhook({ name: `${marker} #${ids.length + 1}` });
      this.webhookCache.set(w.id, w);
      ids.push(w.id);
    }
    return ids;
  }

  /** Whether a webhook id is one we created/adopted (for self-echo detection). */
  ownsWebhook(webhookId: string): boolean {
    return this.webhookCache.has(webhookId);
  }

  private webhook(webhookId: string): Webhook {
    const w = this.webhookCache.get(webhookId);
    if (!w) throw new Error(`Webhook ${webhookId} not cached`);
    return w;
  }

  async sendWebhook(webhookId: string, opts: WebhookSendOpts): Promise<{ messageId: string }> {
    const files = buildAttachments(opts.files);
    const sent = await this.webhook(webhookId).send({
      content: opts.content || undefined,
      username: opts.username,
      avatarURL: opts.avatarURL || undefined,
      threadId: opts.threadId,
      files: files.length ? files : undefined,
      allowedMentions: {
        parse: opts.allowMentions ? ['users', 'roles', 'everyone'] : ['users', 'roles'],
      },
    });
    return { messageId: sent.id };
  }

  async editWebhookMessage(
    webhookId: string,
    messageId: string,
    content: string,
    threadId?: string,
  ): Promise<void> {
    await this.webhook(webhookId).editMessage(messageId, { content, threadId });
  }

  async deleteWebhookMessage(webhookId: string, messageId: string, threadId?: string): Promise<void> {
    await this.webhook(webhookId).deleteMessage(messageId, threadId);
  }

  // ── RoleOps ──

  async createRole(guildId: string, name: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);
    const role = await guild.roles.create({ name, mentionable: true, permissions: [] });
    return role.id;
  }

  async renameRole(guildId: string, roleId: string, name: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    const role = await guild.roles.fetch(roleId);
    if (role) await role.edit({ name, mentionable: true });
  }

  async discoverPooledRoles(
    guildId: string,
    prefix: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.roles.fetch();
    return [...guild.roles.cache.values()]
      .filter((r) => r.name.startsWith(prefix))
      .sort((a, b) => a.id.localeCompare(b.id, 'en-US-u-kn-true'))
      .map((r) => ({ id: r.id, name: r.name }));
  }

  /** Bot-level typing indicator (anonymous — it's the bot user typing, not the
   *  persona; webhooks can't show per-persona typing). */
  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel && 'sendTyping' in channel) await (channel as TextChannel).sendTyping();
  }

  // ── Reactions (native, from the bot) ──

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) throw new Error(`Channel ${channelId} not found`);
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(emoji);
  }

  // ── Queries ──

  listGuilds(): Array<{ id: string; name: string; memberCount: number }> {
    return [...this.client.guilds.cache.values()]
      .filter((g) => this.guildAllowed(g.id))
      .map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
  }

  /** Whether the relay holds the GuildMembers intent (full roster vs. partial). */
  get hasMembersIntent(): boolean {
    return this.guildMembersIntent;
  }

  /** Members from the cache (warmed when the GuildMembers intent is on). */
  listMembers(guildId: string, query?: string, limit = 100): MemberInfo[] {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    const q = query?.toLowerCase();
    const out: MemberInfo[] = [];
    for (const m of guild.members.cache.values()) {
      if (q) {
        const hay = [m.user.username, m.user.globalName, m.user.displayName, m.nickname]
          .filter((s): s is string => !!s)
          .map((s) => s.toLowerCase());
        if (!hay.some((h) => h.includes(q))) continue;
      }
      out.push({
        userId: m.user.id,
        username: m.user.username,
        displayName: m.user.globalName ?? m.user.displayName ?? m.user.username,
        nickname: m.nickname ?? null,
        bot: m.user.bot,
        roles: [...m.roles.cache.keys()],
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The guild's full role catalog (id + name + pooled flag). Roles arrive with
   *  the base Guilds intent, so this is always populated — no availability flag.
   *  `poolPrefix` flags the relay's persona-addressing pool roles. */
  listRoles(guildId: string, poolPrefix: string): Array<{ id: string; guildId: string; name: string; pooled: boolean }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return [...guild.roles.cache.values()].map((r) => ({
      id: r.id,
      guildId,
      name: r.name,
      pooled: r.name.startsWith(poolPrefix),
    }));
  }

  /** Resolve bare handles to user ids (unique case-insensitive match, else null). */
  resolveHandles(guildId: string, handles: string[]): Record<string, string | null> {
    const guild = this.client.guilds.cache.get(guildId);
    const out: Record<string, string | null> = {};
    for (const h of handles) {
      const lower = h.toLowerCase().replace(/^@/, '');
      if (!guild) {
        out[h] = null;
        continue;
      }
      const matches = [...guild.members.cache.values()].filter((m) =>
        [m.user.username, m.user.globalName, m.user.displayName, m.nickname]
          .filter((s): s is string => !!s)
          .some((a) => a.toLowerCase() === lower),
      );
      out[h] = matches.length === 1 ? matches[0].user.id : null;
    }
    return out;
  }

  /** Pinned messages in a channel. discord.js routes via the REST manager, which
   *  owns the /pins rate-limit quirk centrally. */
  async listPins(channelId: string): Promise<IncomingMessage[]> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return [];
    const pinned = await (channel as TextChannel).messages.fetchPinned();
    return [...pinned.values()].map((m) => this.convert(m));
  }

  async getChannelMeta(channelId: string): Promise<ChannelMeta | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    return this.metaOf(channel as GuildBasedChannel);
  }

  private metaOf(channel: GuildBasedChannel): ChannelMeta {
    const isThread = channel.isThread();
    const guildId = 'guildId' in channel ? (channel.guildId ?? null) : null;
    return {
      id: channel.id,
      name: 'name' in channel ? (channel.name ?? null) : null,
      type: mapChannelType(channel.type),
      parentId: isThread ? ((channel as AnyThreadChannel).parentId ?? undefined) : undefined,
      guildId,
      archived: isThread ? ((channel as AnyThreadChannel).archived ?? false) : undefined,
      isThread,
    };
  }

  /** Normalize a target channel id into {parent, thread} for webhook posting. */
  async resolveTarget(channelId: string): Promise<{ parentChannelId: string; threadId?: string } | null> {
    const meta = await this.getChannelMeta(channelId);
    if (!meta) return null;
    if (meta.isThread && meta.parentId) {
      return { parentChannelId: meta.parentId, threadId: meta.id };
    }
    return { parentChannelId: meta.id };
  }

  listChannelMetas(guildId: string): ChannelMeta[] {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return [...guild.channels.cache.values()]
      .filter((c): c is GuildBasedChannel => c != null)
      .map((c) => this.metaOf(c));
  }

  /** discord.js GuildMember for the bot in a guild, for permission checks. */
  meIn(guildId: string): GuildMember | null {
    return this.client.guilds.cache.get(guildId)?.members.me ?? null;
  }

  channelForPerms(channelId: string): GuildBasedChannel | undefined {
    const c = this.client.channels.cache.get(channelId);
    return c && 'guildId' in c ? (c as GuildBasedChannel) : undefined;
  }

  /** Synchronous channel meta from the cache (null if not cached). */
  channelMetaFromCache(channelId: string): ChannelMeta | null {
    const c = this.client.channels.cache.get(channelId);
    return c && 'guildId' in c ? this.metaOf(c as GuildBasedChannel) : null;
  }

  async createTextChannel(guildId: string, name: string, categoryId?: string): Promise<ChannelMeta> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return this.metaOf(channel as GuildBasedChannel);
  }

  async createThread(channelId: string, name: string): Promise<ChannelMeta> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('threads' in channel)) throw new Error(`Channel ${channelId} can't host threads`);
    const thread = await (channel as TextChannel).threads.create({ name });
    return this.metaOf(thread as unknown as GuildBasedChannel);
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'delete' in channel) await (channel as TextChannel).delete();
  }

  /** Re-fetch a single message by snowflake from its container channel,
   *  returning attribution fields (parent/thread/webhook). Used as the C2
   *  store-miss fallback. Returns null if the message is gone or unreachable. */
  async fetchMessageMeta(
    containerChannelId: string,
    discordMsgId: string,
  ): Promise<{ channelId: string; threadId?: string; guildId: string | null; discordMsgId: string; webhookId?: string } | null> {
    const channel = await this.client.channels.fetch(containerChannelId).catch(() => null);
    if (!channel || !('messages' in channel)) return null;
    const msg = await (channel as TextChannel).messages.fetch(discordMsgId).catch(() => null);
    if (!msg) return null;
    const isThread = (channel as GuildBasedChannel).isThread?.() ?? false;
    const parentChannelId = isThread
      ? ((channel as AnyThreadChannel).parentId ?? containerChannelId)
      : containerChannelId;
    return {
      channelId: parentChannelId,
      threadId: isThread ? containerChannelId : undefined,
      guildId: msg.guildId ?? null,
      discordMsgId: msg.id,
      webhookId: msg.webhookId ?? undefined,
    };
  }

  async fetchHistory(
    channelId: string,
    limit: number,
    before?: string,
    after?: string,
  ): Promise<IncomingMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) throw new Error(`Channel ${channelId} not found`);
    const collected: IncomingMessage[] = [];
    let cursor = before;
    while (collected.length < limit) {
      const pageLimit = Math.min(100, limit - collected.length);
      const page = await (channel as TextChannel).messages.fetch({ limit: pageLimit, before: cursor });
      if (page.size === 0) break;
      const arr = [...page.values()].sort((a, b) => b.id.localeCompare(a.id, 'en-US-u-kn-true'));
      let stop = false;
      for (const m of arr) {
        if (after && m.id.localeCompare(after, 'en-US-u-kn-true') <= 0) {
          stop = true;
          break;
        }
        collected.push(this.convert(m));
        if (collected.length >= limit) break;
      }
      if (stop || page.size < pageLimit) break;
      cursor = arr[arr.length - 1]?.id;
      if (!cursor) break;
    }
    return collected;
  }

  /** Resolve human @handle mentions and #channel names in outgoing content to
   *  Discord syntax. Mirrors the discord-mcpl resolver (cache-based). */
  resolveOutgoingMentions(guildId: string | null, content: string): string {
    if (!guildId) return content;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return content;
    const selfId = this.client.user?.id;
    return content.replace(/@([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g, (whole, handle: string) => {
      const lower = handle.toLowerCase();
      if (lower === 'everyone' || lower === 'here') return whole;
      const matches = [...guild.members.cache.values()].filter((m: GuildMember) => {
        if (m.user.id === selfId) return false;
        return [m.nickname, m.user.globalName, m.user.displayName, m.user.username]
          .filter((s): s is string => !!s)
          .some((a) => a.toLowerCase() === lower);
      });
      return matches.length === 1 ? `<@${matches[0].user.id}>` : whole;
    });
  }

  // ── Wiring ──

  private wire(): void {
    this.client.on('ready', () => {
      this.handlers.ready?.();
      if (this.guildMembersIntent) {
        for (const g of this.client.guilds.cache.values()) void this.warmMembers(g);
      }
    });

    this.client.on('messageCreate', (m) => {
      if (m.author.id === this.client.user?.id) return; // our own bot user (rare)
      if (!this.guildAllowed(m.guildId)) return;
      this.handlers.message?.(this.convert(m));
    });

    this.client.on('messageUpdate', (_o, n) => {
      if (!this.guildAllowed(n.guildId)) return;
      if (n.author?.id === this.client.user?.id) return;
      if (n.webhookId && this.ownsWebhook(n.webhookId)) return; // our own edit echo
      this.handlers.messageEdit?.(this.convert(n));
    });

    this.client.on('messageDelete', (m) => {
      this.handlers.messageDelete?.(m.channelId, m.id);
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      void this.onReaction('reactionAdd', reaction, user);
    });
    this.client.on('messageReactionRemove', (reaction, user) => {
      void this.onReaction('reactionRemove', reaction, user);
    });

    this.client.on('channelPinsUpdate', (channel) => {
      if ('guildId' in channel && this.guildAllowed(channel.guildId)) {
        this.handlers.pinsUpdate?.(channel.id, channel.guildId ?? null);
      }
    });

    this.client.on('guildCreate', (g) => {
      void this.warmMembers(g);
      if (!this.guildAllowed(g.id)) return;
      this.handlers.guildCreate?.(g.id, g.name, this.listChannelMetas(g.id));
    });

    this.client.on('channelCreate', (c) => {
      if ('guildId' in c && this.guildAllowed(c.guildId)) {
        this.handlers.channelChange?.(this.metaOf(c as GuildBasedChannel));
      }
    });
    this.client.on('channelUpdate', (_o, c) => {
      if ('guildId' in c && this.guildAllowed((c as GuildBasedChannel).guildId)) {
        this.handlers.channelChange?.(this.metaOf(c as GuildBasedChannel));
      }
    });
    this.client.on('channelDelete', (c) => {
      if ('guildId' in c) this.handlers.channelDelete?.(c.id, (c as GuildBasedChannel).guildId ?? null);
    });

    this.client.on('threadCreate', (t) => {
      if (this.guildAllowed(t.guildId)) this.handlers.channelChange?.(this.metaOf(t as unknown as GuildBasedChannel));
    });
    this.client.on('threadUpdate', (_o, t) => {
      if (this.guildAllowed(t.guildId)) this.handlers.channelChange?.(this.metaOf(t as unknown as GuildBasedChannel));
    });
    this.client.on('threadDelete', (t) => {
      this.handlers.channelDelete?.(t.id, t.guildId ?? null);
    });

    this.client.on('error', (e) => console.error('[portal-relay] client error:', e.message));
  }

  private async onReaction(
    kind: 'reactionAdd' | 'reactionRemove',
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    try {
      if (reaction.partial) await reaction.fetch();
    } catch {
      return;
    }
    const msg = reaction.message as Message;
    if (!this.guildAllowed(msg.guildId)) return;
    if (user.id === this.client.user?.id) return; // ignore the bot's own reactions
    const channel = msg.channel as GuildBasedChannel;
    const isThread = channel?.isThread?.() ?? false;
    const parentChannelId = isThread ? ((channel as AnyThreadChannel).parentId ?? msg.channelId) : msg.channelId;
    const emoji = reaction.emoji.id
      ? `${reaction.emoji.name}:${reaction.emoji.id}`
      : (reaction.emoji.name ?? '?');
    const evt: IncomingReaction = {
      messageId: msg.id,
      channelId: parentChannelId,
      threadId: isThread ? channel.id : undefined,
      guildId: msg.guildId ?? null,
      emoji,
      userId: user.id,
      userName: user.username ?? '',
      isBot: !!user.bot,
    };
    (kind === 'reactionAdd' ? this.handlers.reactionAdd : this.handlers.reactionRemove)?.(evt);
  }

  private async warmMembers(guild: Guild): Promise<void> {
    try {
      await guild.members.fetch();
    } catch (err) {
      console.error(`[portal-relay] member warm failed for ${guild.name}: ${(err as Error).message}`);
    }
  }

  private convert(m: Message | (Partial<Message> & { id: string })): IncomingMessage {
    const msg = m as Message;
    const channel = msg.channel as GuildBasedChannel;
    const isThread = channel?.isThread?.() ?? false;
    const parentChannelId = isThread ? ((channel as AnyThreadChannel).parentId ?? msg.channelId) : msg.channelId;
    const rawClean = (msg as { cleanContent?: string }).cleanContent;
    const author = msg.author as User;
    return {
      id: msg.id,
      content: msg.content ?? '',
      cleanContent: typeof rawClean === 'string' && rawClean.length ? rawClean : (msg.content ?? ''),
      authorId: author?.id ?? '',
      authorName: author?.username ?? '',
      authorDisplayName: author?.displayName ?? author?.username ?? '',
      isBot: author?.bot ?? false,
      webhookId: msg.webhookId ?? undefined,
      channelId: msg.channelId,
      parentChannelId,
      threadId: isThread ? channel.id : undefined,
      guildId: msg.guildId ?? null,
      channelName: 'name' in channel ? ((channel as { name?: string }).name ?? null) : null,
      mentionUserIds: msg.mentions?.users?.map((u) => u.id) ?? [],
      mentionRoleIds: msg.mentions?.roles?.map((r) => r.id) ?? [],
      mentionsEveryone: msg.mentions?.everyone ?? false,
      replyToId: msg.reference?.messageId ?? undefined,
      replyToUserId: msg.mentions?.repliedUser?.id ?? null,
      attachments:
        [...(msg.attachments?.values() ?? [])].map((a) => ({
          id: a.id,
          name: a.name ?? a.id,
          url: a.url,
          contentType: a.contentType ?? null,
          size: a.size ?? 0,
        })) ?? [],
      timestamp: msg.createdAt ?? new Date(),
    };
  }
}

function buildAttachments(files?: WebhookSendOpts['files']): AttachmentBuilder[] {
  if (!files?.length) return [];
  if (files.length > MAX_ATTACH) throw new Error(`Too many files (max ${MAX_ATTACH})`);
  return files.map((f) => {
    if (!f?.path || !existsSync(f.path) || !statSync(f.path).isFile()) {
      throw new Error(`File not found: ${f?.path}`);
    }
    const a = new AttachmentBuilder(f.path, { name: f.name || basename(f.path) });
    if (f.description) a.setDescription(f.description);
    return a;
  });
}

function mapChannelType(type: number): ChannelMeta['type'] {
  switch (type) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return 'text';
    case ChannelType.GuildVoice:
      return 'voice';
    case ChannelType.GuildCategory:
      return 'category';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return 'thread';
    case ChannelType.GuildForum:
      return 'forum';
    default:
      return 'unknown';
  }
}
