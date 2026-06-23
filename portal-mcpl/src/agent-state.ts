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
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';

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
  /** Channels this agent ambiently subscribes to (durable, survives restarts). */
  subscriptions?: string[];
}

const PREVIEW_LEN = 140;
const MAX_UNSEEN_PER_CHANNEL = 200;

export class AgentState {
  /** channelId → highest createdAt the agent has marked read. */
  private watermarks = new Map<string, string>();
  /** channelId → unseen messages (above the watermark), oldest first. */
  private unseen = new Map<string, PortalMessage[]>();
  private pings: PendingPing[] = [];
  /** Channels this agent ambiently subscribes to. Durable agent state — the
   *  source of truth for what the relay session should be subscribed to. */
  private subscriptions = new Set<string>();
  private listeners: Array<() => void> = [];

  /** Notify on any persistence-relevant change (watermark / ping / subscription). */
  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }
  private emitChange(): void {
    for (const cb of this.listeners) cb();
  }

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
      this.emitChange();
      return true;
    }
    return false;
  }

  // ── Subscriptions (durable) ──

  /** Returns true if this changed the set. */
  subscribe(channelId: string): boolean {
    if (this.subscriptions.has(channelId)) return false;
    this.subscriptions.add(channelId);
    this.emitChange();
    return true;
  }

  /** Returns true if this changed the set. */
  unsubscribe(channelId: string): boolean {
    if (!this.subscriptions.delete(channelId)) return false;
    this.emitChange();
    return true;
  }

  subscriptionList(): string[] {
    return [...this.subscriptions];
  }

  isSubscribed(channelId: string): boolean {
    return this.subscriptions.has(channelId);
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
    this.emitChange();
  }

  pendingPings(): PendingPing[] {
    return [...this.pings];
  }

  /** Remove a specific ping (e.g. once the agent replies to it). */
  clearPing(messageId: string): void {
    this.pings = this.pings.filter((p) => p.message.id !== messageId);
    this.emitChange();
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

  /** Flush all unseen messages (oldest first across channels), advancing
   *  watermarks and clearing pending pings. Used to fold accumulated ambient
   *  context into a single wake instead of one wake per message. */
  drainUnread(): PortalMessage[] {
    const all: PortalMessage[] = [];
    for (const [channelId, list] of this.unseen) {
      if (list.length === 0) continue;
      all.push(...list);
      const latest = list[list.length - 1].createdAt;
      const prev = this.watermarks.get(channelId);
      if (!prev || latest > prev) this.watermarks.set(channelId, latest);
    }
    this.unseen.clear();
    this.pings = [];
    all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    if (all.length) this.emitChange();
    return all;
  }

  toJSON(): SerializedState {
    return {
      watermarks: Object.fromEntries(this.watermarks),
      pings: this.pings,
      subscriptions: [...this.subscriptions],
    };
  }

  static fromJSON(data: SerializedState): AgentState {
    const s = new AgentState();
    s.watermarks = new Map(Object.entries(data.watermarks ?? {}));
    s.pings = data.pings ?? [];
    s.subscriptions = new Set(data.subscriptions ?? []);
    return s;
  }
}

function preview(m: PortalMessage): string {
  const who = m.author.kind === 'persona' ? m.author.displayName : m.author.kind === 'user' ? m.author.displayName : 'system';
  const body = (m.cleanContent || m.content || '').replace(/\s+/g, ' ').slice(0, PREVIEW_LEN);
  return `${who}: ${body}`;
}
