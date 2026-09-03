/**
 * Voice output — the grant-checked TTS egress path (RFC-006 §1.4, §3, §4).
 *
 * Portal's one enforcement point: it never selects who speaks, but on the
 * output path it owns, it refuses to synthesize without authority. The
 * contract, verbatim from the RFC: **no valid grant, no synthesis, no fee.**
 *
 * Division of labour, mirroring voice-bot.ts:
 *  - This module owns grant checking, the synthesis queue, voice-kit TTS,
 *    and boundary accounting. It is pure of Discord: the audio sink and the
 *    TTS provider are injected, so the whole path tests against synthetic
 *    providers (convergence review, red pen 8).
 *  - The relay wires the Discord sink (playback into the guild voice
 *    connection, carrier events from the receiver) and the receipt
 *    handlers, and applies delivery policy. That wiring imports THIS module
 *    lazily behind config: voice-kit must never become a relay boot
 *    requirement on installations that never configured voice output
 *    (discord-mcpl #28's fleet-wide lesson, applied here from birth).
 *
 * Grant authority is a seam because the floor service is not deployed yet:
 *  - Default: REFUSE-ALL. An unconfigured relay's output path answers every
 *    request with a refusal receipt and synthesizes nothing — the RFC's
 *    fail-closed posture, not an error state.
 *  - UNGOVERNED: explicit operator opt-in for floor-less rooms. Null grants
 *    accepted; carrier-clear remains the only gate; construction logs the
 *    stance loudly so nobody mistakes it for enforcement.
 *  - FLOOR-RFC-001 authority: future — validates grantId/epochs against the
 *    floor service. The seam's shape (validate at ENQUEUE and again at
 *    CLEARED) is designed for it: a grant that dies while its utterance
 *    waits in the queue is refused at the open, which is the RFC's
 *    "stale grant presented to the output path is refused" exit gate.
 *
 * Zero-cost-loser (shared invariant with discord-mcpl #28): the provider
 * stream opens only at the sink's `cleared` event — carrier-clear checked
 * at open, on the same path as the grant re-check. Anything refused or
 * dropped while queued bills zero characters, and `billedChars` rides every
 * receipt as the proof.
 */

import { PassThrough, type Readable } from 'node:stream';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';

// ── Grants ─────────────────────────────────────────────────────────────────

export interface GrantRef {
  grantId: string;
  participantId: string;
  /** FLOOR-RFC-001 §5 binding the grant was issued for. */
  roomBinding: string;
  logicEpoch: string;
  processEpoch: string;
  /** null = no expiry communicated (the authority still re-validates). */
  expiresAt: number | null;
}

export type GrantVerdict = { ok: true } | { ok: false; reason: string };

export interface GrantAuthority {
  readonly name: string;
  /** Fail closed: anything not positively valid is refused. Called at
   *  enqueue AND again at clearance — queue time is grant-death time. */
  validate(grant: GrantRef | null, participantId: string, now: number): GrantVerdict;
}

/** The unconfigured default: voice output exists but answers only refusals.
 *  This is a stance, not a bug — RFC-006 §1.4's fail-closed posture. */
export class RefuseAllAuthority implements GrantAuthority {
  readonly name = 'refuse-all';
  validate(): GrantVerdict {
    return { ok: false, reason: 'no grant authority configured — voice output is disabled (RFC-006 §1.4: no valid grant, no synthesis)' };
  }
}

/** Explicit operator opt-in for floor-less rooms: null grants pass, the
 *  carrier gate is the only remaining physics. Never a default. */
export class UngovernedAuthority implements GrantAuthority {
  readonly name = 'ungoverned';
  constructor(log: (m: string) => void = (m) => console.error(`[portal voice-output] ${m}`)) {
    log('UNGOVERNED voice output: grant checks are OFF by operator opt-in — carrier-clear is the only gate. This is not floor enforcement.');
  }
  validate(grant: GrantRef | null, _pid: string, now: number): GrantVerdict {
    // Even ungoverned, a PRESENTED grant that is visibly dead is refused:
    // accepting known-stale authority would be worse than accepting none.
    if (grant?.expiresAt != null && grant.expiresAt <= now) {
      return { ok: false, reason: `presented grant ${grant.grantId} expired at ${grant.expiresAt}` };
    }
    return { ok: true };
  }
}

// ── Requests and receipts ──────────────────────────────────────────────────

