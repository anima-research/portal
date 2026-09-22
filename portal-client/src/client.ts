/**
 * PortalClient — WS transport + cache + typed RPC + reconnect/resume.
 *
 * Lifecycle: connect → hello → identify → ready. On an unexpected close it
 * reconnects and `resume`s from the last seq; a non-resumable rejection falls
 * back to a fresh identify. The agent-facing read watermark is NOT here — that
 * lives in portal-mcpl; this layer only does transport-level resume.
 */
import { randomUUID } from './uuid.js';
import { resolveWsFactory, type WsFactory, type WsLike } from './ws-compat.js';
import {
  PORTAL_PROTOCOL_VERSION,
  isServerFrame,
  type AddressReason,
  type PortalChannel,
  type PortalEvent,
  type PortalMessage,
  type PortalReaction,
  type ReactionActor,
  type ReadyData,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
} from '@animalabs/portal-protocol';
import { ClientCache } from './cache.js';
import { TypedEmitter } from './emitter.js';

export interface PortalClientOptions {
  url: string;
  token: string;
  personaId: string;
  /** Ambient channel subscriptions to request on connect. */
  subscriptions?: string[];
  /** RPC timeout in ms (default 15000). */
  rpcTimeoutMs?: number;
  /** Max reconnect backoff in ms (default 30000). */
  maxBackoffMs?: number;
  /** Provide a WebSocket impl. Defaults to the package entry's factory
   *  (Node `ws` via the main entry, native WebSocket via the browser entry). */
  wsFactory?: WsFactory;
}

type MessageEvent = { message: PortalMessage; addressedToMe: boolean; reasons: AddressReason[] };

