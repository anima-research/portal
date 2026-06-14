// Live identity/permission changes: verify a connected persona receives
// capabilities_update / persona_update when (1) permissions are changed via the
// programmatic API, (2) identity is renamed via the API, and (3) the permissions
// file is edited externally (hot-reload). Uses /tmp copies so fixtures aren't mutated.
//
// Usage: node scripts/live-config.mjs <channelId>
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';

const GUILD = '1289595876716707911';
const CH = process.argv[2] || '1314075947724705843'; // #test1
const token = readFileSync(new URL('../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url), 'utf8').trim();
const idPath = '/tmp/portal-id.json';
const permPath = '/tmp/portal-perm.json';
copyFileSync(new URL('../identity.test.json', import.meta.url), idPath);
copyFileSync(new URL('../permissions.test.json', import.meta.url), permPath);
const log = (...a) => console.log('[live]', ...a);

const config = {
  discordToken: token, wsPort: 8790, avatarBaseUrl: '', guildIds: [GUILD],
  identityPath: idPath, permissionsPath: permPath,
  rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
  heartbeatIntervalMs: 30000, guildMembersIntent: true, watchConfig: true,
};

function waitForEvent(client, pred, ms = 6000) {
  return new Promise((resolve) => {
    const off = client.on('event', (e) => { if (pred(e)) { off(); resolve(e); } });
    setTimeout(() => { off(); resolve(null); }, ms);
  });
}

async function main() {
  const relay = new Relay(config);
  await relay.start();
  await new Promise((r) => setTimeout(r, 4000));

  const lena = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-lena', personaId: 'lena' });
  await lena.connect();
  log('lena connected');

  // 1) Programmatic permission change → capabilities_update for that channel.
  const w1 = waitForEvent(lena, (e) => e.type === 'capabilities_update' && e.channelId === CH);
  relay.permissions.setChannel('lena', GUILD, CH, ['VIEW_CHANNEL', 'READ_HISTORY']);
  const e1 = await w1;
  log('1) programmatic perm change:', e1 ? `✅ capabilities_update CH caps=[${e1.capabilities.join(',')}]` : '❌ TIMEOUT');

  // 2) Programmatic identity rename → persona_update (+ live role rename).
  const w2 = waitForEvent(lena, (e) => e.type === 'persona_update');
  relay.identity.upsert({ id: 'lena', displayName: 'Lena Prime', avatar: '', token: 'tok-lena' });
  const e2 = await w2;
  log('2) programmatic rename:', e2 ? `✅ persona_update displayName="${e2.persona.displayName}"` : '❌ TIMEOUT');

  // 3) External file edit → hot-reload → capabilities_update (reload path).
  await new Promise((r) => setTimeout(r, 2500)); // clear self-write suppression window
  const w3 = waitForEvent(lena, (e) => e.type === 'capabilities_update', 8000);
  const perm = JSON.parse(readFileSync(permPath, 'utf8'));
  perm.personas.lena.default = ['VIEW_CHANNEL', 'READ_HISTORY']; // narrow lena's default
  writeFileSync(permPath, JSON.stringify(perm, null, 2));
  const e3 = await w3;
  log('3) external file edit (hot-reload):', e3 ? `✅ capabilities_update arrived (CH=${e3.channelId}, caps=[${e3.capabilities.join(',')}])` : '❌ TIMEOUT');

  // rename back so the Discord role label is tidy
  relay.identity.upsert({ id: 'lena', displayName: 'Lena', avatar: '', token: 'tok-lena' });
  await new Promise((r) => setTimeout(r, 300));

  lena.close();
  await relay.stop();
  log('done');
  process.exit(0);
}

main().catch((err) => { console.error('[live] FAILED:', err); process.exit(1); });
