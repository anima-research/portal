/**
 * RelayMessageId ↔ Discord message bookkeeping.
 *
 * Relay ids are now **deterministic**: `rm_<container>_<discordMsgId>` where
 * `container` is the message's immediate channel (thread id when threaded, else
 * the channel id). Because Discord snowflakes are globally unique and the id is
 * a pure function of them:
 *   - ids are stable across relay restarts (no orphaning),
 *   - cursors decode to a snowflake without the in-memory store,
 *   - the container is recoverable from the id, so a post-restart edit/delete
 *     can re-fetch the message from Discord.
 *
 * Per-persona ownership (who sent a webhook message) is the one thing Discord
 * can't tell us back — all personas share a webhook. So we **persist a thin
 * attribution row** `{discordMsgId → {channelId, threadId, guildId, personaId,
 * webhookId}}` (RFC A6). Message *content* is never persisted — Discord is the
 * durable store; this is only the id/attribution mapping.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface MessageRef {
  relayId: string;
  /** Parent (non-thread) channel id — where the webhook lives. */
  channelId: string;
  /** Thread id when the message is in a thread. */
  threadId?: string;
  guildId: string | null;
  /** The Discord message snowflake. */
  discordMsgId: string;
  /** Set when this message was sent by one of our personas. */
  personaId?: string;
  /** Which pooled webhook (id) carried it — needed to edit/delete it. */
  webhookId?: string;
}

/** The message's immediate channel (where `messages.fetch(id)` lives). */
function containerOf(ref: { channelId: string; threadId?: string }): string {
  return ref.threadId ?? ref.channelId;
}

/** Deterministic relay id from the container channel + message snowflake. */
export function makeRelayId(containerChannelId: string, discordMsgId: string): string {
  return `rm_${containerChannelId}_${discordMsgId}`;
}

/** Decode a relay id back to its container channel + message snowflake.
 *  Returns null for anything not in `rm_<container>_<msg>` shape. */
export function parseRelayId(relayId: string): { channelId: string; discordMsgId: string } | null {
  if (!relayId.startsWith('rm_')) return null;
  const rest = relayId.slice(3);
  const us = rest.indexOf('_');
  if (us <= 0 || us >= rest.length - 1) return null;
  return { channelId: rest.slice(0, us), discordMsgId: rest.slice(us + 1) };
}

interface AttributionRow {
  channelId: string;
  threadId?: string;
  guildId: string | null;
  personaId?: string;
  webhookId?: string;
}

export class MessageStore {
  private byRelay = new Map<string, MessageRef>();
  private byDiscord = new Map<string, string>(); // discordMsgId → relayId
  private order: string[] = []; // relayIds, oldest first, for memory eviction
  private readonly cap: number;

  /** Persisted attribution for our own sent messages (survives restart). */
  private persisted = new Map<string, AttributionRow>(); // discordMsgId → row
  private readonly path?: string;
  private readonly persistCap: number;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: { path?: string; cap?: number; persistCap?: number } = {}) {
    this.cap = opts.cap ?? 50_000;
    this.path = opts.path;
    this.persistCap = opts.persistCap ?? 200_000;
    if (this.path) this.load();
  }

  record(ref: Omit<MessageRef, 'relayId'> & { relayId?: string }): MessageRef {
    const relayId = ref.relayId ?? makeRelayId(containerOf(ref), ref.discordMsgId);
    const existing = this.byRelay.get(relayId);
    if (existing) {
      // Upgrade with authoritative fields a prior (e.g. echo-derived) ref lacked.
      if (ref.personaId && !existing.personaId) existing.personaId = ref.personaId;
      if (ref.webhookId && !existing.webhookId) existing.webhookId = ref.webhookId;
      if (existing.personaId) this.persist(existing);
      return existing;
    }
    const full: MessageRef = { ...ref, relayId };
    this.byRelay.set(relayId, full);
    this.byDiscord.set(full.discordMsgId, relayId);
    this.order.push(relayId);
    this.evictIfNeeded();
    if (full.personaId) this.persist(full);
    return full;
  }

  getByRelayId(relayId: string): MessageRef | undefined {
    const hit = this.byRelay.get(relayId);
    if (hit) return hit;
    const parsed = parseRelayId(relayId);
    return parsed ? this.fromPersisted(parsed.discordMsgId) : undefined;
  }

  getByDiscordId(discordMsgId: string): MessageRef | undefined {
    const relayId = this.byDiscord.get(discordMsgId);
    if (relayId) return this.byRelay.get(relayId);
    return this.fromPersisted(discordMsgId);
  }

  /** Reconstruct (and hydrate) a ref from the persisted attribution map. */
  private fromPersisted(discordMsgId: string): MessageRef | undefined {
    const row = this.persisted.get(discordMsgId);
    if (!row) return undefined;
    const relayId = makeRelayId(row.threadId ?? row.channelId, discordMsgId);
    const ref: MessageRef = { relayId, discordMsgId, ...row };
    this.byRelay.set(relayId, ref);
    this.byDiscord.set(discordMsgId, relayId);
    this.order.push(relayId);
    this.evictIfNeeded();
    return ref;
  }

  /** Relay id for a Discord message, minting a bare ref if unseen. */
  ensureForDiscord(discordMsgId: string, derive: () => Omit<MessageRef, 'relayId'>): MessageRef {
    return this.getByDiscordId(discordMsgId) ?? this.record(derive());
  }

  remove(discordMsgId: string): void {
    const relayId = this.byDiscord.get(discordMsgId);
    if (relayId) {
      this.byDiscord.delete(discordMsgId);
      this.byRelay.delete(relayId);
    }
    if (this.persisted.delete(discordMsgId)) this.scheduleFlush();
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.cap) {
      const old = this.order.shift();
      if (!old) break;
      const ref = this.byRelay.get(old);
      // Only drop the in-memory copy; persisted attribution is the durable layer.
      if (ref && this.byDiscord.get(ref.discordMsgId) === old) this.byDiscord.delete(ref.discordMsgId);
      this.byRelay.delete(old);
    }
  }

  // ── Attribution persistence ──

  private persist(ref: MessageRef): void {
    if (!this.path) return;
    this.persisted.delete(ref.discordMsgId); // re-insert to refresh FIFO order
    this.persisted.set(ref.discordMsgId, {
      channelId: ref.channelId,
      threadId: ref.threadId,
      guildId: ref.guildId,
      personaId: ref.personaId,
      webhookId: ref.webhookId,
    });
    while (this.persisted.size > this.persistCap) {
      const oldest = this.persisted.keys().next().value;
      if (oldest === undefined) break;
      this.persisted.delete(oldest);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.path || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 500);
  }

  /** Synchronously write the attribution map (called on shutdown too). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.path) return;
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.persisted)));
    } catch (err) {
      console.error(`[portal-relay] attribution flush failed: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, AttributionRow>;
      this.persisted = new Map(Object.entries(raw));
      console.error(`[portal-relay] loaded ${this.persisted.size} attribution rows`);
    } catch {
      // missing/corrupt file → start empty
    }
  }
}
