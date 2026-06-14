/**
 * Agent-facing state: the durable "seen" watermark and the pending-ping queue.
 *
 * This is the *semantic* layer of "seen", distinct from the transport-level
 * resume cursor in portal-client. The resume cursor handles brief disconnects;
 * this tracks what the agent has actually processed, survives restarts (when
 * persisted — see toJSON/fromJSON), and drives "what's unread / who's waiting".
 *
 * ISO-8601 timestamps sort lexically, so string comparison is a valid ordering.
 */
import type { AddressReason, PortalMessage } from '@connectome/portal-protocol';

export interface PendingPing {
  message: PortalMessage;
  reasons: AddressReason[];
  /** When the relay delivered it (message.createdAt). */
  at: string;
}

export interface ChannelUnread {
  channelId: string;
  threadId?: string;
  count: number;
  lastAt?: string;
  lastPreview?: string;
}

interface SerializedState {
  watermarks: Record<string, string>;
  pings: PendingPing[];
}

const PREVIEW_LEN = 140;
const MAX_UNSEEN_PER_CHANNEL = 200;

export class AgentState {
  /** channelId → highest createdAt the agent has marked read. */
  private watermarks = new Map<string, string>();
  /** channelId → unseen messages (above the watermark), oldest first. */
  private unseen = new Map<string, PortalMessage[]>();
  private pings: PendingPing[] = [];

  /** Ingest a delivered message. Returns true if it created a new pending ping. */
  ingest(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): boolean {
    const key = message.channelId;
    const watermark = this.watermarks.get(key);
    if (watermark && message.createdAt <= watermark) return false; // already read

    const list = this.unseen.get(key) ?? [];
    list.push(message);
    if (list.length > MAX_UNSEEN_PER_CHANNEL) list.shift();
    this.unseen.set(key, list);

    if (addressedToMe) {
      this.pings.push({ message, reasons, at: message.createdAt });
      return true;
    }
    return false;
  }

  /** Advance the watermark for a channel (optionally only up to a message),
   *  clearing unseen + pending pings at/under that point. */
  markRead(channelId: string, uptoCreatedAt?: string): void {
    const list = this.unseen.get(channelId) ?? [];
    const cutoff = uptoCreatedAt ?? list[list.length - 1]?.createdAt ?? this.watermarks.get(channelId);
    if (!cutoff) return;
    const prev = this.watermarks.get(channelId);
    if (!prev || cutoff > prev) this.watermarks.set(channelId, cutoff);
    this.unseen.set(
      channelId,
      list.filter((m) => m.createdAt > cutoff),
    );
    this.pings = this.pings.filter((p) => p.message.channelId !== channelId || p.at > cutoff);
  }

  pendingPings(): PendingPing[] {
    return [...this.pings];
  }

  /** Remove a specific ping (e.g. once the agent replies to it). */
  clearPing(messageId: string): void {
    this.pings = this.pings.filter((p) => p.message.id !== messageId);
  }

  unreadByChannel(): ChannelUnread[] {
    const out: ChannelUnread[] = [];
    for (const [channelId, list] of this.unseen) {
      if (list.length === 0) continue;
      const last = list[list.length - 1];
      out.push({
        channelId,
        threadId: last.threadId,
        count: list.length,
        lastAt: last.createdAt,
        lastPreview: preview(last),
      });
    }
    return out;
  }

  unreadCount(channelId: string): number {
    return this.unseen.get(channelId)?.length ?? 0;
  }

  toJSON(): SerializedState {
    return { watermarks: Object.fromEntries(this.watermarks), pings: this.pings };
  }

  static fromJSON(data: SerializedState): AgentState {
    const s = new AgentState();
    s.watermarks = new Map(Object.entries(data.watermarks ?? {}));
    s.pings = data.pings ?? [];
    return s;
  }
}

function preview(m: PortalMessage): string {
  const who = m.author.kind === 'persona' ? m.author.displayName : m.author.kind === 'user' ? m.author.displayName : 'system';
  const body = (m.cleanContent || m.content || '').replace(/\s+/g, ' ').slice(0, PREVIEW_LEN);
  return `${who}: ${body}`;
}
