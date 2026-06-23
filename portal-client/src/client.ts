/**
 * PortalClient — WS transport + cache + typed RPC + reconnect/resume.
 *
 * Lifecycle: connect → hello → identify → ready. On an unexpected close it
 * reconnects and `resume`s from the last seq; a non-resumable rejection falls
 * back to a fresh identify. The agent-facing read watermark is NOT here — that
 * lives in portal-mcpl; this layer only does transport-level resume.
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  PORTAL_PROTOCOL_VERSION,
  isServerFrame,
  type AddressReason,
  type PortalChannel,
  type PortalEvent,
  type PortalMessage,
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
  /** Provide a WebSocket impl (tests). Defaults to ws. */
  wsFactory?: (url: string) => WebSocket;
}

type MessageEvent = { message: PortalMessage; addressedToMe: boolean; reasons: AddressReason[] };

export interface PortalClientEvents extends Record<string, (...args: never[]) => void> {
  ready: (data: ReadyData) => void;
  resumed: (replayed: number) => void;
  message: (e: MessageEvent) => void;
  messageUpdate: (e: MessageEvent) => void;
  messageDelete: (e: { channelId: string; threadId?: string; messageId: string }) => void;
  /** Any dispatch event, after the cache has been updated. */
  event: (e: PortalEvent) => void;
  channelChange: (channel: PortalChannel) => void;
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
  private ws?: WebSocket;
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
  react(messageId: string, emoji: string, visible = false) {
    return this.call('react', { messageId, emoji, visible });
  }
  fetchHistory(params: RpcParams<'fetch_history'>) {
    return this.call('fetch_history', params);
  }
  subscribe(channelId: string) {
    const subs = (this.opts.subscriptions ??= []);
    if (!subs.includes(channelId)) subs.push(channelId);
    return this.call('subscribe_channel', { channelId });
  }
  unsubscribe(channelId: string) {
    this.opts.subscriptions = (this.opts.subscriptions ?? []).filter((c) => c !== channelId);
    return this.call('unsubscribe_channel', { channelId });
  }
  /** Claim an invite to expand this persona's rights (RFC-005 §5.6). */
  claimInvite(code: string) {
    return this.call('claim_invite', { code });
  }
  /** Rotate this persona's token; persist the returned token (the old one dies). */
  rotateToken() {
    return this.call('rotate_token', {});
  }

  // ── Internals ──

  private open(): void {
    const ws = this.opts.wsFactory ? this.opts.wsFactory(this.opts.url) : new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on('message', (data: Buffer | string) => this.onMessage(data.toString()));
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
    this.cache.apply(event);
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
      case 'channel_create':
      case 'channel_update':
      case 'thread_create':
      case 'thread_update':
        this.emit('channelChange', event.channel);
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
    this.emit('close', { code, willReconnect });
    if (!willReconnect) return;
    const delay = Math.min(this.backoff, this.opts.maxBackoffMs);
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    setTimeout(() => this.open(), delay);
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
