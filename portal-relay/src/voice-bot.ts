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
  /** Stable per-utterance key; partials replace-in-place under it. */
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

const SCRIBE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const CHUNK_MS = 200;              // audio per Scribe message (docs: 100–250 ms)
const SILENCE_END_MS = 1000;       // Discord-side utterance boundary
const MONO_BYTES_PER_MS = 96;      // 48 kHz × 2 bytes, mono
const PREV_TEXT_CAP = 300;         // chars of per-speaker context carried across utterances

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
  /** Committed text accumulated so far within this utterance. */
  lastText: string;
  /** previous_text is only meaningful on the first chunk of a session. */
  firstChunkSent: boolean;
}

export class VoiceBot {
  private handlers: Handlers = {};
  private connections = new Map<string, { conn: VoiceConnection; guildId: string }>(); // channelId →
  private sessions = new Map<string, SpeakerSession>();  // `${channelId}:${userId}` →
  private pendingStart = new Set<string>();              // utterances awaiting member resolution
  private prevText = new Map<string, string>();          // userId → trailing context
  private nextUtterance = 1;

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

  async join(channelId: string): Promise<void> {
    if (this.connections.has(channelId)) return; // idempotent
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      throw new Error('not a voice channel');
    }
    const voice = channel as VoiceBasedChannel;
    // Discord permits ONE voice connection per guild: joining a second channel
    // MOVES the underlying connection, which would leave the old entry in our
    // map as a zombie listener. Retire it explicitly first.
    for (const [cid, e] of [...this.connections]) {
      if (e.guildId === voice.guild.id && cid !== channelId) this.teardown(cid);
    }
    const conn = joinVoiceChannel({
      channelId,
      guildId: voice.guild.id,
      adapterCreator: voice.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true, // we listen; per-agent TTS speaks under its own bot, not this one
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
    this.connections.set(channelId, { conn, guildId: voice.guild.id });

    conn.receiver.speaking.on('start', (userId) => this.onSpeakingStart(channelId, voice.guild.id, userId));
    conn.on(VoiceConnectionStatus.Disconnected, () => {
      // Channel delete / kick / region move. Don't auto-rejoin: report and let
      // the operator (or agent) decide — silent zombie listeners are worse.
      this.teardown(channelId);
    });
    this.log(`voice: listening in ${voice.name} (${channelId})`);
    this.handlers.status?.(channelId, voice.guild.id, true);
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
      if (key.startsWith(`${channelId}:`)) { s.ws.close(); this.sessions.delete(key); }
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
      // Discord says the utterance is over: flush, force-commit, and let the
      // socket drain its final transcript before closing.
      this.flush(session, true);
      this.sessions.delete(key);
      setTimeout(() => { try { session.ws.close(); } catch { /* fine */ } }, 5_000);
    });
  }

  private openScribeSession(
    channelId: string, guildId: string, userId: string, username: string, displayName: string,
  ): SpeakerSession {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_48000',
      commit_strategy: 'vad', // backstop; Discord silence drives the real commit
    });
    const ws = new WebSocket(`${SCRIBE_URL}?${params}`, { headers: { 'xi-api-key': this.elevenKey } });
    const session: SpeakerSession = {
      ws,
      wsReady: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
      userId,
      utteranceId: `u${this.nextUtterance++}-${userId.slice(-4)}`,
      startedAt: Date.now(),
      pending: [],
      pendingBytes: 0,
      lastText: '',
      firstChunkSent: false,
    };
    session.wsReady.catch((e) => this.log(`voice: scribe connect failed for ${username}: ${e.message}`));

    ws.on('message', (raw) => {
      let msg: { message_type?: string; text?: string; error?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.message_type === 'partial_transcript' || msg.message_type === 'committed_transcript') {
        const partial = msg.message_type === 'partial_transcript';
        // Within one utterance, committed segments accumulate; a partial is
        // displayed as everything-committed-so-far plus the mutable tail.
        const text = `${session.lastText} ${msg.text ?? ''}`.trim();
        if (!partial) session.lastText = text;
        if (!text) return;
        this.handlers.transcript?.({
          channelId, guildId, userId, username, displayName, bot: false,
          utteranceId: session.utteranceId, text, partial,
          startedAt: session.startedAt,
        });
        if (!partial) {
          const prev = (this.prevText.get(userId) ?? '') + ' ' + text;
          this.prevText.set(userId, prev.slice(-PREV_TEXT_CAP));
        }
      } else if (msg.message_type?.includes('error') || msg.message_type === 'quota_exceeded') {
        this.log(`voice: scribe ${msg.message_type} for ${username}: ${msg.error ?? ''}`);
      }
    });
    return session;
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
      if (prev) payload.previous_text = prev; // context across the speaker's utterances
    }
    void session.wsReady.then(() => {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(payload));
    }).catch(() => { /* connect failure already logged */ });
  }
}
