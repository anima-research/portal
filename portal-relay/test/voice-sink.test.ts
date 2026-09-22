// VoiceChannelSink: the carrier-gated playback scheduler, driven with a fake
// playback port and manual timers (no Discord, no clock).
//
//   1) Nothing opens over a live carrier — human OR bot ("no audible overlap
//      asserted at the mixed sink"); opens wait out the hold-off after quiet.
//   2) Only a HUMAN barges in on playback underway; a bot speaker blocks the
//      next open but never interrupts. An unidentified speaker is provisional
//      non-interrupting until upgraded (second carrierStart with bot: false).
//   3) cancel() is silent (the engine writes its own receipts), including the
//      engine cancelling an item synchronously inside its own `cleared`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { VoiceChannelSink, type PlaybackPort, type SinkTimers } from '../src/voice-speaker.js';
import type { SinkEvent, SinkItem } from '../src/voice-output.js';

const HOLDOFF = 600; // keep in sync with the sink's default

class FakeTimers implements SinkTimers {
  t = 1_000; // > 0 so lastQuietAt=0 means "never had carrier activity"
  private timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  now() { return this.t; }
  schedule(ms: number, fn: () => void) {
    const item = { at: this.t + ms, fn, cancelled: false };
    this.timers.push(item);
    return () => { item.cancelled = true; };
  }
  advance(ms: number) {
    const until = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => !x.cancelled && x.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = due.at;
      due.fn();
    }
    this.t = until;
  }
}

class FakePort implements PlaybackPort {
  started: string[] = [];
  stops = 0;
  playingMs = 0; // what stop() reports as played
  private cb: { onStarted: () => void; onFinished: (ms: number) => void } | null = null;
  start(item: SinkItem, cb: { onStarted: () => void; onFinished: (ms: number) => void }) {
    this.started.push(item.id);
    this.cb = cb;
    cb.onStarted();
  }
  stop(): number { this.stops++; this.cb = null; return this.playingMs; }
  finish(playedMs: number) { const cb = this.cb; this.cb = null; cb?.onFinished(playedMs); }
}

function rig(holdoffMs = HOLDOFF) {
  const timers = new FakeTimers();
  const port = new FakePort();
  const sink = new VoiceChannelSink(port, timers, holdoffMs);
  const events: SinkEvent[] = [];
  sink.onEvent((ev) => events.push(ev));
  const item = (id: string): SinkItem => ({ id, stream: new PassThrough() });
  return { timers, port, sink, events, item };
}

test('quiet channel: play → cleared → started immediately; finished → next waits the hold-off', () => {
  const { timers, port, sink, events, item } = rig();
  sink.play(item('a'));
  assert.deepEqual(events.map((e) => e.type), ['cleared', 'started']);
  assert.deepEqual(port.started, ['a']);

  sink.play(item('b'));
  assert.deepEqual(port.started, ['a'], 'b must not open while a plays');
  port.finish(1_200);
  assert.deepEqual(events.map((e) => e.type), ['cleared', 'started', 'finished']);
  assert.deepEqual(port.started, ['a'], 'b waits out the inter-utterance hold-off');
  timers.advance(HOLDOFF);
  assert.deepEqual(port.started, ['a', 'b']);
});

test('carrier occupied at enqueue: opens only after end + hold-off; early re-speak resets the window', () => {
  const { timers, port, sink, events, item } = rig();
  sink.carrierStart('human1', { bot: false, username: 'ra' });
  sink.play(item('a'));
  assert.equal(events.length, 0, 'no clearance while someone is talking');

  sink.carrierEnd('human1');
  assert.equal(port.started.length, 0, 'quiet but hold-off not yet elapsed');
  timers.advance(HOLDOFF / 2);
  sink.carrierStart('human1', { bot: false, username: 'ra' }); // spoke again inside the gap
  timers.advance(HOLDOFF);
  assert.equal(port.started.length, 0, 'carrier re-occupied — pending open must not fire');
  sink.carrierEnd('human1');
  timers.advance(HOLDOFF);
  assert.deepEqual(port.started, ['a']);
  assert.deepEqual(events.map((e) => e.type), ['cleared', 'started']);
});

test('human barges in: interrupted with playedMs and by; bot speaker never interrupts but blocks the next open', () => {
  const { timers, port, sink, events, item } = rig();
  sink.play(item('a'));
  port.playingMs = 850;
  sink.carrierStart('bot9', { bot: true, username: 'otherrelay' });
  assert.equal(events.filter((e) => e.type === 'interrupted').length, 0, 'bots do not barge in');
  sink.carrierEnd('bot9');

  sink.carrierStart('h2', { bot: false, username: 'antra' });
  const cut = events.at(-1)!;
  assert.equal(cut.type, 'interrupted');
  assert.deepEqual(cut.type === 'interrupted' && { ms: cut.playedMs, by: cut.by.username, bot: cut.by.bot },
    { ms: 850, by: 'antra', bot: false });
  assert.equal(port.stops, 1);

  // Queue behind the live speaker: opens only after they stop + hold-off.
  sink.play(item('b'));
  timers.advance(HOLDOFF * 3);
  assert.deepEqual(port.started, ['a'], 'b blocked while the human holds the carrier');
  sink.carrierEnd('h2');
  timers.advance(HOLDOFF);
  assert.deepEqual(port.started, ['a', 'b']);
});

test('unidentified speaker: provisional non-interrupting; identity upgrade to human cuts playback', () => {
  const { port, sink, events, item } = rig();
  sink.play(item('a'));
  sink.carrierStart('mystery', { bot: true }); // cache miss → provisional
  assert.equal(events.filter((e) => e.type === 'interrupted').length, 0);
  port.playingMs = 300;
  sink.carrierStart('mystery', { bot: false, username: 'late-fetch' }); // member resolved: human
  const cut = events.at(-1)!;
  assert.equal(cut.type, 'interrupted');
  assert.equal(cut.type === 'interrupted' && cut.by.username, 'late-fetch');
});

test('cancel: queued item silently removed; current item silently stopped; engine-cancel inside cleared never starts playback', () => {
  const { timers, port, sink, events, item } = rig();
  sink.play(item('a'));
  sink.play(item('b'));
  assert.equal(sink.cancel('b'), true);
  assert.equal(sink.cancel('b'), false, 'already gone');
  assert.equal(sink.cancel('a'), true);
  assert.equal(port.stops, 1);
  assert.deepEqual(events.map((e) => e.type), ['cleared', 'started'], 'cancel emits nothing');

  // Engine refuses at clearance (stale grant): cancel(id) arrives while the
  // sink is still inside its own `cleared` emit — playback must not start,
  // and the queue moves on.
  const { timers: t2, port: p2, sink: s2, events: e2, item: i2 } = rig();
  s2.onEvent((ev) => { if (ev.type === 'cleared' && ev.id === 'stale') s2.cancel('stale'); });
  s2.play(i2('stale'));
  s2.play(i2('fresh'));
  assert.deepEqual(p2.started, ['fresh'], 'the cancelled item never reached the port');
  assert.deepEqual(e2.filter((e) => 'id' in e && e.id === 'stale').map((e) => e.type), ['cleared']);
  void timers; void t2;
});

test('destroy: queue dropped, playback stopped, nothing emitted', () => {
  const { port, sink, events, item } = rig();
  sink.play(item('a'));
  sink.play(item('b'));
  const before = events.length;
  sink.destroy();
  assert.equal(port.stops, 1);
  assert.equal(events.length, before);
  // A finish surfacing after destroy (player race) must not emit either.
  port.finish(10);
  assert.equal(events.length, before);
});
