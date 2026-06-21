// Live RFC-004 checks against antra's server. Verifies the real Discord-facing
// behaviour the unit tests can only fake:
//   1. Scoped invite → default-deny: an enrolled persona sees the in-scope
//      public channel WITH caps and a private channel with EMPTY caps
//      (+ fetch_history on it → FORBIDDEN). This is the security-hole regression.
//   2. mirrorRole access role: scope is computed from a real Discord role's
//      channel visibility (permissionsFor) — staff sees the private channel it's
//      granted, but NOT a private channel it isn't.
//   3. Push invalidation: removing the role's overwrite live emits a
//      channelUpdate → mirror cache busts → capabilities_update re-pushed.
//
// MUTATES the guild: creates 2 private channels + 1 role, deletes them in finally.
//
// Usage: node scripts/rfc4-live.mjs   (build first: npm run build)
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';
import { enroll } from '../../portal-client/dist/src/enroll.js';

// Env-overridable so this runs on the server (admin bot) as well as the test
// guild. RFC4_TOKEN_PATH points at the bot-token file; RFC4_GUILD / RFC4_PUB
// select the guild + a public channel; RFC4_WS_PORT avoids clashing with a live
// relay (default 8791, not the usual 8790).
const GUILD = process.env.RFC4_GUILD ?? '1289595876716707911';
const PUB = process.env.RFC4_PUB ?? '1314075947724705843'; // #test1 (public, @everyone can view)
const PORT = parseInt(process.env.RFC4_WS_PORT ?? '8791', 10);
const VIEW_CHANNEL = '1024'; // 1 << 10
// Token resolution: RFC4_TOKEN / DISCORD_TOKEN env (so the server can just
// `source relay.env` — secret never written to a new file) → RFC4_TOKEN_PATH
// file → the local test-bot token file.
const TOKEN_PATH = process.env.RFC4_TOKEN_PATH
  ? new URL(process.env.RFC4_TOKEN_PATH, `file://${process.cwd()}/`)
  : new URL('../../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url);
const token = (process.env.RFC4_TOKEN ?? process.env.DISCORD_TOKEN ?? readFileSync(TOKEN_PATH, 'utf8')).trim();
const API = 'https://discord.com/api/v10';
const auth = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const URL_WS = `ws://127.0.0.1:${PORT}`;
const log = (...a) => console.log('[rfc4]', ...a);
const ts = process.argv[2] ?? String(process.hrtime.bigint()).slice(-6);

const IDENT = '/tmp/rfc4-identity.json';
const PERMS = '/tmp/rfc4-permissions.json';
const INV = '/tmp/rfc4-invites.json';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; log(`✅ ${name}`, detail); }
  else { fail++; log(`❌ ${name}`, detail); }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capsOf = (channels, id) => channels.find((c) => c.id === id)?.capabilities ?? null;