export interface PortalClientEvents extends Record<string, (...args: never[]) => void> {
  ready: (data: ReadyData) => void;
  resumed: (replayed: number) => void;
  message: (e: MessageEvent) => void;
  messageUpdate: (e: MessageEvent) => void;
  messageDelete: (e: { channelId: string; threadId?: string; messageId: string }) => void;
  /** A reaction was added to a message (native = human/bot; pseudo = a persona
   *  reaction the relay tracks). */
  reactionAdd: (e: {
    channelId: string;
    threadId?: string;
    messageId: string;
    reaction: PortalReaction;
    /** One-line snippet of the reacted-to message's text — absent on pseudo
     *  reactions and text-less (attachment/embed-only) messages. */
    messageSnippet?: string;
  }) => void;
  reactionRemove: (e: {
    channelId: string;
    threadId?: string;
    messageId: string;
    emoji: string;
    actor: ReactionActor;
    /** See reactionAdd.messageSnippet. */
    messageSnippet?: string;
  }) => void;
  /** Any dispatch event, after the cache has been updated. */
  event: (e: PortalEvent) => void;
  /** A channel appeared or changed — including live capability changes (a
   *  rights edit relay-side arrives here with the channel's merged new caps). */
  channelChange: (channel: PortalChannel) => void;
  /** A channel or thread is gone (deleted, or its guild left the allow-list). */
  channelRemove: (e: { channelId: string; guildId: string | null }) => void;
  /** Live speech from a joined voice channel. Partials (`partial: true`)
   *  arrive on the ephemeral path — display-only, replace-in-place by
   *  utteranceId, never replayed on resume. Finals are durable events. */
  voiceTranscript: (e: Extract<PortalEvent, { type: 'voice_transcript' }>) => void;
  voiceStatus: (e: Extract<PortalEvent, { type: 'voice_status' }>) => void;
  /** Terminal outcome of a voice_speak request this persona made (spoken /
   *  interrupted / refused / error, with the voiced/unvoiced boundary). */
  voiceReceipt: (e: Extract<PortalEvent, { type: 'voice_receipt' }>) => void;
  close: (info: { code: number; willReconnect: boolean }) => void;
  error: (err: Error) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PortalClient extends TypedEmitter<PortalClientEvents> {
  readonly cache = new ClientCache();

  /** The persona this client is connected as (for self-message filtering). */
  get personaId(): string {
    return this.opts.personaId;
  }
  private ws?: WsLike;
  private opts: Required<Omit<PortalClientOptions, 'subscriptions' | 'wsFactory'>> &
    Pick<PortalClientOptions, 'subscriptions' | 'wsFactory'>;
  private pending = new Map<string, Pending>();
  private sessionId?: string;
  private lastSeq = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private backoff = 1000;
  private closedByUser = false;
  private ready = false;

  constructor(options: PortalClientOptions) {
    super();
    this.opts = {
      url: options.url,
      token: options.token,
      personaId: options.personaId,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 15_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      // Kept as a mutable set so subscribe/unsubscribe stay durable across
      // reconnects (identify replays this list).
      subscriptions: options.subscriptions ? [...options.subscriptions] : [],
      wsFactory: options.wsFactory,
    };
  }

  /** Connect and resolve once `ready` (or `resumed`) is received. */
  connect(): Promise<ReadyData> {
    this.closedByUser = false;
    return new Promise<ReadyData>((resolve, reject) => {
      const onReady = this.on('ready', (d) => {
        onReady();
        onErr();
        resolve(d);
      });
      const onErr = this.on('error', (e) => {
        if (!this.ready) {
          onReady();
          onErr();
          reject(e);
        }
      });
      this.open();
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, 'client closing');
  }

  /** Typed RPC call. */
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const id = `rpc_${randomUUID()}`;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, this.opts.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendFrame({ op: 'rpc', d: { id, method, params } });
    });
  }

  // Convenience wrappers
  sendMessage(params: RpcParams<'send_message'>) {
    return this.call('send_message', params);
  }
  editMessage(messageId: string, content: string) {
    return this.call('edit_message', { messageId, content });
  }
  deleteMessage(messageId: string) {
    return this.call('delete_message', { messageId });
  }
  react(messageId: string, emoji: string, visible = false, native = false) {
    return this.call('react', { messageId, emoji, visible, native });
  }
  unreact(messageId: string, emoji: string, native = false) {
    return this.call('unreact', { messageId, emoji, native });
  }
  listEmojis(guildId?: string) {
    return this.call('list_emojis', { guildId });
  }
  fetchHistory(params: RpcParams<'fetch_history'>) {
    return this.call('fetch_history', params);
  }
  async subscribe(channelId: string) {
    const subs = (this.opts.subscriptions ??= []);
    const added = !subs.includes(channelId);
    if (added) subs.push(channelId);
    try {
      return await this.call('subscribe_channel', { channelId });
    } catch (error) {
      if (added) this.opts.subscriptions = subs.filter((c) => c !== channelId);
      throw error;
    }
  }
  async unsubscribe(channelId: string) {
    const previous = [...(this.opts.subscriptions ?? [])];
    this.opts.subscriptions = previous.filter((c) => c !== channelId);
    try {
      return await this.call('unsubscribe_channel', { channelId });
    } catch (error) {
      this.opts.subscriptions = previous;
      throw error;
    }
  }
  /** Ask the relay to join a voice channel and stream transcripts here
   *  (auto-subscribes this session to the channel). Requires VOICE_LISTEN. */
  voiceJoin(channelId: string) {
    return this.call('voice_join', { channelId });
  }
  voiceLeave(channelId: string) {
    return this.call('voice_leave', { channelId });
  }
  /** Speak into a joined voice channel via the relay's grant-checked TTS
   *  output path. Resolves when queued; the outcome arrives as a
   *  `voiceReceipt` event carrying the returned requestId. Requires
   *  VOICE_SPEAK, and the relay must already be joined (voice_join). */
  voiceSpeak(params: RpcParams<'voice_speak'>) {
    return this.call('voice_speak', params);
  }
  /** Claim an invite to expand this persona's rights (RFC-005 §5.6). */
  claimInvite(code: string) {
    return this.call('claim_invite', { code });
  }
  /** Machine-mint a single-use, short-lived, channel-scoped enrollment invite
   *  (PORTAL_INVITE_MINTERS-gated; delegated caps must be a subset of this
   *  persona's own effective caps on each scoped channel). */
  mintInvite(params: RpcParams<'mint_invite'>) {
    return this.call('mint_invite', params);
  }
  /** Rotate this persona's token; persist the returned token (the old one dies). */
  rotateToken() {
    return this.call('rotate_token', {});
  }

  // ── Internals ──

  private open(): void {
    const ws = resolveWsFactory(this.opts.wsFactory)(this.opts.url);
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code: number) => this.onClose(code));
    ws.on('error', (err: Error) => this.emit('error', err));
  }

  private onMessage(raw: string): void {
    const parsed: unknown = safeParse(raw);
    if (!isServerFrame(parsed)) return;
    const frame = parsed as ServerFrame;
    switch (frame.op) {
      case 'hello':
        this.startHeartbeat(frame.d.heartbeatIntervalMs);
        if (this.sessionId && this.lastSeq >= 0) {
          this.sendFrame({ op: 'resume', d: { sessionId: this.sessionId, seq: this.lastSeq } });
        } else {
          this.identify();
        }
        return;
      case 'ready':
        this.ready = true;
        this.backoff = 1000;
        this.sessionId = frame.d.sessionId;
        this.lastSeq = frame.d.seq;
        this.cache.hydrate(frame.d);
        this.emit('ready', frame.d);
        return;
      case 'resumed':
        this.ready = true;
        this.backoff = 1000;
        this.emit('resumed', frame.d.replayedEvents);
        return;
      case 'invalid_session':
        // Can't resume — start fresh.
        this.sessionId = undefined;
        this.lastSeq = 0;
        if (frame.d.resumable) {
          /* relay said retry resume, but we lack state → identify */
        }
        this.identify();
        return;
      case 'heartbeat_ack':
        return;
      case 'dispatch':
        this.lastSeq = frame.seq;
        this.onEvent(frame.d);
        return;
      case 'dispatch_ephemeral':
        // Unsequenced by design (transcript partials): must not advance
        // lastSeq — resume replays only the durable stream.
        this.onEvent(frame.d);
        return;
      case 'rpc_result': {
        const p = this.pending.get(frame.d.id);
        if (!p) return;
        this.pending.delete(frame.d.id);
        clearTimeout(p.timer);
        if (frame.d.ok) p.resolve(frame.d.result);
        else p.reject(Object.assign(new Error(frame.d.error.message), { code: frame.d.error.code }));
        return;
      }
    }
  }

  private onEvent(event: PortalEvent): void {
    // Snapshot before apply — guild_delete removes the guild's channels from
    // the cache, but listeners still need to know WHICH channels vanished.
    const guildChannels =
      event.type === 'guild_delete'
        ? this.cache.allChannels().filter((c) => c.guildId === event.guildId)
        : [];
    const applied = this.cache.apply(event);
    this.emit('event', event);
    switch (event.type) {
      case 'message_create':
        this.emit('message', { message: event.message, addressedToMe: event.addressedToMe, reasons: event.reasons });
        break;
      case 'message_update':
        this.emit('messageUpdate', { message: event.message, addressedToMe: event.addressedToMe, reasons: event.reasons });
        break;
      case 'message_delete':
        this.emit('messageDelete', { channelId: event.channelId, threadId: event.threadId, messageId: event.messageId });
        break;
      case 'reaction_add':
        this.emit('reactionAdd', {
          channelId: event.channelId,
          threadId: event.threadId,
          messageId: event.messageId,
          reaction: event.reaction,
          messageSnippet: event.messageSnippet,
        });
        break;
      case 'reaction_remove':
        this.emit('reactionRemove', {
          channelId: event.channelId,
          threadId: event.threadId,
          messageId: event.messageId,
          emoji: event.emoji,
          actor: event.actor,
          messageSnippet: event.messageSnippet,
        });
        break;
      case 'channel_create':
      case 'channel_update':
      case 'thread_create':
      case 'thread_update':
        this.emit('channelChange', event.channel);
        break;
      case 'capabilities_update': {
        // The cache has already merged the new caps; surface the channel so
        // downstream layers (portal-mcpl → host registry) see rights changes
        // live instead of only at the next identify (issue #5). Unknown id ⇒
        // nothing to update — the channel_create carrying it is on its way.
        const channel = this.cache.getChannel(event.channelId);
        if (channel) this.emit('channelChange', channel);
        break;
      }
      case 'channel_delete':
      case 'thread_delete':
        // Only when the cache actually dropped something — a delete for a
        // channel we never knew must not fan a phantom removal downstream.
        if (applied) {
          this.emit('channelRemove', { channelId: event.channelId, guildId: event.guildId });
        }
        break;
      case 'guild_create':
        for (const channel of event.channels) this.emit('channelChange', channel);
        break;
      case 'guild_delete':
        for (const channel of guildChannels) {
          this.emit('channelRemove', { channelId: channel.id, guildId: event.guildId });
        }
        break;
      case 'voice_transcript':
        this.emit('voiceTranscript', event);
        break;
      case 'voice_status':
        this.emit('voiceStatus', event);
        break;
      case 'voice_receipt':
        this.emit('voiceReceipt', event);
        break;
    }
  }

  private identify(): void {
    this.sendFrame({
      op: 'identify',
      d: {
        protocolVersion: PORTAL_PROTOCOL_VERSION,
        token: this.opts.token,
        personaId: this.opts.personaId,
        subscriptions: this.opts.subscriptions,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.sendFrame({ op: 'heartbeat', d: { seq: this.lastSeq } }), intervalMs);
  }

  private onClose(code: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ready = false;
    const willReconnect = !this.closedByUser;

    // Schedule the reconnect BEFORE notifying listeners. emit() runs listeners
    // synchronously with no try/catch, so a throwing 'close' handler must not be
    // able to abort onClose and permanently stall the reconnect loop.
    if (willReconnect) {
      const capped = Math.min(this.backoff, this.opts.maxBackoffMs);
      // Jitter the delay (50–100% of the capped backoff) so a fleet of personas
      // dropped by a single relay restart reconnect spread out instead of in
      // lockstep — avoids a thundering-herd reconnect + role-rebind burst.
      const delay = capped / 2 + Math.random() * (capped / 2);
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
      setTimeout(() => {
        try {
          this.open();
        } catch (err) {
          // A synchronous open() failure must not end the reconnect loop:
          // before this guard, one throw inside the timer left the client
          // wedged forever — no socket, no retries, every RPC timing out
          // (field-observed as the "wedged portal MCP client" gotcha).
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
          this.onClose(0);
        }
      }, delay);
    }

    this.emit('close', { code, willReconnect });
  }

  private sendFrame(frame: unknown): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
