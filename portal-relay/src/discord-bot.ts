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
  PermissionFlagsBits,
  ChannelType,
  MessageType,
  MessageFlags,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  type Interaction,
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
  type Role,
} from 'discord.js';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Capability } from '@animalabs/portal-protocol';
import { capsFromPerms } from './permissions.js';
import type { RoleOps } from './role-pool.js';
import type { WebhookOps, WebhookSendOpts } from './webhook-pool.js';
import { SLASH_COMMANDS, type AutocompleteRequest, type SlashChoice, type SlashInvocation } from './slash.js';

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

/** A reaction summary as carried on a fetched/converted message (counts only;
 *  reactor identities arrive via the live reaction_add/remove events). */
export interface IncomingReactionSummary {
  /** Unicode emoji or `name:id` for a custom emoji. */
  emoji: string;
  count: number;
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
  /** Native reaction summaries (emoji + count). Empty when none / not cached. */
  reactions: IncomingReactionSummary[];
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
  /** One-line snippet of the reacted-to message's text, or null when it has
   *  none (attachment/embed-only, or the message couldn't be resolved). */
  messageSnippet: string | null;
}

/** Cap for the reacted-to-message snippet carried on reaction events. */
const REACTION_SNIPPET_MAX = 80;

/** One-line snippet of a message body for reaction events: custom-emoji tokens
 *  rendered to ':name:', whitespace collapsed, capped. Null when there is no
 *  text (attachment/embed-only) — callers keep the id-only form then.
 *  (Emoji rendering is inlined here because snippets ride reaction events,
 *  which bypass the relay's cleanContent rendering in buildPortalMessage.) */
