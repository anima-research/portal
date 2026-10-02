/**
 * WebSocket gateway: connections, sessions, heartbeats, per-persona event
 * streams with resume, and fan-out.
 *
 * Each persona has its own monotonic seq stream and a bounded replay buffer.
 * Multiple sessions of one persona share that stream (fan-out); a session that
 * briefly drops can `resume` from its last seq. Long gaps fall back to a fresh
 * identify + history backfill (handled a layer up, in portal-mcpl).
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  PORTAL_PROTOCOL_VERSION,
  parseClientFrame,
  type ClientFrame,
  type PortalEvent,
  type ReadyData,
  type RegisterData,
  type RegisteredData,
  type RpcRequest,
  type ServerFrame,
} from '@animalabs/portal-protocol';

export interface GatewayHooks {
  /** Validate identify. Return a persona id on success, null to reject. */
  authenticate(token: string, personaId: string): string | null;
  /** Build the ready payload for a freshly identified session. */
  buildReady(session: Session): Promise<ReadyData>;
  /** Handle one RPC; the handler replies via `session.send`. */
  handleRpc(session: Session, req: RpcRequest): Promise<void>;
  /**
   * Self-registration. Mint a new persona from an invite template. Returns the
   * minted credentials on success or `{ error }` to reject. Absent → the relay
   * has no invites configured and registration is disabled.
   */
  enroll?(data: RegisterData): Promise<RegisteredData | { error: string }>;
  /**
   * Whether a persona may hold an ambient subscription to a channel. Applied
   * to the `subscriptions` restored at identify/register, with the same gate
   * `subscribe_channel` enforces — a restore must not be a way around it
   * (issue #27). Absent → every requested subscription is accepted.
   */
  canSubscribe?(personaId: string, channelId: string): boolean;
  onOpen?(session: Session): void;
  onClose?(session: Session): void;
}

interface PersonaStream {
  seq: number;
  buffer: Array<{ seq: number; event: PortalEvent }>;
}

interface ResumeSession {
  personaId: string;
  /** Absent while a socket using this resume key is live. */
  expiresAt?: number;
}

const BUFFER_CAP = 1000;
const RESUME_RETENTION_MS = 5 * 60_000;

export interface GatewayOptions {
  /** How long a disconnected session may resume (default 5 minutes).
   *  Replay is also limited by the 1000-event buffer. Live sessions never age
   *  out; events arriving while offline do not extend this deadline. */
  resumeRetentionMs?: number;
  /**
   * Sink for session-lifecycle lines (identify / resume / register / close /
   * heartbeat reap). Defaults to stderr. These are the only record of whether a
   * client that reports "can't connect" ever reached the relay, and how long
   * `ready` took — pass `() => {}` to silence.
   */
  log?: (line: string) => void;
}

/** Strings that end up in log lines — client-supplied or loaded from config —
 *  are bounded, reduced to printable ASCII, and have `"` / `\` escaped so a
 *  value can neither split a line nor pose as extra fields. */
