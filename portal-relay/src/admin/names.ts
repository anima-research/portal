/**
 * Human names for the ids the admin panel shows (channels, Discord roles,
 * guilds, personas).
 *
 * The bot's gateway cache only holds live channels and ACTIVE threads, so a
 * grant on an archived thread (the common `/add`-run-in-a-thread case) or on a
 * since-deleted channel has no name there and the panel fell back to the raw
 * snowflake. {@link ChannelNameResolver} covers those with a REST lookup:
 * memoised, bounded concurrency, and a per-request deadline so a persona with
 * hundreds of thread grants can't stall the panel — whatever doesn't finish in
 * time comes back `pending` and keeps loading in the background, so the next
 * view has it.
 */
import type { ChannelMeta } from '../discord-bot.js';

/** What the panel needs to render one channel id as a name. */
export interface ChannelLabel {
  id: string;
  /** Channel/thread name; null when unknown (see the flags below). */
  name: string | null;
  type?: ChannelMeta['type'];
  guildId?: string | null;
  /** Threads: the parent channel, so a thread reads `#parent › thread`. */
  parentId?: string;
  parentName?: string | null;
  archived?: boolean;
  /** Discord says the channel doesn't exist (404) — or, with `hidden`, that
   *  the bot may not see it (403, e.g. a private thread it isn't in). */
  missing?: true;
  hidden?: true;
  /** Guild-scoped views only: deleted, hidden from the bot, or in another
   *  guild — deliberately not told apart, so a guild view can't be used to
   *  probe what the bot sees elsewhere. */
  unavailable?: true;
  /** The lookup didn't finish before the request deadline (or was deferred by
   *  the lookup budget, or hit a transient error); a reload shows it. */
  pending?: true;
}

/** A Discord role id rendered as its name + owning guild. */
export interface RoleLabel {
  name: string;
  guildId: string;
}

/** Name maps attached to admin API responses under `names`. Every map is
 *  keyed by id; a missing key means "no name known — show the id". */
export interface NameMaps {
  channels?: Record<string, ChannelLabel>;
  discordRoles?: Record<string, RoleLabel>;
  guilds?: Record<string, string>;
  personas?: Record<string, string>;
}

/** A REST lookup's answer: the channel, or why there is none. */
export type ChannelFetch = ChannelMeta | 'deleted' | 'hidden';

/** Where channel metadata comes from: the gateway cache, then Discord REST. */
export interface ChannelSource {
  /** Gateway-cache lookup — synchronous and free. */
  cached(id: string): ChannelMeta | null;
  /** REST lookup that must NOT add the result to the bot's cache (an archived
   *  thread pulled in here would otherwise start appearing in channel lists).
   *  Rejects on transient failures so they aren't remembered as gone. */
  fetch(id: string): Promise<ChannelFetch>;
}

export interface ChannelNameResolverOptions {
  /** Parallel REST lookups. */
  concurrency?: number;
  /** Sustained REST lookups per second, and the burst allowed above it. The
   *  lookups share the bot's REST budget with message delivery (50/s global)
   *  and 403s count toward Discord's invalid-request ban (10k / 10 min), so
   *  this stays well below both. */
  ratePerSec?: number;
  burst?: number;
  /** Lookups waiting to run; past this, ids answer `pending` without queueing. */
  maxQueued?: number;
  /** New lookups one resolve() call may start; the rest answer `pending`. */
  maxPerRequest?: number;
  /** How long one request waits for lookups before answering with `pending`. */
  deadlineMs?: number;
  /** How long a found name is reused before it is looked up again. */
  positiveTtlMs?: number;
  /** How long "deleted" / "hidden" is reused. */
  negativeTtlMs?: number;
  /** Memo size bound (oldest entries evicted first). */
  maxEntries?: number;
  now?: () => number;
}

/** What is known about an id: the answer, or undefined = not known (yet). */
type Found = ChannelFetch | undefined;

export class ChannelNameResolver {
  private readonly memo = new Map<string, { found: ChannelFetch; at: number }>();
  private readonly inflight = new Map<string, Promise<Found>>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private tokens: number;
  private lastRefill: number;
  private refillTimer?: ReturnType<typeof setTimeout>;
  private readonly concurrency: number;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly maxQueued: number;
  private readonly maxPerRequest: number;
  private readonly deadlineMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly source: ChannelSource, opts: ChannelNameResolverOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.ratePerSec = Math.max(0.1, opts.ratePerSec ?? 10);
    this.burst = Math.max(1, opts.burst ?? 10);
    this.maxQueued = Math.max(1, opts.maxQueued ?? 1000);
    this.maxPerRequest = Math.max(1, opts.maxPerRequest ?? 300);
    this.deadlineMs = opts.deadlineMs ?? 4000;
    this.positiveTtlMs = opts.positiveTtlMs ?? 60 * 60_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /**
   * Label every id. Cached channels answer immediately; the rest are fetched
   * (deduplicated against lookups already running, within the lookup budget)
   * until the deadline. Thread parents are resolved too, so threads carry
   * `parentName`.
   */
  async resolve(ids: Iterable<string>, opts: { deadlineMs?: number } = {}): Promise<Map<string, ChannelLabel>> {
    const deadline = this.now() + (opts.deadlineMs ?? this.deadlineMs);
    const wanted = [...new Set([...ids].filter((id) => typeof id === 'string' && id.length > 0))];
    // This call's own view: results stay readable here even if the memo
    // evicts them before we're done labelling.
    const got = new Map<string, Found>();
    const budget = { left: this.maxPerRequest };
    await this.settle(wanted, deadline, got, budget);
    // Second pass: parents of threads (nearly always cached — they're live channels).
    const parents = new Set<string>();
    for (const id of wanted) {
      const m = got.get(id);
      if (isMeta(m) && m.parentId) parents.add(m.parentId);
    }
    if (parents.size) await this.settle([...parents], deadline, got, budget);

    const out = new Map<string, ChannelLabel>();
    for (const id of wanted) out.set(id, labelOf(id, got));
    return out;
  }

