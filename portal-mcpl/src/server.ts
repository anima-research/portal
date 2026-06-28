/**
 * MCPL server binding: exposes a PortalAgent (over a PortalClient) to an MCPL
 * host (connectome-host / agent-framework's `mcpl` module).
 *
 * Mirrors discord-mcpl/server.ts but slim: initialize handshake, tools/list,
 * tools/call → PortalAgent, channel registration from the client cache, push
 * events for inbound messages, and channels/publish → send (the host's
 * locus-routing path for plain-text turns).
 */
import {
  McplConnection,
  textContent,
  method,
  type ChannelDescriptor,
  type ChannelsCloseParams,
  type ChannelsCloseResult,
  type ChannelsIncomingParams,
  type ChannelsListResult,
  type ChannelsOpenParams,
  type ChannelsOpenResult,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
  type ContentBlock,
  type InitializeCapabilities,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McplCapabilities,
  type McplInitializeParams,
  type McplInitializeResult,
  type PushEventParams,
} from '@animalabs/mcpl-core';
import type { PortalClient } from '@animalabs/portal-client';
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';
import type { PortalAgent } from './agent.js';
import type { PendingPing } from './agent-state.js';
import { parsePortalChannelId, portalChannelId, toDescriptor } from './channels.js';
import { featureSets } from './feature-sets.js';