export interface SpeakRequest {
  /** Caller's idempotency/tracking key; receipts carry it back. */
  requestId: string;
  participantId: string;
  /** voice-registry voice for this resident (resolved by the caller —
   *  registry lookup is relay wiring, not engine logic). */
  voice: TtsVoice;
  text: string;
  grant: GrantRef | null;
  at: number;
}

export interface SpeakReceipt {
  requestId: string;
  participantId: string;
  status: 'spoken' | 'interrupted' | 'refused' | 'error';
  /** For refusals: the authority's reason, verbatim. */
  reason?: string;
  grantId?: string;
  /** The voiced/unvoiced boundary (RFC-006 §1.5). Exact when the provider
   *  supplied character alignment; proportional and flagged otherwise. */
  voicedText: string;
  unvoicedText: string;
  estimated: boolean;
  playedMs: number;
  queuedMs: number;
  /** Characters actually sent to the provider — zero for every refusal and
   *  every pre-clearance drop (the no-fee half of the contract). */
  billedChars: number;
  interruptedBy?: { userId: string; username?: string; bot: boolean };
}

// ── Sink contract (Discord impl is relay wiring; tests inject a fake) ──────

export interface SinkItem { id: string; stream: Readable }
export type SinkEvent =
  | { type: 'cleared'; id: string }
  | { type: 'started'; id: string }
  | { type: 'finished'; id: string; playedMs: number }
  | { type: 'interrupted'; id: string; playedMs: number; by: { userId: string; username?: string; bot: boolean } };

export interface OutputSink {
  play(item: SinkItem): void;
  cancel(id: string): boolean;
  onEvent(fn: (ev: SinkEvent) => void): void;
}

// ── The engine ─────────────────────────────────────────────────────────────

interface ActiveUtterance {
  req: SpeakRequest;
  out: PassThrough;
  tts: TtsStream | null;
  billedChars: number;
  cleared: boolean;
  queuedAt: number;
  clearedAt: number | null;
  aChars: string[];
  aStartMs: number[];
  aDurMs: number[];
  audioMs: number;
}

export interface VoiceOutputOptions {
  /** Played-vs-synthesized slack for the fully-voiced snap (ms). */
  fullyPlayedSlackMs?: number;
  log?: (m: string) => void;
}

export class VoiceOutputEngine {
  private active = new Map<string, ActiveUtterance>();
  private receiptFns: Array<(r: SpeakReceipt) => void> = [];
  private log: (m: string) => void;

