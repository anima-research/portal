// Relay-side voice delivery policy, with the Discord bot, WS gateway and the
// voice listener replaced by fakes (no network).
//
//   1) voice_join maps listener failures onto RPC codes: one listener per
//      guild ⇒ CONFLICT (never a silent move that ends someone else's
//      transcription); non-voice channel ⇒ INVALID_PARAMS; unset key ⇒ UNAVAILABLE.
//   2) transcripts and voice_status go only to subscribed personas who can
//      VIEW the channel; partials ride the ephemeral op, finals are sequenced.
//   3) stop() retires the listener so the bot does not linger in the channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';
import { VoiceJoinError, type VoiceTranscript } from '../src/voice-bot.js';

const GUILD = 'g1';
const VC_OPEN = 'vc-open';     // alice may VIEW + VOICE_LISTEN
const VC_SECRET = 'vc-secret'; // alice has no rights
const ALICE = 'alice';
const BOB = 'bob';             // bob may VIEW + VOICE_LISTEN everywhere in GUILD

class FakeVoice {
  handlers: Record<string, (...a: never[]) => void> = {};
  joined = new Map<string, string>(); // channelId → guildId
  destroyed = false;
  on(event: string, fn: (...a: never[]) => void) { this.handlers[event] = fn; }
  async join(channelId: string) {
    if (channelId === 'text-chan') throw new VoiceJoinError('INVALID_PARAMS', 'not a voice channel');
    for (const [cid] of this.joined) {
      if (cid !== channelId) throw new VoiceJoinError('CONFLICT', `relay is already listening in voice channel ${cid} of this guild; voice_leave it first`, cid);
    }
    this.joined.set(channelId, GUILD);
    (this.handlers.status as (c: string, g: string, j: boolean) => void)?.(channelId, GUILD, true);
  }
  leave(channelId: string) {
    if (!this.joined.delete(channelId)) return;
    (this.handlers.status as (c: string, g: string, j: boolean) => void)?.(channelId, GUILD, false);
  }
  destroy() { this.destroyed = true; for (const c of [...this.joined.keys()]) this.leave(c); }
  transcript(t: VoiceTranscript) { (this.handlers.transcript as (t: VoiceTranscript) => void)(t); }
}