export class PortalMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private registered = new Set<string>();
  /** Portal channel ids the host has opened — routed via channels/incoming so
   *  ambient traffic folds into the open conversation; closed channels use
   *  push/event (which the host's wake gate evaluates). Mirrors discord-mcpl. */
  private openChannels = new Set<string>();
  /** Ping message ids already surfaced as a wake (live or catch-up), so a
   *  reconnect doesn't re-wake for the same offline-accrued pings. */
  private wokenPings = new Set<string>();
  private eventSeq = 0;

  constructor(
    private client: PortalClient,
    private agent: PortalAgent,
  ) {}

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.wireClient();
    await this.handleInitialize();
    if (this.mcplEnabled) this.registerChannels();

    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request);
        else this.handleNotification(msg.notification);
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') {
        console.error('[portal-mcpl] connection error:', (err as Error).message);
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
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;

    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      channels: true,
      rollback: false,
      featureSets,
    };
    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && { experimental: { mcpl: serverCaps } }),
    };
    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'portal-mcpl', version: '0.1.0' },
    };
    conn.sendResponse(msg.request.id, result);

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      console.error('[portal-mcpl] initialized' + (this.mcplEnabled ? ' (MCPL)' : ' (MCP)'));
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
        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = { channels: this.allDescriptors() };
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_OPEN: {
          const open = params as unknown as ChannelsOpenParams;
          const addr = open.address as { channelId?: string } | undefined;
          const channelId = addr?.channelId;
          const channel = channelId ? this.client.cache.getChannel(channelId) : undefined;
          if (!channelId || !channel) {
            conn.sendError(req.id, -32000, 'unknown channel');
            break;
          }
          void this.client.subscribe(channelId).catch(() => {});
          this.openChannels.add(channelId);
          const result: ChannelsOpenResult = { channel: toDescriptor(channel) };
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_CLOSE: {
          const close = params as unknown as ChannelsCloseParams;
          const channelId = parsePortalChannelId(close.channelId);
          if (channelId) {
            void this.client.unsubscribe(channelId).catch(() => {});
            this.openChannels.delete(channelId);
          }
          const result: ChannelsCloseResult = { closed: true };
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_PUBLISH: {
          const pub = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pub);
          conn.sendResponse(req.id, result);
          break;
        }
        default:
          conn.sendError(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      // Tool errors come back as a tool result with isError, not a JSON-RPC error.
      if (req.method === 'tools/call') {
        conn.sendResponse(req.id, { content: [textContent(`Error: ${e.message}`)], isError: true });
      } else {
        conn.sendError(req.id, -32000, e.message);
      }
    }
  }

  private handleNotification(_n: JsonRpcNotification): void {
    /* featureSets/update etc. — no-op for now (all sets enabled by default). */
  }

  private async handlePublish(pub: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const channelId = parsePortalChannelId(pub.channelId);
    if (!channelId) return { delivered: false };
    const text = pub.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const { messageId } = await this.client.sendMessage({ channelId, content: text });
    return { delivered: true, messageId };
  }

  // ── Client → host event forwarding ──

  private wireClient(): void {
    this.client.on('ready', () => {
      if (this.mcplEnabled) this.registerChannels();
      void this.catchUp().catch((err) =>
        console.error('[portal-mcpl] catch-up failed:', (err as Error).message),
      );
    });
    this.client.on('message', (e) => {
      if (e.addressedToMe) this.wokenPings.add(e.message.id); // live wake covers it
      this.pushMessage(e.message, e.addressedToMe, e.reasons);
    });
    this.client.on('messageDelete', (e) => {
      if (!this.conn || !this.mcplEnabled) return;
      this.conn
        .sendRequest(method.PUSH_EVENT, {
          featureSet: 'portal.messaging',
          eventId: `portal_del_${e.messageId}`,
          timestamp: new Date().toISOString(),
          origin: { source: 'portal', channelId: portalChannelId(e.channelId) },
          payload: { content: [textContent(`[message deleted] ${e.messageId}`)] },
        } satisfies PushEventParams)
        .catch(() => {});
    });
    this.client.on('channelChange', (channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const desc = toDescriptor(channel);
      this.registered.add(desc.id);
      this.conn.sendNotification(method.CHANNELS_CHANGED, { added: [desc] });
    });
  }

  /**
   * Forward an inbound message to the host with discord-mcpl-parity addressing
   * metadata so the host's wake gate fires the same way: an *open* channel uses
   * channels/incoming (ambient folds into the conversation); a closed channel
   * uses push/event (the gate decides whether to wake). The wake flags
   * (isMention/isExplicitMention/isReplyToBot/isBot/isDM) are derived from the
   * relay's per-persona AddressInfo — no client-side guessing.
   */
  private pushMessage(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    if (!this.conn || !this.mcplEnabled) return;
    const conn = this.conn;
    const meta = wakeMetadata(message, addressedToMe, reasons);
    const channelMcplId = portalChannelId(message.channelId);
    void buildContent(message).then((content) => {
      if (this.openChannels.has(message.channelId)) {
        conn
          .sendRequest(method.CHANNELS_INCOMING, {
            messages: [
              {
                channelId: channelMcplId,
                messageId: message.id,
                threadId: message.threadId,
                author: authorOf(message),
                timestamp: message.createdAt,
                content,
                metadata: meta,
              },
            ],
          } satisfies ChannelsIncomingParams)
          .catch(() => {});
      } else {
        conn
          .sendRequest(method.PUSH_EVENT, {
            featureSet: 'portal.messaging',
            eventId: `portal_msg_${message.id}_${this.eventSeq++}`,
            timestamp: message.createdAt,
            // Flat on origin (discord-mcpl parity) — the wake gate reads these.
            origin: {
              source: 'portal',
              messageId: message.id,
              channelId: channelMcplId,
              channelName: this.channelLabel(message.channelId),
              guildId: message.guildId,
              threadId: message.threadId,
              authorId: authorOf(message).id,
              authorName: authorOf(message).name,
              ...meta,
            },
            payload: { content },
          } satisfies PushEventParams)
          .catch(() => {});
      }
    });
  }

  /** On (re)connect, wake once for pings the relay accrued while we were away.
   *  Server-authoritative — an O(missed) read, no Discord history scan. */
  private async catchUp(): Promise<void> {
    if (!this.conn || !this.mcplEnabled) return;
    const conn = this.conn;
    let pings: PendingPing[];
    try {
      pings = await this.agent.pendingPingsFromRelay();
    } catch {
      return; // relay not ready yet; a later ready will retry
    }
    const fresh = pings.filter((p) => !this.wokenPings.has(p.message.id));
    if (fresh.length === 0) return;
    for (const p of fresh) this.wokenPings.add(p.message.id);
    fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const lines = [`[catch-up] ${fresh.length} message(s) addressed to you while you were away:`];
    for (const p of fresh) {
      lines.push(`— ${this.channelLabel(p.message.channelId)}: ${render(p.message)}`);
    }
    lines.push('[use fetch_history / fetch_around for context, then mark_read]');
    const latest = fresh[fresh.length - 1].message;
    conn
      .sendRequest(method.PUSH_EVENT, {
        featureSet: 'portal.messaging',
        eventId: `portal_catchup_${latest.id}_${this.eventSeq++}`,
        timestamp: latest.createdAt,
        // isExplicitMention=true so the host's wake gate surfaces the catch-up.
        origin: {
          source: 'portal',
          channelId: portalChannelId(latest.channelId),
          messageId: latest.id,
          isMention: true,
          isExplicitMention: true,
          isReplyToBot: false,
          isBot: false,
          isDM: false,
          catchup: true,
        },
        payload: { content: [textContent(lines.join('\n'))] },
      } satisfies PushEventParams)
      .catch(() => {});
  }

  private channelLabel(channelId: string): string {
    const name = this.client.cache.getChannel(channelId)?.name;
    return name ? `#${name}` : channelId;
  }

  // ── Channels ──

  private allDescriptors(): ChannelDescriptor[] {
    return this.client.cache.allChannels().map(toDescriptor);
  }

  private registerChannels(): void {
    if (!this.conn) return;
    const added = this.allDescriptors().filter((d) => !this.registered.has(d.id));
    if (added.length === 0) return;
    for (const d of added) this.registered.add(d.id);
    this.conn.sendNotification(method.CHANNELS_CHANGED, { added });
  }
}

