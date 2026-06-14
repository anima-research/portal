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
import type { PortalClient } from '@connectome/portal-client';
import type { PortalMessage } from '@connectome/portal-protocol';
import type { PortalAgent } from './agent.js';

/** Claude Code's channel push notification method. */
const CHANNEL_NOTIFY = 'notifications/claude/channel';

export class PortalCcChannelServer {
  private conn: McplConnection | null = null;

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
    this.client.on('message', (e) => this.pushMessage(e.message, e.addressedToMe, e.reasons));
  }

  private pushMessage(message: PortalMessage, addressedToMe: boolean, reasons: string[]): void {
    if (!this.conn) return;
    // Claude Code channel payload: a string body + flat string-keyed meta used
    // for routing/labeling. We thread channelId through so the model can reply
    // with the send_message tool.
    const meta: Record<string, string> = {
      source: 'discord',
      channelId: message.channelId,
      author: authorLabel(message),
      messageId: message.id,
      addressed: String(addressedToMe),
    };
    if (message.threadId) meta.threadId = message.threadId;
    if (message.guildId) meta.guildId = message.guildId;
    if (reasons.length) meta.reasons = reasons.join(',');

    this.conn.sendNotification(CHANNEL_NOTIFY, { content: render(message), meta });
  }
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
