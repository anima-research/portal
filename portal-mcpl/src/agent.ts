/**
 * PortalAgent — the agent-facing surface over a PortalClient.
 *
 * Wires client events into AgentState (watermarks + pending pings) and routes
 * tool calls to RPC. Transport, cache, and resume are the client's job; durable
 * read-state is AgentState's; this class is the glue + the tool dispatch table.
 *
 * The remaining integration seam is binding this to an McplConnection (from
 * @connectome/mcpl-core): forward tools/list → `toolDefinitions`, tools/call →
 * `handleToolCall`, and emit a PUSH_EVENT whenever `onPing` fires. That binding
 * is intentionally not done here so this package stays transport-agnostic and
 * unit-testable. See README for the ~30-line adapter sketch.
 */
import type { PortalClient } from '@connectome/portal-client';
import type { AddressReason, PortalMessage } from '@connectome/portal-protocol';
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
  }

  private ingest(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    const wasPing = this.state.ingest(message, addressedToMe, reasons);
    if (wasPing && this.onPing) {
      this.onPing({ message, reasons, at: message.createdAt });
    }
  }

  get tools(): typeof toolDefinitions {
    return toolDefinitions;
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
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      case 'list_guilds':
        return this.client.call('list_guilds', {});
      case 'list_channels':
        return this.client.call('list_channels', { guildId: str(args.guildId) });
      case 'create_thread':
        return this.client.call('create_thread', {
          channelId: str(args.channelId),
          name: str(args.name),
        });
      case 'subscribe_channel':
        return this.client.subscribe(str(args.channelId));
      case 'unsubscribe_channel':
        return this.client.unsubscribe(str(args.channelId));
      case 'list_subscriptions':
        return this.client.call('list_subscriptions', {});
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
      case 'list_pins':
        return this.client.call('list_pins', { channelId: str(args.channelId) });
      case 'get_pending_pings':
        return { pings: this.state.pendingPings() };
      case 'list_unread':
        return { channels: this.state.unreadByChannel() };
      case 'mark_read':
        this.state.markRead(str(args.channelId));
        return { ok: true };
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
