/**
 * Claude Code "channel" binding for portal.
 *
 * Claude Code channels are plain MCP servers that (a) declare the
 * `experimental['claude/channel']` capability and (b) push inbound events via a
 * `notifications/claude/channel` JSON-RPC notification, which Claude Code injects
 * into the running session as a <channel …> block — waking inference on external
 * signals. The server also exposes ordinary MCP tools that Claude calls back
 * through (here: send/reply/react/etc. → portal RPC).
 *
 * This is the same PortalClient + PortalAgent stack as the MCPL server
 * (server.ts), but speaks the Claude Code channel dialect instead of MCPL's
 * push/event + channels/* methods. The win: a new Claude Code instance gets a
 * push-driven Discord channel through the one shared relay bot — no Discord bot
 * token of its own.
 *
 * Ref: https://code.claude.com/docs/en/channels (+ channels-reference).
 */
import {
  McplConnection,
  textContent,
  type ContentBlock,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from '@animalabs/mcpl-core';
import type { PortalClient } from '@animalabs/portal-client';
import type { ChannelUnread, PortalMessage } from '@animalabs/portal-protocol';
import type { PortalAgent } from './agent.js';
import type { WakeSink } from './wake-sink.js';
import { IDENTITY_TOOL_FEATURE_SETS, identityToolDefinitions, type IdentityToolHandler } from './identity.js';

/** Claude Code's channel push notification method. */
const CHANNEL_NOTIFY = 'notifications/claude/channel';

export class PortalCcChannelServer {
  private conn: McplConnection | null = null;
  /** Channels we've already backfilled history for (first-contact context). */
  private seeded = new Set<string>();
  /** Per persona: ping message ids already surfaced as a wake (live or
   *  catch-up), so a reconnect doesn't re-wake for the same offline-accrued
   *  pings. Keyed by persona because the session's context does not change on
   *  an identity switch — A→B→A must not re-deliver A's pings. */
  private wokenByPersona = new Map<string, Set<string>>();
  private get wokenPings(): Set<string> {
    let set = this.wokenByPersona.get(this.client.personaId);
    if (!set) this.wokenByPersona.set(this.client.personaId, (set = new Set()));
    return set;
  }
  /** Max messages to prepend per wake; older are truncated (scroll back via
   *  fetch_history). Configurable via PORTAL_CONTEXT_CAP (default 80). */
  private readonly contextCap = Math.max(1, Number(process.env.PORTAL_CONTEXT_CAP ?? '80') || 80);

  constructor(
    private client: PortalClient,
    private agent: PortalAgent,
    /** Where wakes go. Default: Claude Code's channel notification. A sink
     *  (see wake-sink.ts) lets a host without channel push — codex — be woken
     *  from here, where the relay already delivers this persona's mentions. */
    private readonly opts: {
      wakeSink?: WakeSink;
      /** Attach to expose list/mint/switch_identity (see identity.ts). */
      identity?: IdentityToolHandler;
    } = {},
  ) {}

  /** Unsubscribers for the listeners on the CURRENT client (see swapSession). */
  private unwire: Array<() => void> = [];
  /** Wakes run one at a time: each folds the relay's missed tallies and then
   *  advances watermarks, so two overlapping wakes would fold the same
   *  backlog twice. */
  private wakeChain: Promise<void> = Promise.resolve();

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.wireClient();
    await this.handleInitialize();

    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request);
        else this.handleNotification(msg.notification);
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') {
        console.error('[portal-cc] connection error:', (err as Error).message);
      }
    }
    this.conn = null;
  }

  // ── Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      conn.close();
      return;
    }
    // Advertise the Claude Code channel capability alongside tools.
    const result = {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      serverInfo: { name: 'portal-cc-channel', version: '0.1.0' },
    };
    conn.sendResponse(msg.request.id, result);

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      console.error('[portal-cc] initialized (Claude Code channel)');
    }
  }

  // ── Requests ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list':
          conn.sendResponse(req.id, {
            tools: this.opts.identity ? [...this.agent.tools, ...identityToolDefinitions] : this.agent.tools,
          });
          break;
        case 'tools/call': {
          const toolName = params.name as string;
          const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
          // Identity tools act on the session itself, above the swappable agent.
          const out =
            this.opts.identity && toolName in IDENTITY_TOOL_FEATURE_SETS
              ? await this.opts.identity.handleToolCall(toolName, toolArgs)
              : await this.agent.handleToolCall(toolName, toolArgs);
          conn.sendResponse(req.id, { content: [textContent(stringify(out))] });
          break;
        }
        default:
          conn.sendError(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      const e = err as Error;
      if (req.method === 'tools/call') {
        conn.sendResponse(req.id, { content: [textContent(`Error: ${e.message}`)], isError: true });
      } else {
        conn.sendError(req.id, -32000, e.message);
      }
    }
  }

  private handleNotification(_n: JsonRpcNotification): void {
    /* nothing to consume from Claude Code yet */
  }

  // ── Portal inbound → Claude Code channel notification ──

  private wireClient(): void {
    for (const off of this.unwire) off();
    this.unwire = [];
    this.unwire.push(this.client.on('message', (e) => {
      if (e.addressedToMe) this.wokenPings.add(e.message.id); // live wake covers it
      if (process.env.PORTAL_DEBUG) {
        console.error(
          `[portal-cc] recv ch=${e.message.channelId} addressed=${e.addressedToMe} ` +
            `reasons=[${e.reasons.join(',')}] subs=[${this.agent.state.subscriptionList().join(',')}] ` +
            `→ ${e.addressedToMe ? 'WAKE' : 'accrue-ambient'}`,
        );
      }
      void this.pushMessage(e.message, e.addressedToMe, e.reasons).catch((err) =>
        console.error('[portal-cc] push failed:', (err as Error).message),
      );
    }));
    // On a fresh identify (reconnect after a gap, or first connect), the relay
    // holds any pings that arrived while we were away. Surface them as a single
    // catch-up wake — O(missed) from the relay, no Discord history scan.
    this.unwire.push(this.client.on('ready', () => {
      void this.catchUp().catch((err) =>
        console.error('[portal-cc] catch-up failed:', (err as Error).message),
      );
    }));
  }

  /**
   * Replace the live (client, agent) pair with another identity's.
   *
   * Contract: `client` is already connected and `ready` (the identity manager
   * only swaps after `connect()` resolves); the caller closes the old client.
   *
   * This binding has no host-side channel registry, so there is nothing to
   * retract. What does carry over is the set of channels being FOLLOWED: a
   * Claude Code session that switches persona is still the same session, and
   * silently going deaf to the rooms it was in would be a surprise. They are
   * added to the new identity's durable subscriptions wherever it can see the
   * channel. `seeded` is kept for the same reason — it records what is already
   * in this session's context, which the switch did not change. Woken-ping
   * sets are per persona, so pings the new identity accrued while inactive
   * arrive as one catch-up, and switching back does not re-deliver.
   *
   * Runs on the wake chain: a wake queued before the swap completes against
   * the client and agent it was queued for, never against the next persona's.
   */
  swapSession(client: PortalClient, agent: PortalAgent): Promise<void> {
    return this.serialized(async () => this.swapNow(client, agent));
  }

  private swapNow(client: PortalClient, agent: PortalAgent): void {
    const following = this.agent.state.subscriptionList();
    this.client = client;
    this.agent = agent;
    this.wireClient(); // detaches the outgoing client's listeners first

    const visible = new Set(client.cache.allChannels().map((channel) => channel.id));
    for (const channelId of following) {
      // subscribe() is false when already followed — identify replayed those.
      if (!visible.has(channelId) || !agent.state.subscribe(channelId)) continue;
      void client.subscribe(channelId).catch((err) =>
        console.error(`[portal-cc] failed to follow ${channelId} under the new identity:`, (err as Error).message),
      );
    }
    // The new client's `ready` fired before we were listening.
    void this.catchUp().catch((err) =>
      console.error('[portal-cc] catch-up failed:', (err as Error).message),
    );
  }

  /** Wake once for pings accrued while offline (server-authoritative). Ambient
   *  traffic missed in followed channels rides along as context — it never
   *  wakes on its own, but it must not be lost either (see collectMissed). */
  private catchUp(): Promise<void> {
    return this.serialized(async () => {
      if (!this.conn) return;
      const pings = await this.agent.pendingPingsFromRelay();
      const fresh = pings.filter((p) => !this.wokenPings.has(p.message.id));
      if (fresh.length === 0) return;
      for (const p of fresh) this.wokenPings.add(p.message.id);
      fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

      const pingIds = new Set(fresh.map((p) => p.message.id));
      const pingChannels = new Set(fresh.map((p) => p.message.channelId));
      const missed = await this.collectMissed();
      // Pings first (newest win if even they overflow), then folded backlog
      // in whatever room is left — trimmed at its NEWEST end, so what a
      // channel shows is always a prefix of its unseen and its watermark can
      // follow safely.
      const { messages: base, omitted } = this.capped(dedupeById(fresh.map((p) => p.message)));
      const all = [...base, ...foldWithin(missed, this.contextCap - base.length)].sort(byCreatedAt);

      const lines = [`[catch-up] ${fresh.length} message(s) addressed to you while you were away` +
        (missed.length ? `, plus what you missed in ${missed.length} followed channel(s):` : ':')];
      lines.push(this.buildContent(all, pingIds, omitted, (p) => {
        const why = fresh.find((f) => f.message.id === p.id)?.reasons ?? [];
        return why.length ? ` (${why.join(',')})` : '';
      }));
      lines.push(...this.remainingNotes(missed, all));
      lines.push('\n[use fetch_history / fetch_around to read surrounding context, then mark_read]');

      const latest = fresh[fresh.length - 1].message;
      const meta: Record<string, string> = {
        source: 'discord',
        channelId: latest.channelId,
        author: authorLabel(latest),
        messageId: latest.id,
        addressed: 'true',
        catchup: 'true',
      };
      if (process.env.PORTAL_DEBUG) {
        console.error(`[portal-cc] CATCH-UP wake: ${fresh.length} missed ping(s), ${missed.length} channel(s) of ambient`);
      }
      this.deliverWake(lines.join('\n'), meta, [...pingIds], () =>
        this.settleFolded(missed, pingChannels, all),
      );
    });
  }

  /**
   * What the relay says this persona missed in the channels it FOLLOWS, with
   * bodies, OLDEST FIRST. The relay's read-state is server-authoritative and
   * survives everything this process does not: a restart (every new Claude
   * Code session is a fresh cc-cli with an empty in-memory backlog), a
   * non-resumable reconnect, an identity switch. Before this, all of that
   * ambient traffic silently vanished — a catch-up wake carried only the pings.
   *
   * The relay keeps tallies, not bodies (Discord is the durable store), and
   * its fetch_history pages newest-first (`after` is only a stop), so each
   * followed channel with unread is paged back to its watermark and the
   * oldest unseen messages come first: what a wake can't fit stays unread for
   * the next one rather than being skipped. A channel with more missed than
   * FOLD_BOUND is not paged at all — it gets a note and keeps its watermark —
   * because folding the newest slice and advancing past the rest is exactly
   * the loss this exists to prevent.
   *
   * Restricted to followed channels on purpose: the relay tallies every
   * channel the persona can VIEW, which for a guild-wide role is the whole
   * guild. Best-effort per channel (no READ_HISTORY ⇒ skipped).
   */
  private async collectMissed(): Promise<FoldedChannel[]> {
    const followed = new Set(this.agent.state.subscriptionList());
    if (followed.size === 0) return [];
    let unread: ChannelUnread[];
    try {
      ({ channels: unread } = await this.client.call('list_unread', {}));
    } catch {
      return [];
    }
    const out: FoldedChannel[] = [];
    for (const u of unread) {
      if (!followed.has(u.channelId) || u.count <= 0) continue;
      try {
        const missed = await this.client.call('channel_missed', { channelId: u.channelId });
        const upto = missed.lastAt ?? u.lastAt;
        if (!upto) continue;
        // Cut at whichever watermark is further along: the relay's, or the
        // local one — settleFolded advances the relay's asynchronously, so a
        // wake landing right behind another must not re-fold the same backlog.
        const local = this.agent.state.watermark(u.channelId);
        const since = [missed.since, local].filter((w): w is string => !!w).sort().pop();
        if (missed.messages > FOLD_BOUND) {
          out.push({ channelId: u.channelId, messages: [], tooMany: missed.messages });
          continue;
        }
        // Page back from the newest until the page reaches the watermark (the
        // relay's `after` stops the page there too), bounded by FOLD_BOUND.
        const fresh: PortalMessage[] = [];
        let before: string | undefined;
        let reachedWatermark = !since;
        while (fresh.length < FOLD_BOUND) {
          const { messages } = await this.client.fetchHistory({
            channelId: u.channelId,
            limit: FOLD_PAGE,
            ...(before ? { before } : {}),
            ...(since ? { after: sinceCursor(since) } : {}),
          });
          if (messages.length === 0) { reachedWatermark = true; break; }
          const page = [...messages].sort(byCreatedAt);
          fresh.unshift(...page.filter((m) => (!since || m.createdAt > since) && m.createdAt <= upto));
          if (since && page[0].createdAt <= since) { reachedWatermark = true; break; }
          if (messages.length < FOLD_PAGE) { reachedWatermark = true; break; }
          before = page[0].id;
        }
        if (!reachedWatermark) {
          // The bound was hit before the watermark: the oldest fetched is not
          // the oldest unseen, so folding would skip what lies beneath. Note it
          // and leave the watermark where it is.
          out.push({ channelId: u.channelId, messages: [], tooMany: missed.messages });
          continue;
        }
        const ordered = dedupeById(fresh).sort(byCreatedAt);
        if (ordered.length) out.push({ channelId: u.channelId, messages: ordered, remaining: 0 });
      } catch (err) {
        if (process.env.PORTAL_DEBUG) {
          console.error(`[portal-cc] could not fold missed traffic for ${u.channelId}:`, (err as Error).message);
        }
      }
    }
    return out;
  }

  /** Lines telling the agent what a wake could not carry, per channel. */
  private remainingNotes(folded: FoldedChannel[], delivered: PortalMessage[]): string[] {
    const notes: string[] = [];
    for (const f of folded) {
      const label = this.channelLabel(f.channelId);
      if (f.tooMany !== undefined) {
        notes.push(`[${f.tooMany} message(s) missed in ${label} — more than a wake folds; use channel_missed / fetch_history there, then mark_read]`);
        continue;
      }
      const left = f.remaining ?? 0;
      if (left > 0) notes.push(`[${left} more unread message(s) in ${label} will fold into your next wake]`);
    }
    return notes;
  }

  /**
   * After a wake carrying folded backlog was delivered: the agent has now SEEN
   * it, so advance the watermarks (server + local) for the folded channels —
   * otherwise the next wake folds the same messages again. Channels that
   * carried a ping are left alone: their watermark is the agent's to advance
   * with mark_read once it has actually handled the ping, so a turn that dies
   * mid-way keeps the ping pending on the relay.
   */
  private settleFolded(folded: FoldedChannel[], keep: Set<string>, delivered: PortalMessage[]): void {
    for (const f of folded) {
      if (keep.has(f.channelId) || f.tooMany !== undefined) continue;
      // Only as far as what the wake actually carried — never the relay's
      // `lastAt`, which may be past messages the cap trimmed off.
      const shown = delivered.filter((m) => m.channelId === f.channelId);
      if (shown.length === 0) continue;
      const upto = shown[shown.length - 1].createdAt;
      this.agent.state.markRead(f.channelId, upto);
      void this.client.call('mark_read', { channelId: f.channelId, uptoCreatedAt: upto }).catch((err) =>
        console.error(`[portal-cc] mark_read after fold failed for ${f.channelId}:`, (err as Error).message),
      );
    }
  }

  private serialized(fn: () => Promise<void>): Promise<void> {
    const run = this.wakeChain.then(fn, fn);
    this.wakeChain = run.catch(() => {});
    return run;
  }

  /** Newest `contextCap` messages win; the rest are counted for the note. */
  private capped(messages: PortalMessage[]): { messages: PortalMessage[]; omitted: number } {
    const sorted = [...messages].sort(byCreatedAt);
    if (sorted.length <= this.contextCap) return { messages: sorted, omitted: 0 };
    return { messages: sorted.slice(sorted.length - this.contextCap), omitted: sorted.length - this.contextCap };
  }

  /** Hand a wake to the host. Claude Code: channel notification. A configured
   *  sink: its own transport, asynchronously — on failure the pings are
   *  un-marked so a later catch-up (next reconnect) can surface them again; the
   *  relay holds them as pending regardless. */
  private deliverWake(
    content: string,
    meta: Record<string, string>,
    pingIds: string[],
    onDelivered?: () => void,
  ): void {
    const sink = this.opts.wakeSink;
    if (!sink) {
      if (!this.conn) return;
      this.conn.sendNotification(CHANNEL_NOTIFY, { content, meta });
      onDelivered?.();
      return;
    }
    sink.deliver({ content, meta }).then(
      () => {
        if (process.env.PORTAL_DEBUG) console.error(`[portal-cc] wake delivered via ${sink.kind} (${meta.channelId})`);
        onDelivered?.();
      },
      (err: Error) => {
        for (const id of pingIds) this.wokenPings.delete(id);
        console.error(`[portal-cc] wake via ${sink.kind} failed: ${err.message}`);
      },
    );
  }

  /**
   * Only an *addressed* message (mention/reply) wakes Claude Code. Ambient
   * messages accumulate in unread (ingested by PortalAgent) and are folded into
   * the next wake as prepended context — so the agent sees non-mention traffic
   * without a wake per message and without spending a turn on a fetch tool.
   *
   * The prepended context is capped at `contextCap` (most recent wins); on first
   * contact with a channel we backfill recent history so the first ping carries
   * real prior context, not just whatever arrived since connect.
   */
  private pushMessage(message: PortalMessage, addressedToMe: boolean, reasons: string[]): Promise<void> {
    if (!this.conn) return Promise.resolve();
    if (!addressedToMe) return Promise.resolve(); // ambient: surfaced as context on the next wake
    return this.serialized(() => this.wake(message, reasons));
  }

  private async wake(message: PortalMessage, reasons: string[]): Promise<void> {
    if (!this.conn) return;
    const channelId = message.channelId;

    // What the relay says we missed in followed channels (survives restarts),
    // then everything unseen that arrived live (includes this message).
    const missed = await this.collectMissed();
    const drained = this.agent.state.drainUnread();

    // First contact with this channel → backfill recent history for context.
    let triggerCtx = drained.filter((m) => m.channelId === channelId);
    if (!this.seeded.has(channelId)) {
      this.seeded.add(channelId);
      try {
        const hist = await this.client.fetchHistory({ channelId, limit: this.contextCap });
        triggerCtx = dedupeById([...hist.messages, ...triggerCtx]);
      } catch {
        /* best-effort backfill */
      }
    }

    // Combine missed + other channels' unread + this channel's context,
    // time-ordered, capped.
    const others = drained.filter((m) => m.channelId !== channelId);
    // Live context (other channels' unseen, this channel's backfill, the
    // trigger) is capped newest-wins; the relay backlog then fills what is
    // left, trimmed at its NEWEST end so each folded channel shows a prefix of
    // its unseen and its watermark can follow safely (see foldWithin).
    const { messages: base, omitted } = this.capped(dedupeById([...others, ...triggerCtx, message]));
    const all = [...base, ...foldWithin(missed, this.contextCap - base.length)].sort(byCreatedAt);
    const notes = this.remainingNotes(missed, all);

    const meta: Record<string, string> = {
      source: 'discord',
      channelId,
      author: authorLabel(message),
      messageId: message.id,
      addressed: 'true',
    };
    if (message.threadId) meta.threadId = message.threadId;
    if (message.guildId) meta.guildId = message.guildId;
    if (reasons.length) meta.reasons = reasons.join(',');

    if (process.env.PORTAL_DEBUG) {
      console.error(
        `[portal-cc] WAKE ch=${channelId} contextMsgs=${all.length} omitted=${omitted} ` +
          `(relay backlog ${missed.length} ch + live backlog + trigger)`,
      );
    }
    const body = [this.buildContent(all, new Set([message.id]), omitted), ...notes].join('\n');
    this.deliverWake(body, meta, [message.id], () => this.settleFolded(missed, new Set([channelId]), all));
  }

  /** Render the wake payload: optional truncation note, channel-labeled lines,
   *  with the addressed message(s) marked. */
  private buildContent(
    messages: PortalMessage[],
    addressed: Set<string>,
    omitted: number,
    suffix: (m: PortalMessage) => string = () => '',
  ): string {
    const lines: string[] = [];
    if (omitted > 0) {
      lines.push(`[${omitted} earlier message(s) omitted — use fetch_history to scroll back]`);
    }
    let lastChannel = '';
    for (const m of messages) {
      const label = this.channelLabel(m.channelId);
      if (label !== lastChannel) {
        lines.push(`\n— ${label} —`);
        lastChannel = label;
      }
      const line = render(m);
      lines.push(addressed.has(m.id) ? `» ${line}${suffix(m)}   ⟵ addressed to you` : line);
    }
    return lines.join('\n');
  }

  private channelLabel(channelId: string): string {
    const name = this.client.cache.getChannel(channelId)?.name;
    return name ? `#${name}` : channelId;
  }
}

