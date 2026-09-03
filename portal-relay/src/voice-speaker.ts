/**
 * Voice output wiring — the Discord half of voice-output.ts (RFC-006 §3
 * "output path"). Everything the engine deliberately doesn't know lives here:
 * the audio sink on the guild voice connection, carrier sensing from the
 * receiver, registry resolution, and the per-channel engine lifecycle.
 *
 * THIS is the module that imports voice-kit at runtime (provider, registry,
 * resampler). The relay loads it with a dynamic import behind config, so a
 * relay that never configured voice output never resolves the dependency —
 * discord-mcpl #28's fleet lesson: an optional feature's import graph must
 * not become everyone's boot requirement.
 *
 * Topology: the relay's ONE voice connection per guild (voice-bot's listener)
 * is also the speaker — Discord permits no second connection from the same
 * bot, and a separate TTS bot would split consent state across two visible
 * identities. Playback rides an AudioPlayer subscribed to the listener's
 * connection; joining unmuted is the room-visible signal that the relay may
 * be audible (voice-bot's `speak` option).
 *
 * Carrier policy, from the sink's seat:
 *  - ANY other speaker occupies the carrier: a queued utterance never opens
 *    over live audio, human or bot ("no audible overlap asserted at the mixed
 *    sink", RFC-006 §4).
 *  - Only a HUMAN speaker barges in on playback already underway. Another
 *    bot's speech is a floor-discipline problem for the floor service, not a
 *    physics event — two transports interrupting each other converges on
 *    neither ever finishing a sentence.
 *  - A speaker we cannot identify occupies the carrier but does not barge in
 *    until identified as human (member fetch). Losing a moment of barge-in
 *    latency on an uncached member is recoverable; a spoofable instant-mute
 *    lever for any joining bot is a heckler's veto.
 */

import { Transform } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, PlayerSubscription, VoiceConnection } from '@discordjs/voice';
import type { Client } from 'discord.js';
import {
  ElevenLabsTtsProvider,
  loadRegistry,
  monoTo48kStereo,
  resolveVoice,
} from '@animalabs/voice-kit';
import type { TtsProvider } from '@animalabs/voice-kit';
import {
  RefuseAllAuthority,
  UngovernedAuthority,
  VoiceOutputEngine,
  VoiceSpeakError,
} from './voice-output.js';
import type { GrantAuthority, GrantRef, OutputSink, SinkEvent, SinkItem, SpeakReceipt } from './voice-output.js';
import type { VoiceBot } from './voice-bot.js';

/** Quiet time required after the last carrier activity (or our own previous
 *  utterance) before the sink clears the next one. Matches conversational
 *  turn-gap; long enough that a breath between sentences isn't an opening. */
const HOLDOFF_MS = 600;

// ── Carrier-gated playback scheduler (I/O-free; port and timers injected) ───

export interface CarrierMeta {
  bot: boolean;
  username?: string;
}

/** The actual audio machinery, injected so the scheduler tests without
 *  Discord. start() may be called with a stream that has no data yet — the
 *  player buffers until the TTS provider begins writing. */
export interface PlaybackPort {
  start(item: SinkItem, cb: { onStarted: () => void; onFinished: (playedMs: number) => void }): void;
  /** Stop current playback immediately; returns ms actually played. */
  stop(): number;
}

export interface SinkTimers {
  now(): number;
  /** Returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
}

const realTimers: SinkTimers = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * One channel's output scheduler: a FIFO of utterances behind the carrier
 * gate. Emits the engine's sink events; the engine opens synthesis on
 * `cleared` (that ordering is the zero-cost-loser invariant — nothing queued
 * here has cost anything yet).
 */
export class VoiceChannelSink implements OutputSink {
  private queue: SinkItem[] = [];
  private current: { id: string; started: boolean } | null = null;
  private carriers = new Map<string, CarrierMeta>();
  private lastQuietAt = 0;
  private cancelTimer: (() => void) | null = null;
  private eventFns: Array<(ev: SinkEvent) => void> = [];

  constructor(
    private port: PlaybackPort,
    private timers: SinkTimers = realTimers,
    private holdoffMs = HOLDOFF_MS,
  ) {}

