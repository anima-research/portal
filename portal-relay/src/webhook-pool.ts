/**
 * Per-parent-channel webhook pool.
 *
 * One webhook per parent channel is enough (it serves the channel and every
 * thread under it via `threadId`). A pool of >1 is only for a *hot* channel:
 * extra webhooks are independent rate-limit buckets, so several personas can
 * burst in parallel. To keep each persona's own stream ordered, a persona is
 * pinned to one webhook (hash) and that webhook has a serial send queue.
 *
 * discord.js's REST manager already handles 429s/backoff; the per-webhook queue
 * here is purely for *ordering* within a webhook.
 */

import type { OutgoingFile } from '@animalabs/portal-protocol';

export interface WebhookSendOpts {
  threadId?: string;
  username: string;
  avatarURL: string;
  content?: string;
  files?: OutgoingFile[];
  /** Whether @everyone/@here and role mentions in content should ping. */
  allowMentions?: boolean;
}

/** Discord-side webhook operations, implemented by DiscordBot. */
export interface WebhookOps {
  /** Adopt our marked webhooks on the parent channel and create more until
   *  `count` exist; resolve their ids (stable across the process). */
  ensureWebhooks(parentChannelId: string, marker: string, count: number): Promise<string[]>;
  sendWebhook(webhookId: string, opts: WebhookSendOpts): Promise<{ messageId: string }>;
  editWebhookMessage(
    webhookId: string,
    messageId: string,
    content: string,
    threadId?: string,
  ): Promise<void>;
  deleteWebhookMessage(webhookId: string, messageId: string, threadId?: string): Promise<void>;
}

const MARKER = 'portal:relay';

interface ChannelPool {
  ids: string[];
  /** Per-webhook tail promise; new sends chain onto it for ordering. */
  tails: Map<string, Promise<unknown>>;
}

export class WebhookPool {
  private pools = new Map<string, ChannelPool>();
  private ensuring = new Map<string, Promise<ChannelPool>>();

  constructor(
    private ops: WebhookOps,
    private poolSize: number,
  ) {}

  private async ensurePool(parentChannelId: string): Promise<ChannelPool> {
    const existing = this.pools.get(parentChannelId);
    if (existing) return existing;
    const inFlight = this.ensuring.get(parentChannelId);
    if (inFlight) return inFlight;

    const p = (async () => {
      const ids = await this.ops.ensureWebhooks(parentChannelId, MARKER, this.poolSize);
      const pool: ChannelPool = { ids, tails: new Map() };
      this.pools.set(parentChannelId, pool);
      this.ensuring.delete(parentChannelId);
      return pool;
    })();
    this.ensuring.set(parentChannelId, p);
    return p;
  }

  private pick(pool: ChannelPool, personaId: string): string {
    const n = pool.ids.length;
    if (n === 1) return pool.ids[0];
    let h = 0;
    for (let i = 0; i < personaId.length; i++) h = (h * 31 + personaId.charCodeAt(i)) | 0;
    return pool.ids[Math.abs(h) % n];
  }

  /** The webhook id a persona uses in this parent channel (for edit/delete). */
  async webhookIdFor(parentChannelId: string, personaId: string): Promise<string> {
    const pool = await this.ensurePool(parentChannelId);
    return this.pick(pool, personaId);
  }

  /** Send, preserving per-webhook ordering. */
  async send(
    parentChannelId: string,
    personaId: string,
    opts: WebhookSendOpts,
  ): Promise<{ messageId: string; webhookId: string }> {
    const pool = await this.ensurePool(parentChannelId);
    const webhookId = this.pick(pool, personaId);
    const prev = pool.tails.get(webhookId) ?? Promise.resolve();
    const next = prev.then(
      () => this.ops.sendWebhook(webhookId, opts),
      () => this.ops.sendWebhook(webhookId, opts), // prior failure shouldn't block the queue
    );
    pool.tails.set(
      webhookId,
      next.catch(() => undefined),
    );
    const { messageId } = await next;
    return { messageId, webhookId };
  }

  /** Adopt a parent channel's webhooks into the cache. Needed before editing or
   *  deleting a *pre-restart* message whose webhook isn't loaded yet (C2). */
  async ensureLoaded(parentChannelId: string): Promise<void> {
    await this.ensurePool(parentChannelId);
  }

  async edit(webhookId: string, messageId: string, content: string, threadId?: string): Promise<void> {
    await this.ops.editWebhookMessage(webhookId, messageId, content, threadId);
  }

  async delete(webhookId: string, messageId: string, threadId?: string): Promise<void> {
    await this.ops.deleteWebhookMessage(webhookId, messageId, threadId);
  }

  static get marker(): string {
    return MARKER;
  }
}
