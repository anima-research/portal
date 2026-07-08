// Live RFC-006 verification: markdown-preserving split sends + audio attachments.
// Starts the relay (one bot) against a real guild, connects the two test personas,
// and exercises the whole split lifecycle plus an audio round-trip.
//
// Side effects (in the target channel): posts a handful of test messages, edits
// and deletes them, uploads one small .wav, adds one 🐘 reaction. Everything it
// creates it deletes at the end.
//
// Usage: DISCORD_TOKEN=... node scripts/rfc6-live.mjs <guildId> <channelId>
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';
import { normalizeAudioMime, audioMimeFor } from '../../portal-mcpl/dist/src/server.js';

const [guildId, channelId] = process.argv.slice(2);
const token = process.env.DISCORD_TOKEN;
if (!token || !guildId || !channelId) {
  console.error('usage: DISCORD_TOKEN=... node scripts/rfc6-live.mjs <guildId> <channelId>');
  process.exit(2);
}

const config = {
  discordToken: token,
  wsPort: 8792,
  avatarBaseUrl: '',
  guildIds: [guildId],
  identityPath: new URL('../identity.test.json', import.meta.url).pathname,
  permissionsPath: new URL('../permissions.test.json', import.meta.url).pathname,
  rolePool: { size: 2, prefix: 'portal-' },
  webhookPoolSize: 1,
  heartbeatIntervalMs: 30000,
  guildMembersIntent: false,
  watchConfig: false,
};