  onEvent(fn: (ev: SinkEvent) => void): void {
    this.eventFns.push(fn);
  }

  play(item: SinkItem): void {
    this.queue.push(item);
    this.pump();
  }

  /** Engine-initiated removal (refusal at clearance, TTS open failure,
   *  stop()): silent — the engine writes its own receipt. */
  cancel(id: string): boolean {
    if (this.current?.id === id) {
      const started = this.current.started;
      this.current = null;
      this.port.stop();
      // Only audio that actually played earns a breathing gap: a refusal at
      // clearance made no sound, and must not delay whoever is next.
      if (started) this.lastQuietAt = this.timers.now();
      this.pump();
      return true;
    }
    const i = this.queue.findIndex((q) => q.id === id);
    if (i === -1) return false;
    this.queue.splice(i, 1);
    return true;
  }

  /** A user began transmitting. Called with cache-resolved meta immediately;
   *  called AGAIN with authoritative meta when an uncached member resolves —
   *  the second call upgrades a provisional non-interrupting carrier into a
   *  barge-in if the speaker turned out human mid-playback. */
  carrierStart(userId: string, meta: CarrierMeta): void {
    this.carriers.set(userId, meta);
    if (this.current && !meta.bot) {
      const id = this.current.id;
      this.current = null;
      const playedMs = this.port.stop();
      this.lastQuietAt = this.timers.now();
      this.emit({ type: 'interrupted', id, playedMs, by: { userId, username: meta.username, bot: false } });
    }
  }

  carrierEnd(userId: string): void {
    if (!this.carriers.delete(userId)) return;
    if (this.carriers.size === 0) {
      this.lastQuietAt = this.timers.now();
      this.pump();
    }
  }

  /** Channel is going away: drop the queue and stop playback. The engine's
   *  stop() writes the receipts; nothing is emitted from here. */
  destroy(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.queue = [];
    if (this.current) {
      this.current = null;
      this.port.stop();
    }
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    if (this.carriers.size > 0) return; // carrierEnd re-pumps
    const wait = this.lastQuietAt + this.holdoffMs - this.timers.now();
    if (wait > 0 && this.lastQuietAt > 0) {
      this.cancelTimer?.();
      this.cancelTimer = this.timers.schedule(wait, () => {
        this.cancelTimer = null;
        this.pump();
      });
      return;
    }
    const item = this.queue.shift()!;
    this.current = { id: item.id, started: false };
    // The engine reacts to `cleared` synchronously: it re-validates the grant
    // and may cancel() this very item (stale grant, TTS open failure). Only
    // start playback if the item survived its own clearance.
    this.emit({ type: 'cleared', id: item.id });
    if (this.current?.id !== item.id) {
      this.pump();
      return;
    }
    this.port.start(item, {
      onStarted: () => {
        if (this.current?.id === item.id) {
          this.current.started = true;
          this.emit({ type: 'started', id: item.id });
        }
      },
      onFinished: (playedMs) => {
        if (this.current?.id !== item.id) return; // stopped by cancel/barge-in
        this.current = null;
        this.lastQuietAt = this.timers.now(); // breathe before the next one
        this.emit({ type: 'finished', id: item.id, playedMs });
        this.pump();
      },
    });
  }

  private emit(ev: SinkEvent): void {
    for (const fn of this.eventFns) fn(ev);
  }
}

// ── Discord playback port ──────────────────────────────────────────────────

/** Provider PCM (16-bit LE mono at `fromHz`) → 48 kHz stereo for the opus
 *  encoder. Carries an odd-byte remainder across chunks: stream buffering may
 *  split a 16-bit sample between chunks. */
export function ttsToDiscordPcm(fromHz: number): Transform {
  let rem: Buffer | null = null;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let buf = rem ? Buffer.concat([rem, chunk]) : chunk;
      const usable = buf.length & ~1;
      rem = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
      buf = buf.subarray(0, usable);
      cb(null, buf.length ? monoTo48kStereo(buf, fromHz) : Buffer.alloc(0));
    },
  });
}

