// Inbound test with a genuinely EXTERNAL sender: create a webhook the relay
// does NOT own (different name → not adopted), POST to it directly via Discord
// REST (bypassing the relay's send path entirely), and verify the event reaches
// a subscribed persona — once without a mention (ambient) and once with the
// persona's role mention (addressed). Exercises the ownsWebhook=false / external
// author / routing path that our own webhook echoes never hit.
//
// Usage: node scripts/external-inbound.mjs <channelId>
import { readFileSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';

const GUILD = '1289595876716707911';
const channelId = process.argv[2] || '1314075962484457533'; // #test2
const token = readFileSync(
  new URL('../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url),
  'utf8',
).trim();
const API = 'https://discord.com/api/v10';
const auth = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const log = (...a) => console.log('[ext]', ...a);

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

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function waitForMessage(lena, substr, ms = 8000) {
  return new Promise((resolve) => {
    const off = lena.on('message', (e) => {
      if ((e.message.content || '').includes(substr)) {
        off();
        resolve(e);
      }
    });
    setTimeout(() => {
      off();
      resolve(null);
    }, ms);
  });
}

async function main() {
  const relay = new Relay(config);
  await relay.start();
  await new Promise((r) => setTimeout(r, 4000));

  const lena = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-lena', personaId: 'lena' });
  await lena.connect();
  await lena.subscribe(channelId);
  log('lena connected + subscribed to', channelId);

  // Find lena's pooled role (created on connect) for the mention case.
  const roles = await api('GET', `/guilds/${GUILD}/roles`);
  const lenaRole = roles.find((r) => r.name === 'portal-Lena');
  log('lena role:', lenaRole?.id ?? '(not found)');

  // Create an EXTERNAL webhook (name has no portal marker → relay won't adopt it).
  const wh = await api('POST', `/channels/${channelId}/webhooks`, { name: 'Outsider' });
  log('external webhook created:', wh.id);

  try {
    // 1) WITHOUT mention → should arrive ambient (subscription), not addressed.
    const tag1 = `EXT-NOMENTION-${Date.now()}`;
    const w1 = waitForMessage(lena, tag1); // attach listener BEFORE posting (avoid race)
    await api('POST', `/webhooks/${wh.id}/${wh.token}?wait=true`, { content: `${tag1} hi everyone` });
    const e1 = await w1;
    log('without mention:', e1
      ? `✅ received — addressedToMe=${e1.addressedToMe}, reasons=[${e1.reasons.join(',')}], author=${e1.message.author.kind}`
      : '❌ TIMEOUT');

    // 2) WITH lena's role mention → should arrive addressed (role_mention).
    const tag2 = `EXT-MENTION-${Date.now()}`;
    const content = lenaRole ? `<@&${lenaRole.id}> ${tag2} ping` : `${tag2} ping`;
    const w2 = waitForMessage(lena, tag2); // attach listener BEFORE posting
    await api('POST', `/webhooks/${wh.id}/${wh.token}?wait=true`, { content, allowed_mentions: { parse: ['roles'] } });
    const e2 = await w2;
    log('with mention:', e2
      ? `✅ received — addressedToMe=${e2.addressedToMe}, reasons=[${e2.reasons.join(',')}], author=${e2.message.author.kind}, mentions.personas=[${e2.message.mentions.personas.join(',')}]`
      : '❌ TIMEOUT');
  } finally {
    await api('DELETE', `/webhooks/${wh.id}`).catch(() => {});
    log('external webhook deleted');
  }

  lena.close();
  await relay.stop();
  log('done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[ext] FAILED:', err);
  process.exit(1);
});