/** discord-mcpl-parity wake flags, derived from the relay's AddressInfo. The
 *  host's gate matches `metadataTrue` (any-of) against these. */
function wakeMetadata(
  message: PortalMessage,
  addressedToMe: boolean,
  reasons: AddressReason[],
): Record<string, unknown> {
  const isExplicitMention = reasons.includes('role_mention') || reasons.includes('name_mention');
  const isReplyToBot = reasons.includes('reply');
  const isDM = message.guildId === null || reasons.includes('dm');
  const isMention = isExplicitMention || isReplyToBot;
  // A persona author is one of our agents (posted via webhook → bot-like); a
  // user author may be a real bot. Matches discord-mcpl's isBot semantics so the
  // host's bot-skip policy behaves identically.
  const isBot =
    message.author.kind === 'persona' || (message.author.kind === 'user' && message.author.bot);
  return {
    addressed: addressedToMe,
    reasons: reasons.join(','),
    isMention,
    isExplicitMention,
    isReplyToBot,
    isBot,
    isDM,
  };
}

/** Host-facing author {id, name} for channels/incoming. */
function authorOf(message: PortalMessage): { id: string; name: string } {
  const a = message.author;
  if (a.kind === 'persona') return { id: a.personaId, name: a.displayName };
  if (a.kind === 'user') return { id: a.userId, name: a.displayName || a.username };
  return { id: 'system', name: 'system' };
}

/** Max image bytes to fetch + inline as a vision block. */
const IMAGE_INLINE_CAP = 5 * 1024 * 1024;

/** Build MCPL content blocks for a message: the text line, plus inlined image
 *  attachments (so the agent can actually see them) and notes for the rest.
 *  Best-effort — a failed fetch degrades to a text note, never drops the msg. */
async function buildContent(m: PortalMessage): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [textContent(render(m))];
  for (const att of m.attachments) {
    const ct = (att.contentType ?? '').toLowerCase();
    if (ct.startsWith('image/') && att.size > 0 && att.size <= IMAGE_INLINE_CAP) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(att.url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer()).toString('base64');
        blocks.push({ type: 'image', data, mimeType: ct });
      } catch (err) {
        blocks.push(textContent(`[image "${att.name}" unavailable: ${(err as Error).message} — ${att.url}]`));
      }
    } else if (m.attachments.length) {
      blocks.push(textContent(`[attachment "${att.name}" (${att.contentType ?? 'unknown'}, ${att.size}B) — ${att.url}]`));
    }
  }
  return blocks;
}

function render(m: PortalMessage): string {
  const who =
    m.author.kind === 'persona'
      ? m.author.displayName
      : m.author.kind === 'user'
        ? m.author.displayName
        : 'system';
  const body = m.cleanContent || m.content || '';
  const atts = m.attachments.length ? ` [${m.attachments.length} attachment(s)]` : '';
  return `${who}: ${body}${atts}`;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
