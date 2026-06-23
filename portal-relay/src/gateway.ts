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
  onOpen?(session: Session): void;
  onClose?(session: Session): void;
}

interface PersonaStream {
  seq: number;
  buffer: Array<{ seq: number; event: PortalEvent }>;
}

const BUFFER_CAP = 1000;

export class Session {
  readonly id: string;
  personaId = '';
  subscriptions = new Set<string>();
  identified = false;
  lastSeen = Date.now();

  constructor(
    private ws: WebSocket,
    private gateway: Gateway,
  ) {
    this.id = `sess_${randomUUID()}`;
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
  private sessionPersona = new Map<string, string>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private hooks: GatewayHooks,
    private heartbeatIntervalMs: number,
  ) {}

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
    ws.on('close', () => this.onDisconnect(session));
    ws.on('error', () => this.onDisconnect(session));
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
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'auth failed' } });
      session.close(4001, 'auth failed');
      return;
    }
    session.personaId = ok;
    session.identified = true;
    if (subscriptions) for (const c of subscriptions) session.subscriptions.add(c);
    this.register(session);
    this.streams.set(ok, this.streams.get(ok) ?? { seq: 0, buffer: [] });

    const ready = await this.hooks.buildReady(session);
    session.send({ op: 'ready', d: ready });
    this.hooks.onOpen?.(session);
  }

  private async onRegister(session: Session, d: RegisterData): Promise<void> {
    if (session.identified) return;
    if (!this.hooks.enroll) {
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'registration disabled' } });
      session.close(4003, 'registration disabled');
      return;
    }
    const res = await this.hooks.enroll(d);
    if ('error' in res) {
      session.send({ op: 'invalid_session', d: { resumable: false, reason: res.error } });
      session.close(4003, 'register failed');
      return;
    }
    // Promote the connection to an identified session for the minted persona,
    // so a client may register-and-stay (the throwaway-enroll path just reads
    // `registered` and reconnects with the saved token).
    session.personaId = res.personaId;
    session.identified = true;
    if (d.subscriptions) for (const c of d.subscriptions) session.subscriptions.add(c);
    this.register(session);
    this.streams.set(res.personaId, this.streams.get(res.personaId) ?? { seq: 0, buffer: [] });

    session.send({ op: 'registered', d: res });
    const ready = await this.hooks.buildReady(session);
    session.send({ op: 'ready', d: ready });
    this.hooks.onOpen?.(session);
  }

  private onResume(session: Session, sessionId: string, fromSeq: number): void {
    const personaId = this.sessionPersona.get(sessionId);
    const stream = personaId ? this.streams.get(personaId) : undefined;
    if (!personaId || !stream) {
      session.send({ op: 'invalid_session', d: { resumable: false, reason: 'unknown session' } });
      return;
    }
    session.personaId = personaId;
    session.identified = true;
    this.register(session);
    const missed = stream.buffer.filter((e) => e.seq > fromSeq);
    for (const e of missed) session.send({ op: 'dispatch', seq: e.seq, d: e.event });
    session.send({ op: 'resumed', d: { replayedEvents: missed.length } });
    this.hooks.onOpen?.(session);
  }

  private register(session: Session): void {
    this.sessions.set(session.id, session);
    this.sessionPersona.set(session.id, session.personaId);
    let set = this.byPersona.get(session.personaId);
    if (!set) this.byPersona.set(session.personaId, (set = new Set()));
    set.add(session);
  }

  private onDisconnect(session: Session): void {
    this.sessions.delete(session.id);
    this.byPersona.get(session.personaId)?.delete(session);
    this.hooks.onClose?.(session);
    // Keep sessionPersona for resume; it's pruned by buffer turnover.
  }

  private reapStale(): void {
    const cutoff = Date.now() - this.heartbeatIntervalMs * 2;
    for (const s of this.sessions.values()) {
      if (s.lastSeen < cutoff) s.close(4000, 'heartbeat timeout');
    }
  }

  // ── Dispatch ──

  /** Current seq for a persona (resume baseline at ready time). */
  seqOf(personaId: string): number {
    return this.streams.get(personaId)?.seq ?? 0;
  }

  /** Append an event to a persona's stream and fan out to its live sessions. */
  dispatch(personaId: string, event: PortalEvent): void {
    const stream = this.streams.get(personaId) ?? { seq: 0, buffer: [] };
    this.streams.set(personaId, stream);
    const seq = ++stream.seq;
    stream.buffer.push({ seq, event });
    if (stream.buffer.length > BUFFER_CAP) stream.buffer.shift();
    const frame: ServerFrame = { op: 'dispatch', seq, d: event };
    for (const s of this.byPersona.get(personaId) ?? []) s.send(frame);
  }

  /** Personas with at least one live session. */
  activePersonas(): string[] {
    return [...this.byPersona.entries()].filter(([, set]) => set.size > 0).map(([id]) => id);
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
