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
  /** Per persona: how far this process has SHOWN each channel (see collectMissed). */
  private seenByPersona = new Map<string, Map<string, string>>();
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
      /** Attach to expose list/mint/switch_persona (see identity.ts). */
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
    // Clients on the 2026-07-28 MCP revision (Claude Code >= 2.1.282) open with
    // a `server/discover` era probe and only fall back to this legacy handshake
    // once the probe is ANSWERED. Reject whatever precedes `initialize` and keep
    // waiting: closing silently here left the client hanging until its connect
    // timeout, with this process alive and never replying.
    let msg = await conn.nextMessage();
    while (msg.type !== 'request' || msg.request.method !== 'initialize') {
      if (msg.type === 'request') {
        conn.sendError(msg.request.id, -32601, `method not found: ${msg.request.method}`);
      }
      msg = await conn.nextMessage();
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

  /** The current persona's pieces, captured when work is queued. Wakes run on
   *  a chain that an identity switch also joins, so work queued for persona A
   *  can come due after the switch to B; it checks its capture and never runs
   *  against B's client, state or read positions. */
  private bound(): Bound {
    const personaId = this.client.personaId;
    let seen = this.seenByPersona.get(personaId);
    if (!seen) this.seenByPersona.set(personaId, (seen = new Map()));
    return { client: this.client, agent: this.agent, woken: this.wokenPings, seen };
  }

  private wireClient(): void {
    for (const off of this.unwire) off();
    this.unwire = [];
    this.unwire.push(this.client.on('message', (e) => {
      const origin = this.bound();
      if (e.addressedToMe) origin.woken.add(e.message.id); // live wake covers it
      if (process.env.PORTAL_DEBUG) {
        console.error(
          `[portal-cc] recv ch=${e.message.channelId} addressed=${e.addressedToMe} ` +
            `reasons=[${e.reasons.join(',')}] subs=[${origin.agent.state.subscriptionList().join(',')}] ` +
            `→ ${e.addressedToMe ? 'WAKE' : 'accrue-ambient'}`,
        );
      }
      void this.pushMessage(origin, e.message, e.addressedToMe, e.reasons).catch((err) =>
        console.error('[portal-cc] push failed:', (err as Error).message),
      );
    }));
    // On a fresh identify (reconnect after a gap, or first connect), the relay
    // holds any pings that arrived while we were away. Surface them as a single
    // catch-up wake — O(missed) from the relay, no Discord history scan.
    this.unwire.push(this.client.on('ready', () => {
      void this.catchUp(this.bound()).catch((err) =>
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
   * Channels are dropped on a switch: the new identity follows exactly what
   * it follows on its own (its durable subscriptions, replayed by identify),
   * and nothing the old identity followed carries over — follows belong to a
   * persona, and copying them across would grow the new persona's saved set
   * with rooms it never chose, for good. Switching back restores the old
   * identity's follows from its own state. `seeded` is kept: it records what
   * is already in this session's context, which the switch did not change.
   * Woken-ping sets and read positions are per persona, so pings the new
   * identity accrued while inactive arrive as one catch-up, and switching back
   * does not re-deliver.
   *
   * Runs on the wake chain: a wake queued before the swap completes against
   * the client and agent it was queued for, never against the next persona's;
   * one queued for the old persona that comes due after the swap is dropped
   * (its ping stays pending for that persona's next catch-up).
   */
  swapSession(client: PortalClient, agent: PortalAgent): Promise<void> {
    return this.serialized(async () => this.swapNow(client, agent));
  }

  private swapNow(client: PortalClient, agent: PortalAgent): void {
    this.client = client;
    this.agent = agent;
    this.wireClient(); // detaches the outgoing client's listeners first
    // The new client's `ready` fired before we were listening.
    void this.catchUp(this.bound()).catch((err) =>
      console.error('[portal-cc] catch-up failed:', (err as Error).message),
    );
  }

  /** Wake once for pings accrued while offline (server-authoritative). Ambient
   *  traffic missed in followed channels rides along as context — it never
   *  wakes on its own, but it must not be lost either (see collectMissed). */
  private catchUp(origin: Bound = this.bound()): Promise<void> {
    return this.serialized(async () => {
      if (!this.conn || origin.client !== this.client) return; // switched away meanwhile
      const b = origin;
      const pings = await b.agent.pendingPingsFromRelay();
      const fresh = pings.filter((p) => !b.woken.has(p.message.id));
      if (fresh.length === 0) return;
      fresh.sort((a, z) => (a.at < z.at ? -1 : a.at > z.at ? 1 : 0));

      const missed = await this.collectMissed(b);
      // Pings first (newest win if even they overflow), then folded backlog in
      // whatever room is left (see planFold).
      const { messages: base, omitted } = this.capped(dedupeById(fresh.map((p) => p.message)));
      // Only the pings this wake SHOWS count as surfaced. Pings the cap left
      // out stay eligible: the next catch-up (reconnect, switch back) brings
      // the next batch rather than skipping them for good.
      const pingIds = new Set(base.map((m) => m.id));
      for (const id of pingIds) b.woken.add(id);
      const all = this.planFold(missed, base);

      const lines = [`[catch-up] ${fresh.length} message(s) addressed to you while you were away` +
        (missed.length ? `, plus what you missed in ${missed.length} followed channel(s):` : ':')];
      lines.push(this.buildContent(all, pingIds, omitted, (p) => {
        const why = fresh.find((f) => f.message.id === p.id)?.reasons ?? [];
        // A message in a thread names it: a reply goes there only with threadId.
        const thread = p.threadId ? ` [thread ${p.threadId}]` : '';
        return (why.length ? ` (${why.join(',')})` : '') + thread;
      }));
      lines.push(...this.remainingNotes(missed, all));
      lines.push('\n[use fetch_history / fetch_around to read surrounding context, then mark_read]');
      if (fresh.some((p) => p.message.threadId)) {
        lines.push('[to reply in a thread, call send_message with the channel as channelId and the thread as threadId]');
      }

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
      // Every channel with a ping still pending keeps its relay watermark for
      // the agent to advance once it has handled the ping.
      const keep = new Set(pings.map((p) => p.message.channelId));
      this.deliverWake(b, lines.join('\n'), meta, [...pingIds], () => this.settleFolded(b, missed, keep, all));
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
   * followed channel with unread is paged back to its watermark — and so is
   * every thread under it with missed replies, because a thread reply counts
   * toward (and shares the watermark of) its parent channel but is not in the
   * parent's own history. A channel with more missed than FOLD_BOUND, or more
   * threads than the relay tracks, is not paged at all — it gets a note and
   * keeps its watermark — because folding a slice and advancing past the rest
   * is exactly the loss this exists to prevent.
   *
   * Starts from the further of the relay's watermark and how far this process
   * has already SHOWN the channel (`seen`): the relay's mark is asynchronous,
   * and a channel carrying a ping isn't relay-marked at all.
   *
   * Restricted to followed channels on purpose: the relay tallies every
   * channel the persona can VIEW, which for a guild-wide role is the whole
   * guild. Best-effort per channel (no READ_HISTORY ⇒ skipped).
   */
  private async collectMissed(b: Bound): Promise<FoldedChannel[]> {
    const followed = new Set(b.agent.state.subscriptionList());
    if (followed.size === 0) return [];
    let unread: ChannelUnread[];
    try {
      ({ channels: unread } = await b.client.call('list_unread', {}));
    } catch {
      return [];
    }
    const out: FoldedChannel[] = [];
    for (const u of unread) {
      if (!followed.has(u.channelId) || u.count <= 0) continue;
      try {
        const missed = await b.client.call('channel_missed', { channelId: u.channelId });
        const upto = missed.lastAt ?? u.lastAt;
        if (!upto) continue;
        const since = [missed.since, b.seen.get(u.channelId)].filter((w): w is string => !!w).sort().pop();
        if (since && since >= upto) continue; // everything unread was already shown
        // Never marked read: the lower bound is where the relay started
        // counting (older history was never unread). Without it — an older
        // relay — the channel's whole history would page first; note instead.
        const floor = since ?? (missed.firstAt ? justBefore(missed.firstAt) : undefined);
        if (!floor) {
          out.push({ channelId: u.channelId, unseen: [], messages: [], tooMany: missed.messages });
          continue;
        }
        // Too much to page safely, or thread replies we can't enumerate: a relay
        // that predates per-thread tallies names only its LATEST thread, so
        // folding would mark the other threads' replies read unseen.
        const threadsUnknown = missed.threads === undefined && !!missed.threadId;
        if (missed.messages > FOLD_BOUND || missed.threadsTruncated || threadsUnknown) {
          out.push({ channelId: u.channelId, unseen: [], messages: [], tooMany: missed.messages });
          continue;
        }
        // The channel's own history, then each thread with replies past `since`.
        const threads = missed.threads ?? [];
        const pages: Array<PortalMessage[] | null> = [await this.pageBack(b, u.channelId, undefined, floor, upto)];
        for (const th of threads) {
          if (th.lastAt <= floor) continue;
          const threadFloor = since ?? (th.firstAt ? justBefore(th.firstAt) : floor);
          pages.push(await this.pageBack(b, u.channelId, th.threadId, threadFloor, upto));
        }
        const unseen = pages.includes(null)
          ? null
          : dedupeById(pages.flat() as PortalMessage[]).sort(byCreatedAt);
        if (!unseen || unseen.length > FOLD_BOUND) {
          // A bound was hit before the watermark: the oldest fetched is not the
          // oldest unseen, so folding would skip what lies beneath. Note it and
          // leave the watermark where it is.
          out.push({ channelId: u.channelId, unseen: [], messages: [], tooMany: missed.messages });
          continue;
        }
        if (unseen.length) out.push({ channelId: u.channelId, unseen, messages: [], ...(since ? { since } : {}) });
      } catch (err) {
        if (process.env.PORTAL_DEBUG) {
          console.error(`[portal-cc] could not fold missed traffic for ${u.channelId}:`, (err as Error).message);
        }
      }
    }
    return out;
  }

  /** One container's messages in (since, upto], oldest first — paged back from
   *  the newest until the page reaches the watermark (the relay's `after` stops
   *  the page there too). null when FOLD_BOUND is hit before the watermark. */
  private async pageBack(
    b: Bound,
    channelId: string,
    threadId: string | undefined,
    since: string | undefined,
    upto: string,
  ): Promise<PortalMessage[] | null> {
    const fresh: PortalMessage[] = [];
    let before: string | undefined;
    while (fresh.length < FOLD_BOUND) {
      const { messages } = await b.client.fetchHistory({
        channelId,
        ...(threadId ? { threadId } : {}),
        limit: FOLD_PAGE,
        ...(before ? { before } : {}),
        ...(since ? { after: sinceCursor(since) } : {}),
      });
      if (messages.length === 0) return fresh;
      const page = [...messages].sort(byCreatedAt);
      fresh.unshift(...page.filter((m) => (!since || m.createdAt > since) && m.createdAt <= upto));
      if (since && page[0].createdAt <= since) return fresh;
      if (messages.length < FOLD_PAGE) return fresh;
      before = page[0].id;
    }
    return null;
  }

  /**
   * Fit the folded backlog around the live context `base` and return the
   * wake's messages, time-ordered. A backlog message already in `base` (live
   * delivery and the relay's history overlap) is not folded again and spends
   * no budget; the rest fill what `base` leaves, channel by channel, OLDEST
   * first — trimmed at the newest end, so each channel shows a prefix of its
   * unseen and its watermark can follow. Records on each entry what it showed.
   */
  private planFold(folded: FoldedChannel[], base: PortalMessage[]): PortalMessage[] {
    const baseIds = new Set(base.map((m) => m.id));
    let left = Math.max(0, this.contextCap - base.length);
    const taken: PortalMessage[] = [];
    for (const f of folded) {
      if (f.tooMany !== undefined) continue;
      const candidates = f.unseen.filter((m) => !baseIds.has(m.id));
      let take = Math.min(left, candidates.length);
      // Never cut inside a group of messages sharing a timestamp — a read
      // position can't fall between them. Back off to before the group; if
      // that leaves nothing at all, take the whole group, over the cap, so the
      // fold always makes progress.
      if (take > 0 && take < candidates.length && candidates[take].createdAt === candidates[take - 1].createdAt) {
        const at = candidates[take].createdAt;
        let back = take;
        while (back > 0 && candidates[back - 1].createdAt === at) back--;
        if (back > 0) take = back;
        else while (take < candidates.length && candidates[take].createdAt === at) take++;
      }
      f.messages = candidates.slice(0, take);
      left = Math.max(0, left - take);
      taken.push(...f.messages);
    }
    return [...base, ...taken].sort(byCreatedAt);
  }

  /** Lines telling the agent what a wake could not carry, per channel. */
  private remainingNotes(folded: FoldedChannel[], delivered: PortalMessage[]): string[] {
    const shown = new Set(delivered.map((m) => m.id));
    const notes: string[] = [];
    for (const f of folded) {
      const label = this.channelLabel(f.channelId);
      if (f.tooMany !== undefined) {
        notes.push(`[${f.tooMany} message(s) missed in ${label} — more than a wake folds; use channel_missed / fetch_history there, then mark_read]`);
        continue;
      }
      const left = f.unseen.filter((m) => !shown.has(m.id)).length;
      if (left > 0) notes.push(`[${left} more unread message(s) in ${label} will fold into your next wake]`);
    }
    return notes;
  }

  /**
   * After a wake carrying folded backlog was delivered: the agent has now SEEN
   * it, so advance each folded channel's read position — but only through the
   * unbroken run of its unseen messages that the wake actually showed. A live
   * message newer than a gap (the backlog didn't fit) never moves it past the
   * gap; once the whole backlog was shown, newer live messages shown in the
   * same channel count too.
   *
   * The position is recorded locally (`seen`, where the next fold starts) for
   * every folded channel, and on the relay (`mark_read`, with how many unread
   * it covers so a partial mark leaves the rest listed) for every channel
   * except those in `keep`: a channel with a ping still pending keeps its relay
   * watermark for the agent to advance with mark_read once it has handled the
   * ping, so a turn that dies mid-way keeps the ping pending. `keepPings` asks
   * the relay to leave pings alone regardless, for a ping that lands between
   * the pending-ping read and this mark.
   *
   * "Delivered" means handed over, not read: without a wake sink this runs as
   * soon as the channel notification is SENT, because Claude Code sends nothing
   * back once a turn has handled it. If the session dies, restarts or is
   * mid-compaction before the model reads the wake, the folded messages count
   * as read and the next catch-up won't surface them again. Accepted for
   * ambient traffic: it is bounded by one wake (contextCap), the messages stay
   * in the channel for fetch_history, and pings — the traffic that must not be
   * lost — are exempt above. (Same shape as discord-mcpl #30.)
   */
  private settleFolded(
    b: Bound,
    folded: FoldedChannel[],
    keep: Set<string> | null,
    delivered: PortalMessage[],
    droppedLive: PortalMessage[] = [],
  ): void {
    const shown = new Set(delivered.map((m) => m.id));
    for (const f of folded) {
      if (f.tooMany !== undefined || f.unseen.length === 0) continue;
      let run = 0;
      while (run < f.unseen.length && shown.has(f.unseen[run].id)) run++;
      // A read position is a timestamp: never end it inside a group of
      // messages sharing one, or the unshown rest of the group would be marked
      // read too (and the next fold, which starts strictly after it, skip them).
      while (run > 0 && run < f.unseen.length && f.unseen[run].createdAt === f.unseen[run - 1].createdAt) run--;
      if (run === 0) continue;
      let upto = f.unseen[run - 1].createdAt;
      // The relay doesn't tally this persona's own posts, but history has them.
      const own = (m: PortalMessage) => m.author.kind === 'persona' && m.author.personaId === b.client.personaId;
      let count = f.unseen.slice(0, run).filter((m) => !own(m)).length;
      if (run === f.unseen.length) {
        // The whole backlog was shown: newer live messages shown in this
        // channel are seen too — up to (not including) the oldest live message
        // the cap left out, and never into a timestamp it shares.
        const unseenIds = new Set(f.unseen.map((m) => m.id));
        const stop = droppedLive.filter((m) => m.channelId === f.channelId).map((m) => m.createdAt).sort()[0];
        for (const m of [...delivered].sort(byCreatedAt)) {
          if (m.channelId !== f.channelId || unseenIds.has(m.id) || m.createdAt <= upto) continue;
          if (stop !== undefined && m.createdAt >= stop) break;
          upto = m.createdAt;
          if (!own(m)) count++;
        }
      }
      const prev = b.seen.get(f.channelId);
      if (!prev || upto > prev) b.seen.set(f.channelId, upto);
      if (keep === null || keep.has(f.channelId)) continue;
      b.agent.state.markRead(f.channelId, upto);
      void b.client
        .call('mark_read', {
          channelId: f.channelId,
          uptoCreatedAt: upto,
          count,
          ...(f.since ? { since: f.since } : {}),
          keepPings: true,
        })
        .catch((err) =>
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
   *  relay holds them as pending regardless. Both outcomes act on the persona
   *  the wake was built for (`b`), even if a switch happened meanwhile. */
  private deliverWake(
    b: Bound,
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
        for (const id of pingIds) b.woken.delete(id);
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
  private pushMessage(origin: Bound, message: PortalMessage, addressedToMe: boolean, reasons: string[]): Promise<void> {
    if (!this.conn) return Promise.resolve();
    if (!addressedToMe) return Promise.resolve(); // ambient: surfaced as context on the next wake
    return this.serialized(async () => {
      if (origin.client !== this.client) {
        // Queued for a persona this session has since switched away from. Don't
        // present its ping as addressed to the new one; un-mark it so that
        // persona's next catch-up surfaces it (the relay still holds it).
        origin.woken.delete(message.id);
        return;
      }
      await this.wake(origin, message, reasons);
    });
  }

  private async wake(b: Bound, message: PortalMessage, reasons: string[]): Promise<void> {
    if (!this.conn) return;
    const channelId = message.channelId;

    // What the relay says we missed in followed channels (survives restarts),
    // which channels still hold pending pings, then everything unseen that
    // arrived live (includes this message).
    const missed = await this.collectMissed(b);
    const pending = await b.agent.pendingPingsFromRelay().catch(() => null);
    const drained = b.agent.state.drainUnread();

    // First contact with this channel → backfill recent history for context.
    let triggerCtx = drained.filter((m) => m.channelId === channelId);
    if (!this.seeded.has(channelId)) {
      this.seeded.add(channelId);
      try {
        const hist = await b.client.fetchHistory({ channelId, limit: this.contextCap });
        triggerCtx = dedupeById([...hist.messages, ...triggerCtx]);
      } catch {
        /* best-effort backfill */
      }
    }

    // Live context (other channels' unseen, this channel's backfill, the
    // trigger) is capped newest-wins; the relay backlog then fills what is
    // left (see planFold).
    const others = drained.filter((m) => m.channelId !== channelId);
    const { messages: base, omitted } = this.capped(dedupeById([...others, ...triggerCtx, message]));
    const baseIds = new Set(base.map((m) => m.id));
    const droppedLive = drained.filter((m) => !baseIds.has(m.id)); // the cap left these out
    const all = this.planFold(missed, base);
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
    // The trigger's channel and every channel with a ping still pending keep
    // their relay watermark; if the pending set couldn't be read, none move.
    const keep = pending === null ? null : new Set([channelId, ...pending.map((p) => p.message.channelId)]);
    this.deliverWake(b, body, meta, [message.id], () => this.settleFolded(b, missed, keep, all, droppedLive));
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
      if (addressed.has(m.id)) lines.push(`» ${line}${suffix(m)}   ⟵ addressed to you`);
      else lines.push(m.threadId ? `${line} [thread ${m.threadId}]` : line);
    }
    return lines.join('\n');
  }

  private channelLabel(channelId: string): string {
    const name = this.client.cache.getChannel(channelId)?.name;
    return name ? `#${name}` : channelId;
  }
}

/** A persona's pieces as captured for queued work (see `bound()`). */
interface Bound {
  client: PortalClient;
  agent: PortalAgent;
  /** Ping ids already surfaced to this session for this persona. */
  woken: Set<string>;
  /** Per channel: how far this process has shown it (where the next fold starts). */
  seen: Map<string, string>;
}

/** One followed channel's missed backlog, or why it wasn't folded. */
interface FoldedChannel {
  channelId: string;
  /** Every unseen message in the channel and its threads, OLDEST first. */
  unseen: PortalMessage[];
  /** The part of `unseen` this wake folds in (set by planFold). */
  messages: PortalMessage[];
  /** The read position this fold counted from (relay watermark or `seen`). */
  since?: string;
  /** Set when the channel was NOT folded: too much missed to page safely. */
  tooMany?: number;
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

/** One millisecond before `iso`: an exclusive bound that still includes `iso`. */
function justBefore(iso: string): string {
  return new Date(Date.parse(iso) - 1).toISOString();
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