class DiscordPlaybackPort implements PlaybackPort {
  private player: AudioPlayer;
  private subscription: PlayerSubscription | undefined;
  private resource: AudioResource | null = null;
  private cb: { onStarted: () => void; onFinished: (playedMs: number) => void } | null = null;

  constructor(conn: VoiceConnection, private fromHz: number, private log: (m: string) => void) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.subscription = conn.subscribe(this.player);
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing) {
        this.cb?.onStarted();
      }
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        const playedMs = this.playedMs();
        const cb = this.cb;
        this.cb = null;
        this.resource = null;
        cb?.onFinished(playedMs);
      }
    });
    // A playback error surfaces as an early Idle (finished with what played);
    // the boundary in the receipt stays honest via playedMs.
    this.player.on('error', (e) => this.log(`playback error: ${e.message}`));
  }

  start(item: SinkItem, cb: { onStarted: () => void; onFinished: (playedMs: number) => void }): void {
    this.cb = cb;
    const stereo = ttsToDiscordPcm(this.fromHz);
    item.stream.pipe(stereo);
    this.resource = createAudioResource(stereo, { inputType: StreamType.Raw });
    this.player.play(this.resource);
  }

  stop(): number {
    const playedMs = this.playedMs();
    this.cb = null; // the stop()-induced Idle must not double-report
    this.resource = null;
    this.player.stop(true);
    return playedMs;
  }

  destroy(): void {
    this.cb = null;
    this.player.stop(true);
    this.subscription?.unsubscribe();
  }

  private playedMs(): number {
    return this.resource ? Math.round(this.resource.playbackDuration) : 0;
  }
}

// ── Coordinator ────────────────────────────────────────────────────────────

export interface SpeakArgs {
  personaId: string;
  /** Registry lookup key — the persona's display name (voice-registry keys
   *  voices by speaker name, melodeus heritage). */
  speakerName: string;
  channelId: string;
  text: string;
  /** Relay-namespaced (`<personaId>/<clientRequestId>`) so one persona's ids
   *  can never collide with another's in the engine's duplicate check. */
  requestId: string;
  /** participantId inside is the CALLING persona — set by the relay, never
   *  taken from the wire. */
  grant: GrantRef | null;
  at: number;
}

interface ChannelOutput {
  conn: VoiceConnection;
  guildId: string;
  engine: VoiceOutputEngine;
  sink: VoiceChannelSink;
  port: DiscordPlaybackPort;
  detach: () => void;
}

/**
 * Per-channel engine+sink lifecycle over the voice listener's connections.
 * One engine per joined channel: the carrier gate and the no-overlap
 * invariant are per-room physics, and receipts carry their channel.
 */
export class VoiceSpeaker {
  private channels = new Map<string, ChannelOutput>();
  private receiptFns: Array<(channelId: string, guildId: string | null, r: SpeakReceipt) => void> = [];

  constructor(
    private voice: VoiceBot,
    private client: Client,
    private authority: GrantAuthority,
    private tts: TtsProvider,
    private registryPath: string,
    private log: (m: string) => void = (m) => console.error(`[portal voice-output] ${m}`),
  ) {}

  onReceipt(fn: (channelId: string, guildId: string | null, r: SpeakReceipt) => void): void {
    this.receiptFns.push(fn);
  }

  /** Queue one utterance. Throws VoiceSpeakError for caller-fixable
   *  preconditions; everything past here reports through receipts. */
  speak(args: SpeakArgs): void {
    const entry = this.voice.connectionFor(args.channelId);
    if (!entry) {
      throw new VoiceSpeakError('NOT_JOINED',
        `relay is not joined to voice channel ${args.channelId} — voice_join it first (speaking never implicitly joins)`);
    }
    // Re-read per utterance: registry edits (new resident voice, re-voicing)
    // take effect without a relay restart, and utterance cadence makes the
    // read cost irrelevant.
    const registry = loadRegistry(this.registryPath);
    const voice = resolveVoice(registry, args.speakerName);
    if (!voice) {
      throw new VoiceSpeakError('NO_VOICE',
        `no voice registered for "${args.speakerName}" and no defaultBotVoice in the voice registry`);
    }
    const output = this.channelOutput(args.channelId, entry);
    output.engine.speak({
      requestId: args.requestId,
      participantId: args.personaId,
      voice,
      text: args.text,
      grant: args.grant,
      at: args.at,
    });
  }

