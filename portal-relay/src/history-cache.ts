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

export class HistoryCache {
  private map = new Map<string, Entry>();

  constructor(
    private ttlMs: number,
    private cap = 500,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  private key(channelId: string, limit: number, before?: string, after?: string): string {
    return `${channelId}|${limit}|${before ?? ''}|${after ?? ''}`;
  }

  get(channelId: string, limit: number, before?: string, after?: string): IncomingMessage[] | undefined {
    if (!this.enabled) return undefined;
    const k = this.key(channelId, limit, before, after);
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

  set(channelId: string, limit: number, before: string | undefined, after: string | undefined, messages: IncomingMessage[]): void {
    if (!this.enabled) return;
    this.map.set(this.key(channelId, limit, before, after), { messages, at: this.now() });
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop all cached pages for a channel (on any content change there). */
  invalidate(channelId: string): void {
    if (!this.enabled) return;
    const prefix = `${channelId}|`;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}
