/**
 * PortalClient — WS transport + cache + typed RPC + reconnect/resume.
 *
 * Lifecycle: connect → hello → identify → ready. On an unexpected close it
 * reconnects and `resume`s from the last seq; a non-resumable rejection falls
 * back to a fresh identify. Either way the relay session gets this client's
 * ambient subscriptions back: identify carries them, and a resume replays
 * them, since a resumed relay session starts with none. The agent-facing read
 * watermark is NOT here — that lives in portal-mcpl; this layer only does
 * transport-level resume.
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
  /** Ambient channel subscriptions to request on connect. The client keeps
   *  them, with subscribe() and unsubscribe()'s changes, and asks the relay for
   *  them again on every reconnect, a resume included; the relay leaves out
   *  any it refuses. */
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

/** Options for PortalClient.subscribe() and unsubscribe(). */
export interface SubscriptionOptions {
  /** false: a failed call leaves its change to the list standing, as a
   *  success would, for a caller whose subscribe or unsubscribe must hold
   *  whether or not the relay answers. Defaults to true. */
  undo?: boolean;
}

/** A subscribe or unsubscribe still waiting, with whether it lists its
 *  channel (PortalClient.subscriptionCall). Each call is its own object, so a
 *  run finds a call by identity. */
interface SubscriptionCall {
  listed: boolean;
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
  /** Each channel with a subscribe or unsubscribe still waiting
   *  (subscriptionCall): whether the list held the channel before those
   *  calls, as the calls that stood leave it, and the calls still waiting,
   *  oldest first, each with whether it lists the channel. */
  private readonly subscriptionRuns = new Map<string, { before: boolean; calls: SubscriptionCall[] }>();
  /** The reconnect onClose scheduled, until it runs or cancelReconnect()
   *  cancels it: close(), a connect() once its own socket exists, or onClose
   *  scheduling the next. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** RPC frames waiting for a session that can take them: identified (`ready`
   *  or `resumed`) and on an OPEN socket. Held through startup, reconnects and
   *  a CLOSING socket, and flushed by flushOutbox in call order. Each frame is
   *  serialized when the call is made, so a caller mutating its params
   *  afterwards can't change what gets sent. Each call's own timer still
   *  bounds how long it waits; close() rejects them. */
  private outbox: Array<{ id: string; json: string }> = [];
  /** Each connect() still waiting to settle: what close() calls to reject
   *  it. */
  private readonly connecting = new Set<() => void>();

  constructor(options: PortalClientOptions) {
    super();
    this.opts = {
      url: options.url,
      token: options.token,
      personaId: options.personaId,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 15_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      // Kept as a mutable set so subscribe/unsubscribe stay durable across
      // reconnects: identify carries this list, and a resume replays it
      // (restoreSubscriptions).
      subscriptions: options.subscriptions ? [...options.subscriptions] : [],
      wsFactory: options.wsFactory,
    };
  }

  /** Connect and resolve once `ready` (or `resumed`) is received. A client
   *  that still holds a session, after close() or while a reconnect waits,
   *  resumes it. The relay answers a resume it honours with `resumed`, and no
   *  `ready`: connect() then resolves with the session as the client holds it
   *  after the relay's replay (sessionSnapshot). A resume it refuses gets
   *  `invalid_session`, the client identifies, and connect() resolves on that
   *  fresh session's `ready`. An error before then rejects it, and so does
   *  close(). */
  connect(): Promise<ReadyData> {
    this.closedByUser = false;
    return new Promise<ReadyData>((resolve, reject) => {
      const done = () => {
        offReady();
        offResumed();
        offErr();
        this.connecting.delete(cancel);
      };
      const cancel = () => {
        done();
        reject(new Error('connect() cancelled: client closed'));
      };
      this.connecting.add(cancel);
      const offReady = this.on('ready', (d) => {
        done();
        resolve(d);
      });
      const offResumed = this.on('resumed', () => {
        const snapshot = this.sessionSnapshot();
        // A `resumed` for no session this client holds answers no resume of
        // ours, so keep waiting for `ready`.
        if (!snapshot) return;
        done();
        resolve(snapshot);
      });
      // An error before this connect() settles rejects it. Its listeners go
      // once it settles, so a later error doesn't reach it. `ready` can't
      // stand in for settled here: a `resumed` for no session the client
      // holds sets it while this connect() keeps waiting.
      const offErr = this.on('error', (e) => {
        done();
        reject(e);
      });
      try {
        this.open();
      } catch (err) {
        // The factory couldn't make a socket: nothing will answer these
        // listeners, so remove them before the rejection.
        done();
        throw err;
      }
    });
  }