  /** Cache first, then a fresh memo entry. */
  private known(id: string): Found {
    const c = this.source.cached(id);
    if (c) return c;
    const e = this.memo.get(id);
    if (!e) return undefined;
    const ttl = isMeta(e.found) ? this.positiveTtlMs : this.negativeTtlMs;
    if (this.now() - e.at > ttl) return undefined;
    return e.found;
  }

  /** Fill `got` for each id: what's known now, else a lookup awaited until
   *  `deadline` (a lookup still running then keeps going and lands in the memo). */
  private async settle(ids: string[], deadline: number, got: Map<string, Found>, budget: { left: number }): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      const k = this.known(id);
      got.set(id, k);
      if (k !== undefined) continue;
      const running = this.inflight.get(id);
      if (running) { waits.push(running.then((m) => { got.set(id, m); })); continue; }
      if (budget.left <= 0 || this.queue.length >= this.maxQueued) continue; // stays pending
      budget.left--;
      waits.push(this.lookup(id).then((m) => { got.set(id, m); }));
    }
    if (!waits.length) return;
    const remaining = deadline - this.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((r) => { timer = setTimeout(r, remaining); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Queue one REST lookup; it runs when a slot and a rate token are free. */
  private lookup(id: string): Promise<Found> {
    const p = new Promise<Found>((resolve) => {
      this.queue.push(() => {
        // Promise.resolve().then: a source that throws synchronously still
        // settles this lookup and frees its slot.
        Promise.resolve()
          .then(() => this.source.fetch(id))
          .then(
            (found) => { this.remember(id, found); resolve(found); },
            // Transient: not remembered, so the next view retries.
            () => resolve(undefined),
          )
          .finally(() => {
            this.inflight.delete(id);
            this.active--;
            this.pump();
          });
      });
    });
    this.inflight.set(id, p);
    this.pump();
    return p;
  }

  private pump(): void {
    this.refill();
    while (this.active < this.concurrency && this.queue.length && this.tokens >= 1) {
      this.tokens--;
      this.active++;
      this.queue.shift()!();
    }
    // Out of tokens with work waiting: come back when the next one accrues.
    if (this.queue.length && this.active < this.concurrency && this.tokens < 1 && !this.refillTimer) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      this.refillTimer = setTimeout(() => { this.refillTimer = undefined; this.pump(); }, waitMs);
      this.refillTimer.unref?.();
    }
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.lastRefill) / 1000) * this.ratePerSec);
    this.lastRefill = t;
  }

  private remember(id: string, found: ChannelFetch): void {
    this.memo.delete(id);
    this.memo.set(id, { found, at: this.now() });
    while (this.memo.size > this.maxEntries) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
  }
}

function isMeta(f: Found): f is ChannelMeta {
  return typeof f === 'object' && f !== null;
}

function labelOf(id: string, got: Map<string, Found>): ChannelLabel {
  const m = got.get(id);
  if (m === undefined) return { id, name: null, pending: true };
  if (m === 'hidden') return { id, name: null, missing: true, hidden: true };
  if (!isMeta(m)) return { id, name: null, missing: true };
  const label: ChannelLabel = { id, name: m.name, type: m.type, guildId: m.guildId };
  if (m.isThread) {
    label.archived = m.archived ?? false;
    if (m.parentId) {
      label.parentId = m.parentId;
      const p = got.get(m.parentId);
      label.parentName = isMeta(p) ? p.name : null;
    }
  }
  return label;
}

/**
 * Restrict labels to one guild for a guild-scoped admin view. A channel the
 * view can't confirm is in this guild — deleted, hidden from the bot, or in
 * another guild — becomes one opaque `unavailable` label: its name is
 * withheld, and the three cases are not told apart (that difference would
 * reveal what the bot can see in other servers). Pending labels pass through;
 * they carry nothing.
 */
export function clipToGuild(labels: Map<string, ChannelLabel>, guildId: string): Record<string, ChannelLabel> {
  const out: Record<string, ChannelLabel> = {};
  for (const [id, l] of labels) {
    const elsewhere = l.guildId != null && l.guildId !== guildId;
    out[id] = l.missing || elsewhere ? { id, name: null, unavailable: true } : l;
  }
  return out;
}
