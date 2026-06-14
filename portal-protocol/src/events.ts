import type { Capability, PortalChannel, PortalGuild } from './channel.js';
import type { ChannelId, GuildId, RelayMessageId, ThreadId } from './ids.js';
import type { MessageAuthor, PortalMessage, PortalReaction, ReactionActor } from './message.js';
import type { Persona } from './persona.js';

/** Why a message counts as addressed to the receiving session's persona. */
export type AddressReason = 'role_mention' | 'reply' | 'name_mention' | 'subscription' | 'dm';

/**
 * Per-recipient addressing annotation. The same canonical PortalMessage is
 * delivered to every session subscribed to its channel; this envelope is
 * computed individually for the receiving session so the MCPL layer can tell a
 * direct address (→ pending ping) from ambient subscription traffic.
 */
export interface AddressInfo {
  addressedToMe: boolean;
  reasons: AddressReason[];
}

/**
 * A dispatched event. Carried inside a `dispatch` server frame with a
 * monotonic `seq` so a resuming client can replay from where it left off.
 */
export type PortalEvent =
  | ({ type: 'message_create'; message: PortalMessage } & AddressInfo)
  | ({ type: 'message_update'; message: PortalMessage } & AddressInfo)
  | { type: 'message_delete'; channelId: ChannelId; threadId?: ThreadId; messageId: RelayMessageId }
  | {
      type: 'reaction_add';
      channelId: ChannelId;
      threadId?: ThreadId;
      messageId: RelayMessageId;
      reaction: PortalReaction;
    }
  | {
      type: 'reaction_remove';
      channelId: ChannelId;
      threadId?: ThreadId;
      messageId: RelayMessageId;
      emoji: string;
      actor: ReactionActor;
    }
  | { type: 'typing'; channelId: ChannelId; threadId?: ThreadId; author: MessageAuthor }
  /** A channel's pinned-message set changed; clients refetch via list_pins. */
  | { type: 'pins_update'; channelId: ChannelId; threadId?: ThreadId }
  | { type: 'channel_create'; channel: PortalChannel }
  | { type: 'channel_update'; channel: PortalChannel }
  | { type: 'channel_delete'; channelId: ChannelId; guildId: GuildId | null }
  | { type: 'thread_create'; channel: PortalChannel }
  | { type: 'thread_update'; channel: PortalChannel }
  | { type: 'thread_delete'; channelId: ThreadId; parentId: ChannelId; guildId: GuildId | null }
  | { type: 'guild_create'; guild: PortalGuild; channels: PortalChannel[] }
  | { type: 'guild_delete'; guildId: GuildId }
  /** A persona's identity changed (e.g. role rebinding after rotation). */
  | { type: 'persona_update'; persona: Persona }
  /** Effective capabilities in a channel changed for the receiving persona. */
  | { type: 'capabilities_update'; channelId: ChannelId; capabilities: Capability[] };

export type PortalEventType = PortalEvent['type'];
