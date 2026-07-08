// Live audio-carrying test with a REAL model behind a persona.
//
// Mythos posts a spoken .wav into the channel addressing Lena; Lena is driven
// by MiMo v2.5 (OpenRouter): her inbound message is turned into MCPL content
// blocks by portal-mcpl's actual buildContent (audio inlined), mapped to
// OpenRouter `input_audio` parts exactly like membrane's adapter, and MiMo's
// reply is posted back through the persona. Passing = the reply quotes the
// spoken phrase, proving the clip survived Discord → relay → mcpl → model.
//
// The exchange is left in the channel on purpose so humans can see it.
//
// Usage: DISCORD_TOKEN=... OPENROUTER_API_KEY=... \
//        node scripts/mimo-audio-live.mjs <guildId> <channelId> <clip.wav>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';
import { buildContent, normalizeAudioMime } from '../../portal-mcpl/dist/src/server.js';

const [guildId, channelId, clipPath] = process.argv.slice(2);
const token = process.env.DISCORD_TOKEN;
const orKey = process.env.OPENROUTER_API_KEY;
if (!token || !orKey || !guildId || !channelId || !clipPath) {
  console.error('usage: DISCORD_TOKEN=... OPENROUTER_API_KEY=... node scripts/mimo-audio-live.mjs <guildId> <channelId> <clip.wav>');
  process.exit(2);
}

const MODEL = 'xiaomi/mimo-v2.5';
// Pin inference to non-Chinese hosts — mirrors config/bots/mimo.yaml.
const PROVIDER = { order: ['parasail', 'venice', 'deepinfra'], allow_fallbacks: false };
const PHRASE_WORDS = ['elephant', 'midnight', 'copper'];

const config = {
  discordToken: token,
  wsPort: 8793,
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

const log = (...a) => console.log('[mimo-live]', ...a);

/** MCPL audio block MIME → OpenRouter input_audio format (membrane's mapping). */
function formatFor(mimeType) {
  const m = normalizeAudioMime(mimeType);
  if (m === 'audio/mp3') return 'mp3';
  if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(m)) return 'wav';
  return undefined;
}

/** MCPL content blocks → OpenRouter chat-completions content parts. */
function toOpenRouterParts(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'audio') {
      const format = formatFor(b.mimeType ?? 'audio/mpeg');
      if (format) parts.push({ type: 'input_audio', input_audio: { data: b.data, format } });
      else log(`skipping audio block with unmappable MIME ${b.mimeType}`);
    }
  }
  return parts;
}

async function askMimo(parts) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      provider: PROVIDER,
      max_tokens: 512,
      messages: [
        {
          role: 'system',
          content:
            'You are Lena, a Discord persona. A user sent you an audio clip. ' +
            'Describe exactly what you hear and quote any spoken words verbatim. Reply briefly.',
        },
        { role: 'user', content: parts },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.choices?.[0]?.message?.content ?? '';
}

async function main() {
  const relay = new Relay(config);
  await relay.start();
  log('relay started; waiting for caches…');
  await new Promise((r) => setTimeout(r, 4000));

  const mythos = new PortalClient({ url: 'ws://127.0.0.1:8793', token: 'tok-mythos', personaId: 'mythos' });
  const lena = new PortalClient({ url: 'ws://127.0.0.1:8793', token: 'tok-lena', personaId: 'lena' });
  await mythos.connect();
  await lena.connect();
  await lena.subscribe(channelId);

  // Lena's brain: audio message in → mcpl content blocks → MiMo → persona reply.
  let replied;
  const gotReply = new Promise((resolve) => (replied = resolve));
  lena.on('message', (e) => {
    const m = e.message;
    if (m.channelId !== channelId || !m.attachments?.length) return;
    void (async () => {
      const blocks = await buildContent(m, { inlineAudio: true });
      const kinds = blocks.map((b) => b.type).join(', ');
      log(`lena received "${m.author.displayName ?? m.author.kind}: ${m.content}" → mcpl blocks: [${kinds}]`);
      if (!blocks.some((b) => b.type === 'audio')) {
        log('no audio block was inlined — aborting');
        return replied({ ok: false, reply: '' });
      }
      const reply = await askMimo(toOpenRouterParts(blocks));
      log('mimo replied:', JSON.stringify(reply));
      await lena.sendMessage({ channelId, content: reply || '(empty reply)', replyToId: m.id });
      replied({ ok: true, reply });
    })().catch((err) => {
      log('agent error:', err.message);
      replied({ ok: false, reply: String(err.message) });
    });
  });

  const wav = readFileSync(clipPath);
  log(`mythos posts the clip (${wav.length} bytes)…`);
  await mythos.sendMessage({
    channelId,
    content: 'Lena — what do you hear in this clip?',
    mentionPersonaIds: ['lena'],
    files: [{ name: basename(clipPath), bytes: wav.toString('base64'), contentType: 'audio/wav' }],
  });

  const result = await Promise.race([
    gotReply,
    new Promise((r) => setTimeout(() => r({ ok: false, reply: '(timeout)' }), 90000)),
  ]);

  const heard = PHRASE_WORDS.filter((w) => result.reply.toLowerCase().includes(w));
  log(result.ok && heard.length
    ? `✅ PASS — MiMo heard the clip (matched: ${heard.join(', ')})`
    : `❌ FAIL — ok=${result.ok}, phrase words matched: ${heard.join(', ') || 'none'}`);

  mythos.close();
  lena.close();
  await relay.stop();
  process.exit(result.ok && heard.length ? 0 : 1);
}

main().catch((err) => { console.error('[mimo-live] fatal:', err); process.exit(1); });