function makeRelay(opts: { withVoice: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-voice-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({
    personas: [
      { id: ALICE, displayName: 'Alice', avatar: '', token: 'ta' },
      { id: BOB, displayName: 'Bob', avatar: '', token: 'tb' },
    ],
  }));
  const CAPS = ['VIEW_CHANNEL', 'VOICE_LISTEN'];
  writeFileSync(permissionsPath, JSON.stringify({
    personas: {
      [ALICE]: { default: [], guilds: { [GUILD]: { default: [], channels: { [VC_OPEN]: CAPS } } } },
      [BOB]: { default: [], guilds: { [GUILD]: { default: CAPS } } },
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
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 1 }],
    isGuildAllowed: () => true,
    disconnect: async () => {},
  };
  const dispatched: Array<{ personaId: string; op: 'dispatch' | 'ephemeral'; event: any }> = [];
  const subscriptions = new Map<string, Set<string>>();
  relay.gateway = {
    activePersonas: () => [...subscriptions.keys()],
    personaSubscribed: (pid: string, chan: string) => subscriptions.get(pid)?.has(chan) ?? false,
    dispatch: (personaId: string, event: any) => dispatched.push({ personaId, op: 'dispatch', event }),
    dispatchEphemeral: (personaId: string, event: any) => dispatched.push({ personaId, op: 'ephemeral', event }),
    close: async () => {},
  };
  relay.identity.stopWatching = () => {};
  relay.permissions.stopWatching = () => {};
  const voice = new FakeVoice();
  if (opts.withVoice) relay.attachVoice(voice);
  return { relay, voice, dispatched, subscriptions, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const session = (personaId: string) => ({ personaId, subscriptions: new Set<string>() } as unknown as Session);

test('voice_join/voice_leave: UNAVAILABLE without a listener', async () => {
  const { relay, cleanup } = makeRelay({ withVoice: false });
  try {
    for (const m of ['voice_join', 'voice_leave']) {
      await assert.rejects(() => relay.dispatchRpc(session(ALICE), m, { channelId: VC_OPEN }),
        (e: any) => e?.code === 'UNAVAILABLE');
    }
  } finally { cleanup(); }
});

test('voice_join: FORBIDDEN without VOICE_LISTEN, CONFLICT on a second channel in the guild, INVALID_PARAMS on a text channel', async () => {
  const { relay, voice, subscriptions, dispatched, cleanup } = makeRelay({ withVoice: true });
  try {
    await assert.rejects(() => relay.dispatchRpc(session(ALICE), 'voice_join', { channelId: VC_SECRET }),
      (e: any) => e?.code === 'FORBIDDEN');
    assert.equal(voice.joined.size, 0, 'a forbidden join must not touch the listener');

    const alice = session(ALICE);
    subscriptions.set(ALICE, alice.subscriptions);
    assert.deepEqual(await relay.dispatchRpc(alice, 'voice_join', { channelId: VC_OPEN }), { listening: true });
    assert.ok(alice.subscriptions.has(VC_OPEN), 'join auto-subscribes the session');
    assert.deepEqual(dispatched.map((d) => [d.personaId, d.op, d.event.type, d.event.joined]),
      [[ALICE, 'dispatch', 'voice_status', true]]);

    // Bob wants a different channel of the same guild: refused, and Alice's
    // listener is untouched (no silent move).
    await assert.rejects(() => relay.dispatchRpc(session(BOB), 'voice_join', { channelId: VC_SECRET }),
      (e: any) => e?.code === 'CONFLICT' && /vc-open/.test(e.message));
    assert.deepEqual([...voice.joined.keys()], [VC_OPEN]);
    // Bob joining the SAME channel is idempotent.
    assert.deepEqual(await relay.dispatchRpc(session(BOB), 'voice_join', { channelId: VC_OPEN }), { listening: true });

    await assert.rejects(() => relay.dispatchRpc(session(BOB), 'voice_join', { channelId: 'text-chan' }),
      (e: any) => e?.code === 'INVALID_PARAMS');
  } finally { cleanup(); }
});

test('delivery: subscribed + viewable only; partials ephemeral, finals sequenced; status gated the same way', () => {
  const { relay, voice, subscriptions, dispatched, cleanup } = makeRelay({ withVoice: true });
  try {
    // Alice subscribed to both (subscribe-then-revoke race for VC_SECRET); Bob to VC_SECRET only.
    subscriptions.set(ALICE, new Set([VC_OPEN, VC_SECRET]));
    subscriptions.set(BOB, new Set([VC_SECRET]));
    const t = (channelId: string, partial: boolean): VoiceTranscript => ({
      channelId, guildId: GUILD, userId: 'u1', username: 'human', displayName: 'Human', bot: false,
      utteranceId: 'uX-1-0001', text: partial ? 'hel' : 'hello', partial, startedAt: 1,
    });
    voice.transcript(t(VC_OPEN, true));
    voice.transcript(t(VC_OPEN, false));
    voice.transcript(t(VC_SECRET, false));
    assert.deepEqual(dispatched.map((d) => [d.personaId, d.op, d.event.channelId, d.event.partial]), [
      [ALICE, 'ephemeral', VC_OPEN, true],
      [ALICE, 'dispatch', VC_OPEN, false],
      [BOB, 'dispatch', VC_SECRET, false], // alice cannot view VC_SECRET → nothing leaks to her
    ]);
    assert.equal(dispatched[1].event.type, 'voice_transcript');
    assert.equal(dispatched[1].event.speaker.displayName, 'Human');

    dispatched.length = 0;
    voice.handlers.status(VC_SECRET, GUILD, true);
    assert.deepEqual(dispatched.map((d) => [d.personaId, d.event.type]), [[BOB, 'voice_status']],
      'voice_status must respect VIEW_CHANNEL like transcripts do');
  } finally { cleanup(); }
});

test('stop() retires the listener', async () => {
  const { relay, voice, cleanup } = makeRelay({ withVoice: true });
  try {
    await voice.join(VC_OPEN);
    relay.admin = undefined;
    await relay.stop();
    assert.equal(voice.destroyed, true);
    assert.equal(voice.joined.size, 0);
  } finally { cleanup(); }
});
