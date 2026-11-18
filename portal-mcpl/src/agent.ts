/**
 * PortalAgent — the agent-facing surface over a PortalClient.
 *
 * Wires client events into AgentState (watermarks + pending pings) and routes
 * tool calls to RPC. Transport, cache, and resume are the client's job; durable
 * read-state is AgentState's; this class is the glue + the tool dispatch table.
 *
 * The remaining integration seam is binding this to an McplConnection (from
 * @animalabs/mcpl-core): forward tools/list → `agent.tools` (the surface this
 * agent serves: `toolDefinitions` less what the host retires, plus the digest
 * view's `fetch_message` and `view`/`words` when it is on), tools/call →
 * `handleToolCall`, and emit a PUSH_EVENT whenever `onPing` fires. That binding
 * is intentionally not done here so this package stays transport-agnostic and
 * unit-testable. See README for the ~30-line adapter sketch.
 */
import type { PortalClient } from '@animalabs/portal-client';
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState, type PendingPing } from './agent-state.js';
import {
  buildCandidates,
  channelLabel,
  formatChannelLabel,
  parseChannelRef,
  resolveChannelRef,
  type ResolveResult,
} from './channel-names.js';
import { chunkText } from './chunk.js';
import { digestToolDefinitions, toolDefinitions, withDigestView } from './tools.js';
import { DigestIndex, RecentIds, checkedWords, digestMessages } from './digest.js';
import { resolveOutgoingFiles, type ResolveFilesOptions } from './files.js';

/**
 * Tools retired where the host opens and closes channels itself
 * (hostOwnsChannelLifecycle): each answer says nothing ran and points to the
 * host's own channel tools.
 */
const RETIRED_WHEN_HOST_OWNS_CHANNELS: Readonly<Record<string, string>> = {
  subscribe_channel:
    'subscribe_channel is retired here: this host opens and closes channels itself, so nothing ran. ' +
    "Open the channel with your host's own channel tool instead, such as channel_open.",
  unsubscribe_channel:
    'unsubscribe_channel is retired here: this host opens and closes channels itself, so nothing ran. ' +
    "Close the channel with your host's own channel tool instead, such as channel_close.",
  list_subscriptions:
    'list_subscriptions is retired here: this host keeps track of open channels itself, so nothing ran. ' +
    "Your host's own channel tool lists them, such as channel_list.",
  set_reaction_visibility:
    'set_reaction_visibility is retired here, so nothing ran: reactions show in a channel while it is open, ' +
    "and this host opens and closes channels itself. To show or hide them, open or close the channel with your host's " +
    'own channel tools, such as channel_open and channel_close.',
};

const DIGEST_NOTE =
  'Numbered oldest first; times are UTC (month-day hour:minute). ids[N-1] is the relay id of #N: use it to react, ' +
  'reply, edit, or page from that message. A line ending "(+N words, full: ID)" or "(+N chars, full: ID)" was cut: ' +
  'fetch_message with that ID reads the message from the relay now, so it shows edits and reactions as they are, and ' +
  'says so if the message is gone or you can no longer read it. A line with no cut marker is the whole message and ' +
  'keeps its own line breaks. Lines marked ★ are whole because they are addressed to you (★to-you) or are what an ' +
  'addressed message replies to (★replied-to).';

