// The utterance state machine behind the voice listener (voice-bot.ts).
//
// Contract pinned here:
//   1) exactly ONE final per utterance, even when Scribe commits more than
//      once inside it (VAD backstop) — mid-utterance commits surface as
//      partials carrying the cumulative text, so `portal_voice_<utteranceId>`
//      never collides on the host's eventId dedup;
//   2) a drain timeout after Discord's stream end finalizes with whatever was
//      committed (text is never lost to a late socket), and never twice;
//   3) every Scribe frame we don't understand is reported, not swallowed —
//      rate_limited / commit_throttled / session_time_limit_exceeded used to
//      vanish without a log line;
//   4) utterance ids differ across listener instances (relay restarts): the
//      host keeps an in-memory eventId dedup set, so a counter that restarts
//      at 1 would have its first N post-restart utterances dropped as dupes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceBot,
  finalizeUtterance,
  makeUtteranceId,
  newUtteranceState,
  reduceScribeMessage,
} from '../src/voice-bot.js';

test('partials render committed-so-far plus the mutable tail', () => {
  const u = newUtteranceState();
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'partial_transcript', text: 'hel' }),
    { kind: 'emit', text: 'hel', partial: true });
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'hello there' }),
    { kind: 'emit', text: 'hello there', partial: true }); // mid-utterance commit ⇒ still a partial
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'partial_transcript', text: 'how' }),
    { kind: 'emit', text: 'hello there how', partial: true });
  // Empty partial (breath/noise) emits nothing.
  assert.deepEqual(reduceScribeMessage(newUtteranceState(), { message_type: 'partial_transcript', text: '' }),
    { kind: 'none' });
});

test('exactly one final: the commit after Discord closed the stream', () => {
  const u = newUtteranceState();
  reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'first half' });
  u.closing = true; // Discord silence → flush(commit=true)
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'second half' }),
    { kind: 'emit', text: 'first half second half', partial: false });
  // Anything after the final is inert — a late duplicate commit or stray partial
  // must not produce a second final (or resurrect a partial under a finished id).
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'late' }), { kind: 'none' });
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'partial_transcript', text: 'x' }), { kind: 'none' });
  assert.deepEqual(finalizeUtterance(u), { kind: 'none' });
});

test('drain timeout finalizes from committed text, once, and an empty utterance finalizes silently', () => {
  const u = newUtteranceState();
  reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'only this arrived' });
  assert.deepEqual(finalizeUtterance(u), { kind: 'emit', text: 'only this arrived', partial: false });
  assert.deepEqual(finalizeUtterance(u), { kind: 'none' });
  // Post-timeout commit is too late: no second final.
  assert.deepEqual(reduceScribeMessage(u, { message_type: 'committed_transcript', text: 'late' }), { kind: 'none' });

  const empty = newUtteranceState();
  empty.closing = true;
  assert.deepEqual(reduceScribeMessage(empty, { message_type: 'committed_transcript', text: '' }), { kind: 'none' });
  assert.deepEqual(finalizeUtterance(empty), { kind: 'none' });
});

test('every non-transcript frame is a reported problem; known informational frames are silent', () => {
  const u = newUtteranceState();
  for (const type of [
    'rate_limited', 'commit_throttled', 'queue_overflow', 'resource_exhausted',
    'session_time_limit_exceeded', 'unaccepted_terms', 'chunk_size_exceeded',
    'insufficient_audio_activity', 'warning', 'error', 'auth_error', 'quota_exceeded',
    'transcriber_error', 'something_new',
  ]) {
    const out = reduceScribeMessage(u, { message_type: type, error: 'why' });
    assert.equal(out.kind, 'problem', type);
    assert.match((out as { detail: string }).detail, new RegExp(`^${type}: why$`));
  }
  assert.deepEqual(reduceScribeMessage(u, {}), { kind: 'problem', detail: 'unknown:' });
  for (const type of ['session_started', 'committed_transcript_with_timestamps', 'committed_transcript_entities']) {
    assert.deepEqual(reduceScribeMessage(u, { message_type: type }), { kind: 'none' }, type);
  }
  // Problems do not disturb the text state.
  assert.equal(u.committed, '');
});

test('utterance ids are unique across listener instances (relay restarts)', () => {
  const a = new VoiceBot({} as never, 'k');
  const b = new VoiceBot({} as never, 'k');
  assert.notEqual(a.utteranceEpoch, b.utteranceEpoch);
  assert.notEqual(makeUtteranceId(a.utteranceEpoch, 1, '123456789'), makeUtteranceId(b.utteranceEpoch, 1, '123456789'));
  assert.match(makeUtteranceId(a.utteranceEpoch, 7, '123456789'), /^u[0-9a-z]+-7-6789$/);
});
