import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentState } from '../src/agent-state.js';
import { audioMimeFor, normalizeAudioMime } from '../src/server.js';

test('audio visibility: per-channel toggle, default off', () => {
  const s = new AgentState();
  assert.equal(s.isAudioVisible('c1'), false);
  assert.equal(s.setAudioVisibility('c1', true), true);
  assert.equal(s.setAudioVisibility('c1', true), false); // no-op
  assert.equal(s.isAudioVisible('c1'), true);
  assert.equal(s.isAudioVisible('c2'), false);
  assert.equal(s.setAudioVisibility('c1', false), true);
  assert.equal(s.isAudioVisible('c1'), false);
});

test('audio visibility survives serialization', () => {
  const s = new AgentState();
  s.setAudioVisibility('c1', true);
  const restored = AgentState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(restored.isAudioVisible('c1'), true);
  assert.deepEqual(restored.audioVisibilityList(), ['c1']);
});

test('normalizeAudioMime collapses MP3 aliases and strips parameters', () => {
  assert.equal(normalizeAudioMime('audio/mpeg'), 'audio/mp3');
  assert.equal(normalizeAudioMime('audio/mpg'), 'audio/mp3');
  assert.equal(normalizeAudioMime('audio/mpeg3'), 'audio/mp3');
  assert.equal(normalizeAudioMime('audio/x-mpeg-3'), 'audio/mp3');
  assert.equal(normalizeAudioMime('audio/mpeg; rate=16000'), 'audio/mp3');
  assert.equal(normalizeAudioMime('Audio/OGG'), 'audio/ogg');
  assert.equal(normalizeAudioMime('audio/wav'), 'audio/wav');
});

test('audioMimeFor: content-type first, extension fallback, undefined otherwise', () => {
  assert.equal(audioMimeFor({ name: 'clip.bin', contentType: 'audio/mpeg' }), 'audio/mp3');
  // Discord voice messages: audio/ogg with codec parameter
  assert.equal(audioMimeFor({ name: 'voice-message.ogg', contentType: 'audio/ogg; codecs=opus' }), 'audio/ogg');
  // contentType missing → extension fallback
  assert.equal(audioMimeFor({ name: 'song.mp3', contentType: null }), 'audio/mp3');
  assert.equal(audioMimeFor({ name: 'take.M4A', contentType: null }), 'audio/mp4');
  assert.equal(audioMimeFor({ name: 'sound.flac', contentType: 'application/octet-stream' }), 'audio/flac');
  // not audio
  assert.equal(audioMimeFor({ name: 'doc.pdf', contentType: 'application/pdf' }), undefined);
  assert.equal(audioMimeFor({ name: 'noext', contentType: null }), undefined);
});
