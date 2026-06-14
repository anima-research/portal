// Live end-to-end smoke test against antra's server, scoped to that one guild.
// Starts the relay (one bot), connects two persona clients, posts + reacts +
// reads history. Side effects (in a test channel of antra's own server):
//   - creates pooled roles portal-Mythos / portal-Lena
//   - creates one webhook in the target channel
//   - posts a few messages
//
// Usage: node scripts/smoke.mjs <channelId>
import { readFileSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';

const GUILD = '1289595876716707911'; // antra's server
const channelId = process.argv[2] || '1289659411270209609'; // #test
const token = readFileSync(
  new URL('../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url),
  'utf8',
).trim();

const config = {
  discordToken: token,
  wsPort: 8790,
  avatarBaseUrl: '',
  guildIds: [GUILD],
  identityPath: new URL('../identity.test.json', import.meta.url).pathname,
  permissionsPath: new URL('../permissions.test.json', import.meta.url).pathname,
  rolePool: { size: 50, prefix: 'portal-' },
  webhookPoolSize: 1,
  heartbeatIntervalMs: 30000,
  guildMembersIntent: true,
  watchConfig: false,
};

const log = (...a) => console.log('[smoke]', ...a);

async function main() {
  const relay = new Relay(config);
  await relay.start();
  log('relay started; waiting for caches…');
  await new Promise((r) => setTimeout(r, 4000));

  const mythos = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-mythos', personaId: 'mythos' });
  const ready = await mythos.connect();
  log('mythos ready. role bindings:', JSON.stringify(ready.persona.roleByGuild));
  log('channels visible:', mythos.cache.allChannels().length);

  const send1 = await mythos.sendMessage({ channelId, content: '🌉 portal smoke test — Mythos here, posting via webhook (shared bot, no bot slot).' });
  log('mythos posted, relayId =', send1.messageId);

  const lena = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-lena', personaId: 'lena' });
  await lena.connect();
  const send2 = await lena.sendMessage({ channelId, content: 'Lena here too — same bot, different face. Replying to Mythos:', replyToId: send1.messageId });
  log('lena posted reply, relayId =', send2.messageId);

  // ── INBOUND routing test: Mythos @-mentions Lena's role → Lena must receive
  //    it as addressedToMe (reasons include role_mention). Fully automated. ──
  const inbound = new Promise((resolve) => {
    lena.on('message', (e) => {
      if (e.addressedToMe && e.reasons.includes('role_mention')) resolve(e);
    });
  });
  const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
  await mythos.sendMessage({ channelId, content: 'inbound routing check — paging you', mentionPersonaIds: ['lena'] });
  const got = await Promise.race([inbound, timeout(8000)]);
  log('INBOUND:', got ? `✅ lena received addressed msg (reasons=${got.reasons.join(',')})` : '❌ TIMEOUT — no addressed delivery');

  await lena.react(send1.messageId, '👋', true);
  log('lena reacted (visible) to mythos message');

  const hist = await mythos.fetchHistory({ channelId, limit: 5 });
  log('fetch_history returned', hist.messages.length, 'messages; latest authors:',
    hist.messages.slice(0, 3).map((m) => `${m.author.kind}:${m.author.kind === 'persona' ? m.author.displayName : m.author.kind === 'user' ? m.author.username : '?'}`).join(', '));

  // Edit test (client-driven edit)
  await mythos.editMessage(send1.messageId, '🌉 portal smoke test — Mythos here (edited). Webhook persona edit works.');
  log('mythos edited its own message OK');

  mythos.close();
  lena.close();
  await relay.stop();
  log('done — check the channel in Discord. exiting.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