  constructor(
    private authority: GrantAuthority,
    private tts: TtsProvider,
    private sink: OutputSink,
    private opts: VoiceOutputOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.error(`[portal voice-output] ${m}`));
    this.sink.onEvent((ev) => this.handleSinkEvent(ev));
  }

  onReceipt(fn: (r: SpeakReceipt) => void): void { this.receiptFns.push(fn); }

  /** Submit one granted utterance. Refusals receipt immediately with zero
   *  billed characters; accepted requests queue under the carrier gate. */
  speak(req: SpeakRequest): void {
    const verdict = this.authority.validate(req.grant, req.participantId, req.at);
    if (!verdict.ok) {
      this.refuse(req, verdict.reason, 0);
      return;
    }
    if (this.active.has(req.requestId)) {
      this.refuse(req, `duplicate requestId ${req.requestId}`, 0);
      return;
    }
    const utt: ActiveUtterance = {
      req, out: new PassThrough(), tts: null, billedChars: 0,
      cleared: false, queuedAt: req.at, clearedAt: null,
      aChars: [], aStartMs: [], aDurMs: [], audioMs: 0,
    };
    this.active.set(req.requestId, utt);
    this.sink.play({ id: req.requestId, stream: utt.out });
  }

  stop(): void {
    for (const [id, utt] of this.active) {
      this.sink.cancel(id);
      utt.tts?.abort();
      utt.out.end();
      this.receipt(utt, { status: 'refused', reason: 'output path stopped' });
    }
    this.active.clear();
  }

  /** The sink cleared this utterance: re-check the grant (queue time is
   *  grant-death time — the RFC's stale-grant exit gate lives HERE), then
   *  open synthesis. This is the only place characters start billing. */
  private handleCleared(id: string, now: number): void {
    const utt = this.active.get(id);
    if (!utt || utt.cleared) return;
    utt.cleared = true;
    utt.clearedAt = now;
    const verdict = this.authority.validate(utt.req.grant, utt.req.participantId, now);
    if (!verdict.ok) {
      this.active.delete(id);
      this.sink.cancel(id);
      utt.out.end();
      this.refuse(utt.req, `at clearance: ${verdict.reason}`, now - utt.queuedAt);
      return;
    }
    let tts: TtsStream;
    try {
      tts = this.tts.openStream(utt.req.voice);
    } catch (err) {
      this.active.delete(id);
      this.sink.cancel(id);
      utt.out.end();
      this.receipt(utt, { status: 'error', reason: `TTS open failed: ${(err as Error).message}` });
      return;
    }
    utt.tts = tts;
    const rate = this.tts.outputRateHz;
    tts.onAlignment((a: TtsAlignment) => {
      utt.aChars.push(...a.chars);
      utt.aStartMs.push(...a.startMs);
      utt.aDurMs.push(...a.durationMs);
    });
    tts.onAudio((pcm) => {
      utt.audioMs += pcm.length / 2 / (rate / 1000);
      utt.out.write(pcm);
    });
    tts.onEnd(() => utt.out.end());
    tts.onError((e) => { this.log(`TTS stream error: ${e.message}`); utt.out.end(); });
    tts.sendText(utt.req.text);
    utt.billedChars = utt.req.text.length;
    tts.end();
  }

  private handleSinkEvent(ev: SinkEvent): void {
    if (ev.type === 'cleared') { this.handleCleared(ev.id, Date.now()); return; }
    if (ev.type === 'started') return;
    const utt = this.active.get(ev.id);
    if (!utt) return;
    this.active.delete(ev.id);

    if (ev.type === 'interrupted') {
      // Barge-in: abort synthesis, report the boundary (RFC-006 §1.5). The
      // resident's host coordinates inference-abort through this receipt.
      utt.tts?.abort();
      utt.out.end();
      const split = this.split(utt, ev.playedMs);
      this.receipt(utt, { status: 'interrupted', playedMs: ev.playedMs, ...split, interruptedBy: ev.by });
      return;
    }
    const fullyPlayed = ev.playedMs + (this.opts.fullyPlayedSlackMs ?? 250) >= utt.audioMs;
    const split = fullyPlayed
      ? { voicedText: utt.req.text, unvoicedText: '', estimated: false }
      : this.split(utt, ev.playedMs);
    this.receipt(utt, { status: 'spoken', playedMs: ev.playedMs, ...split });
  }

  /** Voiced/unvoiced boundary at a playback position — alignment-exact when
   *  the provider supplied char timing, proportional + flagged otherwise. */
  private split(utt: ActiveUtterance, playedMs: number): { voicedText: string; unvoicedText: string; estimated: boolean } {
    const text = utt.req.text;
    if (utt.aChars.length > 0) {
      let n = 0;
      for (let i = 0; i < utt.aChars.length; i++) {
        if (utt.aStartMs[i]! + utt.aDurMs[i]! / 2 <= playedMs) n++;
      }
      n = Math.min(n, text.length);
      return { voicedText: text.slice(0, n), unvoicedText: text.slice(n), estimated: false };
    }
    if (utt.audioMs > 0) {
      const frac = Math.max(0, Math.min(1, playedMs / utt.audioMs));
      const n = Math.round(text.length * frac);
      return { voicedText: text.slice(0, n), unvoicedText: text.slice(n), estimated: true };
    }
    return { voicedText: '', unvoicedText: text, estimated: true };
  }

  private refuse(req: SpeakRequest, reason: string, queuedMs: number): void {
    this.emit({
      requestId: req.requestId, participantId: req.participantId,
      status: 'refused', reason, grantId: req.grant?.grantId,
      voicedText: '', unvoicedText: req.text, estimated: false,
      playedMs: 0, queuedMs, billedChars: 0,
    });
  }

  private receipt(utt: ActiveUtterance, patch: Partial<SpeakReceipt> & { status: SpeakReceipt['status'] }): void {
    this.emit({
      requestId: utt.req.requestId, participantId: utt.req.participantId,
      grantId: utt.req.grant?.grantId,
      voicedText: '', unvoicedText: utt.req.text, estimated: false,
      playedMs: 0,
      queuedMs: Math.max(0, (utt.clearedAt ?? utt.queuedAt) - utt.queuedAt),
      billedChars: utt.billedChars,
      ...patch,
    });
  }

  private emit(r: SpeakReceipt): void {
    for (const fn of this.receiptFns) { try { fn(r); } catch { /* consumer's */ } }
  }
}
