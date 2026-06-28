/**
 * PortalAgent — the agent-facing surface over a PortalClient.
 *
 * Wires client events into AgentState (watermarks + pending pings) and routes
 * tool calls to RPC. Transport, cache, and resume are the client's job; durable
 * read-state is AgentState's; this class is the glue + the tool dispatch table.
 *
 * The remaining integration seam is binding this to an McplConnection (from
 * @animalabs/mcpl-core): forward tools/list → `toolDefinitions`, tools/call →
 * `handleToolCall`, and emit a PUSH_EVENT whenever `onPing` fires. That binding
 * is intentionally not done here so this package stays transport-agnostic and
 * unit-testable. See README for the ~30-line adapter sketch.
 */
import type { PortalClient } from '@animalabs/portal-client';
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState, type PendingPing } from './agent-state.js';
import { toolDefinitions } from './tools.js';

export interface PortalAgentOptions {
  /** Restore persisted read-state (watermarks + pings). */
  state?: AgentState;
  /** Called when a new message is addressed to this persona — wire to a push. */
  onPing?: (ping: PendingPing) => void;
}

export class PortalAgent {
  readonly state: AgentState;
  private onPing?: (ping: PendingPing) => void;

  constructor(
    private client: PortalClient,
    opts: PortalAgentOptions = {},
  ) {
    this.state = opts.state ?? new AgentState();
    this.onPing = opts.onPing;
    this.client.on('message', (e) => this.ingest(e.message, e.addressedToMe, e.reasons));
    this.client.on('messageUpdate', (e) => {
      // An edit to a message we track refreshes its preview but isn't a new ping.
      this.state.ingest(e.message, false, e.reasons);
    });
    // A transport `resume` restores the event stream but NOT the relay session's
    // subscriptions (the new session starts empty). Reapply from durable state.
    // The fresh-`identify` path already carries them via the client's replay set.
    this.client.on('resumed', () => this.reapplySubscriptions());
  }

  /** Re-assert this agent's durable subscriptions on the live session. */
  private reapplySubscriptions(): void {
    for (const channelId of this.state.subscriptionList()) {
      this.client.subscribe(channelId).catch(() => {});
    }
  }

  private ingest(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    // Auto-subscribe to a channel the moment we're addressed there. A mention is
    // delivered regardless of subscription, but the relay drops *ambient*
    // (non-mention) messages for unsubscribed personas — so without this, the
    // agent never sees the chatter between mentions. Subscribing now means
    // subsequent ambient messages are delivered and accumulate for the next wake.
    if (addressedToMe && this.state.subscribe(message.channelId)) {
      if (process.env.PORTAL_DEBUG) {
        console.error(`[portal-cc] auto-subscribed to ${message.channelId} (addressed here)`);
      }
      this.client.subscribe(message.channelId).catch(() => {});
    }
    const wasPing = this.state.ingest(message, addressedToMe, reasons);
    if (wasPing && this.onPing) {
      this.onPing({ message, reasons, at: message.createdAt });
    }
  }

  get tools(): typeof toolDefinitions {
    return toolDefinitions;
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

  /** Dispatch a tool call. Returns a plain JSON-able result. */
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'send_message':
        return this.client.sendMessage({
          channelId: str(args.channelId),
          content: optStr(args.content),
          files: args.files as never,
          replyToId: optStr(args.replyToId),
          mentionPersonaIds: args.mentionPersonaIds as string[] | undefined,
        });
      case 'edit_message':
        return this.client.editMessage(str(args.messageId), str(args.content));
      case 'delete_message':
        return this.client.deleteMessage(str(args.messageId));
      case 'react':
        return this.client.react(str(args.messageId), str(args.emoji), Boolean(args.visible));
      case 'fetch_history':
        return this.client.fetchHistory({
          channelId: str(args.channelId),
          threadId: optStr(args.threadId),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          before: optStr(args.before),
          after: optStr(args.after),
        });
      case 'fetch_around':
        return this.fetchAround(
          str(args.channelId),
          str(args.messageId),
          typeof args.limit === 'number' ? args.limit : 50,
          optStr(args.threadId),
        );
      case 'list_guilds':
        return this.client.call('list_guilds', {});
      case 'list_channels':
        return this.client.call('list_channels', { guildId: str(args.guildId) });
      case 'create_thread':
        return this.client.call('create_thread', {
          channelId: str(args.channelId),
          name: str(args.name),
        });
      case 'subscribe_channel': {
        const channelId = str(args.channelId);
        this.state.subscribe(channelId); // durable; persisted via onChange
        return this.client.subscribe(channelId);
      }
      case 'unsubscribe_channel': {
        const channelId = str(args.channelId);
        this.state.unsubscribe(channelId);
        return this.client.unsubscribe(channelId);
      }
      case 'list_subscriptions':
        // Durable agent state is the source of truth (survives reconnect/restart).
        return { channelIds: this.state.subscriptionList() };
      case 'list_members':
        return this.client.call('list_members', {
          guildId: str(args.guildId),
          query: optStr(args.query),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      case 'resolve_mentions':
        return this.client.call('resolve_mentions', {
          guildId: str(args.guildId),
          handles: (args.handles as string[]) ?? [],
        });
      case 'list_roles':
        return this.client.call('list_roles', { guildId: str(args.guildId) });
      case 'list_pins':
        return this.client.call('list_pins', { channelId: str(args.channelId) });
      case 'get_pending_pings':
        // Server-authoritative: includes pings accrued while this session was
        // offline (the relay accumulates for every persona, online or not).
        return this.client.call('get_pending_pings', {});
      case 'list_unread':
        return this.client.call('list_unread', {});
      case 'channel_missed':
        return this.client.call('channel_missed', { channelId: str(args.channelId) });
      case 'mark_read': {
        const channelId = str(args.channelId);
        const uptoCreatedAt = optStr(args.uptoCreatedAt);
        // Advance the server watermark (durable) and the local live-wake state.
        this.state.markRead(channelId, uptoCreatedAt);
        await this.client.call('mark_read', { channelId, uptoCreatedAt });
        return { ok: true };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected string argument');
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