/** PORTAL_DIGEST_VIEW=1 (or true) turns the digest view on at this server. Anything else leaves it off. */
function digestViewFromEnv(): boolean {
  const v = process.env.PORTAL_DIGEST_VIEW?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export interface PortalAgentOptions {
  /** Restore persisted read-state (watermarks + pings). */
  state?: AgentState;
  /** The digest view (portal#79): `view: "digest"` and `words` on fetch_history and fetch_around, and fetch_message.
   *  Off by default, and then none of it is served and a call that asks for it is refused. Left out, it follows
   *  PORTAL_DIGEST_VIEW; an explicit value here wins over the environment. */
  digestView?: boolean;
  /** Called when a new message is addressed to this persona — wire to a push. */
  onPing?: (ping: PendingPing) => void;
  /** The surrounding MCPL host owns open/close state in Chronicle. This
   *  disables the legacy subscription tools and mention auto-subscribe while
   *  leaving the standalone Claude Code channel behavior unchanged. */
  hostOwnsChannelLifecycle?: boolean;
  /** How `send_message.files` paths/URLs are resolved to bytes (see files.ts). */
  files?: ResolveFilesOptions;
  /** Called after this persona does something PUBLIC (posts, reacts, edits) —
   *  a beacon for supervisors that can't see every channel it acts in. */
  onPublicActivity?: (kind: 'message' | 'reaction' | 'edit') => void;
}

export class PortalAgent {
  readonly state: AgentState;
  private onPing?: (ping: PendingPing) => void;
  private hostOwnsChannelLifecycle: boolean;
  private fileOpts: ResolveFilesOptions;
  private onPublicActivity?: (kind: 'message' | 'reaction' | 'edit') => void;
  private readonly digestView: boolean;
  /** Where the messages a digest showed live, for fetch_message to read again. No content. */
  private readonly digestIndex = new DigestIndex();
  /** Relay ids of messages this persona wrote that this process has seen: what it sent, and what a digest showed. */
  private readonly ownMessageIds = new RecentIds();

  constructor(
    private client: PortalClient,
    opts: PortalAgentOptions = {},
  ) {
    this.state = opts.state ?? new AgentState();
    this.onPing = opts.onPing;
    this.hostOwnsChannelLifecycle = opts.hostOwnsChannelLifecycle === true;
    this.fileOpts = opts.files ?? {};
    this.onPublicActivity = opts.onPublicActivity;
    this.digestView = opts.digestView ?? digestViewFromEnv();
    this.client.on('message', (e) => this.ingest(e.message, e.addressedToMe, e.reasons));
    this.client.on('messageUpdate', (e) => {
      // An edit to a message we track refreshes its preview but isn't a new ping.
      this.state.ingest(e.message, false, e.reasons);
    });
    // The client asks the relay for its subscriptions again on every
    // reconnect, a resume included. Standalone, it's built with this durable
    // state (session.ts) and each change below goes to both, a voice_join's
    // included; after a failed call the state takes the client's word for the
    // channel (followClient). In host mode the host's opens make the client's
    // list, with the channel of each voice_join added (voiceJoin()), and this
    // state only seeds the host's initiallyOpen hints.
  }

  /** After a failed subscribe or unsubscribe, keep the channel in the state
   *  exactly when the client's list keeps it: the client undoes a failed
   *  call's change only while it's the newest call on the channel. */
  private followClient(channelId: string): void {
    if (this.client.isListed(channelId)) this.state.subscribe(channelId);
    else this.state.unsubscribe(channelId);
  }

  private ingest(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    // Auto-subscribe to a channel the moment we're addressed there. A mention is
    // delivered regardless of subscription, but the relay drops *ambient*
    // (non-mention) messages for unsubscribed personas — so without this, the
    // agent never sees the chatter between mentions. Subscribing now means
    // subsequent ambient messages are delivered and accumulate for the next wake.
    if (!this.hostOwnsChannelLifecycle && addressedToMe && this.state.subscribe(message.channelId)) {
      if (process.env.PORTAL_DEBUG) {
        console.error(`[portal-cc] auto-subscribed to ${message.channelId} (addressed here)`);
      }
      const channelId = message.channelId;
      // A failed subscribe the client undoes leaves the durable state too, so
      // the next mention here tries again.
      this.client.subscribe(channelId).catch(() => this.followClient(channelId));
    }
    const wasPing = this.state.ingest(message, addressedToMe, reasons);
    if (wasPing && this.onPing) {
      this.onPing({ message, reasons, at: message.createdAt });
    }
  }

  get tools(): typeof toolDefinitions {
    const base = toolDefinitions.filter(
      (tool) => !(this.hostOwnsChannelLifecycle && Object.hasOwn(RETIRED_WHEN_HOST_OWNS_CHANNELS, tool.name)),
    );
    if (!this.digestView) return base;
    return [...base.map(withDigestView), ...digestToolDefinitions];
  }

  /** While the digest view is off, a call that asks for any of it is refused before a fetch, a channel lookup or
   *  anything else runs, and says how to turn it on. It is never answered with the full messages instead, which
   *  would let an agent believe it had a view this server does not offer. */
  private refuseDigestWhileOff(name: string, args: Record<string, unknown>): void {
    if (this.digestView) return;
    const given = (v: unknown): boolean => v !== undefined && v !== null;
    if (name === 'fetch_message') {
      throw new Error(
        'Nothing ran: fetch_message is not enabled on this server, because it reads messages a digest view has shown ' +
          'and the digest view is off. Whoever runs this server turns it on with PORTAL_DIGEST_VIEW=1.',
      );
    }
    if ((name === 'fetch_history' || name === 'fetch_around') && (given(args.view) || given(args.words))) {
      throw new Error(
        `Nothing ran: the digest view is not enabled on this server, so view and words are not options here and ${name} ` +
          'was not called. Call it without them for the full messages. Whoever runs this server turns the view on with ' +
          'PORTAL_DIGEST_VIEW=1.',
      );
    }
  }

  /** With the view on: whether this fetch asks for the digest, and its word limit, checked before anything is fetched. */
  private digestRequest(args: Record<string, unknown>): { digest: boolean; words?: number } {
    const view = args.view === undefined || args.view === null ? 'full' : args.view;
    if (view !== 'full' && view !== 'digest') {
      throw new Error(`Nothing ran: view must be "full" or "digest" when given, got ${shortJson(view)}.`);
    }
    const words = optNum(args.words, 'words');
    if (view === 'full') {
      if (words !== undefined) throw new Error('Nothing ran: words only applies to view "digest".');
      return { digest: false };
    }
    return { digest: true, words: checkedWords(words) };
  }

  /** The digest of a fetch's messages, and the cache `fetch_message` reads them back from. */
  private digestOf(messages: readonly PortalMessage[], words: number | undefined): unknown {
    const self = this.client.personaId;
    const { lines, ids, ordered } = digestMessages(messages, { words, selfPersonaId: self, ownMessageIds: this.ownMessageIds });
    // Oldest first, so that past the bound it is the oldest ids that are forgotten, whatever order the relay returned them in.
    for (const m of ordered) if (m.author.kind === 'persona' && m.author.personaId === self) this.ownMessageIds.add(m.id);
    this.digestIndex.put(ordered);
    return { view: 'digest', count: lines.length, note: DIGEST_NOTE, ids, lines };
  }

  /** Server-authoritative pending pings, including any accrued while this
   *  session was offline. Used by the channel binding for reconnect catch-up. */
  async pendingPingsFromRelay(): Promise<PendingPing[]> {
    const { pings } = await this.client.call('get_pending_pings', {});
    return pings;
  }

  /** Fetch a window of messages centred on `messageId` (the relay returns the
   *  older and newer halves; the anchor itself may not be included). */
  private async fetchAround(
    channelId: string,
    messageId: string,
    limit: number,
    threadId?: string,
  ): Promise<{ messages: PortalMessage[] }> {
    const half = Math.max(1, Math.floor(limit / 2));
    const [older, newer] = await Promise.all([
      this.client.fetchHistory({ channelId, threadId, before: messageId, limit: half }),
      this.client.fetchHistory({ channelId, threadId, after: messageId, limit: half }),
    ]);
    const seen = new Set<string>();
    const messages = [...older.messages, ...newer.messages]
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { messages };
  }

  /**
   * Resolve a channel reference — raw snowflake, `portal:<id>`, or the
   * `#name (Guild)` label the listings print — to a relay channel id. Reads the
   * live cache every call (never a startup snapshot: a renamed or re-granted
   * channel must resolve to what it is NOW). See channel-names.ts.
   */
  resolveChannelRef(ref: string): ResolveResult {
    return resolveChannelRef(ref, () =>
      buildCandidates(this.client.cache.allChannels(), this.client.cache.allGuilds()));
  }

  /** `#name (Guild)` for a cached channel; the raw id when unknown. */
  labelFor(channelId: string): string {
    const c = this.client.cache.getChannel(channelId);
    if (!c) return channelId;
    return formatChannelLabel(c.name ?? c.id, c.guildId ? this.client.cache.getGuild(c.guildId)?.name : undefined);
  }

  /** Dispatch a tool call. Returns a plain JSON-able result. */
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    // A tool that won't run is answered before its arguments are looked at:
    // a retired tool's pointer, or the unknown-name refusal, is the whole
    // answer, whatever channel the call names.
    if (this.hostOwnsChannelLifecycle && Object.hasOwn(RETIRED_WHEN_HOST_OWNS_CHANNELS, name)) {
      throw new Error(RETIRED_WHEN_HOST_OWNS_CHANNELS[name]);
    }
    if (!toolDefinitions.some((tool) => tool.name === name) && !digestToolDefinitions.some((tool) => tool.name === name)) {
      throw new Error(unknownToolMessage(name));
    }
    this.refuseDigestWhileOff(name, args);
    // THE chokepoint for channel addressing: every tool that takes a channelId
    // goes through here, so a name is resolved exactly once, before any side
    // effect, or the call fails audibly — never a silent pick, never a name
    // passed downstream hoping the relay rejects it. Ids pass through untouched.
    if (typeof args.channelId === 'string' && args.channelId.trim()) {
      const parsed = parseChannelRef(args.channelId);
      if (parsed?.kind !== 'id') {
        const resolved = this.resolveChannelRef(args.channelId);
        if (!resolved.ok) {
          throw new Error(`Nothing ran: channelId ${shortJson(args.channelId)} ${resolved.message}`);
        }
        args = { ...args, channelId: resolved.id };
      } else if (parsed.id !== args.channelId) {
        args = { ...args, channelId: parsed.id }; // `portal:<id>` → bare id
      }
    }
    // threadId goes through the same chokepoint. Absent or null means no
    // thread. Anything else must name one, in a form channelId accepts, or
    // the call is refused here, before anything is sent or read: a value that
    // named no thread used to be dropped, and the post landed in the parent.
    // A threadId equal to channelId names the thread itself, which channelId
    // alone already addresses.
    if (args.threadId === null) {
      args = { ...args, threadId: undefined };
    } else if (args.threadId !== undefined) {
      const parsed = typeof args.threadId === 'string' ? parseChannelRef(args.threadId) : null;
      // Threads aren't addressable by label, so only an id names one.
      if (parsed?.kind !== 'id') {
        throw new Error(
          `Nothing ran: threadId ${shortJson(args.threadId)} isn't a thread id. A thread is named by its id ` +
            "(or portal:<id>), as create_thread returns it and as a message's threadId shows it; " +
            'null or no threadId means no thread.',
        );
      }
      args = { ...args, threadId: parsed.id === args.channelId ? undefined : parsed.id };
    }
    switch (name) {
      case 'send_message': {
        // Discord caps content at 2000 chars — split long messages into
        // sequential sends (files/reply/mentions ride on the first chunk).
        const content = optStr(args.content, 'content');
        const chunks = content !== undefined ? chunkText(content) : [content];
        // Paths/URLs become inline bytes here, on the resident's host — the
        // relay only ever sees `bytes` (RFC-003 keeps its own disk closed).
        const files = await resolveOutgoingFiles(args.files, this.fileOpts);
        if (!files && content === undefined) throw new Error('send_message needs content or files');
        const posted: string[] = [];
        let first: unknown;
        for (let i = 0; i < chunks.length; i++) {
          let result: unknown;
          try {
            result = await this.client.sendMessage({
              channelId: str(args.channelId, 'channelId'),
              // Every chunk goes to the same place: a thread under channelId
              // when one is named, else channelId itself.
              threadId: optStr(args.threadId, 'threadId'),
              content: chunks[i],
              ...(i === 0
                ? {
                    files,
                    replyToId: optStr(args.replyToId, 'replyToId'),
                    mentionPersonaIds: args.mentionPersonaIds as string[] | undefined,
                  }
                : {}),
            });
          } catch (e) {
            if (i === 0) throw e;
            // The earlier parts are posted, so a refusal of this part, which
            // says nothing ran for its own call, isn't the whole answer; and
            // posting them was public activity.
            this.onPublicActivity?.('message');
            throw new Error(
              `Only part of the message was sent: the first ${i} of ${chunks.length} parts were posted ` +
                `(${posted.map((id) => JSON.stringify(id)).join(', ')}), and part ${i + 1} may not have been. ` +
                `Its call answered: "${(e as Error).message}" ` +
                'To send the rest, call send_message with only the text that didn\'t go out; fetch_around shows what did.',
            );
          }
          const id = (result as { messageId?: unknown } | undefined)?.messageId;
          if (typeof id === 'string') {
            posted.push(id);
            this.ownMessageIds.add(id);
          }
          first ??= result;
        }
        this.onPublicActivity?.('message');
        return first;
      }
      case 'edit_message': {
        const edited = await this.client.editMessage(str(args.messageId, 'messageId'), str(args.content, 'content'));
        this.onPublicActivity?.('edit');
        return edited;
      }
      case 'delete_message':
        return this.client.deleteMessage(str(args.messageId, 'messageId'));
      case 'react': {
        const reacted = await this.client.react(
          str(args.messageId, 'messageId'),
          str(args.emoji, 'emoji'),
          optBool(args.visible, 'visible') ?? false,
          optBool(args.native, 'native') ?? false,
        );
        this.onPublicActivity?.('reaction');
        return reacted;
      }
      case 'unreact':
        return this.client.unreact(str(args.messageId, 'messageId'), str(args.emoji, 'emoji'), optBool(args.native, 'native') ?? false);
      case 'fetch_history': {
        const mode = this.digestRequest(args);
        const history = await this.client.fetchHistory({
          channelId: str(args.channelId, 'channelId'),
          threadId: optStr(args.threadId, 'threadId'),
          limit: optNum(args.limit, 'limit'),
          before: optStr(args.before, 'before'),
          after: optStr(args.after, 'after'),
        });
        return mode.digest ? this.digestOf(history.messages, mode.words) : history;
      }
      case 'fetch_around': {
        const mode = this.digestRequest(args);
        const around = await this.fetchAround(
          str(args.channelId, 'channelId'),
          str(args.messageId, 'messageId'),
          optNum(args.limit, 'limit') ?? 50,
          optStr(args.threadId, 'threadId'),
        );
        return mode.digest ? this.digestOf(around.messages, mode.words) : around;
      }
      case 'fetch_message': {
        const ref = str(args.messageId, 'messageId');
        const place = this.digestIndex.get(ref);
        if (!place) {
          throw new Error(
            `Nothing ran: ${shortJson(ref)} isn't one this server has shown in a digest. It remembers where the last ${this.digestIndex.capacity} ` +
              'messages a digest showed are, and starts empty after a restart. Fetch it again with fetch_history or fetch_around.',
          );
        }
        // A live read, so what comes back is what the relay says now: edits and reactions as they are, and a refusal
        // if the agent can no longer read the channel. `before` is an exclusive snowflake cursor and history pages
        // newest-first, so the first message before the snowflake plus one is this message if it still exists.
        if (!/^\d+$/.test(place.nativeId)) throw new Error(`Nothing ran: ${shortJson(ref)} has no snowflake to read it by. Fetch it again with fetch_history.`);
        const page = await this.client.fetchHistory({
          channelId: place.channelId,
          threadId: place.threadId,
          before: String(BigInt(place.nativeId) + 1n),
          limit: 1,
        });
        const found = page.messages[0];
        if (!found || found.nativeId !== place.nativeId) {
          throw new Error(
            `Nothing ran: ${shortJson(ref)} is no longer there: it was deleted, or you can no longer read it. ` +
              'fetch_history shows what the channel holds now.',
          );
        }
        return { message: found };
      }
      case 'list_guilds':
        return this.client.call('list_guilds', {});
      case 'list_channels': {
        // Each channel carries its `label` — the exact string every channelId
        // argument accepts (display form == address form). Threads/categories
        // are labelled too but remain id-only addresses.
        const guildId = str(args.guildId, 'guildId');
        const guildName = this.client.cache.getGuild(guildId)?.name;
        const res = (await this.client.call('list_channels', { guildId })) as {
          channels: Array<{ id: string; name: string | null; type: string }>;
        };
        return {
          channels: res.channels.map((c) => ({
            ...c,
            label: formatChannelLabel(c.name ?? c.id, guildName),
          })),
        };
      }
      case 'create_thread':
        return this.client.call('create_thread', {
          channelId: str(args.channelId, 'channelId'),
          name: str(args.name, 'name'),
        });
      case 'subscribe_channel': {
        const channelId = str(args.channelId, 'channelId');
        this.state.subscribe(channelId); // durable; persisted via onChange
        try {
          return await this.client.subscribe(channelId);
        } catch (error) {
          this.followClient(channelId);
          throw error;
        }
      }
      case 'unsubscribe_channel': {
        const channelId = str(args.channelId, 'channelId');
        this.state.unsubscribe(channelId);
        try {
          return await this.client.unsubscribe(channelId);
        } catch (error) {
          this.followClient(channelId);
          throw error;
        }
      }
      case 'list_subscriptions':
        // Durable agent state is the source of truth (survives reconnect/restart).
        return { channelIds: this.state.subscriptionList() };
      case 'list_members':
        return this.client.call('list_members', {
          guildId: str(args.guildId, 'guildId'),
          query: optStr(args.query, 'query'),
          limit: optNum(args.limit, 'limit'),
        });
      case 'resolve_mentions':
        return this.client.call('resolve_mentions', {
          guildId: str(args.guildId, 'guildId'),
          handles: (args.handles as string[]) ?? [],
        });
      case 'list_roles':
        return this.client.call('list_roles', { guildId: str(args.guildId, 'guildId') });
      case 'list_emojis':
        return this.client.call('list_emojis', { guildId: optStr(args.guildId, 'guildId') });
      case 'set_reaction_visibility': {
        const channelId = str(args.channelId, 'channelId');
        const visible = optBool(args.visible, 'visible') ?? false;
        // Durable per-channel opt-in; persisted via onChange. Reactions are shown
        // in context but NEVER wake the agent (see server.ts push path).
        this.state.setReactionVisibility(channelId, visible);
        return visible
          ? `Reaction visibility ON for ${channelId}. Reactions there now appear in your context as they happen (they never wake you). Subscribe to the channel if you aren't already, so its reactions reach you.`
          : `Reaction visibility OFF for ${channelId}.`;
      }
      case 'list_pins':
        return this.client.call('list_pins', { channelId: str(args.channelId, 'channelId') });
      case 'voice_join': {
        // voiceJoin(), not call(): the relay subscribes this session as it
        // joins, so the client lists the channel and a reconnect asks again.
        // Standalone, the durable state follows, as the subscribe tools keep
        // it; in host mode it only seeds the host's opens, which a join
        // doesn't make.
        const channelId = str(args.channelId, 'channelId');
        if (this.hostOwnsChannelLifecycle) return this.client.voiceJoin(channelId);
        this.state.subscribe(channelId);
        try {
          return await this.client.voiceJoin(channelId);
        } catch (error) {
          this.followClient(channelId);
          throw error;
        }
      }
      case 'voice_leave':
        return this.client.call('voice_leave', { channelId: str(args.channelId, 'channelId') });
      case 'voice_speak':
        return this.client.call('voice_speak', {
          channelId: str(args.channelId, 'channelId'),
          text: str(args.text, 'text'),
          ...(args.requestId != null ? { requestId: str(args.requestId, 'requestId') } : {}),
          ...(args.grant !== undefined ? { grant: args.grant as never } : {}),
        });
      case 'get_pending_pings':
        // Server-authoritative: includes pings accrued while this session was
        // offline (the relay accumulates for every persona, online or not).
        return this.client.call('get_pending_pings', {});
      case 'list_unread':
        return this.client.call('list_unread', {});
      case 'channel_missed':
        return this.client.call('channel_missed', { channelId: str(args.channelId, 'channelId') });
      case 'mark_read': {
        const channelId = str(args.channelId, 'channelId');
        const uptoCreatedAt = optStr(args.uptoCreatedAt, 'uptoCreatedAt');
        // Advance the server watermark (durable) and the local live-wake state.
        this.state.markRead(channelId, uptoCreatedAt);
        await this.client.call('mark_read', { channelId, uptoCreatedAt });
        return { ok: true };
      }
      default:
        throw new Error(unknownToolMessage(name));
    }
  }
}

