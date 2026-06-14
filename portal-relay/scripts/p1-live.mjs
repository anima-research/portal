// Live P1 checks against antra's server: member reads, mention resolution,
// inbound human edit (message_update), and pins (list_pins + pins_update).
// Native reaction ingest is wired but needs a human reactor, so it's noted only.
//
// Usage: node scripts/p1-live.mjs <channelId>
import { readFileSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';

const GUILD = '1289595876716707911';
const CH = process.argv[2] || '1314075947724705843'; // #test1
const token = readFileSync(new URL('../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url), 'utf8').trim();
const API = 'https://discord.com/api/v10';
const auth = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const log = (...a) => console.log('[p1]', ...a);

const config = {
  discordToken: token, wsPort: 8790, avatarBaseUrl: '', guildIds: [GUILD],
  identityPath: new URL('../identity.test.json', import.meta.url).pathname,
  permissionsPath: new URL('../permissions.test.json', import.meta.url).pathname,
  attributionPath: '/tmp/portal-attr-p1.json',
  rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
  heartbeatIntervalMs: 30000, guildMembersIntent: true, watchConfig: false,
};

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
function waitFor(client, pred, ms = 8000) {
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
  await lena.subscribe(CH);
  log('lena connected + subscribed');

  // A1: list_members
  const members = await lena.call('list_members', { guildId: GUILD, limit: 5 });
  log('A1 list_members:', `${members.members.length} returned, membersAvailable=${members.membersAvailable}`,
    members.members.length > 0 && members.membersAvailable ? '✅' : '⚠️');

  // A2: resolve_mentions (resolve the first member's username → should map to its id)
  const sample = members.members[0];
  if (sample) {
    const r = await lena.call('resolve_mentions', { guildId: GUILD, handles: [sample.username] });
    log('A2 resolve_mentions:', `${sample.username} → ${r.resolved[sample.username]}`,
      r.resolved[sample.username] === sample.userId ? '✅' : '⚠️ (ambiguous/none)');
  }

  // RFC-002: list_roles — catalog with @everyone + pooled portal-* flagged.
  const { roles } = await lena.call('list_roles', { guildId: GUILD });
  const hasEveryone = roles.some((r) => r.name === '@everyone');
  const pooledOk = roles.every((r) => r.pooled === r.name.startsWith('portal-')) && roles.some((r) => r.pooled);
  const memberRolesResolve = sample ? sample.roles.every((id) => roles.some((r) => r.id === id)) : true;
  log('RFC-002 list_roles:', `${roles.length} roles; @everyone:${hasEveryone ? '✅' : '❌'} pooled-flag:${pooledOk ? '✅' : '❌'} member-roleIds-resolve:${memberRolesResolve ? '✅' : '❌'}`);

  // External webhook post (so the relay sees a non-owned message it can edit-track).
  const wh = await api('POST', `/channels/${CH}/webhooks`, { name: 'P1Outsider' });
  try {
    const tag = `P1-${Date.now()}`;
    const posted = await api('POST', `/webhooks/${wh.id}/${wh.token}?wait=true`, { content: `${tag} original` });

    // A3: inbound human edit → message_update
    const wEdit = waitFor(lena, (e) => e.type === 'message_update' && (e.message.content || '').includes(tag));
    await api('PATCH', `/webhooks/${wh.id}/${wh.token}/messages/${posted.id}`, { content: `${tag} EDITED` });
    const e3 = await wEdit;
    log('A3 inbound edit → message_update:', e3 ? `✅ ("${e3.message.content}")` : '❌ TIMEOUT');
    log('A3 native reaction ingest: wired (needs a human reactor to verify live)');

    // A4: pin via bot → pins_update + list_pins. Pinning needs Manage Messages;
    // if the bot lacks it here, still verify the load-bearing read path.
    let pinOk = false;
    try {
      const wPins = waitFor(lena, (e) => e.type === 'pins_update' && e.channelId === CH);
      await api('PUT', `/channels/${CH}/pins/${posted.id}`);
      pinOk = true;
      const e4 = await wPins;
      log('A4 pins_update event:', e4 ? '✅' : '❌ TIMEOUT');
    } catch (e) {
      log('A4 pin trigger skipped (bot lacks Manage Messages here):', String(e.message).slice(0, 50));
    }
    const pins = await lena.call('list_pins', { channelId: CH });
    log('A4 list_pins read path:', Array.isArray(pins.messages) ? `✅ (${pins.messages.length} pins)` : '❌');
    if (pinOk) {
      log('A4 list_pins contains the pinned msg:', pins.messages.some((m) => m.nativeId === posted.id) ? '✅' : '❌');
      await api('DELETE', `/channels/${CH}/pins/${posted.id}`).catch(() => {});
    }
  } finally {
    await api('DELETE', `/webhooks/${wh.id}`).catch(() => {});
  }

  lena.close();
  await relay.stop();
  log('done');
  process.exit(0);
}
main().catch((err) => { console.error('[p1] FAILED:', err); process.exit(1); });