  /** The session the client holds, as `ready` would describe it: its id, the
   *  last seq it has seen, and the persona and directory as the cache holds
   *  them. The relay replays what a resumed session missed before it sends
   *  `resumed`, so at that point the cache has applied it. Like ready's, the
   *  channels are those the persona has a capability in: the cache keeps a
   *  channel whose capabilities were revoked, with none. Undefined when the
   *  client holds no session. */
  private sessionSnapshot(): ReadyData | undefined {
    const persona = this.cache.persona;
    if (!this.sessionId || !persona) return undefined;
    return {
      sessionId: this.sessionId,
      persona,
      guilds: this.cache.allGuilds(),
      channels: this.cache.allChannels().filter((c) => c.capabilities.length > 0),
      seq: this.lastSeq,
    };
  }

  /** Close the connection, and cancel a reconnect still waiting for its
   *  backoff, so a closed client stays closed until connect(). */
  close(): void {
    this.closedByUser = true;
    // A real socket's close event comes only after its closing handshake, so
    // close() marks the session gone itself: a connect() made before then
    // holds calls until its own session is ready.
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.cancelReconnect();
    // A connect() still waiting for its session won't get one now.
    for (const cancel of [...this.connecting]) cancel();
    // Unsent work dies with the client: a later connect() must not run an
    // operation the caller issued before shutting down. Calls already sent
    // keep their timers, since a result can still arrive before the socket
    // finishes closing.
    const held = this.outbox;
    this.outbox = [];
    for (const { id } of held) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error('RPC cancelled: client closed'));
      }
    }
    this.ws?.close(1000, 'client closing');
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Typed RPC call. */
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.closedByUser) return Promise.reject(new Error('RPC cancelled: client closed'));
    const id = `rpc_${randomUUID()}`;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const json = JSON.stringify({ op: 'rpc', d: { id, method, params } });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A call that timed out while held must not be sent later, nor pile
        // up across a long outage. It never ran, so a retry is safe; one that
        // was sent may have run, and its error says so. Both keep "timed out",
        // which callers may match.
        const held = this.outbox.some((f) => f.id === id);
        this.outbox = this.outbox.filter((f) => f.id !== id);
        reject(new Error(held
          ? `RPC ${method} timed out before it was sent: no relay session within ${this.opts.rpcTimeoutMs} ms`
          : `RPC ${method} timed out after it was sent; it may have run`));
      }, this.opts.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.outbox.push({ id, json });
      if (this.ready) this.flushOutbox();
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
  /** Subscribe to a channel's ambient events. The channel joins the list a
   *  reconnect restores at once. A failed call is undone as subscriptionCall
   *  says, unless `undo` is false: then the channel stays listed, as after a
   *  success, and the next resume or identify asks the relay for it again. */
  async subscribe(channelId: string, options: SubscriptionOptions = {}) {
    return this.subscriptionCall('subscribe_channel', channelId, true, options.undo !== false);
  }
  /** Unsubscribe from a channel's ambient events. The channel leaves the list
   *  a reconnect restores at once. A failed call is undone as subscriptionCall
   *  says, unless `undo` is false: then the channel stays out of the list, as
   *  after a success. */
  async unsubscribe(channelId: string, options: SubscriptionOptions = {}) {
    return this.subscriptionCall('unsubscribe_channel', channelId, false, options.undo !== false);
  }
  /** Whether the channel is in the list a reconnect restores, as subscribe()
   *  and unsubscribe() leave it. That's this client's request, not the
   *  relay's state: the relay may have refused the channel, as the list keeps
   *  a refused one. `list_subscriptions` gives the relay's own view. */
  isListed(channelId: string): boolean {
    return (this.opts.subscriptions ?? []).includes(channelId);
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
    // One reconnect at a time: a connect()'s socket takes the place of a
    // reconnect waiting for its backoff, so the timer doesn't open a second
    // one. A factory that throws leaves the waiting reconnect to try again.
    this.cancelReconnect();
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
        this.flushOutbox();
        this.emit('ready', frame.d);
        return;
      case 'resumed':
        this.ready = true;
        this.backoff = 1000;
        this.flushOutbox();
        this.restoreSubscriptions();
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

  /**
   * A resumed relay session starts with no ambient subscriptions (identify
   * carries them, a resume doesn't), so ask for each channel in the list again,
   * before `resumed` is emitted. The answers aren't awaited. A channel the relay
   * refuses, such as one this persona can no longer view, stays in the list, as
   * identify's restore drops a refused channel without a word: the next resume
   * or identify asks again. After close(), call() refuses each of these, so a
   * `resumed` frame that arrives then asks the relay for nothing.
   */
  private restoreSubscriptions(): void {
    for (const channelId of this.opts.subscriptions ?? []) {
      this.call('subscribe_channel', { channelId }).catch(() => {});
    }
  }

  /**
   * Send a subscribe or unsubscribe, putting its change in the list at once.
   * While calls on the channel are waiting, the list holds what the newest of
   * them that hasn't failed asks for. A call that succeeds stands, as does one
   * that fails with `undo` false, and the calls before it no longer count.
   * Once every call made since the last one that stood has failed, the list
   * holds what it held before them, so failed calls change nothing. When a
   * failed call was the newest on the channel, the relay is told the list's
   * state for it.
   */
  private async subscriptionCall(
    method: 'subscribe_channel' | 'unsubscribe_channel',
    channelId: string,
    listed: boolean,
    undo: boolean,
  ) {
    let run = this.subscriptionRuns.get(channelId);
    if (!run) {
      run = { before: this.isListed(channelId), calls: [] };
      this.subscriptionRuns.set(channelId, run);
    }
    const call: SubscriptionCall = { listed };
    run.calls.push(call);
    this.setListed(channelId, listed);
    try {
      const result = await this.call(method, { channelId });
      this.settleSubscriptionCall(channelId, call, 'stood');
      return result;
    } catch (error) {
      this.settleSubscriptionCall(channelId, call, undo ? 'failed' : 'failed, stands');
      throw error;
    }
  }

  /** Apply a settled subscribe or unsubscribe to the list (subscriptionCall).
   *  A call that a later call's standing has already passed over changes
   *  nothing. */
  private settleSubscriptionCall(
    channelId: string,
    call: SubscriptionCall,
    outcome: 'stood' | 'failed' | 'failed, stands',
  ): void {
    const run = this.subscriptionRuns.get(channelId);
    const at = run ? run.calls.indexOf(call) : -1;
    if (!run || at === -1) return;
    const wasNewest = at === run.calls.length - 1;
    if (outcome === 'failed') {
      run.calls.splice(at, 1);
    } else {
      run.before = call.listed;
      run.calls.splice(0, at + 1);
    }
    const newest = run.calls.at(-1);
    this.setListed(channelId, newest ? newest.listed : run.before);
    if (!newest) this.subscriptionRuns.delete(channelId);
    if (outcome !== 'stood' && wasNewest) this.reassertSubscription(channelId);
  }

  private setListed(channelId: string, listed: boolean): void {
    if (this.isListed(channelId) === listed) return;
    if (listed) (this.opts.subscriptions ??= []).push(channelId);
    else this.opts.subscriptions = (this.opts.subscriptions ?? []).filter((c) => c !== channelId);
  }

  /**
   * After a subscribe or unsubscribe fails while it's still the newest call on
   * its channel (subscriptionCall), tell the relay the list's state for the
   * channel once, its answer ignored. A failed call can still have reached
   * the relay, with only its reply lost, so without this the relay could keep a
   * subscription the list has dropped, or have dropped one the list keeps.
   * After close(), call() refuses it, and the next connect() rebuilds the
   * relay's set from the list.
   */
  private reassertSubscription(channelId: string): void {
    const listed = (this.opts.subscriptions ?? []).includes(channelId);
    this.call(listed ? 'subscribe_channel' : 'unsubscribe_channel', { channelId }).catch(() => {});
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
      // One reconnect waits at a time, so close() and connect() reach it.
      this.cancelReconnect();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
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

  /** Send the held RPCs in call order. `ready` alone isn't enough: a socket
   *  can be CLOSING before its close event resets `ready`, so whatever trySend
   *  refuses stays held for the next `ready`/`resumed`. */
  private flushOutbox(): void {
    while (this.outbox.length > 0 && this.trySend(this.outbox[0].json)) this.outbox.shift();
  }

  /** Control frames (identify, resume, heartbeat) are dropped when the socket
   *  isn't OPEN; the next connection sends its own. */
  private sendFrame(frame: unknown): void {
    this.trySend(JSON.stringify(frame));
  }

  /** Send on an OPEN socket. Returns false, sending nothing, otherwise. */
  private trySend(json: string): boolean {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(json);
    return true;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