/** A string argument, refused by name before anything runs. */
function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`Nothing ran: ${name} must be a string, got ${shortJson(v)}.`);
  return v;
}
/** An optional string argument: absent when undefined or null, refused by name when it's anything else. */
function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Nothing ran: ${name} must be a string when given, got ${shortJson(v)}.`);
  return v;
}
/** An optional number argument: absent when undefined or null, refused by name when it's anything else. */
function optNum(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw new Error(`Nothing ran: ${name} must be a number when given, got ${shortJson(v)}.`);
  return v;
}
/** An optional boolean argument: absent when undefined or null, refused by name when it's anything else. */
function optBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`Nothing ran: ${name} must be true or false when given, got ${shortJson(v)}.`);
  return v;
}
/** A caller's value for an error message, bounded so a huge one isn't echoed
 *  whole: at most 60 characters, the cut's ellipsis included, counted and cut
 *  by code points so a cut never splits a character. */
export function shortJson(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(typeof v);
  }
  const points = Array.from(s);
  if (points.length <= 60) return s;
  // A cut string keeps its closing quote, so the message around it still reads.
  return s.startsWith('"') ? `${points.slice(0, 58).join('')}…"` : `${points.slice(0, 59).join('')}…`;
}

/**
 * The refusal for a tool name the server doesn't have. The agent holds the
 * list of tools it can call, so the refusal points there.
 */
export function unknownToolMessage(name: unknown): string {
  return `There's no Portal tool named ${shortJson(name)}, so nothing ran. Call one of the tools listed for you.`;
}
