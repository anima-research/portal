/**
 * Voice output engine: grant gate (fail-closed default, ungoverned opt-in,
 * stale-at-clearance refusal), zero-cost-loser billing, boundary accounting.
 * Synthetic provider + fake sink — no Discord, no network (red pen 8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';
import {
  RefuseAllAuthority, UngovernedAuthority, VoiceOutputEngine,
  type GrantRef, type OutputSink, type SinkEvent, type SinkItem, type SpeakReceipt,
} from '../src/voice-output.js';

class FakeStream implements TtsStream {
  sent: string[] = [];
  ended = false;
  aborted = false;
  private audioFns: Array<(b: Buffer) => void> = [];
  private alignFns: Array<(a: TtsAlignment) => void> = [];
  private endFns: Array<() => void> = [];
  sendText(d: string): void { this.sent.push(d); }
  end(): void { this.ended = true; }
  abort(): void { this.aborted = true; }
  onAudio(f: (b: Buffer) => void): void { this.audioFns.push(f); }
  onAlignment(f: (a: TtsAlignment) => void): void { this.alignFns.push(f); }
  onEnd(f: () => void): void { this.endFns.push(f); }
  onError(): void {}
  emitAudio(b: Buffer): void { for (const f of this.audioFns) f(b); }
  emitAlignment(a: TtsAlignment): void { for (const f of this.alignFns) f(a); }
  finish(): void { for (const f of this.endFns) f(); }
}

class FakeProvider implements TtsProvider {
  readonly name = 'fake';
  readonly outputRateHz = 44100;
  streams: FakeStream[] = [];
  openStream(_v: TtsVoice): TtsStream {
    const s = new FakeStream();
    this.streams.push(s);
    return s;
  }
}

class FakeSink implements OutputSink {
  played: SinkItem[] = [];
  cancelled: string[] = [];
  private fns: Array<(ev: SinkEvent) => void> = [];
  play(item: SinkItem): void { this.played.push(item); }
  cancel(id: string): boolean { this.cancelled.push(id); return true; }
  onEvent(fn: (ev: SinkEvent) => void): void { this.fns.push(fn); }
  emit(ev: SinkEvent): void { for (const f of this.fns) f(ev); }
  clear(id: string): void { this.emit({ type: 'cleared', id }); }
}

const VOICE: TtsVoice = { voiceId: 'v1' };
const grant = (over: Partial<GrantRef> = {}): GrantRef => ({
  grantId: 'g1', participantId: 'res:aria', roomBinding: 'discord://g/c',
  logicEpoch: 'L1', processEpoch: 'P1', expiresAt: null, ...over,
});

function setup(authority = new UngovernedAuthority(() => {})) {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const engine = new VoiceOutputEngine(authority, provider, sink, { log: () => {} });
  const receipts: SpeakReceipt[] = [];
  engine.onReceipt((r) => receipts.push(r));
  return { provider, sink, engine, receipts };
}

test('fail-closed default: RefuseAllAuthority refuses everything, zero synthesis, zero fee', () => {
  const { provider, sink, engine, receipts } = setup(new RefuseAllAuthority());
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'hello room', grant: grant(), at: 1000 });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'refused');
  assert.match(receipts[0]!.reason!, /no grant authority configured/);
  assert.equal(receipts[0]!.billedChars, 0);
  assert.equal(provider.streams.length, 0); // no socket, no synthesis
  assert.equal(sink.played.length, 0);      // never even queued
});

test('ungoverned opt-in: null grant passes; synthesis opens only at cleared; boundary exact via alignment', () => {
  const { provider, sink, engine, receipts } = setup();
  const text = 'hello there room';
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text, grant: null, at: 1000 });
  assert.equal(sink.played.length, 1);
  assert.equal(provider.streams.length, 0); // queued ≠ billed
  sink.clear('r1');
  assert.equal(provider.streams.length, 1);
  assert.deepEqual(provider.streams[0]!.sent, [text]); // one flush, then end
  assert.equal(provider.streams[0]!.ended, true);
  // char i plays [i*100, (i+1)*100)
  provider.streams[0]!.emitAlignment({
    chars: [...text], startMs: [...text].map((_, i) => i * 100), durationMs: [...text].map(() => 100),
  });
  sink.emit({ type: 'interrupted', id: 'r1', playedMs: 550, by: { userId: 'u1', bot: false } });
  const r = receipts[0]!;
  assert.equal(r.status, 'interrupted');
  assert.equal(r.voicedText, text.slice(0, 6)); // midpoints ≤550ms → 6 chars ('hello ')
  assert.equal(r.unvoicedText, text.slice(6));
  assert.equal(r.estimated, false);
  assert.equal(r.billedChars, text.length);
  assert.equal(provider.streams[0]!.aborted, true);
});

test('stale grant refused AT CLEARANCE: valid at enqueue, dead by open — zero billed (the RFC exit gate)', () => {
  const { provider, sink, engine, receipts } = setup();
  // Expires 1ms from enqueue; the clearance happens later in wall time.
  engine.speak({
    requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'too slow',
    grant: grant({ expiresAt: Date.now() - 1 }), at: Date.now() - 10_000,
  });
  assert.equal(receipts.length, 0); // accepted at enqueue? no — expiresAt already past at enqueue-validate
  // The enqueue validate used req.at (10s ago) vs expiresAt (1ms ago): expiry
  // AFTER req.at → passes enqueue, dies before clearance.
  assert.equal(sink.played.length, 1);
  sink.clear('r1');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'refused');
  assert.match(receipts[0]!.reason!, /at clearance: .*expired/);
  assert.equal(receipts[0]!.billedChars, 0);
  assert.equal(provider.streams.length, 0);
  assert.deepEqual(sink.cancelled, ['r1']);
});

test('spoken happy path: full text snaps fully-voiced within slack', () => {
  const { provider, sink, engine, receipts } = setup();
  const text = 'Short and sweet.';
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text, grant: null, at: 0 });
  sink.clear('r1');
  provider.streams[0]!.emitAudio(Buffer.alloc(88200)); // 1000ms @44.1k mono PCM16
  sink.emit({ type: 'finished', id: 'r1', playedMs: 900 });
  const r = receipts[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.voicedText, text);
  assert.equal(r.unvoicedText, '');
  assert.equal(r.billedChars, text.length);
});

test('duplicate requestId refused without touching the queue', () => {
  const { sink, engine, receipts } = setup();
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'one', grant: null, at: 0 });
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'two', grant: null, at: 1 });
  assert.equal(sink.played.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'refused');
  assert.match(receipts[0]!.reason!, /duplicate/);
});

test('stop(): queued utterances refused with receipts, streams aborted', () => {
  const { sink, engine, receipts } = setup();
  engine.speak({ requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'pending', grant: null, at: 0 });
  engine.stop();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'refused');
  assert.equal(receipts[0]!.billedChars, 0);
  assert.deepEqual(sink.cancelled, ['r1']);
});

test('ungoverned still refuses a PRESENTED grant that is visibly expired', () => {
  const { engine, receipts } = setup();
  engine.speak({
    requestId: 'r1', participantId: 'res:aria', voice: VOICE, text: 'nope',
    grant: grant({ expiresAt: 5 }), at: 10,
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'refused');
  assert.match(receipts[0]!.reason!, /expired/);
});
