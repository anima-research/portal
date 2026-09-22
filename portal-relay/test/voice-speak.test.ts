// voice_speak RPC surface + receipt routing, with the speaker wiring replaced
// by a fake (the real one is behind a dynamic import and needs Discord).
//
//   1) Gating: UNAVAILABLE without wiring; FORBIDDEN without VOICE_SPEAK;
//      INVALID_PARAMS on empty/oversized text; NOT_JOINED → CONFLICT and
//      NO_VOICE → NOT_FOUND from the wiring's typed errors.
//   2) Identity is session-derived: the engine requestId is namespaced
//      `<personaId>/<clientId>`, and a wire grant's participantId is
//      OVERWRITTEN with the calling persona.
//   3) Receipts route to the requesting persona only, denamespaced, sequenced.
//   4) Lifecycle: listener leaving a channel closes its output path; relay
//      stop() retires the speaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay, type SpeakerLike } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';
import { VoiceSpeakError, type SpeakReceipt } from '../src/voice-output.js';
import type { SpeakArgs } from '../src/voice-speaker.js';

const GUILD = 'g1';
const VC_OPEN = 'vc-open';     // alice may VOICE_SPEAK here
const VC_SECRET = 'vc-secret'; // alice has no rights
const ALICE = 'alice';

class FakeSpeaker implements SpeakerLike {
  spoken: SpeakArgs[] = [];
  closed: string[] = [];
  stopped = false;
  failWith: VoiceSpeakError | null = null;
  private receiptFn: ((channelId: string, guildId: string | null, r: SpeakReceipt) => void) | null = null;
  speak(args: SpeakArgs): void {
    if (this.failWith) throw this.failWith;
    this.spoken.push(args);
  }
  onReceipt(fn: (channelId: string, guildId: string | null, r: SpeakReceipt) => void): void {
    this.receiptFn = fn;
  }
  channelClosed(channelId: string): void { this.closed.push(channelId); }
  stop(): void { this.stopped = true; }
  emitReceipt(channelId: string, guildId: string | null, r: SpeakReceipt): void {
    this.receiptFn?.(channelId, guildId, r);
  }
}

class FakeVoice {
  handlers: Record<string, (...a: never[]) => void> = {};
  on(event: string, fn: (...a: never[]) => void) { this.handlers[event] = fn; }
  destroy() {}
  status(channelId: string, joined: boolean) {
    (this.handlers.status as (c: string, g: string, j: boolean) => void)?.(channelId, GUILD, joined);
  }
}

function makeRelay(opts: { withSpeaker: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-speak-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({
    personas: [{ id: ALICE, displayName: 'Alice', avatar: '', token: 'ta' }],
  }));
  writeFileSync(permissionsPath, JSON.stringify({
    personas: {
      [ALICE]: {
        default: [],
        guilds: { [GUILD]: { default: [], channels: { [VC_OPEN]: ['VIEW_CHANNEL', 'VOICE_SPEAK'] } } },
      },
    },
  }));
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  relay.bot = {
    channelForPerms: (_channelId: string) => ({ guildId: GUILD, permissionsFor: () => ({ has: () => true }) }),
    meIn: () => ({}),
    isGuildAllowed: () => true,
    disconnect: async () => {},
  };
  const dispatched: Array<{ personaId: string; event: any }> = [];
  relay.gateway = {
    activePersonas: () => [],
    personaSubscribed: () => false,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, event }),
    dispatchEphemeral: () => {},
    close: async () => {},
  };
  relay.identity.stopWatching = () => {};
  relay.permissions.stopWatching = () => {};
  const voice = new FakeVoice();
  relay.attachVoice(voice);
  const speaker = new FakeSpeaker();
  if (opts.withSpeaker) relay.attachSpeaker(speaker);
  return { relay, voice, speaker, dispatched, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const session = (personaId: string) => ({ personaId, subscriptions: new Set<string>() } as unknown as Session);

test('voice_speak: UNAVAILABLE without wiring, FORBIDDEN without VOICE_SPEAK, INVALID_PARAMS on bad text', async () => {
  const bare = makeRelay({ withSpeaker: false });
  try {
    await assert.rejects(() => bare.relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'hi' }),
      (e: any) => e?.code === 'UNAVAILABLE');
  } finally { bare.cleanup(); }

  const { relay, speaker, cleanup } = makeRelay({ withSpeaker: true });
  try {
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_SECRET, text: 'hi' }),
      (e: any) => e?.code === 'FORBIDDEN');
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: '   ' }),
      (e: any) => e?.code === 'INVALID_PARAMS');
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'x'.repeat(2001) }),
      (e: any) => e?.code === 'INVALID_PARAMS');
    assert.equal(speaker.spoken.length, 0, 'nothing reached the wiring');
  } finally { cleanup(); }
});

