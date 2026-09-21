import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_WAKE_MAX_CHARS,
  CodexQueueSink,
  readCodexWakeTarget,
  renderCodexWake,
  wakeSinkFromEnv,
} from '../src/wake-sink.js';

const dir = () => mkdtempSync(join(tmpdir(), 'wake-sink-'));

test('CodexQueueSink waits for the sidecar, then queues a turn on that thread', async () => {
  const file = join(dir(), 'p.wake.json');
  const calls: { bin: string; args: string[] }[] = [];
  let polls = 0;
  const sink = new CodexQueueSink(
    file,
    async (bin, args) => void calls.push({ bin, args }),
    async () => {
      // Sidecar appears on the second poll — a mention that beat the launcher.
      if (++polls === 2) writeFileSync(file, JSON.stringify({ codexBin: '/opt/codex', threadId: 'thread-1' }));
    },
    () => 0, // clock never advances → never times out
  );
  await sink.deliver({ content: 'antra: hi', meta: { channelId: 'c1', author: 'antra' } });
  assert.equal(polls, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/codex');
  assert.deepEqual(calls[0].args.slice(0, 4), ['queue', '--thread', 'thread-1', '--message']);
  assert.match(calls[0].args[4], /^\[portal\] antra addressed you in channel c1 — reply there with send_message\(channelId c1\)\.\nantra: hi$/);
});

test('CodexQueueSink gives up loudly when the sidecar never appears', async () => {
  const file = join(dir(), 'never.wake.json');
  let t = 0;
  const sink = new CodexQueueSink(file, async () => assert.fail('must not exec'), async () => void (t += 60_000), () => t);
  await assert.rejects(sink.deliver({ content: 'x', meta: { channelId: 'c', author: 'a' } }), /no codex wake target/);
});

test('readCodexWakeTarget treats garbage and partial sidecars as absent', () => {
  const d = dir();
  assert.equal(readCodexWakeTarget(join(d, 'missing.json')), undefined);
  const bad = join(d, 'bad.json');
  writeFileSync(bad, '{"codexBin": "/opt/codex"'); // truncated mid-write
  assert.equal(readCodexWakeTarget(bad), undefined);
  const partial = join(d, 'partial.json');
  writeFileSync(partial, JSON.stringify({ codexBin: '/opt/codex' }));
  assert.equal(readCodexWakeTarget(partial), undefined);
  const ok = join(d, 'ok.json');
  writeFileSync(ok, JSON.stringify({ codexBin: '/opt/codex', threadId: 't', extra: 1 }));
  assert.deepEqual(readCodexWakeTarget(ok), { codexBin: '/opt/codex', threadId: 't' });
});

test('renderCodexWake: thread hint, catch-up header, tail-preserving cap', () => {
  const threaded = renderCodexWake({ content: 'body', meta: { channelId: 'c', threadId: 't', author: 'mica' } });
  assert.match(threaded, /^\[portal\] mica addressed you in thread t \(channel c\) — reply there with send_message\(channelId c, threadId t\)\.\nbody$/);

  const catchup = renderCodexWake({ content: 'body', meta: { channelId: 'c', author: 'x', catchup: 'true' } });
  assert.match(catchup, /^\[portal\] Messages addressed to you arrived while you were away/);

  const long = 'a'.repeat(CODEX_WAKE_MAX_CHARS + 500) + 'TRIGGER';
  const capped = renderCodexWake({ content: long, meta: { channelId: 'c', author: 'x' } });
  assert.match(capped, /\[507 chars of earlier context omitted — use fetch_history\]\n/);
  assert.ok(capped.endsWith('TRIGGER'), 'the trigger line survives the cap');
  assert.ok(capped.length < long.length);
});

test('wakeSinkFromEnv: unset → none, codex → sink at the default sidecar, unknown → throws', () => {
  const defaults = { stateDir: '/s', personaId: 'p-1' };
  assert.equal(wakeSinkFromEnv({}, defaults), undefined);
  assert.equal(wakeSinkFromEnv({ PORTAL_WAKE: '' }, defaults), undefined);
  const sink = wakeSinkFromEnv({ PORTAL_WAKE: 'codex' }, defaults) as CodexQueueSink;
  assert.equal(sink.kind, 'codex');
  assert.equal(sink.file, '/s/p-1.wake.json');
  const explicit = wakeSinkFromEnv({ PORTAL_WAKE: 'codex', PORTAL_WAKE_FILE: '/x/y.json' }, defaults) as CodexQueueSink;
  assert.equal(explicit.file, '/x/y.json');
  assert.throws(() => wakeSinkFromEnv({ PORTAL_WAKE: 'carrier-pigeon' }, defaults), /not a wake sink/);
});
