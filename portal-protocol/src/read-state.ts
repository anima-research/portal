/**
 * Server-authoritative read-state (catch-up / unread / pending pings).
 *
 * Because the relay is a single always-connected bot that already computes
 * per-persona addressing (see `AddressInfo`), it can durably accumulate, for
 * EVERY persona — online or not — the messages addressed to it and a compact
 * tally of ambient traffic per channel. A reconnecting agent then asks for its
 * inbox directly (an O(missed) read) instead of re-scanning Discord history.
 *
 * These are the shapes carried by the read-state RPC methods. The mcpl layer
 * surfaces them as the `get_pending_pings` / `list_unread` / `channel_missed`
 * tools; `mark_read` advances the server watermark.
 */
import type { ChannelId, RelayMessageId, ThreadId } from './ids.js';
import type { AddressReason } from './events.js';
import type { PortalMessage } from './message.js';

/** A message addressed to the persona (role mention / reply / dm) that has not
 *  yet been marked read. The full message rides along so a reconnecting agent
 *  can act without a second fetch. */
export interface PendingPing {
  message: PortalMessage;
  reasons: AddressReason[];
  /** When the message was created (message.createdAt) — the ordering key. */
  at: string;
}

/** Per-channel unread summary (counts + a peek), not the message bodies. Fetch
 *  the actual messages with `fetch_history` when the agent wants to read them. */
export interface ChannelUnread {
  channelId: ChannelId;
  threadId?: ThreadId;
  /** Unread messages above the persona's watermark. */
  count: number;
  /** createdAt of the most recent unread message. */
  lastAt?: string;
  /** "author: text" preview of the most recent unread message. */
  lastPreview?: string;
}

/** Ambient traffic missed in one channel since the persona's watermark — the
 *  portal analogue of discord-mcpl's `channel_missed` tally. Counts only; the
 *  relay never stores ambient bodies (Discord remains the durable store). */
export interface ChannelMissed {
  channelId: ChannelId;
  threadId?: ThreadId;
  /** Number of ambient (non-addressed) messages missed. */
  messages: number;
  /** Total characters across those messages (a cheap "how much did I miss"). */
  characters: number;
  /** Watermark the tally is measured from (ISO-8601), if any. */
  since?: string;
  /** createdAt of the most recent missed message. */
  lastAt?: string;
  /** Relay id of the most recent missed message — a cursor for fetch_around. */
  lastMessageId?: RelayMessageId;
  /** "author: text" preview of the most recent missed message. */
  lastPreview?: string;
  /** createdAt of the OLDEST missed message — where the tally started. With
   *  no `since` (the persona never marked this channel read), this is the
   *  lower bound of what it missed: older history was never unread. */
  firstAt?: string;
  /** Threads under this channel with missed replies (their messages are part
   *  of `messages`, but a read of the channel's own history doesn't include
   *  them — fetch each with fetch_history's `threadId`). Always present from a
   *  relay that tracks threads (empty when none); absent from an older relay. */
  threads?: ThreadMissed[];
  /** More threads had missed replies than the relay tracks per channel; the
   *  `threads` list is incomplete. */
  threadsTruncated?: boolean;
}

/** One thread's share of a channel's missed tally. */
export interface ThreadMissed {
  threadId: ThreadId;
  messages: number;
  /** createdAt of the thread's oldest missed message. */
  firstAt?: string;
  /** createdAt of the thread's most recent missed message. */
  lastAt: string;
}

// ── RPC param/result shapes ──

export interface GetPendingPingsResult {
  pings: PendingPing[];
}

export interface ListUnreadResult {
  channels: ChannelUnread[];
}

export interface MarkReadParams {
  channelId: ChannelId;
  threadId?: ThreadId;
  /** Mark read only up to this createdAt (ISO-8601). Omit to mark read to now. */
  uptoCreatedAt?: string;
  /** With `uptoCreatedAt` short of the latest unread: how many of the unread
   *  messages this mark covers, so the relay keeps an accurate count of what
   *  is left (it stores no bodies to count from). Without it, a partial mark
   *  keeps the previous count. */
  count?: number;
  /** The watermark `count` was counted from. The relay subtracts `count` only
   *  while its own watermark is still exactly this — so a repeated mark, or one
   *  overlapping another session's, never charges the same messages twice. */
  since?: string;
  /** Leave pending pings in place: advance the watermark for ambient traffic
   *  without acknowledging addressed messages the agent hasn't handled. */
  keepPings?: boolean;
}

export interface ChannelMissedParams {
  channelId: ChannelId;
}