async function main() {
  // This test bot has MANAGE_CHANNELS but NOT MANAGE_ROLES, so it can create/
  // delete channels but cannot create roles or edit permission overwrites after
  // the fact. We work within that:
  //   - the private channel is created with its overwrites in one POST (bot keeps
  //     access via its own allow; @everyone is denied view);
  //   - the mirrorRole scope mirrors @everyone (id === guildId), which needs no
  //     role creation and exercises the same channelsVisibleToRole path;
  //   - check 3 triggers invalidation with a channelCreate (allowed) rather than
  //     an overwrite edit (would need MANAGE_ROLES).
  // bot overwrite bits: VIEW(1024)|SEND(2048)|READ_HISTORY(65536) = 68608
  const me = await api('GET', '/users/@me');
  const BOT_ALLOW = '68608';

  // ── Setup: a private channel hidden from @everyone but visible to the bot ──
  const priv = await api('POST', `/guilds/${GUILD}/channels`, {
    name: `rfc4-priv-${ts}`, type: 0,
    permission_overwrites: [
      { id: GUILD, type: 0, deny: VIEW_CHANNEL }, // hide from @everyone
      { id: me.id, type: 1, allow: BOT_ALLOW }, // keep the (non-admin) bot's access
    ],
  });
  log(`setup: priv=${priv.id} (mirroring @everyone=${GUILD})`);

  // ── Config files (written before relay construction; watchConfig off) ──
  writeFileSync(IDENT, JSON.stringify({ personas: [] }));
  writeFileSync(PERMS, JSON.stringify({
    roles: {
      // Mirror @everyone: scope = exactly the channels @everyone can view.
      rfc4staff: { caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'], scope: { mirrorRole: GUILD }, guildId: GUILD },
    },
    personas: {},
  }));
  writeFileSync(INV, JSON.stringify({
    invites: [
      { code: `scoped-pub-${ts}`, label: 'scoped', grant: { caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'], scope: { channels: [PUB] } }, guildId: GUILD, maxUses: 50 },
      { code: `mirror-staff-${ts}`, label: 'mirror', roles: ['rfc4staff'], maxUses: 50 },
    ],
  }));

  const relay = new Relay({
    discordToken: token, wsPort: PORT, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: IDENT, permissionsPath: PERMS, invitesPath: INV,
    attributionPath: '/tmp/rfc4-attr.json',
    rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
    // Members intent is privileged + unneeded here; default off so we don't get
    // a disallowed-intent disconnect on bots that haven't enabled it.
    heartbeatIntervalMs: 30000, guildMembersIntent: process.env.RFC4_MEMBERS_INTENT === 'true', watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024, allowPathFiles: false, replyLink: true,
  });

  let guest, staff;
  try {
    await relay.start();
    await sleep(4000); // let the gateway warm its channel/role cache

    // ── Check 1: scoped invite → default-deny ──
    const gc = await enroll({ url: URL_WS, invite: `scoped-pub-${ts}`, desiredName: 'rfc4-guest' });
    guest = new PortalClient({ url: URL_WS, token: gc.token, personaId: gc.personaId });
    await guest.connect();
    const g1 = await guest.call('list_channels', { guildId: GUILD });
    check('guest sees PUBLIC channel with caps', (capsOf(g1.channels, PUB) ?? []).includes('SEND_MESSAGES'),
      `caps=[${capsOf(g1.channels, PUB)}]`);
    check('guest sees PRIVATE channel with EMPTY caps (hole closed)', (capsOf(g1.channels, priv.id) ?? ['x']).length === 0,
      `caps=[${capsOf(g1.channels, priv.id)}]`);
    let forbidden = false;
    try { await guest.fetchHistory({ channelId: priv.id, limit: 1 }); }
    catch (e) { forbidden = e.code === 'FORBIDDEN' || /FORBIDDEN|capability/i.test(String(e.message)); }
    check('guest fetch_history on PRIVATE → FORBIDDEN', forbidden);

    // ── Check 2: mirrorRole scope computed from real Discord visibility ──
    // Mirroring @everyone ⇒ scope = exactly the channels @everyone can see:
    // public PUB is in, private priv (denied to @everyone) is out.
    const sc = await enroll({ url: URL_WS, invite: `mirror-staff-${ts}`, desiredName: 'rfc4-staff' });
    staff = new PortalClient({ url: URL_WS, token: sc.token, personaId: sc.personaId });
    await staff.connect();
    const s1 = await staff.call('list_channels', { guildId: GUILD });
    check('staff (mirror @everyone) SEES public channel', (capsOf(s1.channels, PUB) ?? []).includes('READ_HISTORY'),
      `caps=[${capsOf(s1.channels, PUB)}]`);
    check('staff (mirror @everyone) does NOT see @everyone-private channel', (capsOf(s1.channels, priv.id) ?? ['x']).length === 0,
      `caps=[${capsOf(s1.channels, priv.id)}]`);

    // ── Check 3: push invalidation via a live channelCreate ──
    // A new public channel ⇒ channelCreate ⇒ mirror cache busts ⇒ caps recomputed
    // and capabilities_update re-pushed. Staff (mirror @everyone) should gain it.
    // Attach the collector BEFORE creating the channel — the push can arrive the
    // instant the gateway delivers channelCreate, before a post-hoc listener.
    const seen = [];
    const off = staff.on('event', (e) => { if (e.type === 'capabilities_update') seen.push(e); });
    const fresh = await api('POST', `/guilds/${GUILD}/channels`, { name: `rfc4-new-${ts}`, type: 0 });
    await sleep(2500);
    off();
    const ev = seen.find((e) => e.channelId === fresh.id);
    check('capabilities_update pushed for new channel (invalidation path)', !!ev,
      ev ? `caps=[${ev.capabilities}]` : `TIMEOUT (${seen.length} caps events seen)`);
    const s2 = await staff.call('list_channels', { guildId: GUILD });
    check('staff sees newly-created public channel after invalidation', (capsOf(s2.channels, fresh.id) ?? []).includes('VIEW_CHANNEL'),
      `caps=[${capsOf(s2.channels, fresh.id)}]`);
    await api('DELETE', `/channels/${fresh.id}`).catch(() => {});
  } finally {
    guest?.close(); staff?.close();
    await relay.stop().catch(() => {});
    await api('DELETE', `/channels/${priv.id}`).catch(() => {});
    for (const f of [IDENT, PERMS, INV, '/tmp/rfc4-attr.json']) rmSync(f, { force: true });
  }

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((err) => { console.error('[rfc4] FAILED:', err); process.exit(1); });
