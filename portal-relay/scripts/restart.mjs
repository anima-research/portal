// Live restart-simulation (RFC P0 acceptance gate). Against antra's server.
//   1. relay #1: mythos posts a message; deep fetch_history; assert nativeId +
//      snowflake-derived ids.
//   2. stop relay #1 (flush attribution) → start relay #2 on the SAME attribution
//      file = a process restart with empty in-memory state.
//   3. mythos edits its own PRE-restart message → succeeds (via persisted
//      attribution + webhook re-adoption).
//   4. lena editing mythos's message → FORBIDDEN (ownership preserved).
//   5. cursor: fetch_history before=<relayId> and before=<raw snowflake> → both
//      return an older page (not the latest).
//
// Usage: node scripts/restart.mjs <channelId>
import { readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Relay } from '../dist/src/relay.js';
import { parseRelayId } from '../dist/src/message-store.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';

/** Resolve once nothing is listening on the port (clean restart guard). */
function waitPortFree(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const sock = createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('port never freed'));
        setTimeout(probe, 200);
      });
      sock.once('error', () => { sock.destroy(); resolve(); }); // refused = free
    };
    probe();
  });
}

const GUILD = '1289595876716707911';
const CH = process.argv[2] || '1289659411270209609'; // #test
const token = readFileSync(new URL('../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url), 'utf8').trim();
const ATTR = '/tmp/portal-attr.json';
rmSync(ATTR, { force: true });
const log = (...a) => console.log('[restart]', ...a);

const baseConfig = {
  discordToken: token, wsPort: 8790, avatarBaseUrl: '', guildIds: [GUILD],
  identityPath: new URL('../identity.test.json', import.meta.url).pathname,
  permissionsPath: new URL('../permissions.test.json', import.meta.url).pathname,
  attributionPath: ATTR,
  rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
  heartbeatIntervalMs: 30000, guildMembersIntent: true, watchConfig: false,
};

async function boot() {
  const relay = new Relay({ ...baseConfig });
  await relay.start();
  await new Promise((r) => setTimeout(r, 4000));
  return relay;
}

async function main() {
  // ── Phase 1: pre-restart ──
  let relay = await boot();
  let mythos = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-mythos', personaId: 'mythos' });
  await mythos.connect();
  const sent = await mythos.sendMessage({ channelId: CH, content: 'restart-test: original message' });
  const relayId = sent.messageId;
  const native = parseRelayId(relayId)?.discordMsgId;
  log('posted; relayId =', relayId, '| parsed native =', native);

  const hist = await mythos.fetchHistory({ channelId: CH, limit: 5 });
  const mine = hist.messages.find((m) => m.id === relayId);
  log('1) nativeId present & id is snowflake-derived:',
    mine && mine.nativeId === native && mine.id === `rm_${CH}_${native}` ? '✅' : `❌ (${JSON.stringify(mine && { id: mine.id, nativeId: mine.nativeId })})`);

  mythos.close();
  await relay.stop();
  await waitPortFree(8790);
  log('— relay restarted (port freed) —');

  // ── Phase 2: post-restart (fresh in-memory store, same attribution file) ──
  relay = await boot();
  mythos = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-mythos', personaId: 'mythos' });
  await mythos.connect();

  // 3) edit own pre-restart message
  let edited = false;
  try {
    await mythos.editMessage(relayId, 'restart-test: EDITED after restart ✅');
    edited = true;
  } catch (e) {
    log('   edit error:', e.message, e.code ?? '');
  }
  log('3) edit own pre-restart message:', edited ? '✅' : '❌');

  // 4) lena editing mythos's message → FORBIDDEN
  const lena = new PortalClient({ url: 'ws://127.0.0.1:8790', token: 'tok-lena', personaId: 'lena' });
  await lena.connect();
  let rejected = false;
  try {
    await lena.editMessage(relayId, 'lena should not be able to do this');
  } catch (e) {
    rejected = e.code === 'FORBIDDEN';
    log('   lena edit rejected with:', e.code, '-', e.message);
  }
  log('4) cross-persona edit rejected:', rejected ? '✅' : '❌');

  // 5) cursor pagination by relay id and by raw snowflake
  const byRelay = await mythos.fetchHistory({ channelId: CH, limit: 3, before: relayId });
  const bySnow = await mythos.fetchHistory({ channelId: CH, limit: 3, before: native });
  const olderThanCursor = (msgs) => msgs.every((m) => m.nativeId.localeCompare(native, 'en-US-u-kn-true') < 0);
  log('5) cursor before=relayId →', byRelay.messages.length, 'msgs, all older:', olderThanCursor(byRelay.messages) ? '✅' : '❌');
  log('   cursor before=snowflake →', bySnow.messages.length, 'msgs, all older:', olderThanCursor(bySnow.messages) ? '✅' : '❌');

  mythos.close();
  lena.close();
  await relay.stop();
  log('done');
  process.exit(0);
}

main().catch((err) => { console.error('[restart] FAILED:', err); process.exit(1); });
