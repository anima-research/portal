/**
 * Voice listener: joins Discord voice channels and turns speech into
 * transcript events, one Scribe session per active speaker.
 *
 * Division of labour with the rest of the relay:
 *  - This file owns @discordjs/voice, opus decoding, and the ElevenLabs
 *    Scribe v2 Realtime WebSocket protocol. Nothing else in the relay knows
 *    any of that exists.
 *  - Relay wires `transcript`/`status` handlers and applies the delivery
 *    policy (subscription gate, ephemeral partials vs sequenced finals).
 *
 * Speaker model: Discord hands us a separate Opus stream per speaking user —
 * which is exactly Scribe Realtime's expectation (it has no realtime
 * diarization; one WS per speaker is the intended pattern). Sessions are
 * per-utterance: opened when a user starts speaking, force-committed and
 * closed when Discord's silence detector ends their stream. `previous_text`
 * carries conversational context across a speaker's consecutive utterances.
 * Concurrency therefore tracks *simultaneous speakers*, not channel size —
 * comfortably inside per-key session limits.
 *
 * Audio path: 48 kHz stereo Opus → decode (prism-media) → downmix to mono
 * PCM16LE → base64 chunks (~200 ms) → Scribe (`audio_format=pcm_48000`, no
 * resample; 48 kHz is natively accepted). VAD commit is enabled as a backstop,
 * but the authoritative utterance boundary is Discord's per-speaker silence.
 *
 * Utterance/finals contract (see `reduceScribeMessage`): every utterance emits
 * any number of partials and EXACTLY ONE final — after Discord closed the
 * stream, once Scribe's post-commit transcript arrives (or the drain window
 * expires, in which case whatever was committed so far is the final). Scribe
 * may commit more than once inside one utterance (VAD backstop); those
 * mid-utterance commits surface as partials carrying the cumulative text, so
 * downstream keys (`portal_voice_<utteranceId>`) never see two finals.
 *
 * Privacy: sessions are opened with `enable_logging=false` (ElevenLabs zero
 * retention) — RFC-006 §6: raw audio is not retained beyond the STT session.
 */

import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import prism from 'prism-media';
import WebSocket from 'ws';
import { ChannelType } from 'discord.js';
import type { Client, VoiceBasedChannel } from 'discord.js';

export interface VoiceTranscript {
  channelId: string;
  guildId: string;
  userId: string;
  username: string;
  displayName: string;
  bot: boolean;
  /** Stable per-utterance key; partials replace-in-place under it. Unique
   *  across relay restarts (carries a per-process epoch) so host-side
   *  eventId dedup never swallows a fresh utterance. */
  utteranceId: string;
  text: string;
  partial: boolean;
  /** ms epoch when this utterance's audio began. */
  startedAt: number;
}

type Handlers = {
  transcript?: (t: VoiceTranscript) => void;
  /** Joined/left a voice channel (join(), leave(), or connection death). */
  status?: (channelId: string, guildId: string, joined: boolean) => void;
};

/** join() failures the relay maps onto RPC error codes. */
export class VoiceJoinError extends Error {
  constructor(
    public readonly code: 'CONFLICT' | 'INVALID_PARAMS' | 'NOT_FOUND',
    message: string,
    /** For CONFLICT: the channel this guild's listener is already in. */
    public readonly listeningIn?: string,
  ) {
    super(message);
  }
}

const SCRIBE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const CHUNK_MS = 200;              // audio per Scribe message (docs: 100–250 ms)
const SILENCE_END_MS = 1000;       // Discord-side utterance boundary
const MONO_BYTES_PER_MS = 96;      // 48 kHz × 2 bytes, mono
const PREV_TEXT_CAP = 300;         // chars of per-speaker context carried across utterances
/** After Discord ends a stream: how long we wait for Scribe's post-commit
 *  transcript before finalizing with what we have and closing the socket. */