function logSafe(v: unknown, max = 80): string {
  return String(v ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/[\\"]/g, (c) => `\\${c}`)
    .slice(0, max);
}

/** Pre-auth rejections a single socket may log before the rest are only
 *  counted (reported on its close line). Bounds log growth per connection. */
const REJECT_LOG_CAP = 3;

export class Session {
  readonly id: string;
  /** The original ready.sessionId, retained across successful resumes. */
  resumeId: string;
  personaId = '';
  subscriptions = new Set<string>();
  identified = false;
  lastSeen = Date.now();
  readonly connectedAt = Date.now();
  /** Set once the disconnect has been handled. */
  disconnected = false;
  /** `error` precedes `close` on a ws socket; keep the message for the close line. */
  lastError?: string;
  /** Heartbeat reaper already closed this socket; don't log/close it again. */
  reaped = false;
  /** Pre-auth rejections (bad identify, unknown resume) on this socket. */
  rejections = 0;

  constructor(
    private ws: WebSocket,
    private gateway: Gateway,
  ) {
    this.id = `sess_${randomUUID()}`;
    this.resumeId = this.id;
  }

  send(frame: ServerFrame): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  /** Hard-close the socket (used on shutdown so the listen port frees promptly). */
  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }

  touch(): void {
    this.lastSeen = Date.now();
  }
}

export class Gateway {
  private wss?: WebSocketServer;
  private sessions = new Map<string, Session>();
  private byPersona = new Map<string, Set<Session>>();
  private streams = new Map<string, PersonaStream>();
  /** Retains sessionId → personaId for a window so resume can find the stream. */
  private sessionPersona = new Map<string, ResumeSession>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private log: (line: string) => void;
  private resumeRetentionMs: number;

  constructor(
    private hooks: GatewayHooks,
    private heartbeatIntervalMs: number,
    opts: GatewayOptions = {},
  ) {
    this.log = opts.log ?? ((line) => console.error(line));
    this.resumeRetentionMs = opts.resumeRetentionMs ?? RESUME_RETENTION_MS;
    if (!Number.isFinite(this.resumeRetentionMs) || this.resumeRetentionMs < 0) {
      throw new RangeError('resumeRetentionMs must be a finite nonnegative number');
    }
  }

  /** `live=<sessions>/<personas>` — appended to lifecycle lines so a reconnect
   *  storm or a slow leak is visible from the log alone. */
  private live(): string {
    let personas = 0;
    for (const set of this.byPersona.values()) if (set.size > 0) personas++;
    return `live=${this.sessions.size}/${personas}`;
  }

  /** A log sink must never take a session down with it. */
  private emit(line: string): void {
    try {
      this.log(line);
    } catch {
      /* logging is best-effort */
    }
  }

  private sessionLog(event: string, session: Session, detail = ''): void {
    const who = session.personaId ? `persona=${logSafe(session.personaId)}` : 'persona=-';
    this.emit(
      `[portal-relay] session ${event} ${who} sess=${session.id.slice(5, 13)}${detail ? ' ' + detail : ''} ${this.live()}`,
    );
  }

  /** Pre-auth rejections are client-driven and the socket stays open, so a
   *  socket gets REJECT_LOG_CAP lines; after that they are only counted. */
  private rejectLog(event: string, session: Session, detail: string): void {
    session.rejections++;
    if (session.rejections <= REJECT_LOG_CAP) this.sessionLog(event, session, detail);
  }

  listen(port: number): void {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.heartbeatTimer = setInterval(() => this.reapStale(), this.heartbeatIntervalMs);
    console.error(`[portal-relay] gateway listening on ws://127.0.0.1:${port}`);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Hard-terminate so wss.close()'s callback (which waits for live sockets to
    // end) fires promptly and the listen port frees — critical for a clean
    // restart of the shared relay.
    for (const s of this.sessions.values()) s.terminate();
    this.sessions.clear();
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    await Promise.race([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  }

  private onConnection(ws: WebSocket): void {
    const session = new Session(ws, this);
    session.send({
      op: 'hello',
      d: { protocolVersion: PORTAL_PROTOCOL_VERSION, heartbeatIntervalMs: this.heartbeatIntervalMs },
    });
    ws.on('message', (data) => {
      const frame = parseClientFrame(data.toString());
      if (!frame) return;
      this.onFrame(session, frame).catch((err) =>
        console.error('[portal-relay] frame error:', (err as Error).message),
      );
    });
    // ws emits `close` after `error`, so the error only annotates the close line.
    ws.on('error', (err) => {
      session.lastError = err.message;
    });
    ws.on('close', (code, reason) =>
      this.onDisconnect(session, `code=${code}${reason?.length ? ` reason="${logSafe(reason.toString())}"` : ''}`),
    );
  }

  private async onFrame(session: Session, frame: ClientFrame): Promise<void> {
    session.touch();
    switch (frame.op) {
      case 'identify':
        return this.onIdentify(session, frame.d.token, frame.d.personaId, frame.d.subscriptions);
      case 'register':
        return this.onRegister(session, frame.d);
      case 'resume':
        return this.onResume(session, frame.d.sessionId, frame.d.seq);
      case 'heartbeat':
        session.send({ op: 'heartbeat_ack' });
        return;
      case 'rpc':
        if (!session.identified) {
          session.send({
            op: 'rpc_result',
            d: { id: frame.d.id, ok: false, error: { code: 'FORBIDDEN', message: 'not identified' } },
          });
          return;
        }
        return this.hooks.handleRpc(session, frame.d);
    }
  }

  private async onIdentify(
    session: Session,
    token: string,
    personaId: string,
    subscriptions?: string[],
  ): Promise<void> {
    if (session.identified) return;
    const ok = this.hooks.authenticate(token, personaId);
    if (!ok) {
      this.rejectLog('identify-rejected', session, `claimed="${logSafe(personaId)}" reason="auth failed"`);
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'auth failed' } });
      session.close(4001, 'auth failed');
      return;
    }
    session.personaId = ok;
    session.identified = true;
    this.restoreSubscriptions(session, subscriptions);
    this.register(session);
    this.streams.set(ok, this.streams.get(ok) ?? { seq: 0, buffer: [] });

    await this.sendReady(session, 'identify');
  }

  /**
   * Build and send `ready`, timing it. `buildReady` awaits real Discord calls;
   * if it throws, the client would otherwise sit on an open, heartbeating
   * socket waiting for a `ready` that never comes — close instead, so its
   * reconnect loop gets another try.
   */
  private async sendReady(session: Session, via: 'identify' | 'register'): Promise<void> {
    const t0 = Date.now();
    let ready: ReadyData;
    try {
      ready = await this.hooks.buildReady(session);
    } catch (err) {
      session.close(1011, 'ready failed');
      this.sessionLog(`${via}-failed`, session, `ready-ms=${Date.now() - t0} error="${logSafe((err as Error).message, 160)}"`);
      return;
    }
    if (session.disconnected) {
      // The client left while ready was being built; `send` would drop the
      // frame silently. Say so rather than record a success nobody received.
      this.sessionLog(`${via}-abandoned`, session, `ready-ms=${Date.now() - t0}`);
      return;
    }
    session.send({ op: 'ready', d: ready });
    this.sessionLog(
      via,
      session,
      `ready-ms=${Date.now() - t0} since-connect-ms=${Date.now() - session.connectedAt} channels=${ready.channels.length} subs=${session.subscriptions.size}`,
    );
    this.hooks.onOpen?.(session);
  }

  private async onRegister(session: Session, d: RegisterData): Promise<void> {
    if (session.identified) return;
    if (!this.hooks.enroll) {
      this.sessionLog('register-rejected', session, 'reason="registration disabled"');
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'registration disabled' } });
      session.close(4003, 'registration disabled');
      return;
    }
    const res = await this.hooks.enroll(d);
    if ('error' in res) {
      this.sessionLog('register-rejected', session, `reason="${logSafe(res.error, 160)}"`);
      session.send({ op: 'invalid_session', d: { resumable: false, reason: res.error } });
      session.close(4003, 'register failed');
      return;
    }
    // Promote the connection to an identified session for the minted persona,
    // so a client may register-and-stay (the throwaway-enroll path just reads
    // `registered` and reconnects with the saved token).
    session.personaId = res.personaId;
    session.identified = true;
    this.restoreSubscriptions(session, d.subscriptions);
    this.register(session);
    this.streams.set(res.personaId, this.streams.get(res.personaId) ?? { seq: 0, buffer: [] });

    session.send({ op: 'registered', d: res });
    await this.sendReady(session, 'register');
  }

  /** Restore the client's requested ambient subscriptions, dropping (silently —
   *  identify has no per-channel error channel) any the hook refuses. */
  private restoreSubscriptions(session: Session, requested?: string[]): void {
    if (!requested) return;
    for (const c of requested) {
      if (this.hooks.canSubscribe && !this.hooks.canSubscribe(session.personaId, c)) continue;
      session.subscriptions.add(c);
    }
  }

  private onResume(session: Session, sessionId: string, fromSeq: number): void {
    if (session.identified || session.disconnected) return;
    this.pruneResumeState(Date.now());
    const personaId = this.sessionPersona.get(sessionId)?.personaId;
    const stream = personaId ? this.streams.get(personaId) : undefined;
    if (!personaId || !stream) {
      this.rejectLog('resume-rejected', session, `reason="unknown session" from-seq=${logSafe(fromSeq, 16)}`);
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'unknown session' } });
      return;
    }
    // Gap detection: if events the session missed have already been shifted
    // out of the bounded buffer, a silent partial replay would leave the
    // client believing it is current while holding stale channel/rights
    // state — force a fresh identify (full ready rehydrate) instead.
    const oldest = stream.buffer[0]?.seq;
    const gap = oldest !== undefined ? fromSeq < oldest - 1 : fromSeq < stream.seq;
    if (gap) {
      this.emit(
        `[portal-relay] session resume-rejected persona=${logSafe(personaId)} sess=${session.id.slice(5, 13)} reason="resume window exceeded" from-seq=${logSafe(fromSeq, 16)} stream-seq=${stream.seq} ${this.live()}`,
      );
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'resume window exceeded' } });
      return;
    }
    session.personaId = personaId;
    session.identified = true;
    // The resumed frame supplies no replacement sessionId. Keep accepting
    // the key the client received in ready, rather than leaking one key per
    // reconnect or expiring a key that is still in active use.
    session.resumeId = sessionId;
    this.register(session);
    const missed = stream.buffer.filter((e) => e.seq > fromSeq);
    for (const e of missed) session.send({ op: 'dispatch', seq: e.seq, d: e.event });
    session.send({ op: 'resumed', d: { replayedEvents: missed.length } });
    this.sessionLog('resume', session, `replayed=${missed.length} since-connect-ms=${Date.now() - session.connectedAt}`);
    this.hooks.onOpen?.(session);
  }

  private register(session: Session): void {
    this.sessions.set(session.id, session);
    this.sessionPersona.set(session.resumeId, { personaId: session.personaId });
    let set = this.byPersona.get(session.personaId);
    if (!set) this.byPersona.set(session.personaId, (set = new Set()));
    set.add(session);
  }

  private onDisconnect(session: Session, why = ''): void {
    if (session.disconnected) return;
    session.disconnected = true;
    this.sessions.delete(session.id);
    const live = this.byPersona.get(session.personaId);
    live?.delete(session);
    if (live?.size === 0) this.byPersona.delete(session.personaId);
    const retained = this.sessionPersona.get(session.resumeId);
    if (retained && ![...(live ?? [])].some((s) => s.resumeId === session.resumeId)) {
      retained.expiresAt = Date.now() + this.resumeRetentionMs;
    }
    const extra = [
      session.lastError ? `error="${logSafe(session.lastError)}"` : '',
      session.rejections ? `rejections=${session.rejections}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    this.sessionLog(
      session.identified ? 'close' : 'close-unidentified',
      session,
      `${why}${extra ? ' ' + extra : ''} age-s=${Math.round((Date.now() - session.connectedAt) / 1000)}`,
    );
    this.hooks.onClose?.(session);
    // The heartbeat sweep releases expired resume keys and unused streams.
  }

  private reapStale(): void {
    const now = Date.now();
    this.pruneResumeState(now);
    const cutoff = now - this.heartbeatIntervalMs * 2;
    for (const s of this.sessions.values()) {
      if (s.lastSeen < cutoff && !s.reaped) {
        s.reaped = true; // the socket stays in `sessions` until its close event
        this.sessionLog('heartbeat-timeout', s, `idle-s=${Math.round((Date.now() - s.lastSeen) / 1000)}`);
        s.close(4000, 'heartbeat timeout');
      }
    }
  }

  /** Expire disconnected keys, then release streams nobody can resume.
   *  Dispatch does not refresh retention: a busy guild must not keep an
   *  absent persona's replay buffer alive forever. */
  private pruneResumeState(now: number): void {
    const retainedPersonas = new Set<string>();
    for (const [id, retained] of this.sessionPersona) {
      if (retained.expiresAt !== undefined && retained.expiresAt <= now) {
        this.sessionPersona.delete(id);
      } else {
        retainedPersonas.add(retained.personaId);
      }
    }
    for (const personaId of this.streams.keys()) {
      if (!retainedPersonas.has(personaId) && !this.byPersona.has(personaId)) {
        this.streams.delete(personaId);
      }
    }
  }

  // ── Dispatch ──

  /** Current seq for a persona (resume baseline at ready time). */
  seqOf(personaId: string): number {
    return this.streams.get(personaId)?.seq ?? 0;
  }

  /** Append an event to a persona's stream and fan out to its live sessions. */
  dispatch(personaId: string, event: PortalEvent): void {
    const stream = this.streams.get(personaId);
    // Only identify/register establishes a stream. An offline identity update
    // or a late voice event must not recreate state after retention expires.
    if (!stream) return;
    const seq = ++stream.seq;
    stream.buffer.push({ seq, event });
    if (stream.buffer.length > BUFFER_CAP) stream.buffer.shift();
    const frame: ServerFrame = { op: 'dispatch', seq, d: event };
    for (const s of this.byPersona.get(personaId) ?? []) s.send(frame);
  }

  /**
   * Fan out an event to a persona's live sessions WITHOUT sequencing it —
   * no stream append, no replay on resume. For high-frequency display-only
   * events (voice transcript partials) that would churn the replay buffer:
   * a resumed session has no use for stale interim captions, and BUFFER_CAP
   * worth of partials would evict the durable events resume actually needs.
   */
  dispatchEphemeral(personaId: string, event: PortalEvent): void {
    const frame: ServerFrame = { op: 'dispatch_ephemeral', d: event };
    for (const s of this.byPersona.get(personaId) ?? []) s.send(frame);
  }

  /** Personas with at least one live session. */
  activePersonas(): string[] {
    return [...this.byPersona.entries()].filter(([, set]) => set.size > 0).map(([id]) => id);
  }

  /**
   * Personas with a retained event stream — identified at least once since
   * boot and still live or within the resume window. Structural/rights events
   * dispatch to these (buffered for resume) so a briefly-dropped agent doesn't miss a
   * channel_create/channel_delete/capabilities_update; messages deliberately
   * do NOT (offline message catch-up rides durable read-state instead).
   */
  streamPersonas(): string[] {
    return [...this.streams.keys()];
  }

  hasStream(personaId: string): boolean {
    return this.streams.has(personaId);
  }

  /** Drop a persona's stream + buffer (identity removed — not token rotation,
   *  which keeps the stream so re-authed sessions can resume). */
  dropStream(personaId: string): void {
    this.streams.delete(personaId);
    for (const [id, retained] of this.sessionPersona) {
      if (retained.personaId === personaId) this.sessionPersona.delete(id);
    }
  }

  sessionsOf(personaId: string): Session[] {
    return [...(this.byPersona.get(personaId) ?? [])];
  }

  /** Close all live sessions of a persona (e.g. identity removed/revoked). */
  closePersona(personaId: string, code = 4001, reason = 'persona revoked'): void {
    for (const s of [...(this.byPersona.get(personaId) ?? [])]) s.close(code, reason);
  }

  /** Whether any live session of a persona subscribes to a channel. */
  personaSubscribed(personaId: string, channelId: string): boolean {
    for (const s of this.byPersona.get(personaId) ?? []) {
      if (s.subscriptions.has(channelId)) return true;
    }
    return false;
  }
}
