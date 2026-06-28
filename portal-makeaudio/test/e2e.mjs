#!/usr/bin/env node
// End-to-end test for the makeaudio bot. Enrolls a separate "makeaudio-tester"
// persona, finds a writable channel, posts a source message, then @-mentions
// makeaudio with the source link (+ a prompt prefix) and waits for the audio
// reply. Run the bot (src/index.mjs) FIRST.
//
// Usage: node test/e2e.mjs [channelId]
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PortalClient, loadOrEnrollCreds } from '../../portal-client/dist/src/index.js';

const URL_WS = process.env.PORTAL_URL ?? 'wss://portal.animalabs.ai';
const INVITE = process.env.PORTAL_INVITE ?? 'inv_eWHy-z-gbVsyA-KoXb2RTi3Q';
const MAKEAUDIO_ID = process.env.MAKEAUDIO_ID ?? 'makeaudio-93487f';
const FORCE_CH = process.argv[2];
const log = (...a) => console.log('[e2e]', ...a);

async function main() {
  const creds = await loadOrEnrollCreds({
    url: URL_WS,
    credsPath: join(homedir(), '.portal', 'makeaudio-tester.creds.json'),
    invite: INVITE,
    desiredName: 'makeaudio-tester',
  });
  const c = new PortalClient({ url: URL_WS, token: creds.token, personaId: creds.personaId });
  c.on('error', (e) => log('client error', e.message));
  await c.connect();
  log('tester connected as', creds.personaId);

  // Pick a writable channel.
  let channelId = FORCE_CH;
  let guildId;
  const { guilds } = await c.call('list_guilds', {});
  log('guilds:', guilds.map((g) => `${g.name}(${g.id})`).join(', '));
  outer: for (const g of guilds) {
    const { channels } = await c.call('list_channels', { guildId: g.id });
    for (const ch of channels) {
      const writable =
        ch.type === 'text' &&
        ch.capabilities.includes('SEND_MESSAGES') &&
        ch.capabilities.includes('READ_HISTORY');
      if (FORCE_CH ? ch.id === FORCE_CH : writable) {
        channelId = ch.id;
        guildId = g.id;
        log(`using channel #${ch.name} (${ch.id}) in ${g.name} caps=${ch.capabilities.join(',')}`);
        break outer;
      }
    }
  }
  if (!channelId) throw new Error('no writable channel found');

  // 1) Source message that makeaudio will read.
  const sourceText = 'Welcome to the midnight broadcast. Tonight, a single candle flickers in an empty lighthouse.';
  const src = await c.sendMessage({ channelId, content: sourceText });
  await new Promise((r) => setTimeout(r, 1500));
  const hist = await c.fetchHistory({ channelId, limit: 5 });
  const srcMsg = hist.messages.find((m) => m.id === src.messageId);
  const nativeId = srcMsg?.nativeId;
  if (!nativeId) throw new Error('could not resolve source nativeId');
  const link = `https://discord.com/channels/${guildId}/${channelId}/${nativeId}`;
  log('source link:', link);

  // 2) Trigger: @mention makeaudio with the link + a prompt prefix.
  const t0 = Date.now();
  const trigger = await c.sendMessage({
    channelId,
    content: `${link} read this as a slow, eerie radio-drama narration`,
    mentionPersonaIds: [MAKEAUDIO_ID],
  });
  log('posted trigger', trigger.messageId, '— waiting for audio reply…');

  // 3) Poll history for the bot's reply (a makeaudio persona msg replying to our
  //    trigger, carrying an audio attachment). Polling is robust to push timing.
  const deadline = Date.now() + 120000;
  let found = null;
  while (Date.now() < deadline && !found) {
    await new Promise((r) => setTimeout(r, 4000));
    const h = await c.fetchHistory({ channelId, limit: 8 });
    found = h.messages.find((m) => {
      const isBot = m.author?.kind === 'persona' && m.author.personaId === MAKEAUDIO_ID;
      // Webhook personas can't carry a native reply (replyToId degrades to a
      // quoted jump-link), so match on author + audio + posted-after-trigger.
      const fresh = new Date(m.createdAt).getTime() >= t0 - 2000;
      const hasAudio = (m.attachments || []).some(
        (a) => /audio|\.(mp3|wav|ogg)/i.test(`${a.contentType || ''} ${a.name || ''}`),
      );
      return isBot && hasAudio && fresh;
    });
  }

  if (found) {
    const a = found.attachments[0];
    log('✅ AUDIO REPLY:', a.name, `${a.size}B`, a.contentType, '| content=', JSON.stringify(found.content));
  } else {
    log('❌ TIMEOUT — no audio reply in 120s. Recent history:');
    const h2 = await c.fetchHistory({ channelId, limit: 6 });
    for (const m of h2.messages)
      log('  -', m.author?.kind, m.author?.displayName || m.author?.username || '', JSON.stringify((m.content || '').slice(0, 80)), (m.attachments || []).length, 'att');
  }
  c.close();
  process.exit(found ? 0 : 1);
}
main().catch((e) => {
  console.error('[e2e] FAILED', e);
  process.exit(1);
});