/** One followed channel's folded backlog (oldest first), or why it wasn't folded. */
interface FoldedChannel {
  channelId: string;
  messages: PortalMessage[];
  /** Unseen messages newer than the last one here — they fold next time. */
  remaining?: number;
  /** Set when the channel was NOT folded: more missed than FOLD_BOUND. */
  tooMany?: number;
}

/**
 * Fit folded backlog into `budget` messages: channels in order, each taking
 * from its OLDEST; whatever doesn't fit is trimmed from the newest end and
 * counted in `remaining` (it is still unread on the relay and folds next
 * time). Mutates the entries so settle/notes see what was actually shown.
 */
function foldWithin(folded: FoldedChannel[], budget: number): PortalMessage[] {
  const out: PortalMessage[] = [];
  let left = Math.max(0, budget);
  for (const f of folded) {
    if (f.tooMany !== undefined) continue;
    const take = f.messages.slice(0, left);
    f.remaining = (f.remaining ?? 0) + (f.messages.length - take.length);
    f.messages = take;
    left -= take.length;
    out.push(...take);
  }
  return out;
}

/** Relay page size (Discord's max per request). */
const FOLD_PAGE = 100;
/** Most messages paged for one channel in one wake. */
const FOLD_BOUND = 500;

/** A Discord snowflake at `iso`: the relay accepts a raw snowflake as a
 *  history cursor, so a watermark timestamp becomes an `after` bound. */
function sinceCursor(iso: string): string {
  const ms = Date.parse(iso);
  return ((BigInt(ms) - 1420070400000n) << 22n).toString();
}

function byCreatedAt(a: PortalMessage, b: PortalMessage): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** De-duplicate messages by id, keeping first occurrence. */
function dedupeById(messages: PortalMessage[]): PortalMessage[] {
  const seen = new Set<string>();
  const out: PortalMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function authorLabel(m: PortalMessage): string {
  const a = m.author;
  if (a.kind === 'persona') return a.displayName;
  if (a.kind === 'user') return a.displayName || a.username;
  return 'system';
}

function render(m: PortalMessage): string {
  const body = m.cleanContent || m.content || '';
  const atts = m.attachments.length
    ? '\n' + m.attachments.map((a) => `[attachment: ${a.name} — ${a.url}]`).join('\n')
    : '';
  return `${authorLabel(m)}: ${body}${atts}`;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export { McplConnection };
export type { ContentBlock };
