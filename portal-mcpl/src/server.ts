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
    // Live reactions → context, NEVER a wake. Only *native* (human/bot)
    // reactions are surfaced: the relay dispatches a persona's own *pseudo*
    // reaction back only to that persona, so skipping pseudo avoids echoing the
    // agent's own reactions. Per-channel opt-in (default off) via
    // set_reaction_visibility. discord-mcpl parity.
    this.client.on('reactionAdd', (e) => {
      if (e.reaction.kind === 'pseudo') return;
      this.pushReaction('add', e.channelId, e.messageId, e.reaction.emoji, e.reaction.by[0]?.name ?? 'someone');
    });
    this.client.on('reactionRemove', (e) => {
      if (e.actor.kind === 'persona') return;
      this.pushReaction('remove', e.channelId, e.messageId, e.emoji, e.actor.name);
    });
    this.client.on('messageDelete', (e) => {
      if (!this.conn || !this.mcplEnabled) return;
      // Only surface deletions for channels the host actually has open — a delete
      // in a channel the agent isn't following is zero-signal context noise.
      // (The relay also gates deletes by subscription; this is belt-and-braces.)
      if (!this.openChannels.has(e.channelId)) return;
      this.conn
        .sendRequest(method.PUSH_EVENT, {
          featureSet: 'portal.messaging',
          eventId: `portal_del_${e.messageId}`,
          timestamp: new Date().toISOString(),
          origin: { source: 'portal', channelId: portalChannelId(e.channelId) },
          tags: ['chat:deleted'],
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
    const tags = deriveTags(message, addressedToMe, reasons);
    const channelMcplId = portalChannelId(message.channelId);
    const inlineAudio = this.agent.state.isAudioVisible(message.channelId);
    // A clip too large to inline can't be heard by anyone — flag it in Discord
    // with a native 🐘 so the sender knows (idempotent: the shared bot reacts
    // once even if several opted-in agents notice it).
    if (inlineAudio) {
      for (const att of message.attachments) {
        if (audioMimeFor(att) && att.size > AUDIO_INLINE_CAP) {
          void this.client.react(message.id, '🐘', false, true).catch((err: Error) => {
            console.error(`[portal-mcpl] oversized-audio flag failed (needs ADD_REACTIONS): ${err.message}`);
          });
          break;
        }
      }
    }
    void buildContent(message, { inlineAudio }).then((content) => {
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
                tags,
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
            tags, // MCPL RFC-001 — the host routes/gates on these
            payload: { content },
          } satisfies PushEventParams)
          .catch(() => {});
      }
    });
  }

  /**
   * Surface a live reaction into the agent's context WITHOUT waking it. Gated by
   * the per-channel opt-in (set_reaction_visibility, default off). The push
   * carries the `chat:reaction` tag and an origin with NO wake flags
   * (isMention/isExplicitMention/addressed absent) — the host's wake gate matches
   * nothing, so the event is addMessage()'d into context but triggers no
   * inference. Mirrors discord-mcpl's non-waking reaction path.
   */
  private pushReaction(
    action: 'add' | 'remove',
    channelId: string,
    messageId: string,
    emoji: string,
    reactorName: string,
  ): void {
    if (!this.conn || !this.mcplEnabled) return;
    if (!this.agent.state.isReactionVisible(channelId)) return;
    const verb = action === 'add' ? 'reacted' : 'removed a reaction';
    const shown = renderReactionEmoji(emoji);
    const line = `[reaction] @${reactorName} ${verb} ${shown} on message ${messageId} in ${this.channelLabel(channelId)}`;
    this.conn
      .sendRequest(method.PUSH_EVENT, {
        featureSet: 'portal.messaging',
        eventId: `portal_reaction_${action}_${messageId}_${emoji}_${reactorName}_${this.eventSeq++}`,
        timestamp: new Date().toISOString(),
        // Deliberately NO wake flags on origin — reactions must never wake.
        origin: {
          source: 'portal',
          channelId: portalChannelId(channelId),
          messageId,
          reactor: reactorName,
          emoji: shown,
          action,
        },
        tags: ['chat:reaction'], // matches no wake policy → shown, not woken
        payload: { content: [textContent(line)] },
      } satisfies PushEventParams)
      .catch(() => {});
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
        tags: ['chat:addressed', 'chat:mention'],
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

/**
 * MCPL RFC-001 event tags for a portal message. Emits the reserved `chat:*` core
 * (including umbrellas like `chat:addressed`, so no host-side implication
 * expansion is required) plus the `portal:*` namespace. Derived from the relay's
 * per-persona AddressInfo — authoritative, no guessing.
 */
function deriveTags(
  message: PortalMessage,
  addressedToMe: boolean,
  reasons: AddressReason[],
): string[] {
  const t = new Set<string>();
  const mention = reasons.includes('role_mention') || reasons.includes('name_mention');
  if (mention) t.add('chat:mention');
  if (reasons.includes('reply')) t.add('chat:reply');
  if (message.guildId === null || reasons.includes('dm')) t.add('chat:dm');
  t.add(addressedToMe ? 'chat:addressed' : 'chat:ambient');
  // sender
  if (message.author.kind === 'persona') {
    t.add('chat:from-agent');
    t.add('portal:persona');
  } else if (message.author.kind === 'user') {
    t.add(message.author.bot ? 'chat:from-bot' : 'chat:from-human');
  }
  // content modality
  for (const a of message.attachments ?? []) {
    const ct = (a.contentType ?? '').toLowerCase();
    if (ct.startsWith('image/')) t.add('chat:has-image');
    else if (audioMimeFor(a)) t.add('chat:has-audio');
    else t.add('chat:has-file');
  }
  if (message.threadId) t.add('chat:thread');
  // portal namespace specifics
  if (reasons.includes('role_mention')) t.add('portal:role-mention');
  if (reasons.includes('name_mention')) t.add('portal:name-mention');
  if (reasons.includes('subscription')) t.add('portal:subscription');
  return [...t];
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
/** Max audio bytes to fetch + inline as an audio block (raw; ~16MB as base64,
 *  under typical provider inline-media ceilings with headroom for images). */
const AUDIO_INLINE_CAP = 12 * 1024 * 1024;
/** Max audio blocks inlined per message (each is large in tokens/bytes). */
const MAX_AUDIO_PER_MESSAGE = 2;

/** Extension → MIME fallback: Discord's attachment `contentType` is optional. */
const AUDIO_EXTENSION_MIME: Record<string, string> = {
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
};

/** Collapse MP3 MIME aliases (Discord reports `audio/mpeg`; legacy uploaders
 *  use `audio/mpeg3`/`audio/x-mpeg-3`) to the widely-expected `audio/mp3`. */
export function normalizeAudioMime(mime: string): string {
  const bare = mime.split(';')[0].trim().toLowerCase();
  return ['audio/mpeg', 'audio/mpg', 'audio/mpeg3', 'audio/x-mpeg-3'].includes(bare)
    ? 'audio/mp3'
    : bare;
}

/** Resolve an attachment's audio MIME: content-type first, else extension.
 *  Returns undefined when the attachment isn't audio (or isn't recognizable). */
export function audioMimeFor(att: { name: string; contentType: string | null }): string | undefined {
  const ct = (att.contentType ?? '').toLowerCase();
  if (ct.startsWith('audio/')) return normalizeAudioMime(ct);
  const ext = att.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_EXTENSION_MIME[ext];
}

/** Fetch an attachment body with a bounded timeout. */
async function fetchAttachment(url: string, timeoutMs = 15000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function attachmentNote(att: PortalMessage['attachments'][number]): string {
  const dur = att.duration !== undefined ? `, ${Math.round(att.duration)}s` : '';
  return `[attachment "${att.name}" (${att.contentType ?? 'unknown'}, ${att.size}B${dur}) — ${att.url}]`;
}

/** Build MCPL content blocks for a message: the text line, plus inlined image
 *  attachments (so the agent can actually see them), inlined audio when the
 *  channel is opted in (so it can hear them), and notes for the rest.
 *  Best-effort — a failed fetch degrades to a text note, never drops the msg.
 *  Exported for live verification (scripts drive a real model with its output). */
export async function buildContent(
  m: PortalMessage,
  opts: { inlineAudio?: boolean } = {},
): Promise<ContentBlock[]> {
  // Decide each attachment's treatment synchronously (audio slots are ordered),
  // then fetch the inlined ones concurrently — outcomes are independent.
  let audioSlots = MAX_AUDIO_PER_MESSAGE;
  const jobs: Promise<ContentBlock>[] = m.attachments.map((att) => {
    const ct = (att.contentType ?? '').toLowerCase();
    const audioMime = opts.inlineAudio ? audioMimeFor(att) : undefined;
    if (ct.startsWith('image/') && att.size > 0 && att.size <= IMAGE_INLINE_CAP) {
      return fetchAttachment(att.url).then(
        (buf): ContentBlock => ({ type: 'image', data: buf.toString('base64'), mimeType: ct }),
        (err: Error) => textContent(`[image "${att.name}" unavailable: ${err.message} — ${att.url}]`),
      );
    }
    if (audioMime && att.size > 0 && att.size <= AUDIO_INLINE_CAP && audioSlots > 0) {
      audioSlots--;
      return fetchAttachment(att.url).then(
        (buf): ContentBlock => ({ type: 'audio', data: buf.toString('base64'), mimeType: audioMime }),
        (err: Error) => textContent(`[audio "${att.name}" unavailable: ${err.message} — ${att.url}]`),
      );
    }
    // Audio that WOULD inline but can't — say why, so the agent can tell it
    // apart from a generic file.
    if (audioMime && att.size > AUDIO_INLINE_CAP) {
      return Promise.resolve(
        textContent(`[audio "${att.name}" too large to inline (${att.size}B > ${AUDIO_INLINE_CAP}B) — ${att.url}]`),
      );
    }
    if (audioMime && audioSlots <= 0) {
      return Promise.resolve(
        textContent(`[audio "${att.name}" not inlined (max ${MAX_AUDIO_PER_MESSAGE} per message) — ${att.url}]`),
      );
    }
    return Promise.resolve(textContent(attachmentNote(att)));
  });
  return [textContent(render(m)), ...(await Promise.all(jobs))];
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

/** Render a reaction emoji legibly: a custom `name:id` becomes `:name:`; unicode
 *  passes through. (The relay encodes customs as `name:id` on the wire.) */
function renderReactionEmoji(emoji: string): string {
  const m = /^(\w+):\d+$/.exec(emoji);
  return m ? `:${m[1]}:` : emoji;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