const FINAL_DRAIN_MS = 5_000;
/** After a `Disconnected`, how long discord.js gets to re-signal (voice-server
 *  region migration, channel move) before we treat the listener as dead. */
const RECONNECT_GRACE_MS = 5_000;

// ── Pure utterance/transcript state machine (unit-tested; no I/O) ──

/** Scribe server frames we act on; everything else is reported as a problem. */
export interface ScribeMessage {
  message_type?: string;
  text?: string;
  error?: string;
  message?: string;
}

export interface UtteranceState {
  /** Text Scribe has committed so far within this utterance. */
  committed: string;
  /** Discord ended the stream; the next commit (or the drain timeout) is final. */
  closing: boolean;
  /** The single allowed final has been emitted. */
  finalEmitted: boolean;
}

export type Reduced =
  | { kind: 'emit'; text: string; partial: boolean }
  | { kind: 'problem'; detail: string }
  | { kind: 'none' };

export function newUtteranceState(): UtteranceState {
  return { committed: '', closing: false, finalEmitted: false };
}

const SILENT_MESSAGE_TYPES = new Set([
  'session_started',
  'committed_transcript_with_timestamps',
  'committed_transcript_entities',
]);

/** Fold one Scribe frame into the utterance. Mutates `u`; returns what to emit. */
export function reduceScribeMessage(u: UtteranceState, msg: ScribeMessage): Reduced {
  const type = msg.message_type;
  if (type === 'partial_transcript') {
    if (u.finalEmitted) return { kind: 'none' };
    const text = `${u.committed} ${msg.text ?? ''}`.trim();
    return text ? { kind: 'emit', text, partial: true } : { kind: 'none' };
  }
  if (type === 'committed_transcript') {
    u.committed = `${u.committed} ${msg.text ?? ''}`.trim();
    if (u.finalEmitted) return { kind: 'none' };
    if (u.closing) {
      u.finalEmitted = true;
      return u.committed ? { kind: 'emit', text: u.committed, partial: false } : { kind: 'none' };
    }
    // Mid-utterance commit (VAD backstop): still in progress from the
    // listener's point of view — surface as a partial, never a second final.
    return u.committed ? { kind: 'emit', text: u.committed, partial: true } : { kind: 'none' };
  }
  if (type && SILENT_MESSAGE_TYPES.has(type)) return { kind: 'none' };
  // rate_limited, commit_throttled, queue_overflow, resource_exhausted,
  // session_time_limit_exceeded, unaccepted_terms, chunk_size_exceeded,
  // insufficient_audio_activity, warning, *error*, quota_exceeded, unknown…
  // — anything we did not expect is a problem worth a log line, never silence.
  return { kind: 'problem', detail: `${type ?? 'unknown'}: ${msg.error ?? msg.message ?? ''}`.trim() };
}

/** Drain window expired (or the stream ended with nothing to commit): emit the
 *  final exactly once from whatever was committed. */
export function finalizeUtterance(u: UtteranceState): Reduced {
  u.closing = true;
  if (u.finalEmitted) return { kind: 'none' };
  u.finalEmitted = true;
  return u.committed ? { kind: 'emit', text: u.committed, partial: false } : { kind: 'none' };
}

