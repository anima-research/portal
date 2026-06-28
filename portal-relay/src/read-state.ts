/**
 * Durable per-persona read-state — the server-authoritative inbox.
 *
 * The relay sees every Discord message live and already computes per-persona
 * addressing. So instead of each agent re-scanning Discord history on reconnect
 * (the discord-mcpl approach), the relay accumulates, for EVERY known persona —
 * online or not:
 *   - pending pings: messages addressed to it (role mention / reply), stored in
 *     full (capped) so a reconnecting agent can act without a second fetch;
 *   - a compact per-channel ambient tally (counts + a preview), NOT bodies —
 *     Discord stays the durable store; `fetch_history` pulls bodies on demand.
 *
 * A watermark per (persona, channel) marks what's been read; `mark_read`
 * advances it and drops everything at/under it. Catch-up is then an O(missed)
 * read of this store, persisted across relay restarts.
 *
 * ISO-8601 timestamps sort lexically, so string comparison is valid ordering.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type {
  AddressReason,
  ChannelMissed,
  ChannelUnread,
  PendingPing,
  PortalMessage,
} from '@animalabs/portal-protocol';

/** Compact ambient tally for one channel — counts + a peek, never bodies. */
interface Tally {
  threadId?: string;
  messages: number;
  characters: number;
  lastAt: string;
  lastMessageId: string;
  lastPreview: string;
}

interface Inbox {
  /** channelId → highest createdAt the persona has marked read. */
  watermarks: Record<string, string>;
  /** Addressed messages not yet marked read (capped, newest-biased). */
  pings: PendingPing[];
  /** channelId → ambient tally above the watermark. */
  tallies: Record<string, Tally>;
}

export interface ReadStateOptions {
  /** Persist to this JSON path (debounced). Omit for in-memory only. */
  path?: string;
  /** Max pending pings retained per persona (oldest dropped). Default 500. */
  pingsCap?: number;
  /** Max channels with a live tally per persona (least-recent dropped). Default 1000. */
  channelsCap?: number;
  /** Max characters of preview stored per channel. Default 140. */
  previewLen?: number;
}

const PREVIEW_LEN = 140;

