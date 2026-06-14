/**
 * Id type aliases. These are plain strings at runtime; the aliases document
 * intent at call sites. Discord-native ids are snowflakes; relay-minted ids
 * are opaque.
 */

/** A Discord snowflake (guild, channel, user, role, message, …). */
export type Snowflake = string;

export type GuildId = Snowflake;
/** A channel id. For a thread this is the thread's own id; its parent text/
 *  forum channel is carried separately (see `PortalChannel.parentId`). */
export type ChannelId = Snowflake;
export type ThreadId = Snowflake;
export type RoleId = Snowflake;
export type UserId = Snowflake;
export type DiscordMessageId = Snowflake;

/**
 * Relay-internal, stable message id handed to clients. Abstracts the Discord
 * snowflake (+ which webhook/thread carried it) behind one opaque token, and
 * lets non-Discord surfaces (e.g. future web DMs) mint ids in the same space.
 * Clients address edit/delete/react/reply by this, never by a raw snowflake.
 */
export type RelayMessageId = string;

/** Stable id for an agent identity — the thing that posts via a webhook persona. */
export type PersonaId = string;

/** A single live client connection. One persona may hold many simultaneously
 *  (events fan out to all; RPC is accepted from any). */
export type SessionId = string;

/** Correlates an RPC request with its response. Client-generated, unique per session. */
export type RpcId = string;
