import type { ChannelId, GuildId } from './ids.js';

export type ChannelType = 'text' | 'voice' | 'category' | 'thread' | 'forum' | 'unknown';

/**
 * A subset of Discord's permission model, expressed as relay capabilities.
 * The effective set a persona has in a channel is computed relay-side as
 * (relay policy ∩ what the underlying bot can actually do there), so a client
 * is never told it can do something Discord will 403.
 */
export type Capability =
  | 'VIEW_CHANNEL'
  | 'READ_HISTORY'
  | 'SEND_MESSAGES'
  | 'SEND_IN_THREADS'
  | 'CREATE_THREADS'
  | 'ATTACH_FILES'
  | 'ADD_REACTIONS'
  | 'MENTION_EVERYONE'
  | 'EDIT_OWN'
  | 'DELETE_OWN'
  /** Edit/delete messages authored by *other* personas/users. */
  | 'MANAGE_MESSAGES'
  | 'MANAGE_CHANNELS'
  /** Ask the relay to join this voice channel and transcribe it (voice_join). */
  | 'VOICE_LISTEN'
  /** Speak into this voice channel through the relay's grant-checked TTS
   *  output path (voice_speak). Distinct from VOICE_LISTEN: hearing a room
   *  and being audible in it are separate consents. */
  | 'VOICE_SPEAK';

export interface PortalChannel {
  id: ChannelId;
  /** Underlying Discord channel snowflake (correlation key). */
  native?: string;
  guildId: GuildId | null;
  /** Channel name (e.g. "general"). null for unnamed/uncached channels. */
  name: string | null;
  type: ChannelType;
  /**
   * For threads: the parent text/forum channel id. Webhooks live on the
   * parent; the relay posts into a thread by reusing the parent's webhook
   * with a thread id. For other channels: the category heading's id, when
   * one exists. A category the persona's listing includes (it has some
   * capability there) appears as its own entry (type "category"), so the
   * name is one join away; a filtered-out category leaves an honest
   * dangling id rather than an invented value — and for a persona whose
   * grants are all on individual text, voice or forum channels, EVERY
   * category id dangles (nothing flows up from a channel to its
   * category), so the join is best-effort by design.
   * Absent when there is no parent (top-level channels and the categories
   * themselves).
   */
  parentId?: ChannelId;
  /** For threads: whether currently archived (posting auto-unarchives). */
  archived?: boolean;
  /**
   * Effective capabilities the *requesting session's persona* has here.
   * Recomputed and re-pushed (capabilities_update) when policy or Discord
   * permissions change.
   */
  capabilities: Capability[];
}

export interface PortalGuild {
  id: GuildId;
  /** Underlying Discord guild snowflake (correlation key). */
  native?: string;
  name: string;
  memberCount?: number;
}
