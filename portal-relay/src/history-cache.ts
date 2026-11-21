/**
 * Short-TTL LRU cache for fetch_history pages (RFC A5).
 *
 * Every fetch_history is live Discord REST against the ONE shared bot's ~50
 * req/s budget, now contended across all personas. A migrating bot that rebuilds
 * deep context frequently would dominate that bucket. This caches identical page
 * requests for a few seconds and invalidates a channel on any content change
 * (create/edit/delete), so repeated reads are correctness-neutral but cheap.
 */
import type { IncomingMessage } from './discord-bot.js';

interface Entry {
  messages: IncomingMessage[];
  at: number;
}

export interface HistoryPage {
  channelId: string;
  limit: number;
  before?: string;
  after?: string;
  forward?: boolean;
}

interface Read {
  overtaken: boolean;
}

export class HistoryCache {
  private map = new Map<string, Entry>();
  private reading = new Map<string, Set<Read>>();

  constructor(
    private ttlMs: number,
    private cap = 500,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  private key(page: HistoryPage): string {
    // `forward` is part of the key: the same (channel, limit, after) names
    // two different pages depending on the walk (portal#98), and serving one
    // as the other would silently hand a consumer the wrong end of history.
    return `${page.channelId}|${page.limit}|${page.before ?? ''}|${page.after ?? ''}|${page.forward ? 'f' : ''}`;
  }

  async read(page: HistoryPage, fetch: () => Promise<IncomingMessage[]>): Promise<IncomingMessage[]> {
    if (!this.enabled) return fetch();
    const k = this.key(page);
    const cached = this.lookup(k);
    if (cached) return cached;
    const read: Read = { overtaken: false };
    let reads = this.reading.get(page.channelId);
    if (!reads) this.reading.set(page.channelId, (reads = new Set()));
    reads.add(read);
    try {
      const messages = await fetch();
      if (!read.overtaken) this.store(k, messages);
      return messages;
    } finally {
      reads.delete(read);
      if (reads.size === 0) this.reading.delete(page.channelId);
    }
  }

  private lookup(k: string): IncomingMessage[] | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    // refresh LRU recency
    this.map.delete(k);
    this.map.set(k, e);
    return e.messages;
  }

  private store(k: string, messages: IncomingMessage[]): void {
    this.map.set(k, { messages, at: this.now() });
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop all cached pages for a channel (on any content change there). */
  invalidate(channelId: string): void {
    if (!this.enabled) return;
    for (const read of this.reading.get(channelId) ?? []) read.overtaken = true;
    const prefix = `${channelId}|`;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}