/** Per-process epoch so utterance ids never repeat across relay restarts. */
export function newUtteranceEpoch(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeUtteranceId(epoch: string, n: number, userId: string): string {
  return `u${epoch}-${n}-${userId.slice(-4)}`;
}

// ── Live listener ──

/** One speaker's in-flight utterance: opus pipeline + Scribe WS. */
interface SpeakerSession {
  ws: WebSocket;
  wsReady: Promise<void>;
  userId: string;
  utteranceId: string;
  startedAt: number;
  /** Buffered mono PCM awaiting the next chunk boundary. */
  pending: Buffer[];
  pendingBytes: number;
  state: UtteranceState;
  /** previous_text is only meaningful on the first chunk of a session. */
  firstChunkSent: boolean;
  drainTimer?: NodeJS.Timeout;
}

export class VoiceBot {
  private handlers: Handlers = {};
  private connections = new Map<string, { conn: VoiceConnection; guildId: string }>(); // channelId →
  private sessions = new Map<string, SpeakerSession>();  // `${channelId}:${userId}` →
  private pendingStart = new Set<string>();              // utterances awaiting member resolution
  private prevText = new Map<string, string>();          // userId → trailing context
  private nextUtterance = 1;
  readonly utteranceEpoch = newUtteranceEpoch();

  constructor(
    private client: Client,
    private elevenKey: string,
    private log: (msg: string) => void = () => {},
  ) {}

  on<K extends keyof Handlers>(event: K, fn: Handlers[K]): void {
    this.handlers[event] = fn;
  }

  listening(channelId: string): boolean {
    return this.connections.has(channelId);
  }

  /** The channel this guild's listener is in, if any (Discord allows ONE
   *  voice connection per guild). */
  listeningIn(guildId: string): string | null {
    for (const [cid, e] of this.connections) if (e.guildId === guildId) return cid;
    return null;
  }

  async join(channelId: string): Promise<void> {
    if (this.connections.has(channelId)) return; // idempotent
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new VoiceJoinError('NOT_FOUND', 'channel not found');
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new VoiceJoinError('INVALID_PARAMS', 'not a voice channel');
    }
    const voice = channel as VoiceBasedChannel;
    // Discord permits ONE voice connection per guild: joining a second channel
    // would MOVE the underlying connection and silently end whoever was
    // listening in the first one. Refuse; the caller must voice_leave first —
    // an explicit stop is visible to everyone, an implicit move is not.
    const elsewhere = this.listeningIn(voice.guild.id);
    if (elsewhere) {
      throw new VoiceJoinError('CONFLICT',
        `relay is already listening in voice channel ${elsewhere} of this guild; voice_leave it first`, elsewhere);
    }
    const conn = joinVoiceChannel({
      channelId,
      guildId: voice.guild.id,
      adapterCreator: voice.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true, // we listen; per-agent TTS speaks under its own bot, not this one
    });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
    } catch (e) {
      try { conn.destroy(); } catch { /* fine */ }
      throw e;
    }
    this.connections.set(channelId, { conn, guildId: voice.guild.id });

    conn.receiver.speaking.on('start', (userId) => this.onSpeakingStart(channelId, voice.guild.id, userId));
    conn.on(VoiceConnectionStatus.Disconnected, () => void this.onDisconnected(channelId, conn));
    conn.on(VoiceConnectionStatus.Destroyed, () => {
      // Destroyed under us (not via teardown): report so nobody assumes a
      // listener that is gone. teardown() removes the map entry first, so a
      // teardown-initiated destroy is a no-op here.
      if (this.connections.get(channelId)?.conn === conn) this.teardown(channelId);
    });
    this.log(`voice: listening in ${voice.name} (${channelId})`);
    this.handlers.status?.(channelId, voice.guild.id, true);
  }

  /**
   * `Disconnected` is NOT a verdict: discord.js raises it on voice-server
   * region migration and on being moved between channels, then re-signals on
   * its own. Give it a grace window; only a connection that stays down is a
   * dead listener. A re-signalled connection that ended up in a different
   * channel than the one we announced is retired too — we would otherwise be
   * transcribing a room nobody asked us to listen to.
   */
  private async onDisconnected(channelId: string, conn: VoiceConnection): Promise<void> {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
        entersState(conn, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
      ]);
    } catch {
      if (this.connections.get(channelId)?.conn === conn) {
        this.log(`voice: connection to ${channelId} stayed down for ${RECONNECT_GRACE_MS}ms — leaving`);
        this.teardown(channelId);
      }
      return;
    }
    if (conn.joinConfig.channelId !== channelId && this.connections.get(channelId)?.conn === conn) {
      this.log(`voice: moved out of ${channelId} (now ${conn.joinConfig.channelId}) — leaving`);
      this.teardown(channelId);
      return;
    }
    this.log(`voice: reconnecting to ${channelId}`);
  }

  leave(channelId: string): void {
    if (!this.connections.has(channelId)) return;
    this.teardown(channelId);
  }

  destroy(): void {
    for (const channelId of [...this.connections.keys()]) this.teardown(channelId);
  }

  private teardown(channelId: string): void {
    const entry = this.connections.get(channelId);
    if (!entry) return;
    this.connections.delete(channelId);
    for (const [key, s] of [...this.sessions]) {
      if (key.startsWith(`${channelId}:`)) {
        this.sessions.delete(key);
        if (s.drainTimer) clearTimeout(s.drainTimer);
        try { s.ws.close(); } catch { /* fine */ }
      }
    }
    try { entry.conn.destroy(); } catch { /* already dead */ }
    this.log(`voice: left ${channelId}`);
    this.handlers.status?.(channelId, entry.guildId, false);
  }

  // ── Per-utterance pipeline ──

  private onSpeakingStart(channelId: string, guildId: string, userId: string): void {
    const key = `${channelId}:${userId}`;
    // Guard both maps: speaking events repeat, and the async member fetch
    // below must not race a second start into a duplicate session.
    if (this.sessions.has(key) || this.pendingStart.has(key)) return;
    this.pendingStart.add(key);
    void this.beginUtterance(channelId, guildId, userId, key)
      .catch((e: Error) => this.log(`voice: utterance start failed for ${userId}: ${e.message}`))
      .finally(() => this.pendingStart.delete(key));
  }

  private async beginUtterance(channelId: string, guildId: string, userId: string, key: string): Promise<void> {
    const entry = this.connections.get(channelId);
    if (!entry) return;

    // Speaker identity: cache first, REST on miss. A voice-only TTS bot never
    // posts a text message, so it may be absent from the member cache — and
    // the bot check below MUST see it. Unidentifiable speakers are skipped
    // (fail closed): losing one utterance from an unfetchable user is
    // recoverable; a bot-echo feedback loop (agent speech → transcript →
    // agents respond → more speech) is not.
    const guild = this.client.guilds.cache.get(guildId);
    let member = guild?.members.cache.get(userId);
    if (!member) member = await guild?.members.fetch(userId).catch(() => undefined);
    if (!member) { this.log(`voice: cannot identify speaker ${userId} — skipping utterance`); return; }
    const username = member.user.username;
    const displayName = member.displayName ?? username;
    // Don't transcribe bots: their speech is already text somewhere upstream
    // (per-agent TTS), and echoing it back as transcript would duplicate it.
    if (member.user.bot) return;

    const session = this.openScribeSession(channelId, guildId, userId, username, displayName);
    this.sessions.set(key, session);

    const opus = entry.conn.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    opus.pipe(decoder);

    decoder.on('data', (stereo: Buffer) => this.pushAudio(session, stereo));
    decoder.on('error', (e: Error) => this.log(`voice: decode error for ${username}: ${e.message}`));
    opus.once('end', () => {
      this.sessions.delete(key);
      session.state.closing = true;
      if (!session.firstChunkSent && session.pendingBytes === 0) {
        // Speaking event with no decodable audio: nothing to commit, and an
        // empty commit would only earn an `insufficient_audio_activity`.
        this.finalize(session, channelId, guildId, userId, username, displayName);
        return;
      }
      // Discord says the utterance is over: flush, force-commit, and give the
      // socket a drain window for its post-commit transcript before finalizing.
      this.flush(session, true);
      session.drainTimer = setTimeout(
        () => this.finalize(session, channelId, guildId, userId, username, displayName),
        FINAL_DRAIN_MS,
      );
    });
  }

  private openScribeSession(
    channelId: string, guildId: string, userId: string, username: string, displayName: string,
  ): SpeakerSession {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_48000',
      commit_strategy: 'vad', // backstop; Discord silence drives the real commit
      // Zero retention (RFC-006 §6): ElevenLabs keeps neither audio nor text.
      enable_logging: 'false',
    });
    const ws = new WebSocket(`${SCRIBE_URL}?${params}`, { headers: { 'xi-api-key': this.elevenKey } });
    const session: SpeakerSession = {
      ws,
      wsReady: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
      userId,
      utteranceId: makeUtteranceId(this.utteranceEpoch, this.nextUtterance++, userId),
      startedAt: Date.now(),
      pending: [],
      pendingBytes: 0,
      state: newUtteranceState(),
      firstChunkSent: false,
    };
    session.wsReady.catch((e) => this.log(`voice: scribe connect failed for ${username}: ${e.message}`));

    ws.on('message', (raw) => {
      let msg: ScribeMessage;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const out = reduceScribeMessage(session.state, msg);
      if (out.kind === 'problem') {
        this.log(`voice: scribe ${out.detail} (speaker ${username}, utterance ${session.utteranceId})`);
        return;
      }
      if (out.kind !== 'emit') return;
      this.emit(session, channelId, guildId, userId, username, displayName, out.text, out.partial);
      if (!out.partial) this.closeSoon(session);
    });
    ws.on('error', () => { /* surfaced via wsReady rejection above */ });
    return session;
  }

  private emit(
    session: SpeakerSession, channelId: string, guildId: string, userId: string,
    username: string, displayName: string, text: string, partial: boolean,
  ): void {
    this.handlers.transcript?.({
      channelId, guildId, userId, username, displayName, bot: false,
      utteranceId: session.utteranceId, text, partial, startedAt: session.startedAt,
    });
    if (!partial) {
      const prev = (this.prevText.get(userId) ?? '') + ' ' + text;
      this.prevText.set(userId, prev.slice(-PREV_TEXT_CAP));
    }
  }

  /** Drain window over (or nothing was ever sent): emit the one final from
   *  whatever is committed and close the socket. */
  private finalize(
    session: SpeakerSession, channelId: string, guildId: string, userId: string,
    username: string, displayName: string,
  ): void {
    const out = finalizeUtterance(session.state);
    if (out.kind === 'emit') this.emit(session, channelId, guildId, userId, username, displayName, out.text, out.partial);
    this.closeSoon(session, 0);
  }

  private closeSoon(session: SpeakerSession, delayMs = 250): void {
    if (session.drainTimer) { clearTimeout(session.drainTimer); session.drainTimer = undefined; }
    setTimeout(() => { try { session.ws.close(); } catch { /* fine */ } }, delayMs);
  }

  /** Downmix interleaved stereo PCM16LE to mono and buffer to chunk size. */
  private pushAudio(session: SpeakerSession, stereo: Buffer): void {
    const mono = Buffer.allocUnsafe(stereo.length / 2);
    for (let i = 0; i + 3 < stereo.length; i += 4) {
      const l = stereo.readInt16LE(i);
      const r = stereo.readInt16LE(i + 2);
      mono.writeInt16LE((l + r) >> 1, i / 2);
    }
    session.pending.push(mono);
    session.pendingBytes += mono.length;
    if (session.pendingBytes >= CHUNK_MS * MONO_BYTES_PER_MS) this.flush(session, false);
  }

  private flush(session: SpeakerSession, commit: boolean): void {
    const chunk = session.pending.length ? Buffer.concat(session.pending) : Buffer.alloc(0);
    session.pending = [];
    session.pendingBytes = 0;
    if (!chunk.length && !commit) return;
    const payload: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: chunk.toString('base64'),
      commit,
      sample_rate: 48_000,
    };
    if (!session.firstChunkSent) {
      session.firstChunkSent = true;
      const prev = this.prevText.get(session.userId);
      if (prev) payload.previous_text = prev; // context across the speaker's utterances (first chunk only)
    }
    void session.wsReady.then(() => {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(payload));
    }).catch(() => { /* connect failure already logged */ });
  }
}