export function buildReactionSnippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = text
    .replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`)
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  return collapsed.length > REACTION_SNIPPET_MAX
    ? `${collapsed.slice(0, REACTION_SNIPPET_MAX - 1)}…`
    : collapsed;
}

/** The slice of a discord.js MessageSnapshot that forward rendering reads. */
interface ForwardSnapshot {
  content?: string | null;
  attachments?: { size: number } | null;
  embeds?: { length: number } | null;
}

/** Render a forwarded message's snapshots into visible text. Discord forwards
 *  carry their body in `messageSnapshots` (discord.js ≥14.16), not `content`,
 *  so without this a bare forward reaches the agent as an empty message.
 *  Attachment/embed-only snapshots get a bracketed note instead of silence.
 *  Snapshots have no `cleanContent`, so mention ids stay raw; custom-emoji
 *  tokens are rendered downstream (buildPortalMessage's cleanContent pass). */
export function buildForwardedContent(
  baseContent: string,
  snapshots: Iterable<ForwardSnapshot>,
): string {
  const parts: string[] = [];
  for (const snap of snapshots) {
    const text =
      typeof snap.content === 'string' && snap.content.trim().length > 0 ? snap.content : null;
    const attachmentCount = snap.attachments?.size ?? 0;
    const notes: string[] = [];
    if (attachmentCount > 0) {
      notes.push(`[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}]`);
    }
    if (!text && (snap.embeds?.length ?? 0) > 0) notes.push('[embed]');
    const body = [text, ...notes].filter(Boolean).join(' ');
    parts.push(`[forwarded message] ${body || '[no text content]'}`);
  }
  if (parts.length === 0) return baseContent;
  const forwarded = parts.join('\n');
  return baseContent.trim().length > 0 ? `${baseContent}\n${forwarded}` : forwarded;
}

/** Render a content-less Discord system message the way the human client
 *  does — from its type. The author of a system message is its subject
 *  (e.g. the joining member authors the UserJoin message), so downstream
 *  "Author: <text>" rendering reads naturally. Unknown/new types degrade to
 *  a generic marker with the numeric type rather than an empty string. */
export function systemMessageText(type: MessageType): string {
  switch (type) {
    case MessageType.UserJoin:
      return '[joined the server]';
    case MessageType.GuildBoost:
      return '[boosted the server]';
    case MessageType.GuildBoostTier1:
    case MessageType.GuildBoostTier2:
    case MessageType.GuildBoostTier3:
      return '[boosted the server to a new tier]';
    case MessageType.ChannelPinnedMessage:
      return '[pinned a message to this channel]';
    case MessageType.ChannelFollowAdd:
      return '[followed a channel into this one]';
    case MessageType.RecipientAdd:
      return '[added someone to the group]';
    case MessageType.RecipientRemove:
      return '[removed someone from the group]';
    case MessageType.ChannelNameChange:
      return '[changed the channel name]';
    case MessageType.ThreadCreated:
      return '[started a thread]';
    case MessageType.AutoModerationAction:
      return '[automod action]';
    default:
      return `[system message: type ${type}]`;
  }
}

/** Resolve a message's visible body: `cleanContent` when populated (raw
 *  content otherwise — partial channels can leave it empty), with forwarded
 *  snapshots rendered in and content-less system messages synthesized from
 *  their type. Shared by every path through convert() — live, edits, history,
 *  pins — so forwards/system messages can't regress to empty on any of them.
 *  Note: unlike discord-mcpl, Reply is excluded from the system-message gate —
 *  an attachment-only reply is a user message, not a system affordance. */
export function resolveVisibleContent(m: {
  content?: string | null;
  cleanContent?: string | null;
  type?: MessageType | null;
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
}): string {
  const base =
    typeof m.cleanContent === 'string' && m.cleanContent.length > 0
      ? m.cleanContent
      : (m.content ?? '');
  const withForwards =
    m.messageSnapshots && m.messageSnapshots.size > 0
      ? buildForwardedContent(base, m.messageSnapshots.values())
      : base;
  // Discord SYSTEM messages (member joins, boosts, pins…) carry no content —
  // the Discord client renders them from the type. Forwarding them raw gave
  // the agent literally empty messages ("Bob: "). Synthesize the same
  // affordance the human client shows.
  if (
    withForwards.length === 0 &&
    m.type != null &&
    m.type !== MessageType.Default &&
    m.type !== MessageType.Reply
  ) {
    return systemMessageText(m.type);
  }
  return withForwards;
}

export interface MemberInfo {
  userId: string;
  username: string;
  displayName: string;
  nickname: string | null;
  bot: boolean;
  roles: string[];
}

/** A custom (server) emoji from the bot's guild cache. */
export interface EmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  guildId: string;
  guildName: string | null;
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
  /** A channel or thread appeared or changed. `kind` preserves Discord's
   *  create/update distinction so the relay can dispatch the matching wire
   *  event (clients upsert either way; the semantics are for the protocol). */
  channelChange?: (channel: ChannelMeta, kind: 'create' | 'update') => void;
  channelDelete?: (channelId: string, guildId: string | null) => void;
  /** A role's guild-level perms changed, or a role was created/deleted (RFC-004
   *  mirror invalidation). `roleId === @everyone` ⇒ guild-wide baseline shift. */
  roleChange?: (guildId: string, roleId: string) => void;
  /** A slash command was invoked (already normalized; reply is sent ephemeral). */
  slashCommand?: (inv: SlashInvocation) => string;
  /** An autocomplete keystroke on a slash-command option. */
  slashAutocomplete?: (req: AutocompleteRequest) => SlashChoice[];
};

const MAX_ATTACH = 10;

export class DiscordBot implements WebhookOps, RoleOps {
  private client: Client;
  private handlers: Handlers = {};
  private webhookCache = new Map<string, Webhook>(); // webhookId → Webhook

  private guildMembersIntent: boolean;
  private maxInlineTotalBytes: number;
  private allowPathFiles: boolean;

  constructor(
    private token: string,
    /** Live guild allow-list accessor: null = allow all (legacy env mode);
     *  string[] = explicit list, empty = deny all. Read on every check so
     *  runtime edits (admin panel / hot-reload) apply without a reconnect. */
    private allowedGuilds: () => string[] | null,
    opts: { guildMembersIntent?: boolean; maxInlineTotalBytes?: number; allowPathFiles?: boolean } = {},
  ) {
    this.maxInlineTotalBytes = opts.maxInlineTotalBytes ?? 8 * 1024 * 1024;
    this.allowPathFiles = opts.allowPathFiles ?? false;
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
      // Non-privileged. Populates guild.emojis for list_emojis and keeps the
      // custom-emoji cache fresh (emojiCreate/Update/Delete).
      GatewayIntentBits.GuildEmojisAndStickers,
      // Non-privileged. Required for voice: joinVoiceChannel needs the voice
      // state cache to complete its handshake. Harmless when voice is unused.
      GatewayIntentBits.GuildVoiceStates,
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

  /** The underlying discord.js client, for subsystems that need gateway-adjacent
   *  state discord.js doesn't expose through this facade (voice adapters). */
  get rawClient(): Client {
    return this.client;
  }

  private guildAllowed(guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    const list = this.allowedGuilds();
    return list === null || list.includes(guildId);
  }

  /** Public live allow-check (relay gates capability resolution on it). */
  isGuildAllowed(guildId: string): boolean {
    return this.guildAllowed(guildId);
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
    const files = buildAttachments(opts.files, {
      maxTotalBytes: this.maxInlineTotalBytes,
      allowPath: this.allowPathFiles,
    });
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

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    // Never-throw, per RoleOps ("must resolve even if already gone"): callers
    // fire-and-forget from cleanup paths, and a kicked guild / transient API
    // error must not surface as an unhandled rejection.
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (role) await role.delete().catch(() => {}); // already gone → fine
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

  /** Bot-level (moderation) delete of ANY message — needs the bot to hold
   *  Manage Messages in the channel. Used for deleting non-persona messages
   *  (e.g. a user's command) when the persona has the MANAGE_MESSAGES capability. */
  async deleteAnyMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) throw new Error(`Channel ${channelId} not found`);
    await (channel as TextChannel).messages.delete(messageId);
  }

  // ── Reactions (native, from the bot) ──

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) throw new Error(`Channel ${channelId} not found`);
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(this.resolveReactionEmoji(emoji, msg.guild));
  }

  /** Remove the shared bot's OWN native reaction from a message. (A native
   *  reaction belongs to the bot user; there is one per emoji regardless of how
   *  many personas "reacted", so this removes it for all of them.) No-op if the
   *  bot has no such reaction. */
  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) throw new Error(`Channel ${channelId} not found`);
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const resolved = this.resolveReactionEmoji(emoji, msg.guild);
    const selfId = this.client.user?.id;
    if (!selfId) return;
    // Match the reaction bucket by resolved identifier (custom) or unicode name.
    const reaction = msg.reactions.cache.find((r) => {
      const id = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : (r.emoji.name ?? '');
      return id === resolved || r.emoji.name === resolved;
    });
    if (reaction) await reaction.users.remove(selfId).catch(() => {});
  }

  /** Turn a caller-supplied emoji into something discord.js `.react()` accepts.
   *  Unicode chars and the full custom forms ('<:name:id>', 'name:id') pass
   *  through untouched; a bare ':name:' or 'name' is resolved to a cached custom
   *  emoji's 'name:id' identifier (a bare name is not resolvable by discord.js).
   *  Falls back to the input unchanged (treated as unicode) when nothing
   *  matches. Mirrors discord-mcpl's resolver. */
  private resolveReactionEmoji(emoji: string, guild: Guild | null): string {
    const trimmed = emoji.trim();
    if (/^<a?:\w+:\d+>$/.test(trimmed) || /^\w+:\d+$/.test(trimmed)) return trimmed;
    const bare = trimmed.replace(/^:+|:+$/g, '');
    if (/^\w{2,}$/.test(bare)) {
      const found =
        guild?.emojis.cache.find((e) => e.name === bare) ??
        this.client.emojis.cache.find((e) => e.name === bare);
      if (found) return found.identifier;
    }
    return trimmed;
  }

  // ── Queries ──

  listGuilds(): Array<{ id: string; name: string; memberCount: number }> {
    return [...this.client.guilds.cache.values()]
      .filter((g) => this.guildAllowed(g.id))
      .map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
  }

  /** EVERY joined guild (the cache holds all of them regardless of the
   *  allow-list) with the live allowed flag — feeds the admin allow-list
   *  editor's "joined but not allowed" picker. */
  listAllGuilds(): Array<{ id: string; name: string; memberCount: number; allowed: boolean }> {
    return [...this.client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
      allowed: this.guildAllowed(g.id),
    }));
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

  /** The custom (server) emojis the bot can see — the shared palette for both
   *  message content and reactions. Omit `guildId` to span all allowed guilds.
   *  Reads the warm gateway cache (GuildEmojisAndStickers intent); best-effort
   *  fetch when a guild's cache is cold. */
  async listEmojis(guildId?: string): Promise<EmojiInfo[]> {
    const guilds: Guild[] = [];
    if (guildId) {
      if (!this.guildAllowed(guildId)) return [];
      const g = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
      if (g) guilds.push(g);
    } else {
      guilds.push(...[...this.client.guilds.cache.values()].filter((g) => this.guildAllowed(g.id)));
    }
    const out: EmojiInfo[] = [];
    for (const g of guilds) {
      let emojis = g.emojis.cache;
      if (emojis.size === 0) emojis = await g.emojis.fetch().catch(() => emojis);
      for (const e of emojis.values()) {
        if (!e.name) continue;
        out.push({ id: e.id, name: e.name, animated: e.animated ?? false, guildId: g.id, guildName: g.name });
      }
    }
    return out;
  }

  /** Per-channel portal caps the given Discord role holds (RFC-004 mirror
   *  scopes). Keys = channels the role can VIEW; values = the caps its
   *  permission bits support there (post-overwrite), for full-fidelity
   *  `mirrorCaps` mirroring. Reads the warm gateway cache, so it's cheap on a
   *  resolve miss. Unknown guild/role → empty map (deny). */
  roleCapsByChannel(guildId: string, roleId: string): Map<string, Set<Capability>> {
    const out = new Map<string, Set<Capability>>();
    const guild = this.client.guilds.cache.get(guildId);
    const role = guild?.roles.cache.get(roleId);
    if (!guild || !role) return out;
    for (const ch of guild.channels.cache.values()) {
      const perms = ch.permissionsFor(role);
      if (!perms.has(PermissionsBitField.Flags.ViewChannel)) continue;
      out.set(ch.id, capsFromPerms(perms));
    }
    return out;
  }

  /** Channel ids the given Discord role can VIEW (RFC-004 mirrorRole scope). */
  channelsVisibleToRole(guildId: string, roleId: string): Set<string> {
    return new Set(this.roleCapsByChannel(guildId, roleId).keys());
  }

  /** The @everyone role id for a guild (its baseline visibility role). */
  everyoneRoleId(guildId: string): string | undefined {
    return this.client.guilds.cache.get(guildId)?.roles.everyone.id;
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

  // ── Slash commands ──

  /**
   * (Re)register the admin slash commands for allowed+joined guilds (or one
   * guild). Registered with Manage-Server default visibility — that hides them
   * from non-admins; the authoritative gate is server-side in SlashHandler.
   * No-op unless a slashCommand handler is wired (relay opts in).
   */
  async syncSlashCommands(guildId?: string): Promise<void> {
    if (!this.handlers.slashCommand) return;
    const app = this.client.application;
    if (!app) return;
    const data = SLASH_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description,
      // Guild-scoped commands can't run in DMs, so no dmPermission field (it's
      // a global-command concept and some API paths reject it on guild sets).
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      options: c.options.map((o) => ({
        type: ApplicationCommandOptionType.String as const,
        name: o.name,
        description: o.description,
        required: o.required ?? false,
        autocomplete: o.autocomplete ?? false,
        ...(o.choices ? { choices: o.choices.map((v) => ({ name: v, value: v })) } : {}),
      })),
    }));
    const gids = guildId
      ? [guildId]
      : [...this.client.guilds.cache.keys()].filter((id) => this.guildAllowed(id));
    for (const gid of gids) {
      if (!this.guildAllowed(gid) || !this.client.guilds.cache.has(gid)) continue;
      try {
        await app.commands.set(data, gid);
      } catch (err) {
        console.error(`[discord-bot] slash registration failed (${gid}):`, (err as Error).message);
      }
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      const handler = this.handlers.slashAutocomplete;
      if (!handler || !interaction.guildId) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused(true);
      const options: Record<string, string | undefined> = {};
      for (const o of interaction.options.data) {
        if (typeof o.value === 'string') options[o.name] = o.value;
      }
      const choices = handler({
        command: interaction.commandName,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        invoker: {
          id: interaction.user.id,
          name: interaction.user.username,
          hasManageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        },
        option: focused.name,
        partial: String(focused.value ?? ''),
        options,
      });
      await interaction.respond(choices.slice(0, 25));
      return;
    }
    if (interaction.isChatInputCommand()) {
      const handler = this.handlers.slashCommand;
      if (!handler || !interaction.guildId || !interaction.channelId) return;
      const options: Record<string, string | undefined> = {};
      for (const o of interaction.options.data) {
        if (o.value !== undefined) options[o.name] = String(o.value);
      }
      const channel = interaction.channel;
      const channelName =
        channel && 'name' in channel && channel.name ? channel.name : interaction.channelId;
      // Defer BEFORE running the handler: /list-style commands can walk
      // personas × mirror caches, and the raw-reply window is only 3s —
      // deferring first (the await yields, letting the ACK go out) buys 15
      // minutes for the synchronous work below.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const content = handler({
        command: interaction.commandName,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        channelName,
        invoker: {
          id: interaction.user.id,
          name: interaction.user.username,
          hasManageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        },
        options,
      });
      // Ephemeral, chunked on line boundaries under Discord's 2000-char limit.
      // Mentions never parse — option values echo into replies.
      const chunks = splitContent(content, 1990);
      await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
      for (const extra of chunks.slice(1)) {
        await interaction.followUp({
          content: extra,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    }
  }

  // ── Wiring ──

  private wire(): void {
    this.client.on('ready', () => {
      this.handlers.ready?.();
      if (this.guildMembersIntent) {
        for (const g of this.client.guilds.cache.values()) void this.warmMembers(g);
      }
      void this.syncSlashCommands().catch((err) =>
        console.error('[discord-bot] slash registration:', (err as Error).message),
      );
    });

    this.client.on('interactionCreate', (interaction) => {
      void this.onInteraction(interaction).catch((err) =>
        console.error('[discord-bot] interaction:', (err as Error).message),
      );
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
      void this.syncSlashCommands(g.id).catch((err) =>
        console.error('[discord-bot] slash registration:', (err as Error).message),
      );
      this.handlers.guildCreate?.(g.id, g.name, this.listChannelMetas(g.id));
    });

    this.client.on('channelCreate', (c) => {
      if ('guildId' in c && this.guildAllowed(c.guildId)) {
        this.handlers.channelChange?.(this.metaOf(c as GuildBasedChannel), 'create');
      }
    });
    this.client.on('channelUpdate', (_o, c) => {
      if ('guildId' in c && this.guildAllowed((c as GuildBasedChannel).guildId)) {
        this.handlers.channelChange?.(this.metaOf(c as GuildBasedChannel), 'update');
      }
    });
    this.client.on('channelDelete', (c) => {
      // Allow-list gate matches create/update above — without it every delete
      // in a bot-joined-but-non-allowed guild would burn a slot in every
      // persona's bounded resume buffer.
      if ('guildId' in c && this.guildAllowed(c.guildId)) {
        this.handlers.channelDelete?.(c.id, (c as GuildBasedChannel).guildId ?? null);
      }
    });

    this.client.on('threadCreate', (t) => {
      if (this.guildAllowed(t.guildId)) this.handlers.channelChange?.(this.metaOf(t as unknown as GuildBasedChannel), 'create');
    });
    this.client.on('threadUpdate', (_o, t) => {
      if (this.guildAllowed(t.guildId)) this.handlers.channelChange?.(this.metaOf(t as unknown as GuildBasedChannel), 'update');
    });
    this.client.on('threadDelete', (t) => {
      if (this.guildAllowed(t.guildId)) this.handlers.channelDelete?.(t.id, t.guildId ?? null);
    });

    // Role events ride the base Guilds intent (already requested) — no new intent.
    // They feed mirrorRole scope invalidation (RFC-004 §5.5).
    const onRole = (r: Role) => {
      if (this.guildAllowed(r.guild.id)) this.handlers.roleChange?.(r.guild.id, r.id);
    };
    this.client.on('roleCreate', onRole);
    this.client.on('roleDelete', onRole);
    this.client.on('roleUpdate', (oldR, newR) => {
      // Position-only reorders don't affect channel visibility — skip them.
      if (oldR.permissions.bitfield === newR.permissions.bitfield) return;
      onRole(newR);
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
    // The reacted-to message can itself be partial (uncached history); fetch it
    // so the event can carry a content snippet — an id alone is meaningless to
    // the agent. Best-effort: unresolvable → null snippet.
    const resolvedMsg = msg.partial ? await msg.fetch().catch(() => null) : msg;
    const snippetSource = resolvedMsg
      ? ((resolvedMsg as { cleanContent?: string | null }).cleanContent ?? resolvedMsg.content)
      : null;
    const evt: IncomingReaction = {
      messageId: msg.id,
      channelId: parentChannelId,
      threadId: isThread ? channel.id : undefined,
      guildId: msg.guildId ?? null,
      emoji,
      userId: user.id,
      userName: user.username ?? '',
      isBot: !!user.bot,
      messageSnippet: buildReactionSnippet(snippetSource),
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
    const author = msg.author as User;
    // A forward's reference points at its ORIGIN message (reference.type =
    // Forward); only a real reply (type Default = 0) should read as reply-to —
    // else a forwarded persona message reads as a reply and can falsely WAKE
    // that persona through the relay's `reply` address reason.
    const refType = (msg.reference as { type?: number } | null)?.type ?? 0;
    return {
      id: msg.id,
      content: msg.content ?? '',
      // cleanContent fallback + forwarded snapshots + system-message synthesis,
      // shared by live/edit/history/pins since they all pass through convert().
      cleanContent: resolveVisibleContent(msg),
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
      replyToId: refType === 0 ? (msg.reference?.messageId ?? undefined) : undefined,
      replyToUserId: msg.mentions?.repliedUser?.id ?? null,
      attachments:
        [...(msg.attachments?.values() ?? [])].map((a) => ({
          id: a.id,
          name: a.name ?? a.id,
          url: a.url,
          contentType: a.contentType ?? null,
          size: a.size ?? 0,
        })) ?? [],
      reactions: [...(msg.reactions?.cache?.values() ?? [])].map((r) => ({
        emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : (r.emoji.name ?? '?'),
        count: r.count ?? 0,
      })),
      timestamp: msg.createdAt ?? new Date(),
    };
  }
}

/** An error that surfaces to the client as INVALID_PARAMS (not INTERNAL). */
function invalidFile(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'INVALID_PARAMS' });
}

/**
 * Turn OutgoingFile[] into discord.js attachments. Inline `bytes` (base64) is
 * the primary path; filesystem `path` is gated behind `allowPath` (default off
 * — it lets a client read the relay host's disk). `maxTotalBytes` bounds the
 * decoded total *per message* (matches Discord's per-message upload cap and
 * keeps the WS frame + memory bounded).
 */
export function buildAttachments(
  files: WebhookSendOpts['files'],
  limits: { maxTotalBytes: number; allowPath: boolean },
): AttachmentBuilder[] {
  if (!files?.length) return [];
  if (files.length > MAX_ATTACH) throw invalidFile(`Too many files (max ${MAX_ATTACH})`);
  let total = 0;
  const charge = (n: number) => {
    total += n;
    if (total > limits.maxTotalBytes) {
      throw invalidFile(`attachments exceed ${limits.maxTotalBytes} bytes total`);
    }
  };
  return files.map((f) => {
    if (!f || (f.bytes == null) === (f.path == null)) {
      throw invalidFile('each file needs exactly one of `bytes` or `path`');
    }
    if (f.bytes != null) {
      if (!f.name) throw invalidFile('inline (bytes) file requires a `name`');
      const buf = Buffer.from(f.bytes, 'base64');
      charge(buf.length);
      const a = new AttachmentBuilder(buf, { name: f.name });
      if (f.description) a.setDescription(f.description);
      return a;
    }
    // path-based — disclosure vector, off by default
    if (!limits.allowPath) throw invalidFile('path-based files are disabled on this relay (use `bytes`)');
    if (!existsSync(f.path!) || !statSync(f.path!).isFile()) throw invalidFile(`File not found: ${f.path}`);
    charge(statSync(f.path!).size);
    const a = new AttachmentBuilder(f.path!, { name: f.name || basename(f.path!) });
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

/** Split reply content into ≤max-char chunks, preferring line boundaries. */
export function splitContent(content: string, max: number): string[] {
  if (!content) return ['(empty)'];
  const chunks: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // A single oversized line hard-wraps.
    let rest = line;
    while (rest.length > max) {
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ['(empty)'];
}