test('voice_speak: identity is session-derived — namespaced requestId, grant participantId overwritten', async () => {
  const { relay, speaker, cleanup } = makeRelay({ withSpeaker: true });
  try {
    const res = await relay.dispatchRpc(session(ALICE), 'voice_speak', {
      channelId: VC_OPEN,
      text: '  hello room  ',
      requestId: 'my-key',
      grant: {
        grantId: 'gr1', roomBinding: 'discord://g1/vc-open',
        logicEpoch: 'e1', processEpoch: 'p1', expiresAt: null,
        participantId: 'mallory', // wire-forged identity must not survive
      },
    });
    assert.deepEqual(res, { requestId: 'my-key' });
    assert.equal(speaker.spoken.length, 1);
    const args = speaker.spoken[0];
    assert.equal(args.requestId, `${ALICE}/my-key`);
    assert.equal(args.personaId, ALICE);
    assert.equal(args.speakerName, 'Alice', 'registry lookup uses the display name');
    assert.equal(args.text, 'hello room', 'text is trimmed');
    assert.equal(args.grant?.participantId, ALICE);

    // Server-generated id when the caller brings none.
    const res2 = await relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'again' });
    assert.match(res2.requestId, /^spk/);
    assert.equal(speaker.spoken[1].requestId, `${ALICE}/${res2.requestId}`);
  } finally { cleanup(); }
});

test('voice_speak: wiring errors map onto RPC codes (NOT_JOINED → CONFLICT, NO_VOICE → NOT_FOUND)', async () => {
  const { relay, speaker, cleanup } = makeRelay({ withSpeaker: true });
  try {
    speaker.failWith = new VoiceSpeakError('NOT_JOINED', 'relay is not joined to voice channel vc-open — voice_join it first');
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'hi' }),
      (e: any) => e?.code === 'CONFLICT' && /voice_join/.test(e.message));
    speaker.failWith = new VoiceSpeakError('NO_VOICE', 'no voice registered for "Alice"');
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'hi' }),
      (e: any) => e?.code === 'NOT_FOUND');
    speaker.failWith = Object.assign(new Error('registry unreadable')) as VoiceSpeakError;
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_speak', { channelId: VC_OPEN, text: 'hi' }),
      (e: any) => e?.code === 'INTERNAL');
  } finally { cleanup(); }
});

test('receipts: denamespaced and delivered to the requesting persona only, sequenced', () => {
  const { relay, speaker, dispatched, cleanup } = makeRelay({ withSpeaker: true });
  try {
    speaker.emitReceipt(VC_OPEN, GUILD, {
      requestId: `${ALICE}/my-key`, participantId: ALICE, status: 'interrupted',
      voicedText: 'hello', unvoicedText: ' room', estimated: false,
      playedMs: 640, queuedMs: 120, billedChars: 10,
      interruptedBy: { userId: 'u9', username: 'ra', bot: false },
    });
    // An engine-internal id (no namespace) has no addressee: dropped, not misrouted.
    speaker.emitReceipt(VC_OPEN, GUILD, {
      requestId: 'orphan', participantId: 'x', status: 'refused',
      voicedText: '', unvoicedText: 'y', estimated: false,
      playedMs: 0, queuedMs: 0, billedChars: 0,
    });
    assert.equal(dispatched.length, 1);
    const { personaId, event } = dispatched[0];
    assert.equal(personaId, ALICE);
    assert.equal(event.type, 'voice_receipt');
    assert.equal(event.requestId, 'my-key');
    assert.equal(event.status, 'interrupted');
    assert.equal(event.voicedText, 'hello');
    assert.equal(event.billedChars, 10);
    assert.equal(event.interruptedBy.username, 'ra');
    assert.equal(event.channelId, VC_OPEN);
  } finally { cleanup(); }
});

test('lifecycle: listener leaving closes the channel output; stop() retires the speaker', async () => {
  const { relay, voice, speaker, cleanup } = makeRelay({ withSpeaker: true });
  try {
    voice.status(VC_OPEN, true);
    assert.deepEqual(speaker.closed, [], 'joining closes nothing');
    voice.status(VC_OPEN, false);
    assert.deepEqual(speaker.closed, [VC_OPEN]);
    relay.admin = undefined;
    await relay.stop();
    assert.equal(speaker.stopped, true);
  } finally { cleanup(); }
});