  /** The listener left (voice_leave, channel death, connection loss): refuse
   *  everything queued (engine writes the receipts) and release the player. */
  channelClosed(channelId: string): void {
    const output = this.channels.get(channelId);
    if (!output) return;
    this.channels.delete(channelId);
    output.engine.stop();
    output.sink.destroy();
    output.port.destroy();
    output.detach();
  }

  stop(): void {
    for (const channelId of [...this.channels.keys()]) this.channelClosed(channelId);
  }

  private channelOutput(channelId: string, entry: { conn: VoiceConnection; guildId: string }): ChannelOutput {
    const existing = this.channels.get(channelId);
    if (existing) {
      if (existing.conn === entry.conn) return existing;
      // The channel was re-joined on a fresh connection while our wiring still
      // pointed at the dead one (teardown raced the rejoin): rebuild.
      this.channelClosed(channelId);
    }
    const port = new DiscordPlaybackPort(entry.conn, this.tts.outputRateHz, this.log);
    const sink = new VoiceChannelSink(port);
    const engine = new VoiceOutputEngine(this.authority, this.tts, sink, { log: this.log });
    engine.onReceipt((r) => {
      for (const fn of this.receiptFns) {
        try { fn(channelId, entry.guildId, r); } catch { /* consumer's */ }
      }
    });
    const detach = this.attachCarrierSensing(entry.conn, entry.guildId, sink);
    const output: ChannelOutput = { conn: entry.conn, guildId: entry.guildId, engine, sink, port, detach };
    this.channels.set(channelId, output);
    return output;
  }

  /**
   * Feed the receiver's speaking events to the carrier gate. Identity is
   * cache-first: a cached member gates with authoritative bot-ness at once;
   * an uncached one occupies the carrier provisionally as non-interrupting
   * (bot: true) and upgrades via fetch — see the module comment for why the
   * unknown-speaker default leans away from the instant-mute lever.
   */
  private attachCarrierSensing(conn: VoiceConnection, guildId: string, sink: VoiceChannelSink): () => void {
    const live = new Set<string>();
    const onStart = (userId: string): void => {
      if (userId === this.client.user?.id) return; // never our own playback
      live.add(userId);
      const guild = this.client.guilds.cache.get(guildId);
      const cached = guild?.members.cache.get(userId);
      sink.carrierStart(userId, {
        bot: cached ? cached.user.bot : true,
        username: cached?.user.username,
      });
      if (!cached) {
        guild?.members.fetch(userId).then((m) => {
          if (live.has(userId)) sink.carrierStart(userId, { bot: m.user.bot, username: m.user.username });
        }).catch(() => { /* stays a provisional non-interrupting carrier */ });
      }
    };
    const onEnd = (userId: string): void => {
      live.delete(userId);
      sink.carrierEnd(userId);
    };
    conn.receiver.speaking.on('start', onStart);
    conn.receiver.speaking.on('end', onEnd);
    return () => {
      conn.receiver.speaking.off('start', onStart);
      conn.receiver.speaking.off('end', onEnd);
    };
  }
}

// ── Factory (the relay's single dynamic-import entry point) ────────────────

export function createVoiceSpeaker(opts: {
  voice: VoiceBot;
  client: Client;
  elevenKey: string;
  registryPath: string;
  /** Explicit operator opt-in for floor-less rooms. Default is refuse-all:
   *  the output path exists and answers only refusals until a floor service
   *  (or this flag) says otherwise. */
  ungoverned: boolean;
  log?: (m: string) => void;
}): VoiceSpeaker {
  const log = opts.log ?? ((m) => console.error(`[portal voice-output] ${m}`));
  const authority: GrantAuthority = opts.ungoverned
    ? new UngovernedAuthority(log)
    : new RefuseAllAuthority();
  const tts = new ElevenLabsTtsProvider(opts.elevenKey);
  return new VoiceSpeaker(opts.voice, opts.client, authority, tts, opts.registryPath, log);
}
