import type { PortalChannel, PortalGuild } from './channel.js';
import type { ChannelId, GuildId, PersonaId, RelayMessageId, RpcId, ThreadId, UserId } from './ids.js';
import type { PortalMessage } from './message.js';
import type { PortalMember, PortalRole } from './members.js';

/** A file to upload, read from a local path on the host running the client. */
export interface OutgoingFile {
  path: string;
  name?: string;
  description?: string;
}

export interface SendMessageParams {
  channelId: ChannelId;
  /** Target a thread under `channelId`. The relay reuses the parent channel's
   *  webhook with this thread id. */
  threadId?: ThreadId;
  content?: string;
  files?: OutgoingFile[];
  /** Relay id of a message to reply to. For persona sends this degrades to a
   *  quoted jump-link (webhooks can't carry a native reply). */
  replyToId?: RelayMessageId;
  /** Personas to @-address. The relay resolves each to its bound role mention
   *  in the target guild, assigning a pooled role on demand if needed. */
  mentionPersonaIds?: PersonaId[];
}
export interface SendMessageResult {
  messageId: RelayMessageId;
}

export interface EditMessageParams {
  messageId: RelayMessageId;
  content: string;
}

export interface DeleteMessageParams {
  messageId: RelayMessageId;
}

export interface ReactParams {
  messageId: RelayMessageId;
  /** Unicode emoji or `name:id` for a custom emoji. */
  emoji: string;
  /**
   * true  → also drop a visible persona webhook line so humans see the
   *         reaction in Discord (+ record the structured pseudo-reaction).
   * false → record a structured pseudo-reaction only (clean channel; agents
   *         and a real UI still see it via reaction_add).
   */
  visible: boolean;
}

export interface UnreactParams {
  messageId: RelayMessageId;
  emoji: string;
}

export interface FetchHistoryParams {
  channelId: ChannelId;
  threadId?: ThreadId;
  limit?: number;
  /** Bounding cursors (exclusive). Each accepts **either** a RelayMessageId
   *  **or** a raw Discord snowflake — so a migrating bot can page using
   *  snowflakes it already persisted without first obtaining a relay id. */
  before?: RelayMessageId | string;
  after?: RelayMessageId | string;
}
export interface FetchHistoryResult {
  messages: PortalMessage[];
}

export interface ListGuildsResult {
  guilds: PortalGuild[];
}

export interface ListChannelsParams {
  guildId: GuildId;
}
export interface ListChannelsResult {
  channels: PortalChannel[];
}

export interface CreateThreadParams {
  channelId: ChannelId;
  name: string;
}
export interface CreateTextChannelParams {
  guildId: GuildId;
  name: string;
  categoryId?: ChannelId;
}
export interface ChannelResult {
  channel: PortalChannel;
}

export interface DeleteChannelParams {
  channelId: ChannelId;
}

export interface SetTypingParams {
  channelId: ChannelId;
  threadId?: ThreadId;
}

export interface SubscribeParams {
  channelId: ChannelId;
}
export interface ListSubscriptionsResult {
  channelIds: ChannelId[];
}

// ── Member / role reads + mention resolution (RFC A1/A2) ──

export interface ListMembersParams {
  guildId: GuildId;
  /** Case-insensitive substring filter over username/displayName/nickname. */
  query?: string;
  limit?: number;
}
export interface ListMembersResult {
  members: PortalMember[];
  /** false when the relay bot lacks the GuildMembers intent (results are then
   *  opportunistic/partial rather than the full roster). */
  membersAvailable: boolean;
}

export interface ResolveMentionsParams {
  guildId: GuildId;
  /** Bare handles (no leading @). */
  handles: string[];
}
export interface ResolveMentionsResult {
  /** handle → Discord user id, or null when unresolved/ambiguous. */
  resolved: Record<string, UserId | null>;
}

export interface ListRolesParams {
  guildId: GuildId;
}
export interface ListRolesResult {
  /** The guild's full role catalog. Always populated (roles arrive with the
   *  base Guilds intent — no privileged intent or availability flag needed). */
  roles: PortalRole[];
}

// ── Pinned messages (RFC A4) ──

export interface ListPinsParams {
  channelId: ChannelId;
}
export interface ListPinsResult {
  messages: PortalMessage[];
}

type Empty = Record<string, never>;

/**
 * The single source of truth for RPC: method name → { params, result }.
 * Both the relay handler table and the client method surface derive from this,
 * so adding a method in one place type-checks everywhere.
 */
export interface RpcMethods {
  send_message: { params: SendMessageParams; result: SendMessageResult };
  edit_message: { params: EditMessageParams; result: Empty };
  delete_message: { params: DeleteMessageParams; result: Empty };
  react: { params: ReactParams; result: Empty };
  unreact: { params: UnreactParams; result: Empty };
  fetch_history: { params: FetchHistoryParams; result: FetchHistoryResult };
  list_guilds: { params: Empty; result: ListGuildsResult };
  list_channels: { params: ListChannelsParams; result: ListChannelsResult };
  create_thread: { params: CreateThreadParams; result: ChannelResult };
  create_text_channel: { params: CreateTextChannelParams; result: ChannelResult };
  delete_channel: { params: DeleteChannelParams; result: Empty };
  set_typing: { params: SetTypingParams; result: Empty };
  subscribe_channel: { params: SubscribeParams; result: Empty };
  unsubscribe_channel: { params: SubscribeParams; result: Empty };
  list_subscriptions: { params: Empty; result: ListSubscriptionsResult };
  list_members: { params: ListMembersParams; result: ListMembersResult };
  resolve_mentions: { params: ResolveMentionsParams; result: ResolveMentionsResult };
  list_roles: { params: ListRolesParams; result: ListRolesResult };
  list_pins: { params: ListPinsParams; result: ListPinsResult };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: RpcId;
  method: M;
  params: RpcParams<M>;
}

export type RpcErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'RATE_LIMITED'
  | 'DISCORD_ERROR'
  | 'INTERNAL';

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { id: RpcId; ok: true; result: RpcResult<M> }
  | { id: RpcId; ok: false; error: RpcError };