const log = (...a) => console.log('[rfc6]', ...a);
let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { pass++; log('  ✅', label); }
  else { fail++; log('  ❌', label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until fn() returns truthy (polling), or time out. */
async function until(fn, ms = 10000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return undefined;
    await sleep(step);
  }
}

/** Minimal valid WAV: 0.5 s of 440 Hz sine, 8 kHz mono 16-bit (~8 KB). */
function makeWav() {
  const rate = 8000;
  const n = rate / 2;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Over-limit content: prose + a long ts fence + a tail, so at least one split
 *  boundary falls INSIDE the fence (the bridge open/close machinery must fire). */
const fenceBody = Array.from({ length: 110 }, (_, i) => `const line_${String(i).padStart(3, '0')} = 'markdown split survival test padding';`).join('\n');
const ORIGINAL = `**RFC-006 live test** — the fence below must survive splitting intact.\n\`\`\`ts\n${fenceBody}\n\`\`\`\nTail after the fence, with *emphasis* intact.`;

async function main() {
  const relay = new Relay(config);
  await relay.start();
  log('relay started; waiting for caches…');
  await sleep(4000);

  const mythos = new PortalClient({ url: 'ws://127.0.0.1:8792', token: 'tok-mythos', personaId: 'mythos' });
  const lena = new PortalClient({ url: 'ws://127.0.0.1:8792', token: 'tok-lena', personaId: 'lena' });
  await mythos.connect();
  await lena.connect();
  await lena.subscribe(channelId);

  const events = [];   // lena's message_create events in the channel
  const deletes = [];  // lena's message_delete events
  lena.on('message', (e) => { if (e.message.channelId === channelId) events.push(e.message); });
  lena.on('messageDelete', (e) => { if (e.channelId === channelId) deletes.push(e.messageId); });

  // ── 1. split send ──
  log(`1. split send (${ORIGINAL.length} chars)`);
  const sent = await mythos.sendMessage({ channelId, content: ORIGINAL });
  check(Array.isArray(sent.messageIds) && sent.messageIds.length >= 2, `split into ${sent.messageIds?.length} parts`);
  check(sent.messageId === sent.messageIds?.[0], 'messageId === first part');

  // ── 2. live events: parts arrive stripped, continuations tagged partOf ──
  const parts = await until(() => {
    const got = sent.messageIds.map((id) => events.find((m) => m.id === id));
    return got.every(Boolean) ? got : undefined;
  });
  check(!!parts, 'all parts arrived as live events');
  if (parts) {
    check(parts[0].partOf === undefined, 'first part has no partOf');
    check(parts.slice(1).every((m) => m.partOf === sent.messageId), 'continuations partOf → first part');
    check(parts.every((m) => ORIGINAL.includes(m.content)), 'every event content is a clean substring of the original (bridges stripped)');
  }

  // ── 3. history: same messages, same stripping, reassembly ──
  const hist1 = await mythos.fetchHistory({ channelId, limit: 10 });
  const hParts = sent.messageIds.map((id) => hist1.messages.find((m) => m.id === id));
  check(hParts.every(Boolean), 'all parts present in fetch_history');
  if (hParts.every(Boolean)) {
    check(hParts.every((m) => ORIGINAL.includes(m.content)), 'history contents are clean substrings');
    const joined = [hParts.map((m) => m.content).join(''), hParts.map((m) => m.content).join('\n')];
    check(joined.includes(ORIGINAL), 'parts reassemble to the original');
  }

  // ── 4. edit: shrink within part count, then collapse to one part ──
  log('2. edit lifecycle');
  const SHRUNK = ORIGINAL.slice(0, 2600) + "';\n```\nshrunk tail.";
  await mythos.editMessage(sent.messageId, SHRUNK);
  const hist2 = await mythos.fetchHistory({ channelId, limit: 10 });
  const after = sent.messageIds.map((id) => hist2.messages.find((m) => m.id === id)).filter(Boolean);
  check(after.length >= 2 && after.length <= sent.messageIds.length, `shrunk edit spans ${after.length} parts`);
  check(after.every((m) => SHRUNK.includes(m.content)), 'edited parts are clean substrings of new content');

  await mythos.editMessage(sent.messageId, 'collapsed to a single short message.');
  const gone = await until(() => sent.messageIds.slice(1).every((id) => deletes.includes(id) || !id));
  check(!!gone, 'surplus parts deleted on collapse (delete events seen)');
  const hist3 = await mythos.fetchHistory({ channelId, limit: 10 });
  check(!hist3.messages.some((m) => sent.messageIds.slice(1).includes(m.id)), 'surplus parts absent from history');

  // ── 5. edit that would need MORE parts must be refused ──
  const TOO_LONG = ORIGINAL + '\n' + ORIGINAL;
  let refused = false;
  try { await mythos.editMessage(sent.messageId, TOO_LONG); } catch (err) { refused = /INVALID_PARAMS|shorten/i.test(String(err?.code ?? '') + err.message); }
  check(refused, 'growth beyond original part count refused with INVALID_PARAMS');

  // ── 6. delete fans out over all parts ──
  log('3. delete fan-out');
  const sent2 = await mythos.sendMessage({ channelId, content: ORIGINAL });
  check(sent2.messageIds?.length >= 2, `second split send (${sent2.messageIds?.length} parts)`);
  deletes.length = 0;
  await mythos.deleteMessage(sent2.messageId);
  const allGone = await until(() => sent2.messageIds.every((id) => deletes.includes(id)));
  check(!!allGone, 'delete of first part removed every part');

  // ── 7. audio attachment round-trip ──
  log('4. audio attachment');
  const wav = makeWav();
  const sentAudio = await mythos.sendMessage({
    channelId, content: 'RFC-006 audio round-trip.',
    files: [{ name: 'rfc6-test.wav', bytes: wav.toString('base64'), contentType: 'audio/wav' }],
  });
  const audioMsg = await until(() => events.find((m) => m.id === sentAudio.messageId && m.attachments?.length));
  check(!!audioMsg, 'audio message arrived with attachment');
  if (audioMsg) {
    const att = audioMsg.attachments[0];
    const mime = audioMimeFor(att);
    check(!!mime && mime.startsWith('audio/'), `detected as audio (${att.contentType ?? 'no contentType'} → ${mime})`);
    check(normalizeAudioMime('audio/mpeg; rate=44100') === 'audio/mp3', 'MIME normalization sane');
    const res = await fetch(att.url);
    const body = Buffer.from(await res.arrayBuffer());
    check(res.ok && body.length === wav.length, `attachment fetchable from CDN (${body.length} bytes)`);
    await lena.react(sentAudio.messageId, '🐘', false, true);
    check(true, 'native 🐘 reaction accepted');
  }

  // ── cleanup ──
  await mythos.deleteMessage(sentAudio.messageId).catch(() => {});
  await mythos.deleteMessage(sent.messageId).catch(() => {});
  log(`done: ${pass} passed, ${fail} failed`);
  mythos.close();
  lena.close();
  await relay.stop();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('[rfc6] fatal:', err); process.exit(1); });
