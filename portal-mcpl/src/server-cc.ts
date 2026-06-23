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
import type { PortalMessage } from '@animalabs/portal-protocol';
import type { PortalAgent } from './agent.js';

/** Claude Code's channel push notification method. */
const CHANNEL_NOTIFY = 'notifications/claude/channel';

export class PortalCcChannelServer {
  private conn: McplConnection | null = null;
  /** Channels we've already backfilled history for (first-contact context). */
  private seeded = new Set<string>();
  /** Max messages to prepend per wake; older are truncated (scroll back via
   *  fetch_history). Configurable via PORTAL_CONTEXT_CAP (default 80). */
  private readonly contextCap = Math.max(1, Number(process.env.PORTAL_CONTEXT_CAP ?? '80') || 80);

  constructor(
    private client: PortalClient,
    private agent: PortalAgent,
  ) {}

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
          conn.sendResponse(req.id, { tools: this.agent.tools });
          break;
        case 'tools/call': {
          const out = await this.agent.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
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
    this.client.on('message', (e) => {
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
    });
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
  private async pushMessage(message: PortalMessage, addressedToMe: boolean, reasons: string[]): Promise<void> {
    if (!this.conn) return;
    if (!addressedToMe) return; // ambient: surfaced as context on the next wake
    const conn = this.conn;
    const channelId = message.channelId;

    // Flush everything unseen (includes this message), oldest first.
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

    // Combine other channels' unread + this channel's context, time-ordered, capped.
    const others = drained.filter((m) => m.channelId !== channelId);
    let all = dedupeById([...others, ...triggerCtx]).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    let omitted = 0;
    if (all.length > this.contextCap) {
      omitted = all.length - this.contextCap;
      all = all.slice(all.length - this.contextCap);
    }

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
        `[portal-cc] WAKE ch=${channelId} contextMsgs=${all.length} omitted=${omitted} (folded backlog + trigger)`,
      );
    }
    conn.sendNotification(CHANNEL_NOTIFY, { content: this.buildContent(all, message, omitted), meta });
  }

  /** Render the wake payload: optional truncation note, channel-labeled lines,
   *  with the triggering message marked. */
  private buildContent(messages: PortalMessage[], trigger: PortalMessage, omitted: number): string {
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
      lines.push(m.id === trigger.id ? `» ${line}   ⟵ addressed to you` : line);
    }
    return lines.join('\n');
  }

  private channelLabel(channelId: string): string {
    const name = this.client.cache.getChannel(channelId)?.name;
    return name ? `#${name}` : channelId;
  }
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