export class ReadStateStore {
  private inboxes = new Map<string, Inbox>();
  private readonly path?: string;
  private readonly pingsCap: number;
  private readonly channelsCap: number;
  private readonly previewLen: number;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: ReadStateOptions = {}) {
    this.path = opts.path;
    this.pingsCap = opts.pingsCap ?? 500;
    this.channelsCap = opts.channelsCap ?? 1000;
    this.previewLen = opts.previewLen ?? PREVIEW_LEN;
    if (this.path) this.load();
  }

  private inbox(personaId: string): Inbox {
    let ib = this.inboxes.get(personaId);
    if (!ib) {
      ib = { watermarks: {}, pings: [], tallies: {} };
      this.inboxes.set(personaId, ib);
    }
    return ib;
  }

  /**
   * Record a delivered message for a persona. `addressedToMe` messages also
   * queue a pending ping; every recorded message bumps the channel's ambient
   * tally (so unread reflects all unseen traffic, addressed or not). Messages
   * at/under the channel watermark are ignored (already read).
   */
  record(
    personaId: string,
    message: PortalMessage,
    addressedToMe: boolean,
    reasons: AddressReason[],
  ): void {
    const ib = this.inbox(personaId);
    const channelId = message.channelId;
    const watermark = ib.watermarks[channelId];
    if (watermark && message.createdAt <= watermark) return; // already read

    // Ambient tally (compact).
    const t = ib.tallies[channelId];
    const len = (message.cleanContent || message.content || '').length;
    if (t) {
      t.messages += 1;
      t.characters += len;
      t.lastAt = message.createdAt;
      t.lastMessageId = message.id;
      t.lastPreview = this.preview(message);
      if (message.threadId) t.threadId = message.threadId;
    } else {
      ib.tallies[channelId] = {
        threadId: message.threadId,
        messages: 1,
        characters: len,
        lastAt: message.createdAt,
        lastMessageId: message.id,
        lastPreview: this.preview(message),
      };
      this.evictChannels(ib);
    }

    // Pending ping (full message), deduped by id.
    if (addressedToMe && !ib.pings.some((p) => p.message.id === message.id)) {
      ib.pings.push({ message, reasons, at: message.createdAt });
      if (ib.pings.length > this.pingsCap) ib.pings.shift();
    }
    this.scheduleFlush();
  }

  /** Advance a channel's watermark, dropping pings/tally at or under the cutoff.
   *  `upto` (ISO) limits how far; omitted ⇒ read to the channel's latest. */
  markRead(personaId: string, channelId: string, upto?: string): void {
    const ib = this.inboxes.get(personaId);
    if (!ib) return;
    const cutoff = upto ?? ib.tallies[channelId]?.lastAt ?? ib.watermarks[channelId];
    if (!cutoff) return;
    const prev = ib.watermarks[channelId];
    if (!prev || cutoff > prev) ib.watermarks[channelId] = cutoff;
    // Bodies aren't stored, so a partial mark can't subtract precisely — clear
    // the tally and let the remainder re-accumulate from the new watermark.
    delete ib.tallies[channelId];
    ib.pings = ib.pings.filter((p) => p.message.channelId !== channelId || p.at > cutoff);
    this.scheduleFlush();
  }

  pendingPings(personaId: string): PendingPing[] {
    return [...(this.inboxes.get(personaId)?.pings ?? [])];
  }

  unread(personaId: string): ChannelUnread[] {
    const ib = this.inboxes.get(personaId);
    if (!ib) return [];
    const out: ChannelUnread[] = [];
    for (const [channelId, t] of Object.entries(ib.tallies)) {
      if (t.messages === 0) continue;
      out.push({
        channelId,
        threadId: t.threadId,
        count: t.messages,
        lastAt: t.lastAt,
        lastPreview: t.lastPreview,
      });
    }
    return out;
  }

  missed(personaId: string, channelId: string): ChannelMissed {
    const ib = this.inboxes.get(personaId);
    const t = ib?.tallies[channelId];
    if (!t) {
      return { channelId, messages: 0, characters: 0, since: ib?.watermarks[channelId] };
    }
    return {
      channelId,
      threadId: t.threadId,
      messages: t.messages,
      characters: t.characters,
      since: ib?.watermarks[channelId],
      lastAt: t.lastAt,
      lastMessageId: t.lastMessageId,
      lastPreview: t.lastPreview,
    };
  }

  /** Drop a persona's inbox entirely (e.g. identity removed). */
  forget(personaId: string): void {
    if (this.inboxes.delete(personaId)) this.scheduleFlush();
  }

  // ── Internals ──

  private evictChannels(ib: Inbox): void {
    const ids = Object.keys(ib.tallies);
    if (ids.length <= this.channelsCap) return;
    // Drop the least-recently-active channels until under cap.
    ids
      .sort((a, b) => (ib.tallies[a].lastAt < ib.tallies[b].lastAt ? -1 : 1))
      .slice(0, ids.length - this.channelsCap)
      .forEach((id) => delete ib.tallies[id]);
  }

  private preview(m: PortalMessage): string {
    const who =
      m.author.kind === 'persona'
        ? m.author.displayName
        : m.author.kind === 'user'
          ? m.author.displayName || m.author.username
          : 'system';
    const body = (m.cleanContent || m.content || '').replace(/\s+/g, ' ').slice(0, this.previewLen);
    return `${who}: ${body}`;
  }

  private scheduleFlush(): void {
    if (!this.path || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 500);
  }

  /** Synchronously persist (also called on shutdown). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.path) return;
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.inboxes)));
    } catch (err) {
      console.error(`[portal-relay] read-state flush failed: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Inbox>;
      this.inboxes = new Map(
        Object.entries(raw).map(([id, ib]) => [
          id,
          { watermarks: ib.watermarks ?? {}, pings: ib.pings ?? [], tallies: ib.tallies ?? {} },
        ]),
      );
      console.error(`[portal-relay] loaded read-state for ${this.inboxes.size} personas`);
    } catch {
      // missing/corrupt → start empty
    }
  }
}
