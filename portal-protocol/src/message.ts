import type {
  ChannelId,
  GuildId,
  PersonaId,
  RelayMessageId,
  RoleId,
  ThreadId,
  UserId,
} from './ids.js';

export interface PortalAttachment {
  id: string;
  name: string;
  /** Discord CDN URL (signed; expires). */
  url: string;
  contentType: string | null;
  size: number;
}

/**
 * Who authored a message.
 *  - persona: one of our agents, posted via a webhook (our side).
 *  - user:    an external Discord human or third-party bot.
 *  - system:  a relay-generated notice (e.g. a persona joined/left a channel).
 */
export type MessageAuthor =
  | { kind: 'persona'; personaId: PersonaId; displayName: string; avatarUrl: string }
  | { kind: 'user'; userId: UserId; username: string; displayName: string; bot: boolean }
  | { kind: 'system' };

export interface MessageMentions {
  /**
   * Personas addressed via their bound role mention — the primary routing
   * signal. The relay resolves mentioned role ids back to persona ids.
   */
  personas: PersonaId[];
  roles: RoleId[];
  users: UserId[];
  everyone: boolean;
}

/** native = a real Discord reaction; pseudo = a relay-tracked persona reaction
 *  (personas can't add native reactions). */
export type ReactionKind = 'native' | 'pseudo';

export interface ReactionActor {
  kind: 'persona' | 'user';
  /** PersonaId or UserId. */
  id: string;
  name: string;
}

export interface PortalReaction {
  /** Unicode emoji or `name:id` for a custom emoji. */
  emoji: string;
  count: number;
  kind: ReactionKind;
  /** Known reactors. Native reactions may carry only counts until fetched. */
  by: ReactionActor[];
}

export interface PortalMessage {
  id: RelayMessageId;
  /** The underlying Discord message snowflake — the documented correlation key
   *  for Discord URLs, audit logs, and a bot's own persisted state. Stable
   *  across relay restarts; `id` is derived from it. */
  nativeId: string;
  channelId: ChannelId;
  /** Present when the message lives in a thread. */
  threadId?: ThreadId;
  guildId: GuildId | null;
  author: MessageAuthor;
  /** Raw content (mentions encoded as <@id>, <@&roleId>, <#chanId>). */
  content: string;
  /** Mentions resolved to readable handles (@name, #channel, @role). */
  cleanContent: string;
  attachments: PortalAttachment[];
  mentions: MessageMentions;
  /** Relay id of the message this replies to, if any. */
  replyToId?: RelayMessageId;
  reactions: PortalReaction[];
  /** ISO-8601 strings — the wire carries no Date objects. */
  createdAt: string;
  editedAt?: string;
}
