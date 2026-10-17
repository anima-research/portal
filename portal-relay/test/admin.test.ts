import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminConfig } from '../src/config.js';
import { IdentityStore, generateToken, hashToken } from '../src/identity.js';
import { PermissionsStore, ALL_CAPS } from '../src/permissions.js';
import { LEVEL_CAPS } from '../src/slash.js';
import { InviteStore } from '../src/invites.js';
import { GuildAllowStore } from '../src/guild-allowlist.js';
import { AdminServer, stateCookieName, type AdminDeps, type AdminLimits } from '../src/admin/server.js';
import { deriveAdminGuilds } from '../src/admin/oauth.js';
import { SessionStore } from '../src/admin/sessions.js';
import { AuditLog } from '../src/admin/audit.js';
import { canManageGuild, canAuthorRoles } from '../src/admin/authz.js';
import type { ChannelLabel } from '../src/admin/names.js';
import type { Capability } from '@animalabs/portal-protocol';

const ADMINISTRATOR = '8';
const MANAGE_GUILD = '32';

// ── Pure admin-guild derivation (RFC-005 §5.3) ──

test('deriveAdminGuilds: owner / ADMINISTRATOR / MANAGE_GUILD qualify; others do not', () => {
  const { ids, names } = deriveAdminGuilds([
    { id: 'owner', name: 'Owned', owner: true, permissions: '0' },
    { id: 'admin', name: 'Admin', permissions: ADMINISTRATOR },
    { id: 'manage', name: 'Manage', permissions: MANAGE_GUILD },
    { id: 'member', name: 'Member', permissions: '0' },
    { id: 'combo', name: 'Combo', permissions: String(BigInt(ADMINISTRATOR) | 0x400n) },
  ]);
  assert.deepEqual(ids.sort(), ['admin', 'combo', 'manage', 'owner']);
  assert.equal(names['admin'], 'Admin');
  assert.ok(!ids.includes('member'));
});

test('deriveAdminGuilds: malformed permissions fail closed', () => {
  const { ids } = deriveAdminGuilds([
    { id: 'bad', name: 'Bad', permissions: 'not-a-number' },
    { id: 'missing', name: 'Missing' },
    // @ts-expect-error intentionally malformed entry
    null,
  ]);
  assert.deepEqual(ids, []);
});

// ── Authz helpers ──

test('canManageGuild / canAuthorRoles', () => {
  const base = {
    id: 's', userId: 'u', userName: 'U', guildNames: {},
    csrf: 'c', createdAt: 0, expiresAt: Infinity,
  };
  const guildAdmin = { ...base, adminGuilds: new Set(['G1', 'G9']), isSuper: false };
  const superAdmin = { ...base, adminGuilds: new Set<string>(), isSuper: true };
  const served = (g: string) => g === 'G1' || g === 'G2';
  assert.equal(canManageGuild(guildAdmin, 'G1', served), true);
  assert.equal(canManageGuild(guildAdmin, 'G2', served), false, 'served, but not an admin there');
  assert.equal(canManageGuild(guildAdmin, 'G9', served), false, 'an admin there, but the relay does not serve it');
  assert.equal(canManageGuild(superAdmin, 'anything', served), true);
  assert.equal(canAuthorRoles(guildAdmin), false);
  assert.equal(canAuthorRoles(superAdmin), true);
});

// ── Session store ──

test('SessionStore: TTL expiry and single-use state', () => {
  let now = 1000;
  const store = new SessionStore(5000, () => now);
  const s = store.create({
    userId: 'u', userName: 'U', adminGuilds: new Set(['G1']),
    guildNames: {}, isSuper: false,
  });
  assert.ok(store.get(s.id));
  now = 6001; // past TTL
  assert.equal(store.get(s.id), undefined);

  const state = store.issueState();
  assert.equal(store.stateStatus(state), 'live');
  assert.deepEqual(store.consumeState(state), { ok: true, reauth: false });
  assert.deepEqual(store.consumeState(state), { ok: false, why: 'unknown' }, 'state is single-use');
  assert.equal(store.stateStatus(state), 'unknown');
  assert.deepEqual(store.consumeState('never-issued'), { ok: false, why: 'unknown' });

  const slow = store.issueState({ reauth: true });
  now += 10 * 60_000; // the ten minutes a sign-in may take
  assert.equal(store.stateStatus(slow), 'expired');
  assert.deepEqual(store.consumeState(slow), { ok: false, why: 'expired' });
  const re = store.issueState({ reauth: true });
  assert.deepEqual(store.consumeState(re), { ok: true, reauth: true });
});

test('SessionStore: one address holds only its share of sign-ins in flight; a full store makes room from the busiest', () => {
  let now = 1000;
  const store = new SessionStore(5000, () => now, { maxPending: 6, maxPendingPerClient: 3 });
  const admin = store.issueState({ client: '198.51.100.7' });
  // A flood from one address pushes out only its own oldest.
  const flood = Array.from({ length: 50 }, () => store.issueState({ client: '203.0.113.5' }));
  assert.equal(store.stateStatus(admin), 'live', 'the admin’s sign-in is untouched');
  assert.deepEqual(flood.map((s) => store.stateStatus(s)).filter((x) => x === 'live').length, 3);
  assert.equal(store.stateStatus(flood.at(-1)), 'live', 'the newest of the flood are the ones kept');
  assert.equal(store.stateStatus(flood[0]), 'unknown');
  // Every address together at the cap: the address holding the most gives way.
  const b = store.issueState({ client: '198.51.100.8' });
  const c = store.issueState({ client: '198.51.100.9' });
  assert.equal(store.stateStatus(admin), 'live');
  assert.equal(store.stateStatus(b), 'live');
  const d = store.issueState({ client: '198.51.100.10' });
  for (const s of [admin, b, c, d]) assert.equal(store.stateStatus(s), 'live');
  assert.equal(flood.filter((s) => store.stateStatus(s) === 'live').length, 2, 'one of the flood’s made room');
  // A used state no longer counts against its address.
  assert.deepEqual(store.consumeState(admin), { ok: true, reauth: false });
  const again = Array.from({ length: 2 }, () => store.issueState({ client: '198.51.100.7' }));
  for (const s of again) assert.equal(store.stateStatus(s), 'live');
  assert.equal(flood.filter((s) => store.stateStatus(s) === 'live').length, 1, 'the flood gave way again');
  // Expired ones go before anything live.
  now += 10 * 60_000;
  const fresh = store.issueState({ client: '203.0.113.5' });
  assert.equal(store.stateStatus(fresh), 'live');
});

// ── Audit log ──

test('AuditLog: append, newest-first read, guild filter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-audit-'));
  const path = join(dir, 'audit.jsonl');
  let now = 1000;
  const log = new AuditLog(path, () => (now += 1000));
  log.append({ actor: { id: 'a', name: 'A', kind: 'admin' }, action: 'one', guildId: 'G1', ok: true });
  log.append({ actor: { id: 'a', name: 'A', kind: 'admin' }, action: 'two', guildId: 'G2', ok: true });
  log.append({ actor: { id: 'a', name: 'A', kind: 'admin' }, action: 'three', guildId: 'G1', ok: false });

  const all = log.read();
  assert.equal(all[0].action, 'three', 'newest first');
  const g1 = log.read({ guildId: 'G1' });
  assert.deepEqual(g1.map((r) => r.action), ['three', 'one']);
  rmSync(dir, { recursive: true, force: true });
});

// ── Integration: OAuth round-trip → session → scoped reads ──

function fakeDiscordFetch(guilds: unknown[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const body = u.includes('/oauth2/token')
      ? { access_token: 'x', token_type: 'Bearer' }
      : u.endsWith('/users/@me')
        ? { id: 'admin1', username: 'admin', global_name: 'Admin' }
        : u.endsWith('/users/@me/guilds')
          ? guilds
          : null;
    if (body === null) throw new Error(`unexpected fetch ${u}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function setupDeps(
  superadmins: string[],
  guildAdmins: Record<string, string[]> = {},
  opts: { allowlistEditable?: boolean; fileDefault?: string[]; botCaps?: Record<string, string[]> } = {},
): {
  deps: AdminDeps;
  dir: string;
  identity: IdentityStore;
  permissions: PermissionsStore;
  invites: InviteStore;
  allowStore: GuildAllowStore;
  allowPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'portal-admin-'));
  const idPath = join(dir, 'identity.json');
  const permPath = join(dir, 'permissions.json');
  const invPath = join(dir, 'invites.json');
  writeFileSync(idPath, JSON.stringify({
    personas: [{ id: 'p1', displayName: 'Persona One', avatar: '', token: hashToken('t1') }],
  }));
  writeFileSync(permPath, JSON.stringify({
    ...(opts.fileDefault ? { default: opts.fileDefault } : {}),
    roles: { 'r-g1': { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G1' } },
    personas: { p1: { policy: { default: [], guilds: { G1: { default: ['VIEW_CHANNEL'] } } } } },
  }));
  writeFileSync(invPath, JSON.stringify({
    invites: [
      { code: 'in-g1', guildId: 'G1', roles: ['r-g1'], uses: 0 },
      { code: 'in-g2', guildId: 'G2', roles: ['r'], uses: 0 },
      { code: 'aug-g1', guildId: 'G1', roles: ['r-g1'], mode: 'augment', uses: 0 },
    ],
  }));
  const config: AdminConfig = {
    port: 0,
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    redirectUri: 'https://example.test/admin/callback',
    postLoginUrl: '/done',
    superadmins,
    guildAdmins,
    sessionTtlMs: 60_000,
    auditPath: join(dir, 'audit.jsonl'),
    cookieSecure: false,
    avatarDir: join(dir, 'avatars'),
  };
  const identity = new IdentityStore(idPath, '');
  const permissions = new PermissionsStore(permPath);
  const invites = new InviteStore(invPath);
  // Guild allow-list: numeric ids (the admin endpoints validate snowflakes).
  const allowPath = join(dir, 'guilds.json');
  const allowStore = new GuildAllowStore(allowPath, ['1111100000']);
  // G1: two text channels, a thread in c1, a category, and a channel of a
  // kind the relay doesn't know. G2: one text channel.
  const channelTable: Record<string, Array<{ id: string; name: string; type: string; parentId?: string }>> = {
    G1: [
      { id: 'c1', name: 'c1', type: 'text' },
      { id: 'c2', name: 'c2', type: 'text' },
      { id: 'th-c1', name: 'th-c1', type: 'thread', parentId: 'c1' },
      { id: 'cat1', name: 'cat1', type: 'category' },
      { id: 'odd1', name: 'odd1', type: 'unknown' },
    ],
    G2: [{ id: 'cZ', name: 'cZ', type: 'text' }],
  };
  const channels: Record<string, string[]> = Object.fromEntries(Object.entries(channelTable).map(([g, cs]) => [g, cs.map((c) => c.id)]));
  // Where the channels sit in Discord: c1 and c2 in cat1.
  const categoryOf: Record<string, string> = { c1: 'cat1', c2: 'cat1' };
  // What the relay's bot can do: everything in a channel it has, unless the
  // test says less; in one it doesn't have (not cached), what capsFor's
  // computeCapabilities lets through without a channel.
  const botCaps = (gid: string, cid: string): Capability[] =>
    (channels[gid] ?? []).includes(cid) ? ((opts.botCaps?.[cid] ?? ALL_CAPS) as Capability[]) : ['EDIT_OWN', 'DELETE_OWN'];
  let codeN = 0;
  const deps: AdminDeps = {
    config,
    identity,
    permissions,
    invites,
    audit: new AuditLog(config.auditPath),
    listGuilds: () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }],
    listAllGuilds: () => [
      { id: '1111100000', name: 'Guild One', memberCount: 1, allowed: allowStore.has('1111100000') },
      { id: '2222200000', name: 'Guild Two', memberCount: 2, allowed: allowStore.has('2222200000') },
    ],
    allowlist: {
      editable: opts.allowlistEditable ?? true,
      list: () => allowStore.list(),
      allow: (g) => allowStore.allow(g),
      disallow: (g) => allowStore.disallow(g),
    },
    listRoles: () => [{ id: 'role1', guildId: 'G1', name: 'Mods', pooled: false }],
    listChannels: (gid) => (channelTable[gid] ?? []).map((c) => ({ ...c })),
    channelInGuild: (gid, cid) => (channels[gid] ?? []).includes(cid),
    closePersona: () => {},
    applyClaim: (pid, code) => {
      const inv = invites.get(code)!;
      const roles = permissions.addPersonaRoles(pid, inv.roles ?? []);
      invites.consume(code);
      return { roles };
    },
    rotatePersonaToken: (pid) => {
      const cur = identity.get(pid)!;
      const t = generateToken();
      identity.upsert({ ...cur, token: hashToken(t) });
      return t;
    },
    revokePersonaToken: (pid) => {
      const cur = identity.get(pid)!;
      identity.upsert({ ...cur, token: hashToken(generateToken()) });
    },
    newInviteCode: () => `inv_test_${++codeN}`,
    // As Relay.capsFor: nothing for an unknown persona or an unserved guild,
    // else the policy within what the bot can do.
    capsFor: (pid, cid, gid) => {
      if (!identity.get(pid) || !deps.listGuilds().some((g) => g.id === gid)) return [];
      const policy = permissions.resolve(pid, gid, cid);
      const bot = new Set(botCaps(gid, cid));
      return ALL_CAPS.filter((c) => policy.has(c) && bot.has(c));
    },
    botCaps,
    // As Relay.permChannelId: a thread's access is its parent's.
    permChannelId: (cid) => {
      for (const cs of Object.values(channelTable)) {
        const c = cs.find((x) => x.id === cid);
        if (c) return c.type === 'thread' && c.parentId ? c.parentId : cid;
      }
      return cid;
    },
    listChannelLayout: (gid) =>
      (channelTable[gid] ?? []).filter((c) => c.type !== 'thread').map((c, i) => ({ id: c.id, categoryId: categoryOf[c.id] ?? null, position: i, announcement: false })),
    canAccessGuild: (pid, gid) => permissions.couldAccessGuild(pid, gid, (cid) => (channels[gid] ?? []).includes(cid)),
    resync: () => 0,
  };
  return { deps, dir, identity, permissions, invites, allowStore, allowPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function parseSetCookie(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [];
  for (const c of all) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (first.slice(0, eq) === name) return first.slice(eq + 1);
  }
  return undefined;
}

/** The OAuth state /admin/login put in its state cookie. */
function loginState(res: Response): string | undefined {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (first.startsWith('portal_admin_state_') && first.slice(0, eq) === stateCookieName(first.slice(eq + 1))) return first.slice(eq + 1);
  }
  return undefined;
}
/** The Cookie header of a browser that started the sign-in for `state`. */
const stateCookie = (state: string) => `${stateCookieName(state)}=${state}`;

async function login(base: string, guilds: unknown[]): Promise<string> {
  // 1. /login → state cookie + redirect carrying the same state.
  const loginRes = await fetch(`${base}/admin/login`, { redirect: 'manual' });
  assert.equal(loginRes.status, 302);
  const state = loginState(loginRes);
  assert.ok(state, 'state cookie set');
  const loc = new URL(loginRes.headers.get('location')!);
  assert.equal(loc.searchParams.get('state'), state);

  // 2. /callback with matching state → session cookie.
  const cbRes = await fetch(
    `${base}/admin/callback?code=abc&state=${state}`,
    { redirect: 'manual', headers: { cookie: stateCookie(state!) } },
  );
  assert.equal(cbRes.status, 302, 'callback redirects on success');
  const session = parseSetCookie(cbRes, 'portal_admin_session');
  assert.ok(session, 'session cookie set');
  return session!;
}

test('integration: guild-admin can read own guild, blocked cross-guild', async () => {
  const { deps, cleanup } = setupDeps([]);
  const server = new AdminServer(deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD },
    { id: 'G2', name: 'Guild Two', permissions: '0' },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };

    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    assert.equal(me.isSuper, false);
    assert.deepEqual(me.guilds.map((g: { id: string }) => g.id), ['G1']);
    assert.ok(me.csrf);

    // Own guild: 200, scoped data.
    const invRes = await fetch(`${base}/admin/g/G1/invites`, auth);
    assert.equal(invRes.status, 200);
    const inv = await invRes.json();
    assert.deepEqual(inv.invites.map((i: { code: string }) => i.code), ['aug-g1', 'in-g1'], 'newest first');

    const personasRes = await fetch(`${base}/admin/g/G1/personas`, auth);
    const personas = await personasRes.json();
    assert.deepEqual(personas.personas.map((p: { id: string }) => p.id), ['p1']);

    const rolesRes = await fetch(`${base}/admin/g/G1/roles`, auth);
    const roles = await rolesRes.json();
    assert.equal(roles.canAuthor, false, 'guild-admin cannot author the catalog');

    // Cross-guild: 403.
    const cross = await fetch(`${base}/admin/g/G2/invites`, auth);
    assert.equal(cross.status, 403);

    // No session: 401.
    const anon = await fetch(`${base}/admin/me`);
    assert.equal(anon.status, 401);
  } finally {
    await server.close();
    cleanup();
  }
});

test('integration: per-guild allowlist grants guild-admin without Discord perms', async () => {
  // admin1 has NO qualifying Discord perms anywhere, but the operator allowlist
  // names them for G2 → guild-admin there, and nowhere else.
  const { deps, cleanup } = setupDeps([], { G2: ['admin1'] });
  deps.listGuilds = () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }, { id: 'G2', name: 'Guild Two', memberCount: 1 }];
  const server = new AdminServer(deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: '0' },
    { id: 'G2', name: 'Guild Two', permissions: '0' },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    assert.equal(me.isSuper, false, 'allowlist does not confer super-admin');

    // Allowlisted guild: reachable.
    const g2 = await fetch(`${base}/admin/g/G2/invites`, auth);
    assert.equal(g2.status, 200, 'allowlisted guild reachable');

    // Non-allowlisted, non-Discord-admin guild: still blocked.
    const g1 = await fetch(`${base}/admin/g/G1/invites`, auth);
    assert.equal(g1.status, 403, 'non-allowlisted guild still blocked');

    // Catalog authoring stays super-admin-only.
    const roles = await (await fetch(`${base}/admin/g/G2/roles`, auth)).json();
    assert.equal(roles.canAuthor, false, 'guild-admin via allowlist cannot author catalog');
  } finally {
    await server.close();
    cleanup();
  }
});

test('integration: super-admin reaches any guild', async () => {
  const { deps, cleanup } = setupDeps(['admin1']);
  const server = new AdminServer(deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: '0' },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    assert.equal(me.isSuper, true);
    // Not a Discord-admin of G2, but super-admin overrides scoping.
    const res = await fetch(`${base}/admin/g/G2/invites`, auth);
    assert.equal(res.status, 200);
    const rolesRes = await fetch(`${base}/admin/g/G2/roles`, auth);
    assert.equal((await rolesRes.json()).canAuthor, true);
  } finally {
    await server.close();
    cleanup();
  }
});

test('integration: guild-admin mutations (invite/role/grant/token/claim) + CSRF', async () => {
  const ctx = setupDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, {
      headers: { cookie: `portal_admin_session=${session}` },
    })).json();
    const csrf = me.csrf as string;
    const hdr = (extra: Record<string, string> = {}) => ({
      cookie: `portal_admin_session=${session}`,
      'content-type': 'application/json',
      ...extra,
    });

    // Mutation without CSRF → 403.
    const noCsrf = await fetch(`${base}/admin/g/G1/invites`, {
      method: 'POST', headers: hdr(), body: JSON.stringify({ roles: ['r-g1'] }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, 'CSRF');

    // Mint a valid invite (role bound to G1).
    const mint = await fetch(`${base}/admin/g/G1/invites`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ label: 'guests', roles: ['r-g1'], mode: 'both', maxUses: 5 }),
    });
    assert.equal(mint.status, 200);
    const minted = await mint.json();
    assert.equal(minted.invite.guildId, 'G1', 'guildId comes from the path');
    assert.equal(minted.invite.mode, 'both');
    assert.ok(ctx.invites.get(minted.code), 'invite persisted');

    // Mint with an unknown role → 403.
    const badRole = await fetch(`${base}/admin/g/G1/invites`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ roles: ['nope'] }),
    });
    assert.equal(badRole.status, 403);

    // Assign role to persona.
    const assign = await fetch(`${base}/admin/g/G1/personas/p1/roles`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ role: 'r-g1' }),
    });
    assert.equal(assign.status, 200);
    assert.ok((await assign.json()).roles.includes('r-g1'));
    assert.ok(ctx.permissions.getRoleNames('p1').includes('r-g1'));

    // Revoke the role.
    const revoke = await fetch(`${base}/admin/g/G1/personas/p1/roles/r-g1`, {
      method: 'DELETE', headers: hdr({ 'x-csrf-token': csrf }),
    });
    assert.equal(revoke.status, 200);
    assert.ok(!ctx.permissions.getRoleNames('p1').includes('r-g1'));

    // Ad-hoc per-channel grant, clipped to G — channel in G1 OK.
    const grant = await fetch(`${base}/admin/g/G1/personas/p1/grants`, {
      method: 'PUT', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ channelId: 'c1', caps: ['SEND_MESSAGES'] }),
    });
    assert.equal(grant.status, 200);
    assert.deepEqual(ctx.permissions.getEntry('p1')?.policy?.guilds?.G1?.channels?.c1, ['SEND_MESSAGES']);

    // Grant to a channel NOT in G1 → 403 (clip enforcement).
    const badChan = await fetch(`${base}/admin/g/G1/personas/p1/grants`, {
      method: 'PUT', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ channelId: 'cX', caps: ['SEND_MESSAGES'] }),
    });
    assert.equal(badChan.status, 403);

    // Admin-initiated claim of an augment invite.
    const claim = await fetch(`${base}/admin/g/G1/personas/p1/claim`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ code: 'aug-g1' }),
    });
    assert.equal(claim.status, 200);
    assert.ok((await claim.json()).roles.includes('r-g1'));

    // Token lifecycle is super-admin-only and NOT on the guild path: a guild-admin
    // hitting the global endpoint is forbidden, and the old guild path 404s.
    const tokGlobal = await fetch(`${base}/admin/personas/p1/token`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ action: 'rotate' }),
    });
    assert.equal(tokGlobal.status, 403, 'guild-admin cannot rotate tokens');
    const tokGuildPath = await fetch(`${base}/admin/g/G1/personas/p1/token`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ action: 'rotate' }),
    });
    assert.equal(tokGuildPath.status, 404, 'token route no longer exists under a guild');

    // Cross-guild mutation → 403.
    const cross = await fetch(`${base}/admin/g/G2/invites`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ roles: ['r-g1'] }),
    });
    assert.equal(cross.status, 403);

    // Catalog authoring is super-admin-only → 403 for a guild-admin.
    const author = await fetch(`${base}/admin/roles`, {
      method: 'POST', headers: hdr({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ name: 'x', role: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }),
    });
    assert.equal(author.status, 403);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: search + pagination + detail + global registry', async () => {
  const ctx = setupDeps(['admin1']); // super-admin so we can hit the global registry
  // listGuilds drives guildCount in the registry.
  ctx.deps.listGuilds = () => [{ id: 'G1', name: 'G1', memberCount: 1 }, { id: 'G2', name: 'G2', memberCount: 1 }];
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };

    // Guild personas list is paged + total; p1 has access in G1 (guild default).
    const list = await (await fetch(`${base}/admin/g/G1/personas?limit=1&offset=0`, auth)).json();
    assert.equal(typeof list.total, 'number');
    assert.ok(list.personas.length <= 1);
    assert.equal(list.personas[0].id, 'p1');
    assert.equal(typeof list.personas[0].hasOverride, 'boolean');

    // Search miss → empty.
    const miss = await (await fetch(`${base}/admin/g/G1/personas?q=zzzznope`, auth)).json();
    assert.equal(miss.personas.length, 0);

    // Per-persona drawer detail.
    const detail = await (await fetch(`${base}/admin/g/G1/personas/p1`, auth)).json();
    assert.equal(detail.id, 'p1');
    assert.ok('guildPolicy' in detail);

    // Global registry (super-admin) lists all personas with a guild count.
    const reg = await fetch(`${base}/admin/personas`, auth);
    assert.equal(reg.status, 200);
    const regBody = await reg.json();
    assert.ok(regBody.personas.some((p: { id: string }) => p.id === 'p1'));
    const p1 = regBody.personas.find((p: { id: string }) => p.id === 'p1');
    assert.equal(typeof p1.guildCount, 'number');

    // Global persona detail lists accessible guilds.
    const gdetail = await (await fetch(`${base}/admin/personas/p1`, auth)).json();
    assert.ok(Array.isArray(gdetail.guilds));
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: /admin/guilds is bot-guilds scoped + names; persona detail enriched', async () => {
  const ctx = setupDeps(['admin1']); // super-admin
  ctx.deps.listGuilds = () => [
    { id: 'G1', name: 'Guild One', memberCount: 1 },
    { id: 'G2', name: 'Guild Two', memberCount: 1 },
  ];
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    // Super sees ALL bot guilds, with names.
    const g = await (await fetch(`${base}/admin/guilds`, auth)).json();
    assert.deepEqual(g.guilds.map((x: { id: string }) => x.id).sort(), ['G1', 'G2']);
    assert.equal(g.guilds.find((x: { id: string }) => x.id === 'G1').name, 'Guild One');
    // Enriched detail: roles are objects (name+caps+scope), policy present, guilds named.
    const d = await (await fetch(`${base}/admin/personas/p1`, auth)).json();
    assert.ok('policy' in d);
    assert.ok(d.guilds.every((x: any) => typeof x.id === 'string' && typeof x.name === 'string'));
    if (d.roles.length) assert.ok('caps' in d.roles[0] && 'name' in d.roles[0]);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: guild-admin /admin/guilds = bot guilds ∩ their admin set', async () => {
  const ctx = setupDeps([]); // guild-admin only
  ctx.deps.listGuilds = () => [
    { id: 'G1', name: 'Guild One', memberCount: 1 },
    { id: 'G2', name: 'Guild Two', memberCount: 1 },
  ];
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const g = await (await fetch(`${base}/admin/guilds`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    assert.deepEqual(g.guilds.map((x: { id: string }) => x.id), ['G1'], 'only the guild they admin AND bot is in');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: global persona registry is super-admin only', async () => {
  const ctx = setupDeps([]); // guild-admin only
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const res = await fetch(`${base}/admin/personas`, { headers: { cookie: `portal_admin_session=${session}` } });
    assert.equal(res.status, 403, 'guild-admin cannot enumerate the global registry');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: super-admin authors the role catalog', async () => {
  const ctx = setupDeps(['admin1']);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const res = await fetch(`${base}/admin/roles`, {
      method: 'POST',
      headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ name: 'newrole', role: { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G1' } }),
    });
    assert.equal(res.status, 200);

    // Roles are guild-scoped: authoring without a guildId is rejected.
    const unbound = await fetch(`${base}/admin/roles`, {
      method: 'POST',
      headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ name: 'nowhere', role: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }),
    });
    assert.equal(unbound.status, 400);
    assert.ok(ctx.permissions.getRole('newrole'), 'role added to catalog');
    const del = await fetch(`${base}/admin/roles/newrole`, {
      method: 'DELETE',
      headers: { cookie: `portal_admin_session=${session}`, 'x-csrf-token': me.csrf },
    });
    assert.equal(del.status, 200);
    assert.equal(ctx.permissions.getRole('newrole'), undefined);

    // Super-admin can force-rotate a persona token via the global endpoint.
    const rot = await fetch(`${base}/admin/personas/p1/token`, {
      method: 'POST',
      headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ action: 'rotate' }),
    });
    assert.equal(rot.status, 200);
    const newToken = (await rot.json()).token as string;
    assert.ok(ctx.identity.authenticate(newToken, 'p1'), 'rotated token works');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: super-admin edits the guild allow-list', async () => {
  const ctx = setupDeps(['admin1']);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const cookie = `portal_admin_session=${session}`;
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie } })).json();

    // GET /all: both guilds visible with live allowed flags; editable.
    const all = await (await fetch(`${base}/admin/guilds/all`, { headers: { cookie } })).json();
    assert.equal(all.editable, true);
    assert.deepEqual(all.allowlist, ['1111100000']);
    assert.equal(all.guilds.find((g: any) => g.id === '1111100000').allowed, true);
    assert.equal(all.guilds.find((g: any) => g.id === '2222200000').allowed, false);

    // Mutation without CSRF → 403.
    const noCsrf = await fetch(`${base}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ guildId: '2222200000' }),
    });
    assert.equal(noCsrf.status, 403);

    // POST: allow the joined-but-not-allowed guild; persists to disk.
    const post = await fetch(`${base}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ guildId: '2222200000' }),
    });
    assert.equal(post.status, 200);
    const posted = await post.json();
    assert.equal(posted.present, true);
    assert.equal(posted.warning, undefined);
    const onDisk = JSON.parse(readFileSync(ctx.allowPath, 'utf8'));
    assert.ok(onDisk.guildIds.includes('2222200000'), 'allow persisted to guilds.json');

    // POST junk → 400; POST a not-joined snowflake → 200 + warning + present:false.
    const junk = await fetch(`${base}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ guildId: 'not-a-snowflake' }),
    });
    assert.equal(junk.status, 400);
    const dormant = await fetch(`${base}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ guildId: '9999900000' }),
    });
    assert.equal(dormant.status, 200);
    const dormantBody = await dormant.json();
    assert.equal(dormantBody.present, false);
    assert.ok(dormantBody.warning, 'not-joined allow carries a warning');
    // GET /all surfaces the dormant entry as allowed + present:false.
    const all2 = await (await fetch(`${base}/admin/guilds/all`, { headers: { cookie } })).json();
    const ghost = all2.guilds.find((g: any) => g.id === '9999900000');
    assert.equal(ghost.present, false);
    assert.equal(ghost.allowed, true);

    // DELETE: remove; second delete 404; removing the rest flags denyAll.
    assert.equal((await fetch(`${base}/admin/guilds/9999900000`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': me.csrf } })).status, 200);
    assert.equal((await fetch(`${base}/admin/guilds/9999900000`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': me.csrf } })).status, 404);
    assert.equal((await fetch(`${base}/admin/guilds/2222200000`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': me.csrf } })).status, 200);
    const last = await fetch(`${base}/admin/guilds/1111100000`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': me.csrf } });
    assert.equal(last.status, 200);
    assert.equal((await last.json()).denyAll, true, 'empty list is deny-all, and reported as such');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: guild allow-list is super-admin only and env-mode is read-only', async () => {
  // Non-super guild admin: scope GET still works, allow-list routes are 403.
  const ctx = setupDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const cookie = `portal_admin_session=${session}`;
    assert.equal((await fetch(`${base}/admin/guilds`, { headers: { cookie } })).status, 200, 'scope selector GET unaffected');
    assert.equal((await fetch(`${base}/admin/guilds/all`, { headers: { cookie } })).status, 403);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie } })).json();
    const post = await fetch(`${base}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ guildId: '2222200000' }),
    });
    assert.equal(post.status, 403);
  } finally {
    await server.close();
    ctx.cleanup();
  }

  // Env-managed (editable:false): GET reports it, mutations 409.
  const ctx2 = setupDeps(['admin1'], {}, { allowlistEditable: false });
  const server2 = new AdminServer(ctx2.deps, fakeDiscordFetch([{ id: 'G1', name: 'G', permissions: '0' }]));
  await server2.listen();
  const base2 = `http://127.0.0.1:${server2.boundPort}`;
  try {
    const session = await login(base2, []);
    const cookie = `portal_admin_session=${session}`;
    const all = await (await fetch(`${base2}/admin/guilds/all`, { headers: { cookie } })).json();
    assert.equal(all.editable, false);
    const me = await (await fetch(`${base2}/admin/me`, { headers: { cookie } })).json();
    const post = await fetch(`${base2}/admin/guilds`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ guildId: '2222200000' }),
    });
    assert.equal(post.status, 409);
  } finally {
    await server2.close();
    ctx2.cleanup();
  }
});

test('hashed tokens: plaintext never authenticates; rotation works', () => {
  // A stored hash authenticates only against its plaintext preimage.
  const dir = mkdtempSync(join(tmpdir(), 'portal-idhash-'));
  const path = join(dir, 'identity.json');
  writeFileSync(path, JSON.stringify({
    personas: [{ id: 'p1', displayName: 'P1', avatar: '', token: hashToken('secret-1') }],
  }));
  const store = new IdentityStore(path, '');
  assert.ok(store.authenticate('secret-1', 'p1'), 'correct plaintext authenticates');
  assert.equal(store.authenticate('wrong', 'p1'), null);
  // The at-rest value is a hash, not the plaintext.
  assert.equal(store.authenticate(hashToken('secret-1'), 'p1'), null, 'presenting the hash does not work');
  rmSync(dir, { recursive: true, force: true });
});

test('integration: super-admin sets/clears persona avatar (global identity)', async () => {
  const ctx = setupDeps(['admin1']);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const hdr = { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf };

    const ok = await fetch(`${base}/admin/personas/p1/avatar`, { method: 'PUT', headers: hdr, body: JSON.stringify({ avatar: 'https://example.test/a.png' }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).avatar, 'https://example.test/a.png');
    assert.equal(ctx.identity.get('p1')!.avatar, 'https://example.test/a.png');
    // Token still authenticates — avatar change must not disturb identity auth.
    assert.ok(ctx.identity.authenticate('t1', 'p1'));

    // Path-traversal / junk rejected.
    const bad = await fetch(`${base}/admin/personas/p1/avatar`, { method: 'PUT', headers: hdr, body: JSON.stringify({ avatar: '../../etc/passwd' }) });
    assert.equal(bad.status, 400);

    // Clear.
    const clr = await fetch(`${base}/admin/personas/p1/avatar`, { method: 'PUT', headers: hdr, body: JSON.stringify({ avatar: '' }) });
    assert.equal(clr.status, 200);
    assert.equal(ctx.identity.get('p1')!.avatar, '');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: guild-admin cannot set avatar (global = super-admin only)', async () => {
  const ctx = setupDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const res = await fetch(`${base}/admin/personas/p1/avatar`, {
      method: 'PUT',
      headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({ avatar: 'https://example.test/a.png' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: super-admin uploads + serves a persona avatar', async () => {
  const ctx = setupDeps(['admin1']);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: '0' }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  // Minimal valid PNG (signature + padding to clear the 12-byte magic check).
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const authHdr = { cookie: `portal_admin_session=${session}`, 'x-csrf-token': me.csrf };

    // Upload.
    const up = await fetch(`${base}/admin/personas/p1/avatar/upload`, {
      method: 'POST', headers: { ...authHdr, 'content-type': 'image/png' }, body: png,
    });
    assert.equal(up.status, 200);
    const { avatar } = await up.json();
    assert.match(avatar, /^p1-[0-9a-f]+\.png$/);
    assert.equal(ctx.identity.get('p1')!.avatar, avatar);

    // Serve it back (public, no session) with the bytes intact.
    const got = await fetch(`${base}/admin/avatars/${avatar}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

    // Wrong content-type → 400.
    const badCt = await fetch(`${base}/admin/personas/p1/avatar/upload`, { method: 'POST', headers: { ...authHdr, 'content-type': 'text/plain' }, body: png });
    assert.equal(badCt.status, 400);
    // Not actually an image → 400.
    const notImg = await fetch(`${base}/admin/personas/p1/avatar/upload`, { method: 'POST', headers: { ...authHdr, 'content-type': 'image/png' }, body: Buffer.from('hello world not a png') });
    assert.equal(notImg.status, 400);
    // Path traversal on serve → 400.
    assert.equal((await fetch(`${base}/admin/avatars/..%2f..%2fetc%2fpasswd`)).status, 400);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: guild-admin cannot upload avatar (global = super-admin only)', async () => {
  const ctx = setupDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'G1', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const res = await fetch(`${base}/admin/personas/p1/avatar/upload`, {
      method: 'POST', headers: { cookie: `portal_admin_session=${session}`, 'x-csrf-token': me.csrf, 'content-type': 'image/png' }, body: png,
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: tampered oauth state is rejected', async () => {
  const { deps, cleanup } = setupDeps([]);
  const server = new AdminServer(deps, fakeDiscordFetch([]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    // Cookie and query state disagree → back on the panel, no session minted.
    const real = loginState(await fetch(`${base}/admin/login`, { redirect: 'manual' }))!;
    const res = await fetch(
      `${base}/admin/callback?code=abc&state=${'B'.repeat(43)}`,
      { redirect: 'manual', headers: { cookie: stateCookie(real) } },
    );
    assert.equal(res.status, 302, 'lands back on the panel');
    assert.equal(res.headers.get('location'), '/done?login_error=mismatch');
    assert.equal(parseSetCookie(res, 'portal_admin_session'), undefined);
  } finally {
    await server.close();
    cleanup();
  }
});

// ── Names: the panel shows names, not ids ──

/** Deps where p1 holds ad-hoc grants on an archived thread, a deleted channel
 *  and (hand-edited) another guild's channel, and the catalog has roles that
 *  mirror Discord roles in G1 and G2. */
function namesDeps(superadmins: string[]) {
  const ctx = setupDeps(superadmins);
  const labels: Record<string, ChannelLabel> = {
    c1: { id: 'c1', name: 'general', type: 'text', guildId: 'G1' },
    th1: { id: 'th1', name: 'design-notes', type: 'thread', guildId: 'G1', parentId: 'c1', parentName: 'general', archived: true },
    x2: { id: 'x2', name: 'g2-private', type: 'text', guildId: 'G2' },
  };
  ctx.deps.resolveChannels = async (ids) =>
    new Map(ids.map((id) => [id, labels[id] ?? { id, name: null, missing: true as const }]));
  ctx.deps.discordRole = (rid) =>
    rid === 'role1' ? { name: 'Mods', guildId: 'G1' } : rid === 'role2' ? { name: 'G2 Staff', guildId: 'G2' } : null;
  ctx.deps.listAllGuilds = () => [
    { id: 'G1', name: 'Guild One', memberCount: 1, allowed: true },
    { id: 'G2', name: 'Guild Two', memberCount: 1, allowed: true },
  ];
  ctx.permissions.setChannel('p1', 'G1', 'th1', ['VIEW_CHANNEL']);
  ctx.permissions.setChannel('p1', 'G1', 'gone1', ['VIEW_CHANNEL']);
  ctx.permissions.setChannel('p1', 'G1', 'x2', ['VIEW_CHANNEL']);
  ctx.permissions.setRole('mirror-g1', { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role1' }, guildId: 'G1' });
  ctx.permissions.setRole('mirror-g2', { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role2' }, guildId: 'G2' });
  ctx.permissions.setRole('chans-g2', { caps: ['VIEW_CHANNEL'], scope: { channels: ['x2'] }, guildId: 'G2' });
  ctx.permissions.addPersonaRoles('p1', ['mirror-g2']);
  ctx.invites.mint({ code: 'in-mirror', label: 'mirror', guildId: 'G1', uses: 0, grant: { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role1' } } } as any);
  ctx.deps.audit.append({ actor: { id: 'a', name: 'A', kind: 'admin' }, action: 'persona.grant.set', target: 'p1', guildId: 'G1', ok: true, after: { channelId: 'th1' } });
  return ctx;
}

test('integration: guild-admin views carry names — and only their own guild\'s', async () => {
  const ctx = namesDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };

    // Persona drawer: the archived thread is named with its parent. A deleted
    // channel and another guild's channel read the same — unavailable, no name.
    const d = await (await fetch(`${base}/admin/g/G1/personas/p1`, auth)).json();
    assert.equal(d.names.channels.th1.name, 'design-notes');
    assert.equal(d.names.channels.th1.parentName, 'general');
    assert.equal(d.names.channels.th1.archived, true);
    assert.deepEqual(d.names.channels.gone1, { id: 'gone1', name: null, unavailable: true });
    assert.deepEqual(d.names.channels.x2, { id: 'x2', name: null, unavailable: true });

    // Roles tab (asks with ?names=1): this guild's mirror role is named; G2's
    // roles aren't even looked at. Pickers (no flag) get no names.
    const r = await (await fetch(`${base}/admin/g/G1/roles?names=1`, auth)).json();
    assert.deepEqual(r.names.discordRoles, { role1: { name: 'Mods', guildId: 'G1' } });
    assert.deepEqual(r.names.channels, {});
    assert.deepEqual(r.names.guilds, { G1: 'Guild One' });
    const plain = await (await fetch(`${base}/admin/g/G1/roles`, auth)).json();
    assert.equal(plain.names, undefined);

    // Invites: the mirrored role is named.
    const inv = await (await fetch(`${base}/admin/g/G1/invites`, auth)).json();
    assert.equal(inv.names.discordRoles.role1.name, 'Mods');

    // Audit: persona targets and detail channels are named.
    const a = await (await fetch(`${base}/admin/g/G1/audit`, auth)).json();
    assert.equal(a.names.personas.p1, 'Persona One');
    assert.equal(a.names.channels.th1.name, 'design-notes');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: super-admin identity detail names grants, role scopes and guilds everywhere', async () => {
  const ctx = namesDeps(['admin1']);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const d = await (await fetch(`${base}/admin/personas/p1`, auth)).json();
    assert.equal(d.names.channels.th1.name, 'design-notes');
    assert.equal(d.names.channels.x2.name, 'g2-private', 'super-admin view is not clipped');
    assert.equal(d.names.channels.gone1.missing, true);
    assert.equal(d.names.discordRoles.role2.name, 'G2 Staff');
    assert.equal(d.names.guilds.G1, 'Guild One');
    assert.equal(d.names.guilds.G2, 'Guild Two');

    const r = await (await fetch(`${base}/admin/g/G1/roles?names=1`, auth)).json();
    assert.equal(r.names.discordRoles.role2.name, 'G2 Staff');
    assert.equal(r.names.channels.x2.name, 'g2-private');
    assert.equal(r.names.guilds.G2, 'Guild Two');
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

test('integration: clearing a grant the persona does not hold is 404 and is not audited', async () => {
  const ctx = namesDeps([]);
  const server = new AdminServer(ctx.deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const hdr = { cookie: `portal_admin_session=${session}`, 'x-csrf-token': me.csrf };
    const before = ctx.deps.audit.read({ guildId: 'G1' }).length;
    const bogus = await fetch(`${base}/admin/g/G1/personas/p1/grants?channelId=999999999999999999`, { method: 'DELETE', headers: hdr });
    assert.equal(bogus.status, 404);
    assert.equal(ctx.deps.audit.read({ guildId: 'G1' }).length, before, 'no audit record for a no-op');
    const real = await fetch(`${base}/admin/g/G1/personas/p1/grants?channelId=th1`, { method: 'DELETE', headers: hdr });
    assert.equal(real.status, 200);
    assert.equal((await real.json()).guildPolicy.channels?.th1, undefined);
  } finally {
    await server.close();
    ctx.cleanup();
  }
});

// ── Served guilds only; invite grants validated (2026-10-16) ──

test('login: someone who administers no guild the relay serves gets no session', async () => {
  const { deps, cleanup } = setupDeps([]);
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'MYSERVER', name: 'My own server', owner: true, permissions: ADMINISTRATOR }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const loginRes = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    const state = loginState(loginRes)!;
    const cb = await fetch(`${base}/admin/callback?code=abc&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie(state) } });
    assert.equal(cb.status, 302, 'lands back on the panel with a reason');
    assert.match(cb.headers.get('location') ?? '', /login_error=not_admin$/);
    assert.equal(parseSetCookie(cb, 'portal_admin_session'), undefined, 'no session cookie');
    const last = deps.audit.read({}).find((r) => r.action === 'login.denied');
    assert.ok(last, 'audited as login.denied');
  } finally {
    await server.close();
    cleanup();
  }
});

test('a guild the admin runs but the relay does not serve is out of reach, even with a session', async () => {
  const { deps, cleanup } = setupDeps([]);
  const server = new AdminServer(deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD },
    { id: 'MYSERVER', name: 'My own server', owner: true, permissions: ADMINISTRATOR },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    assert.deepEqual(me.guilds.map((g: { id: string }) => g.id), ['G1'], 'only served guilds are listed');
    const hdr = { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf };
    for (const [method, path, body] of [
      ['GET', '/admin/g/MYSERVER/invites', undefined],
      ['POST', '/admin/g/MYSERVER/invites', { grant: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }],
      ['POST', '/admin/g/MYSERVER/personas/p1/claim', { code: 'whatever' }],
    ] as const) {
      const r = await fetch(`${base}${path}`, { method, headers: hdr, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  } finally {
    await server.close();
    cleanup();
  }
});

test('invite grants are validated and rebuilt; only a super-admin may grant a whole guild', async () => {
  for (const asSuper of [false, true]) {
    const { deps, invites, cleanup } = setupDeps(asSuper ? ['admin1'] : []);
    const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
    await server.listen();
    const base = `http://127.0.0.1:${server.boundPort}`;
    try {
      const session = await login(base, []);
      const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
      const mint = (grant: unknown) => fetch(`${base}/admin/g/G1/invites`, {
        method: 'POST',
        headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf },
        body: JSON.stringify({ grant }),
      });
      const all = await mint({ caps: ['VIEW_CHANNEL'], scope: { all: true } });
      assert.equal(all.status, asSuper ? 200 : 403, `scope all as ${asSuper ? 'super' : 'guild-admin'}`);
      if (asSuper) {
        const stored = invites.get((await all.json()).code)!;
        assert.deepEqual(stored.grant, { caps: ['VIEW_CHANNEL'], scope: { all: true } });
      }
      assert.equal((await mint({ caps: ['NOT_A_CAP'], scope: { channels: ['c1'] } })).status, 400);
      assert.equal((await mint({ caps: [], scope: { channels: ['c1'] } })).status, 400);
      assert.equal((await mint({ caps: ['VIEW_CHANNEL'], scope: { channels: ['elsewhere'] } })).status, 403);
      assert.equal((await mint({ caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role-of-another-guild' } })).status, 403);
      assert.equal((await mint({ caps: ['VIEW_CHANNEL'], scope: { channels: ['c1'], all: true } })).status, 400, 'two scopes');
      // Junk riding along is not stored.
      const ok = await mint({ caps: ['VIEW_CHANNEL', 'VIEW_CHANNEL'], scope: { channels: ['c1'] }, extra: 'smuggled', guildId: 'OTHER' });
      assert.equal(ok.status, 200);
      const stored = invites.get((await ok.json()).code)!;
      assert.deepEqual(stored.grant, { caps: ['VIEW_CHANNEL'], scope: { channels: ['c1'] } });
      assert.equal(stored.guildId, 'G1');
      const mirror = await mint({ caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role1' } });
      assert.equal(mirror.status, 200, 'a role of this guild may be mirrored');
    } finally {
      await server.close();
      cleanup();
    }
  }
});

test("guild-admins see only their guild's access roles, and not invites carrying other guilds' roles", async () => {
  const { deps, permissions, invites, cleanup } = setupDeps([]);
  permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  permissions.addPersonaRoles('p1', ['r-g1', 'r-g2']);
  invites.mint({ code: 'cross', guildId: 'G1', roles: ['r-g2'], mode: 'augment', uses: 0 } as any);
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const roles = await (await fetch(`${base}/admin/g/G1/roles`, auth)).json();
    assert.deepEqual(Object.keys(roles.catalog), ['r-g1'], 'catalog limited to G1');
    const detail = await (await fetch(`${base}/admin/g/G1/personas/p1`, auth)).json();
    assert.deepEqual(detail.roles, ['r-g1']);
    const list = await (await fetch(`${base}/admin/g/G1/personas`, auth)).json();
    assert.deepEqual(list.personas.find((p: { id: string }) => p.id === 'p1').roles, ['r-g1']);
    const inv = await (await fetch(`${base}/admin/g/G1/invites`, auth)).json();
    assert.ok(!inv.invites.some((i: { code: string }) => i.code === 'cross'), 'cross-guild invite hidden');
    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    const claim = await fetch(`${base}/admin/g/G1/personas/p1/claim`, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: JSON.stringify({ code: 'cross' }),
    });
    assert.equal(claim.status, 404, 'and not claimable');
  } finally {
    await server.close();
    cleanup();
  }
});

test('a guild that becomes served mid-session appears without signing in again', async () => {
  const { deps, cleanup } = setupDeps([]);
  let served = ['G1'];
  deps.listGuilds = () => served.map((id) => ({ id, name: id, memberCount: 1 }));
  const server = new AdminServer(deps, fakeDiscordFetch([
    { id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD },
    { id: 'G7', name: 'Guild Seven', permissions: MANAGE_GUILD },
  ]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    assert.deepEqual((await (await fetch(`${base}/admin/me`, auth)).json()).guilds.map((g: { id: string }) => g.id), ['G1']);
    assert.equal((await fetch(`${base}/admin/g/G7/invites`, auth)).status, 403);
    served = ['G1', 'G7'];
    assert.deepEqual((await (await fetch(`${base}/admin/me`, auth)).json()).guilds.map((g: { id: string }) => g.id).sort(), ['G1', 'G7']);
    assert.equal((await fetch(`${base}/admin/g/G7/invites`, auth)).status, 200);
    served = ['G7'];
    assert.equal((await fetch(`${base}/admin/g/G1/invites`, auth)).status, 403, 'and one that stops being served drops out at once');
  } finally {
    await server.close();
    cleanup();
  }
});

test("the audit view never shows a whole invite code, nor a guild admin another guild's role names", async () => {
  const { deps, permissions, invites, cleanup } = setupDeps([]);
  permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  // As a super-admin's cross-guild mint and slash /invite would record them.
  const code = 'inv_supersecretcode0123456789';
  invites.mint({ code, guildId: 'G1', roles: ['r-g2'], mode: 'both', uses: 0 } as any);
  const superActor = { id: 'super', name: 'Super', kind: 'admin' as const };
  deps.audit.append({ actor: superActor, action: 'invite.mint', target: code, guildId: 'G1', ok: true, after: invites.get(code) });
  deps.audit.append({ actor: superActor, action: 'slash.invite', target: code, guildId: 'G1', ok: true, detail: { via: 'slash', roles: ['r-g2', 'r-g1'] } });
  deps.audit.append({ actor: superActor, action: 'persona.claim', target: 'p1', guildId: 'G1', ok: true, after: { code, roles: ['r-g1', 'r-g2'] } });
  deps.audit.append({ actor: superActor, action: 'persona.role.assign', target: 'p1', guildId: 'G1', ok: true, after: { role: 'r-g2' } });
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const body = await (await fetch(`${base}/admin/g/G1/audit`, auth)).json();
    const text = JSON.stringify(body);
    assert.ok(!text.includes(code), 'no whole code anywhere in the audit view');
    assert.ok(text.includes(code.slice(0, 12)), 'a prefix still matches records to invites');
    assert.ok(!text.includes('r-g2'), "no other guild's role names");
    assert.ok(text.includes('r-g1'), "the guild's own roles still show");
    // And the hidden invite can't be revoked by this admin either.
    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    const del = await fetch(`${base}/admin/g/G1/invites/${code}`, { method: 'DELETE', headers: { ...auth.headers, 'x-csrf-token': me.csrf } });
    assert.equal(del.status, 404);
    assert.ok(invites.get(code), 'still there');
  } finally {
    await server.close();
    cleanup();
  }
});

test("a guild admin's role changes answer with their guild's roles only", async () => {
  const { deps, permissions, cleanup } = setupDeps([]);
  permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  permissions.setRole('r-g1b', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G1' });
  permissions.addPersonaRoles('p1', ['r-g2']);
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const hdr = { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf };
    const add = await (await fetch(`${base}/admin/g/G1/personas/p1/roles`, { method: 'POST', headers: hdr, body: JSON.stringify({ role: 'r-g1b' }) })).json();
    assert.deepEqual(add.roles, ['r-g1b']);
    const claim = await (await fetch(`${base}/admin/g/G1/personas/p1/claim`, { method: 'POST', headers: hdr, body: JSON.stringify({ code: 'aug-g1' }) })).json();
    assert.deepEqual(claim.roles.sort(), ['r-g1', 'r-g1b']);
    const del = await (await fetch(`${base}/admin/g/G1/personas/p1/roles/r-g1b`, { method: 'DELETE', headers: hdr })).json();
    assert.deepEqual(del.roles, ['r-g1']);
    assert.ok(permissions.getRoleNames('p1').includes('r-g2'), 'the other guild\'s role is untouched');
  } finally {
    await server.close();
    cleanup();
  }
});

test("an invite whose role no longer resolves is hidden from guild admins (it is dead: the relay refuses it)", async () => {
  const { deps, permissions, invites, cleanup } = setupDeps([]);
  permissions.setRole('r-temp', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  invites.mint({ code: 'temp-inv', guildId: 'G1', roles: ['r-temp'], mode: 'both', uses: 0 } as any);
  permissions.removeRole('r-temp'); // was another guild's; a name can come back
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const auth = { headers: { cookie: `portal_admin_session=${session}` } };
    const list = await (await fetch(`${base}/admin/g/G1/invites`, auth)).json();
    assert.ok(!list.invites.some((i: { code: string }) => i.code === 'temp-inv'), 'not listed');
    const me = await (await fetch(`${base}/admin/me`, auth)).json();
    const claim = await fetch(`${base}/admin/g/G1/personas/p1/claim`, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: JSON.stringify({ code: 'temp-inv' }),
    });
    assert.equal(claim.status, 404, 'not claimable');
    assert.ok(!permissions.getRoleNames('p1').includes('r-temp'));
  } finally {
    await server.close();
    cleanup();
  }
});

test('an explicit deny does not lift a ban; a grant does only when the admin chose to lift it (liftBan: true)', async () => {
  const { deps, permissions, cleanup } = setupDeps([]);
  permissions.clearGuild('p1', 'G1');
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const hdr = { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf };
    const put = (body: unknown) => fetch(`${base}/admin/g/G1/personas/p1/grants`, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
    assert.equal((await put({ channelId: 'c1', deny: true })).status, 200);
    assert.equal(permissions.isBanned('p1', 'G1'), true, 'a deny keeps the ban');
    // Unasked, a grant is refused and nothing is written: a write from a view
    // loaded before the removal (an Undo, a queued change) can't lift it.
    const before = JSON.stringify(permissions.getEntry('p1'));
    for (const body of [{ channelId: 'c1', caps: ['VIEW_CHANNEL'] }, { channelId: 'c1', level: 'write', liftBan: false }, { guildDefault: true, level: 'read' }]) {
      const r = await put(body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal((await r.json()).error.code, 'BANNED');
    }
    assert.equal(JSON.stringify(permissions.getEntry('p1')), before, 'nothing written');
    assert.equal(permissions.isBanned('p1', 'G1'), true);
    assert.equal((await put({ channelId: 'c1', caps: ['VIEW_CHANNEL'], liftBan: 'yes' })).status, 400, 'liftBan is a boolean');
    const lifted = await put({ channelId: 'c1', caps: ['VIEW_CHANNEL'], liftBan: true });
    assert.equal(lifted.status, 200);
    assert.equal((await lifted.json()).liftedBan, true);
    assert.equal(permissions.isBanned('p1', 'G1'), false, 'a grant the admin chose to lift with lifts it');
    // Not removed: liftBan changes nothing.
    const plain = await put({ channelId: 'c1', level: 'read', liftBan: true });
    assert.equal(plain.status, 200);
    assert.equal('liftedBan' in (await plain.json()), false);
  } finally {
    await server.close();
    cleanup();
  }
});

test('a removal is never lifted unasked: an Undo sent after Remove, an access role, an invite applied — each 409 BANNED until the admin chooses to lift it', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    // A grant given, then taken away (its Undo would put Write back, expecting nothing there).
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'write', expect: null })).status, 200);
    assert.equal((await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c1', { expect: WRITE })).status, 200);
    // Removed from G1 meanwhile (the panel's Remove; slash /ban is the same function).
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/remove')).status, 200);
    const sets = () => ctx.deps.audit.read({ guildId: 'G1', limit: 100 }).filter((x) => x.action === 'persona.grant.set').length;
    const n = sets();
    // The Undo: expect (nothing there) still matches — the removal dropped every grant — but it can't lift the removal.
    const undo = await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'write', expect: null });
    assert.equal(undo.status, 409);
    assert.equal(undo.body.error.code, 'BANNED');
    assert.equal(ctx.permissions.isBanned('p1', 'G1'), true, 'still removed');
    assert.equal(sets(), n, 'nothing written, nothing recorded');
    assert.equal((await s.get('/admin/g/G1/personas/p1/access')).body.removed, true);
    // A changed-meanwhile refusal still comes first.
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'write', expect: READ })).body.error.code, 'CONFLICT');

    // An access role that grants something: the same.
    const role = await s.call('POST', '/admin/g/G1/personas/p1/roles', { role: 'r-g1' });
    assert.equal(role.status, 409);
    assert.equal(role.body.error.code, 'BANNED');
    assert.deepEqual(ctx.permissions.getRoleNames('p1'), [], 'not given');
    const roleLifted = await s.call('POST', '/admin/g/G1/personas/p1/roles', { role: 'r-g1', liftBan: true });
    assert.equal(roleLifted.status, 200);
    assert.equal(roleLifted.body.banned, false);
    assert.deepEqual(ctx.deps.audit.read({ guildId: 'G1', limit: 1 })[0].after, { role: 'r-g1', liftedBan: true });

    // An invite applied by the admin: the same.
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/remove')).status, 200);
    const claim = await s.call('POST', '/admin/g/G1/personas/p1/claim', { code: 'aug-g1' });
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error.code, 'BANNED');
    assert.equal(ctx.invites.get('aug-g1')!.uses, 0, 'not applied');
    const claimLifted = await s.call('POST', '/admin/g/G1/personas/p1/claim', { code: 'aug-g1', liftBan: true });
    assert.equal(claimLifted.status, 200);
  } finally {
    await s.close();
  }
});

test('Unset guild-wide on a persona removed with /ban: refused unless the ban is lifted with it; the drawer is told', async () => {
  const { deps, permissions, cleanup } = setupDeps([]);
  permissions.setPersonaDefault('p1', ['VIEW_CHANNEL', 'READ_HISTORY']);
  permissions.clearGuild('p1', 'G1');
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const cookie = `portal_admin_session=${session}`;
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie } })).json();
    const hdr = { cookie, 'x-csrf-token': me.csrf };
    const detail = await (await fetch(`${base}/admin/g/G1/personas/p1`, { headers: { cookie } })).json();
    assert.equal(detail.banned, true, 'the drawer is told about the ban');
    assert.deepEqual(detail.guildPolicy, { default: [] });

    const plain = await fetch(`${base}/admin/g/G1/personas/p1/grants?guildDefault=unset`, { method: 'DELETE', headers: hdr });
    assert.equal(plain.status, 409);
    assert.equal((await plain.json()).error.code, 'BANNED');
    assert.equal(permissions.isBanned('p1', 'G1'), true, 'nothing changed');
    assert.deepEqual(permissions.getEntry('p1')?.policy?.guilds?.G1, { default: [] });
    assert.equal(deps.audit.read({ limit: 100 }).filter((r) => r.action === 'persona.grant.clear').length, 0);

    const lift = await fetch(`${base}/admin/g/G1/personas/p1/grants?guildDefault=unset&liftBan=1`, { method: 'DELETE', headers: hdr });
    assert.equal(lift.status, 200);
    const { effective: liftEffect, ...lifted } = await lift.json();
    assert.deepEqual(lifted, { guildPolicy: null, banned: false });
    assert.deepEqual(liftEffect, {
      guildWide: true, channels: 3, counts: { read: 3, write: 0, full: 0, custom: 0 }, direct: { read: 0, write: 0, full: 0, custom: 0 },
    }, 'and says what that gives: the persona default’s Read in each of G1’s channels (odd1, of a kind the panel can’t give access on, too)');
    assert.equal(permissions.isBanned('p1', 'G1'), false);
    assert.deepEqual([...permissions.resolve('p1', 'G1', 'c1')].sort(), ['READ_HISTORY', 'VIEW_CHANNEL'], 'what the panel says: the persona default applies');
    const rec = deps.audit.read({ limit: 100 }).find((r) => r.action === 'persona.grant.clear')!;
    assert.deepEqual(rec.after, { guildDefault: true, caps: null, liftedBan: true });
    const after = await (await fetch(`${base}/admin/g/G1/personas/p1`, { headers: { cookie } })).json();
    assert.equal(after.banned, false);

    // Not banned: liftBan changes nothing, and a plain Unset works as before.
    permissions.setGuildDefault('p1', 'G1', []);
    const again = await fetch(`${base}/admin/g/G1/personas/p1/grants?guildDefault=unset`, { method: 'DELETE', headers: hdr });
    assert.equal(again.status, 200);
    const { effective: _again, ...unset } = await again.json();
    assert.deepEqual(unset, { guildPolicy: null, banned: false });
    // A grant's answer says whether the persona is still removed.
    permissions.clearGuild('p1', 'G1');
    const deny = await fetch(`${base}/admin/g/G1/personas/p1/grants?guildDefault=deny`, { method: 'DELETE', headers: hdr });
    assert.equal((await deny.json()).banned, true, 'a deny keeps the ban, and says so');
    const put = await fetch(`${base}/admin/g/G1/personas/p1/grants`, { method: 'PUT', headers: { ...hdr, 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'c1', level: 'read', liftBan: true }) });
    assert.equal((await put.json()).banned, false, 'a grant lifts it, and says so');
  } finally {
    await server.close();
    cleanup();
  }
});

test('audit view: short hand-chosen codes are hidden outright; deleted roles are labelled as deleted', async () => {
  const { deps, permissions, cleanup } = setupDeps([]);
  const actor = { id: 'super', name: 'Super', kind: 'admin' as const };
  deps.audit.append({ actor, action: 'invite.mint', target: 'g2-guests-0001', guildId: 'G1', ok: true, after: { code: 'g2-guests-0001' } });
  permissions.setRole('r-g1-old', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G1' });
  deps.audit.append({ actor, action: 'persona.role.assign', target: 'p1', guildId: 'G1', ok: true, after: { role: 'r-g1-old' } });
  permissions.removeRole('r-g1-old');
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const body = await (await fetch(`${base}/admin/g/G1/audit`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const text = JSON.stringify(body);
    assert.ok(!text.includes('g2-guests'), 'no part of a short code');
    const assign = body.records.find((r: { action: string }) => r.action === 'persona.role.assign');
    assert.equal(assign.after.role, '(deleted role)');
  } finally {
    await server.close();
    cleanup();
  }
});


// ── Server validation, guild-scoped reads, one CSRF gate (P3) ──

const READ = LEVEL_CAPS.read;
const WRITE = LEVEL_CAPS.write;

/** An AdminServer over `ctx`, signed in (by default as an admin of G1 only).
 *  call() sends JSON with the session's CSRF token unless told otherwise. */
async function signedIn(
  ctx: ReturnType<typeof setupDeps>,
  oauthGuilds: unknown[] = [{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }],
  limits: AdminLimits = {},
) {
  const server = new AdminServer(ctx.deps, fakeDiscordFetch(oauthGuilds), limits);
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  const session = await login(base, []);
  const cookie = `portal_admin_session=${session}`;
  const me = await (await fetch(`${base}/admin/me`, { headers: { cookie } })).json();
  const call = async (method: string, path: string, body?: unknown, opts: { csrf?: string | null; raw?: Buffer; type?: string } = {}) => {
    const headers: Record<string, string> = { cookie };
    const token = opts.csrf === undefined ? me.csrf : opts.csrf;
    if (token !== null) headers['x-csrf-token'] = token;
    if (opts.raw) headers['content-type'] = opts.type ?? 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, ...(opts.raw ? { body: opts.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const get = (path: string) => call('GET', path);
  return { server, base, cookie, me, call, get, close: async () => { await server.close(); ctx.cleanup(); } };
}

/** Every file the stores keep, as bytes, to show a refused request changed nothing. */
function storeBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name), prefix + f.name + '/');
      else out[prefix + f.name] = readFileSync(join(d, f.name)).toString('base64');
    }
  };
  walk(dir, '');
  return out;
}

test('grants: one target and one operation; every refusal has its code, is not audited and changes nothing', async () => {
  const ctx = setupDeps([]);
  ctx.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  const s = await signedIn(ctx);
  try {
    const before = storeBytes(ctx.dir);
    const put = (body: unknown) => s.call('PUT', '/admin/g/G1/personas/p1/grants', body);
    const cases: Array<[unknown, number, string]> = [
      [{}, 400, 'TARGET_REQUIRED'],
      [{ caps: ['VIEW_CHANNEL'] }, 400, 'TARGET_REQUIRED'], // what a panel from before this change sent for guild-wide
      [{ channelId: 'c1', guildDefault: true, level: 'read' }, 400, 'TARGET_REQUIRED'],
      [{ channelId: 'c1' }, 400, 'EMPTY_CAPS'],
      [{ channelId: 'c1', caps: [] }, 400, 'EMPTY_CAPS'], // a deny is {deny: true} now
      [{ channelId: 'c1', caps: ['NOT_A_CAP'] }, 400, 'UNKNOWN_CAP'],
      [{ channelId: 'c1', level: 'admin' }, 400, 'INVALID'],
      [{ channelId: 'c1', level: 'toString' }, 400, 'INVALID'],
      [{ channelId: 'c1', level: 'read', deny: true }, 400, 'INVALID'],
      [{ channelId: 'c1', deny: false }, 400, 'INVALID'],
      [{ guildDefault: 'yes', level: 'read' }, 400, 'INVALID'],
      [{ channelId: 'nowhere', level: 'read' }, 403, 'FORBIDDEN'],
      [{ channelId: 'cZ', level: 'read' }, 403, 'FORBIDDEN'], // Guild Two's channel
      [{ channelId: 'th-c1', level: 'read' }, 400, 'THREAD_TARGET'],
      [{ channelId: 'cat1', level: 'read' }, 400, 'CATEGORY_TARGET'],
      [{ channelId: 'odd1', level: 'read' }, 400, 'NOT_GRANTABLE'],
    ];
    for (const [body, status, code] of cases) {
      const r = await put(body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.body.error.code, code, JSON.stringify(body));
    }
    const thread = await put({ channelId: 'th-c1', level: 'write' });
    assert.equal(thread.body.error.parentId, 'c1', 'a thread names the channel to give access on instead');
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/nobody/grants', { channelId: 'c1', level: 'read' })).status, 404);

    const del = (q: string) => s.call('DELETE', '/admin/g/G1/personas/p1/grants' + q);
    assert.equal((await del('')).body.error.code, 'TARGET_REQUIRED', 'a bare DELETE no longer means deny');
    assert.equal((await del('?channelId=c1&guildDefault=deny')).body.error.code, 'TARGET_REQUIRED');
    assert.equal((await del('?guildDefault=maybe')).body.error.code, 'INVALID');
    assert.equal((await del('?channelId=c2')).status, 404, 'no grant there');
    assert.equal((await s.call('DELETE', '/admin/g/G1/personas/p2/grants?guildDefault=unset')).status, 404, 'nothing to unset');

    assert.deepEqual(storeBytes(ctx.dir), before, 'nothing written, nothing audited');
  } finally {
    await s.close();
  }
});

test('grants: levels are slash’s, deny stores [], guild-wide is set, denied or unset explicitly; audit has before and after', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  const g1 = () => ctx.permissions.getEntry('p1')?.policy?.guilds?.G1;
  const last = () => ctx.deps.audit.read({ guildId: 'G1', limit: 1 })[0];
  try {
    const put = (body: unknown) => s.call('PUT', '/admin/g/G1/personas/p1/grants', body);
    assert.equal((await put({ channelId: 'c1', level: 'write' })).status, 200);
    assert.deepEqual(g1()?.channels?.c1, WRITE);
    assert.equal(last().action, 'persona.grant.set');
    assert.deepEqual(last().before, { channelId: 'c1', caps: null });
    assert.deepEqual(last().after, { channelId: 'c1', caps: WRITE, level: 'write' });

    assert.equal((await put({ channelId: 'c1', caps: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'VIEW_CHANNEL'] })).status, 200);
    assert.deepEqual(g1()?.channels?.c1, ['VIEW_CHANNEL', 'SEND_MESSAGES'], 'a custom set, without repeats');
    assert.deepEqual(last().before, { channelId: 'c1', caps: WRITE });

    assert.equal((await put({ channelId: 'c2', deny: true })).status, 200);
    assert.deepEqual(g1()?.channels?.c2, [], 'deny: true is the explicit deny');

    assert.equal((await put({ guildDefault: true, level: 'read' })).status, 200);
    assert.deepEqual(g1()?.default, READ);
    assert.deepEqual(last().before, { guildDefault: true, caps: ['VIEW_CHANNEL'] });
    assert.deepEqual(last().after, { guildDefault: true, caps: READ, level: 'read' });

    const del = (q: string) => s.call('DELETE', '/admin/g/G1/personas/p1/grants' + q);
    const denied = await del('?guildDefault=deny');
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.body.guildPolicy.default, []);
    assert.equal(last().action, 'persona.grant.clear');
    assert.deepEqual(last().before, { guildDefault: true, caps: READ });
    assert.deepEqual(last().after, { guildDefault: true, caps: [] });

    // Unset: no guild-wide setting at all — channels fall back to the persona default.
    ctx.permissions.setPersonaDefault('p1', ['VIEW_CHANNEL', 'READ_HISTORY']);
    assert.equal(ctx.permissions.resolve('p1', 'G1', 'c9').size, 0, 'denied guild-wide: the persona default is blocked here');
    const unset = await del('?guildDefault=unset');
    assert.equal(unset.status, 200);
    assert.equal('default' in unset.body.guildPolicy, false);
    assert.deepEqual([...ctx.permissions.resolve('p1', 'G1', 'c9')].sort(), ['READ_HISTORY', 'VIEW_CHANNEL'], 'falls back to the persona default');
    assert.deepEqual(last().before, { guildDefault: true, caps: [] });
    assert.deepEqual(last().after, { guildDefault: true, caps: null });

    // Removing the last direct grants leaves no empty guild entry behind.
    assert.equal((await del('?channelId=c1')).status, 200);
    assert.deepEqual(last().before, { channelId: 'c1', caps: ['VIEW_CHANNEL', 'SEND_MESSAGES'] });
    assert.deepEqual(last().after, { channelId: 'c1', caps: null });
    const gone = await del('?channelId=c2');
    assert.equal(gone.body.guildPolicy, null);
    assert.equal(ctx.permissions.getEntry('p1')?.policy?.guilds, undefined);
  } finally {
    await s.close();
  }
});

test('persona rows: hasOverride and directGrants say whether direct grants give anything here', async () => {
  const ctx = setupDeps([]);
  ctx.permissions.addPersonaRoles('p1', ['r-g1']); // so p1 stays listed whatever its direct grants say
  const s = await signedIn(ctx);
  const row = async () => (await s.get('/admin/g/G1/personas')).body.personas.find((p: { id: string }) => p.id === 'p1');
  try {
    assert.equal((await row()).directGrants, 'grants');
    assert.equal((await row()).hasOverride, true);
    await s.call('DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=unset');
    assert.equal((await row()).hasOverride, false, 'nothing left');
    assert.equal((await row()).directGrants, 'none');
    await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', deny: true });
    assert.equal((await row()).hasOverride, false, 'a block gives nothing');
    assert.equal((await row()).directGrants, 'none');
    await s.call('DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=deny');
    assert.equal((await row()).directGrants, 'denied');
    assert.equal((await row()).hasOverride, false);
    assert.equal('otherGuildRoleCount' in (await row()), false, 'a guild admin is not told about other guilds');
  } finally {
    await s.close();
  }
});

test('invariant I3: every channel written under G is one of G’s that can hold access, under the key G', async () => {
  const ctx = setupDeps(['admin1']); // a super-admin reaches every route that writes channels
  ctx.deps.listGuilds = () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }, { id: 'G2', name: 'Guild Two', memberCount: 1 }];
  const s = await signedIn(ctx, []);
  try {
    const before = storeBytes(ctx.dir);
    const refused: Array<[string, string, unknown, string]> = [
      ['PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'cZ', level: 'read' }, 'FORBIDDEN'],
      ['PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'th-c1', level: 'read' }, 'THREAD_TARGET'],
      ['PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'cat1', level: 'read' }, 'CATEGORY_TARGET'],
      ['PUT', '/admin/g/G2/personas/p1/grants', { channelId: 'c1', level: 'read' }, 'FORBIDDEN'],
      ['POST', '/admin/g/G1/invites', { grant: { caps: READ, scope: { channels: ['c1', 'th-c1'] } } }, 'THREAD_TARGET'],
      ['POST', '/admin/g/G1/invites', { grant: { caps: READ, scope: { channels: ['cat1'] } } }, 'CATEGORY_TARGET'],
      ['POST', '/admin/g/G1/invites', { grant: { caps: READ, scope: { channels: ['odd1'] } } }, 'NOT_GRANTABLE'],
      ['POST', '/admin/g/G1/invites', { grant: { caps: READ, scope: { channels: ['cZ'] } } }, 'FORBIDDEN'],
      ['POST', '/admin/roles', { name: 'g1-thread', role: { caps: READ, scope: { channels: ['th-c1'] }, guildId: 'G1' } }, 'THREAD_TARGET'],
      ['POST', '/admin/roles', { name: 'g1-cat', role: { caps: READ, scope: { channels: ['cat1'] }, guildId: 'G1' } }, 'CATEGORY_TARGET'],
      ['POST', '/admin/roles', { name: 'g1-far', role: { caps: READ, scope: { channels: ['cZ'] }, guildId: 'G1' } }, 'INVALID'],
    ];
    for (const [method, path, body, code] of refused) {
      const r = await s.call(method, path, body);
      assert.equal(r.body?.error?.code, code, `${method} ${path} ${JSON.stringify(body)}`);
    }
    assert.deepEqual(storeBytes(ctx.dir), before, 'nothing written');

    // What is written lands under the route's guild, whatever the body says.
    const ok = await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'read', guildId: 'G2' });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ctx.permissions.getEntry('p1')?.policy?.guilds ?? {}), ['G1']);
    assert.deepEqual(ctx.permissions.getEntry('p1')?.policy?.guilds?.G1?.channels?.c1, READ);
  } finally {
    await s.close();
  }
});

test('invites list: search, newest first, a status for each, and a status filter', async () => {
  const ctx = setupDeps([]);
  const hour = 3_600_000;
  // Written to disk and loaded, as an invite with an unreadable expiry can only come from the file.
  writeFileSync(join(ctx.dir, 'invites.json'), JSON.stringify({
    invites: [
      { code: 'inv-guests', label: 'guests', guildId: 'G1', roles: ['r-g1'], maxUses: 5, uses: 1 },
      { code: 'inv-usedup', label: 'used-up', guildId: 'G1', roles: ['r-g1'], maxUses: 1, uses: 1 },
      { code: 'inv-old', label: 'expired', guildId: 'G1', roles: ['r-g1'], expiresAt: new Date(Date.now() - hour).toISOString() },
      { code: 'inv-both', label: 'expired and used up', guildId: 'G1', roles: ['r-g1'], maxUses: 1, uses: 1, expiresAt: new Date(Date.now() - hour).toISOString() },
      { code: 'inv-garbled', label: 'garbled expiry', guildId: 'G1', roles: ['r-g1'], expiresAt: 'next tuesday' },
      { code: 'inv-elsewhere', label: 'guests too', guildId: 'G2', roles: ['r-g1'] },
      { code: 'inv-new', label: 'newest', guildId: 'G1', roles: ['r-g1'], expiresAt: new Date(Date.now() + 24 * hour).toISOString() },
    ],
  }));
  ctx.deps.invites = new InviteStore(join(ctx.dir, 'invites.json'));
  const s = await signedIn(ctx);
  try {
    const codes = (b: any) => b.invites.map((i: { code: string }) => i.code);
    const all = (await s.get('/admin/g/G1/invites')).body;
    assert.deepEqual(codes(all), ['inv-new', 'inv-garbled', 'inv-both', 'inv-old', 'inv-usedup', 'inv-guests'], 'newest first, this guild only');
    assert.deepEqual(Object.fromEntries(all.invites.map((i: { code: string; status: string }) => [i.code, i.status])), {
      'inv-new': 'active', 'inv-garbled': 'expired', 'inv-both': 'expired', 'inv-old': 'expired', 'inv-usedup': 'used', 'inv-guests': 'active',
    });
    assert.deepEqual(codes((await s.get('/admin/g/G1/invites?q=guests')).body), ['inv-guests'], 'search works, within the guild');
    assert.deepEqual(codes((await s.get('/admin/g/G1/invites?q=zzzz')).body), []);
    assert.deepEqual(codes((await s.get('/admin/g/G1/invites?q=INV-USED')).body), ['inv-usedup'], 'codes match too, any case');
    assert.deepEqual(codes((await s.get('/admin/g/G1/invites?status=active')).body), ['inv-new', 'inv-guests']);
    assert.deepEqual(codes((await s.get('/admin/g/G1/invites?status=spent')).body), ['inv-garbled', 'inv-both', 'inv-old', 'inv-usedup']);
    assert.equal((await s.get('/admin/g/G1/invites?status=later')).status, 400);
    assert.equal((await s.get('/admin/g/G1/invites?limit=2')).body.total, 6, 'paging counts what matches');
    assert.equal(ctx.deps.invites!.get('inv-guests')!.status, undefined, 'the status is computed, not stored');
  } finally {
    await s.close();
  }
});

test('/admin/me: api version, the relay’s own levels and capabilities, features and when the session ends', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    assert.equal(s.me.apiVersion, 3, 'API 3: the access views, the persona directory, Remove from <guild> and Resync');
    assert.deepEqual(s.me.levels, LEVEL_CAPS);
    assert.deepEqual(s.me.caps, ALL_CAPS);
    assert.deepEqual(s.me.features, { invites: true, avatarUploads: true, allowlistEditable: true });
    assert.equal(typeof s.me.session.expiresAt, 'number');
    assert.ok(s.me.session.expiresAt > Date.now() && s.me.session.expiresAt <= Date.now() + 60_000);
  } finally {
    await s.close();
  }
  const bare = setupDeps([], {}, { allowlistEditable: false });
  bare.deps.config = { ...bare.deps.config, avatarDir: undefined };
  bare.deps.invites = undefined;
  const s2 = await signedIn(bare);
  try {
    assert.deepEqual(s2.me.features, { invites: false, avatarUploads: false, allowlistEditable: false });
  } finally {
    await s2.close();
  }
});

test('persona reads: a guild admin gets this guild’s access roles; a super-admin all of them and how many are elsewhere', async () => {
  const ctx = setupDeps(['admin1']);
  ctx.permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  ctx.permissions.addPersonaRoles('p1', ['r-g1', 'r-g2']);
  const s = await signedIn(ctx, []);
  try {
    const detail = (await s.get('/admin/g/G1/personas/p1')).body;
    assert.deepEqual(detail.roles, ['r-g1', 'r-g2']);
    assert.equal(detail.otherGuildRoleCount, 1);
    const row = (await s.get('/admin/g/G1/personas')).body.personas.find((p: { id: string }) => p.id === 'p1');
    assert.equal(row.otherGuildRoleCount, 1);
  } finally {
    await s.close();
  }
  const ctx2 = setupDeps([]);
  ctx2.permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  ctx2.permissions.addPersonaRoles('p1', ['r-g1', 'r-g2']);
  const g = await signedIn(ctx2);
  try {
    const detail = (await g.get('/admin/g/G1/personas/p1')).body;
    assert.deepEqual(detail.roles, ['r-g1']);
    assert.equal('otherGuildRoleCount' in detail, false);
  } finally {
    await g.close();
  }
});

test('invariant I5: what a guild admin reads in G names only G’s channels and access roles', async () => {
  const ctx = setupDeps([]);
  const { permissions, invites, deps } = ctx;
  permissions.setRole('r-g2-secret', { caps: ['VIEW_CHANNEL'], scope: { channels: ['cZ'] }, guildId: 'G2' });
  permissions.addPersonaRoles('p1', ['r-g1', 'r-g2-secret']);
  permissions.setChannel('p1', 'G2', 'cZ', ['VIEW_CHANNEL']);
  invites.mint({ code: 'inv-carries-g2', guildId: 'G1', roles: ['r-g2-secret'], mode: 'augment', uses: 0 } as any);
  deps.audit.append({ actor: { id: 'super', name: 'Super', kind: 'admin' }, action: 'persona.role.assign', target: 'p1', guildId: 'G1', ok: true, after: { role: 'r-g2-secret' } });
  deps.audit.append({ actor: { id: 'super', name: 'Super', kind: 'admin' }, action: 'persona.grant.set', target: 'p1', guildId: 'G2', ok: true, after: { channelId: 'cZ', caps: ['VIEW_CHANNEL'] } });
  const s = await signedIn(ctx);
  try {
    for (const path of ['personas', 'personas/p1', 'roles', 'roles?names=1', 'invites', 'channels', 'audit']) {
      const r = await s.get('/admin/g/G1/' + path);
      assert.equal(r.status, 200, path);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes('r-g2-secret'), `${path}: no other guild's access role`);
      assert.ok(!text.includes('cZ'), `${path}: no other guild's channel`);
    }
  } finally {
    await s.close();
  }
});

test('role catalog: a name in use is refused unless replaced in its own guild; definitions are checked and rebuilt', async () => {
  const ctx = setupDeps(['admin1']);
  ctx.deps.listRoles = (gid) => (gid === 'G1'
    ? [{ id: 'role1', guildId: 'G1', name: 'Mods', pooled: false }, { id: 'pool1', guildId: 'G1', name: 'portal-x', pooled: true }]
    : [{ id: 'role-g2', guildId: 'G2', name: 'Desk', pooled: false }]);
  const s = await signedIn(ctx, []);
  const post = (body: unknown) => s.call('POST', '/admin/roles', body);
  const def = (role: object, name = 'g1-new') => post({ name, role: { caps: READ, scope: { all: true }, guildId: 'G1', ...role } });
  try {
    const original = ctx.permissions.getRole('r-g1');
    const taken = await post({ name: 'r-g1', role: { caps: WRITE, scope: { all: true }, guildId: 'G1' } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'EXISTS');
    assert.equal(taken.body.error.existing.guildId, 'G1');
    const wrongGuild = await post({ name: 'r-g1', role: { caps: WRITE, scope: { all: true }, guildId: 'G1' }, replace: true, expectedGuildId: 'G2' });
    assert.equal(wrongGuild.status, 409);
    assert.equal(wrongGuild.body.error.code, 'GUILD_MISMATCH');
    const move = await post({ name: 'r-g1', role: { caps: WRITE, scope: { all: true }, guildId: 'G2' }, replace: true, expectedGuildId: 'G1' });
    assert.equal(move.body.error.code, 'GUILD_MISMATCH', 'replacing never moves a role to another guild');
    assert.deepEqual(ctx.permissions.getRole('r-g1'), original, 'still as it was');
    const replaced = await post({ name: 'r-g1', role: { caps: WRITE, scope: { all: true }, guildId: 'G1' }, replace: true, expectedGuildId: 'G1' });
    assert.equal(replaced.status, 200);
    assert.deepEqual(ctx.permissions.getRole('r-g1')?.caps, WRITE);
    const rec = ctx.deps.audit.read({ limit: 1 })[0];
    assert.equal(rec.action, 'role.set');
    assert.deepEqual(rec.before, original);

    const cases: Array<[Promise<{ status: number; body: any }>, string]> = [
      [post({ name: 'Bad Name', role: { caps: READ, scope: { all: true }, guildId: 'G1' } }), 'INVALID_NAME'],
      [post({ name: '-dash-first', role: { caps: READ, scope: { all: true }, guildId: 'G1' } }), 'INVALID_NAME'],
      [post({ name: 'x'.repeat(65), role: { caps: READ, scope: { all: true }, guildId: 'G1' } }), 'INVALID_NAME'],
      [def({ caps: [] }), 'EMPTY_CAPS'],
      [def({ caps: ['NOT_A_CAP'] }), 'UNKNOWN_CAP'],
      [def({ scope: {} }), 'INVALID'],
      [def({ scope: { all: true, channels: ['c1'] } }), 'INVALID'],
      [def({ scope: { all: false } }), 'INVALID'],
      [def({ scope: { channels: [] } }), 'INVALID'],
      [def({ scope: { mirrorRole: 'pool1' } }), 'INVALID'],
      [def({ scope: { mirrorRole: 'role-g2' } }), 'INVALID'],
      [def({ scope: { mirrorRoles: ['role1', 'role-g2'] } }), 'INVALID'],
      [def({ scope: { mirrorRole: 'role1' }, mirrorCaps: 'yes' }), 'INVALID'],
      [def({ scope: { all: true }, mirrorCaps: true }), 'INVALID'],
    ];
    for (const [p, code] of cases) {
      const r = await p;
      assert.equal(r.status, 400, code);
      assert.equal(r.body.error.code, code);
    }
    assert.equal(ctx.permissions.getRole('g1-new'), undefined, 'nothing was defined');

    // A good definition is stored as checked, without anything riding along.
    const ok = await post({ name: 'g1-mods.v2_x', role: { caps: ['VIEW_CHANNEL', 'VIEW_CHANNEL'], scope: { mirrorRole: 'role1', extra: 1 }, guildId: 'G1', mirrorCaps: true, holders: ['p1'] } });
    assert.equal(ok.status, 400, 'a scope with two keys is refused');
    const ok2 = await post({ name: 'g1-mods.v2_x', role: { caps: ['VIEW_CHANNEL', 'VIEW_CHANNEL'], scope: { mirrorRole: 'role1' }, guildId: 'G1', mirrorCaps: true, holders: ['p1'] } });
    assert.equal(ok2.status, 200);
    assert.deepEqual(ctx.permissions.getRole('g1-mods.v2_x'), { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'role1' }, guildId: 'G1', mirrorCaps: true });
    const chans = await def({ scope: { channels: ['c1', 'c2', 'c1'] } }, 'g1-chans');
    assert.equal(chans.status, 200);
    assert.deepEqual(ctx.permissions.getRole('g1-chans')?.scope, { channels: ['c1', 'c2'] });

    // A name from before the naming rule can still be replaced under that name.
    ctx.permissions.setRole('Old Name', { caps: READ, scope: { all: true }, guildId: 'G1' });
    assert.equal((await post({ name: 'Old Name', role: { caps: WRITE, scope: { all: true }, guildId: 'G1' }, replace: true, expectedGuildId: 'G1' })).status, 200);
  } finally {
    await s.close();
  }
});

test('invariant I2: no request but a GET gets past a missing or wrong CSRF token — logout included — and nothing changes', async () => {
  const ctx = setupDeps(['admin1']);
  const s = await signedIn(ctx, []);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  // Every non-GET route the admin API has, plus methods and paths it doesn't:
  // the gate runs before routing.
  const routes: Array<[string, string, unknown?]> = [
    ['POST', '/admin/logout'],
    ['POST', '/admin/guilds', { guildId: '2222200000' }],
    ['DELETE', '/admin/guilds/1111100000'],
    ['POST', '/admin/roles', { name: 'g1-x', role: { caps: READ, scope: { all: true }, guildId: 'G1' } }],
    ['DELETE', '/admin/roles/r-g1'],
    ['POST', '/admin/personas/p1/token', { action: 'rotate' }],
    ['PUT', '/admin/personas/p1/avatar', { avatar: 'https://example.test/a.png' }],
    ['POST', '/admin/personas/p1/avatar/upload', png],
    ['POST', '/admin/g/G1/invites', { roles: ['r-g1'] }],
    ['DELETE', '/admin/g/G1/invites/in-g1'],
    ['POST', '/admin/g/G1/personas/p1/roles', { role: 'r-g1' }],
    ['DELETE', '/admin/g/G1/personas/p1/roles/r-g1'],
    ['PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'read' }],
    ['DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=unset'],
    ['POST', '/admin/g/G1/personas/p1/claim', { code: 'aug-g1' }],
    ['POST', '/admin/g/G1/personas/p1/remove'],
    ['POST', '/admin/g/G1/personas/p1/resync'],
    ['PATCH', '/admin/g/G1/personas/p1'],
    ['POST', '/admin/no-such-route', {}],
  ];
  try {
    const before = storeBytes(ctx.dir);
    const wrongSameLength = s.me.csrf.slice(0, -1) + (s.me.csrf.endsWith('A') ? 'B' : 'A');
    for (const [method, path, body] of routes) {
      for (const csrf of [null, '', 'x', wrongSameLength, s.me.csrf + 'x']) {
        const r = Buffer.isBuffer(body)
          ? await s.call(method, path, undefined, { csrf, raw: body, type: 'image/png' })
          : await s.call(method, path, body, { csrf });
        assert.equal(r.status, 403, `${method} ${path} with ${JSON.stringify(csrf)}`);
        assert.equal(r.body.error.code, 'CSRF', `${method} ${path}`);
      }
    }
    assert.deepEqual(storeBytes(ctx.dir), before, 'no store file and no audit line changed');
    assert.equal(existsSync(join(ctx.dir, 'avatars')) ? readdirSync(join(ctx.dir, 'avatars')).length : 0, 0, 'no upload stored');
    assert.equal((await s.get('/admin/me')).status, 200, 'logout without the token did not sign out');
    // With the token it does.
    assert.equal((await s.call('POST', '/admin/logout')).status, 200);
    assert.equal((await s.get('/admin/me')).status, 401);
  } finally {
    await s.close();
  }
});

test('a persona on the file default keeps it in other guilds when a guild admin first gives it something here', async () => {
  const ctx = setupDeps([], {}, { fileDefault: ['VIEW_CHANNEL'] });
  for (const id of ['p2', 'p3', 'p4', 'p5']) ctx.identity.upsert({ id, displayName: id, avatar: '', token: hashToken(id) });
  const s = await signedIn(ctx);
  const elsewhere = (pid: string) => [...ctx.permissions.resolve(pid, 'G2', 'cZ')];
  try {
    for (const pid of ['p2', 'p3', 'p4', 'p5']) assert.deepEqual(elsewhere(pid), ['VIEW_CHANNEL'], 'no entry: the file default everywhere');
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p2/grants', { channelId: 'c1', level: 'write' })).status, 200);
    assert.deepEqual(elsewhere('p2'), ['VIEW_CHANNEL'], 'after a grant in G1');
    assert.deepEqual([...ctx.permissions.resolve('p2', 'G1', 'c2')], ['VIEW_CHANNEL'], 'and in G1’s other channels');
    assert.equal((await s.call('DELETE', '/admin/g/G1/personas/p3/grants?guildDefault=deny')).status, 200);
    assert.deepEqual(elsewhere('p3'), ['VIEW_CHANNEL'], 'after a guild-wide deny in G1');
    assert.equal(ctx.permissions.resolve('p3', 'G1', 'c2').size, 0, 'which does deny in G1');
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p4/roles', { role: 'r-g1' })).status, 200);
    assert.deepEqual(elsewhere('p4'), ['VIEW_CHANNEL'], 'after an access role in G1');
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p5/claim', { code: 'aug-g1' })).status, 200);
    assert.deepEqual(elsewhere('p5'), ['VIEW_CHANNEL'], 'after an admin claim in G1');
  } finally {
    await s.close();
  }
});

test('invariant I1: every guild route checks the guild first — a guild the admin does not manage is refused, whatever the route', async () => {
  const ctx = setupDeps([]);
  ctx.deps.listGuilds = () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }, { id: 'G2', name: 'Guild Two', memberCount: 1 }];
  const s = await signedIn(ctx); // an admin of G1 only; the relay serves G1 and G2
  try {
    const before = storeBytes(ctx.dir);
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/admin/g/G2/personas'], ['GET', '/admin/g/G2/personas/p1'], ['GET', '/admin/g/G2/roles?names=1'],
      ['GET', '/admin/g/G2/channels'], ['GET', '/admin/g/G2/invites'], ['GET', '/admin/g/G2/audit'], ['GET', '/admin/g/G2/no-such'],
      ['POST', '/admin/g/G2/invites', { roles: ['r-g1'] }], ['DELETE', '/admin/g/G2/invites/in-g2'],
      ['POST', '/admin/g/G2/personas/p1/roles', { role: 'r-g1' }], ['DELETE', '/admin/g/G2/personas/p1/roles/r-g1'],
      ['PUT', '/admin/g/G2/personas/p1/grants', { channelId: 'cZ', level: 'read' }], ['DELETE', '/admin/g/G2/personas/p1/grants?guildDefault=deny'],
      ['POST', '/admin/g/G2/personas/p1/claim', { code: 'in-g2' }],
      ['POST', '/admin/g/G2/personas/p1/remove'], ['POST', '/admin/g/G2/personas/p1/resync'],
      ['GET', '/admin/g/G2/access/summary'], ['GET', '/admin/g/G2/channels/cZ/access'], ['GET', '/admin/g/G2/personas/p1/access'],
      ['GET', '/admin/g/G2/persona-directory?q=p'],
    ];
    for (const [method, path, body] of routes) {
      const r = await s.call(method, path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error.reason, 'NOT_GUILD_ADMIN', `${method} ${path}`);
    }
    const after = storeBytes(ctx.dir);
    const { 'audit.jsonl': auditAfter, ...restAfter } = after;
    const { 'audit.jsonl': auditBefore, ...restBefore } = before;
    assert.deepEqual(restAfter, restBefore, 'no store changed');
    const denials = ctx.deps.audit.read({ guildId: 'G2' }).filter((r) => r.action === 'authz.denied');
    assert.equal(denials.length, routes.length, 'each refusal is audited');
    assert.notEqual(auditAfter, auditBefore);
  } finally {
    await s.close();
  }
});

test('invariant I4: a guild admin assigns, revokes, mints and claims only their own guild’s access roles', async () => {
  const ctx = setupDeps([]);
  ctx.permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  ctx.permissions.addPersonaRoles('p1', ['r-g2']);
  ctx.invites.mint({ code: 'inv-g1-carrying-g2', guildId: 'G1', roles: ['r-g2'], mode: 'augment', uses: 0 } as any);
  const s = await signedIn(ctx);
  try {
    const before = storeBytes(ctx.dir);
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/roles', { role: 'r-g2' })).status, 403);
    assert.equal((await s.call('DELETE', '/admin/g/G1/personas/p1/roles/r-g2')).status, 403);
    assert.equal((await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1', 'r-g2'] })).status, 403);
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/claim', { code: 'inv-g1-carrying-g2' })).status, 404);
    assert.equal((await s.call('DELETE', '/admin/g/G1/invites/inv-g1-carrying-g2')).status, 404);
    assert.deepEqual(storeBytes(ctx.dir), before, 'nothing changed');
    assert.deepEqual(ctx.permissions.getRoleNames('p1'), ['r-g2']);
  } finally {
    await s.close();
  }
});

test('invariant I8: a guild admin never writes persona-wide state', async () => {
  const ctx = setupDeps([]);
  ctx.permissions.setPersonaDefault('p1', ['VIEW_CHANNEL']);
  const s = await signedIn(ctx);
  try {
    const before = storeBytes(ctx.dir);
    const refused: Array<[string, string, unknown]> = [
      ['POST', '/admin/g/G1/invites', { grant: { caps: READ, scope: { all: true } } }], // every channel: super-admin only
      ['POST', '/admin/roles', { name: 'g1-x', role: { caps: READ, scope: { all: true }, guildId: 'G1' } }],
      ['DELETE', '/admin/roles/r-g1', undefined],
      ['POST', '/admin/personas/p1/token', { action: 'rotate' }],
      ['PUT', '/admin/personas/p1/avatar', { avatar: 'https://example.test/a.png' }],
      ['POST', '/admin/guilds', { guildId: '2222200000' }],
      ['DELETE', '/admin/guilds/1111100000', undefined],
    ];
    for (const [method, path, body] of refused) assert.equal((await s.call(method, path, body)).status, 403, `${method} ${path}`);
    const { 'audit.jsonl': _a, ...after } = storeBytes(ctx.dir);
    const { 'audit.jsonl': _b, ...was } = before;
    assert.deepEqual(after, was, 'no store changed');
    // Everything a guild admin may do to a persona leaves its persona default alone.
    for (const [method, path, body] of [
      ['PUT', '/admin/g/G1/personas/p1/grants', { guildDefault: true, level: 'write' }],
      ['PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', deny: true }],
      ['DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=deny', undefined],
      ['DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=unset', undefined],
      ['POST', '/admin/g/G1/personas/p1/roles', { role: 'r-g1' }],
      ['POST', '/admin/g/G1/personas/p1/claim', { code: 'aug-g1' }],
      ['POST', '/admin/g/G1/personas/p1/resync', undefined],
      ['POST', '/admin/g/G1/personas/p1/remove', undefined],
    ] as Array<[string, string, unknown]>) {
      assert.equal((await s.call(method, path, body)).status, 200, `${method} ${path}`);
      assert.deepEqual(ctx.permissions.getEntry('p1')?.policy?.default, ['VIEW_CHANNEL'], `${method} ${path}`);
      assert.deepEqual(Object.keys(ctx.permissions.getEntry('p1')?.policy?.guilds ?? {}).filter((g) => g !== 'G1'), []);
    }
  } finally {
    await s.close();
  }
});

test('a refused sign-in puts login_error in the query even when postLoginUrl has a fragment', async () => {
  const { deps, cleanup } = setupDeps([]);
  deps.config.postLoginUrl = '/panel#start';
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G9', name: 'Unserved', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const l = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    const st = loginState(l)!;
    const cb = await fetch(`${base}/admin/callback?code=abc&state=${st}`, { redirect: 'manual', headers: { cookie: stateCookie(st) } });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/panel?login_error=not_admin#start');
  } finally {
    await server.close();
    cleanup();
  }
});

test('assigning an access role whose scope names nothing does not lift a ban', async () => {
  const { deps, permissions, cleanup } = setupDeps([]);
  permissions.setRole('r-g1-empty', { caps: ['VIEW_CHANNEL'], scope: { channels: [] }, guildId: 'G1' });
  permissions.clearGuild('p1', 'G1');
  const server = new AdminServer(deps, fakeDiscordFetch([{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const session = await login(base, []);
    const me = await (await fetch(`${base}/admin/me`, { headers: { cookie: `portal_admin_session=${session}` } })).json();
    const r = await fetch(`${base}/admin/g/G1/personas/p1/roles`, {
      method: 'POST', headers: { cookie: `portal_admin_session=${session}`, 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: JSON.stringify({ role: 'r-g1-empty' }),
    });
    assert.equal(r.status, 200);
    assert.equal(permissions.isBanned('p1', 'G1'), true);
  } finally {
    await server.close();
    cleanup();
  }
});


// ── Effective access (P6): reads, the directory, and grant echoes ──

test('access reads: a channel that isn’t G’s is one 404, whatever the reason; threads and categories say why they hold nothing', async () => {
  const ctx = setupDeps([]);
  ctx.deps.listGuilds = () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }, { id: 'G2', name: 'Guild Two', memberCount: 1 }];
  const s = await signedIn(ctx);
  try {
    // Another guild's channel, a channel that never existed, one the bot can't see (not in the list): the same answer.
    const answers = await Promise.all(['cZ', 'nope', 'gone1'].map((cid) => s.get(`/admin/g/G1/channels/${cid}/access`)));
    for (const a of answers) {
      assert.equal(a.status, 404);
      assert.deepEqual(a.body, { error: { code: 'NOT_FOUND', message: 'no such channel in this guild' } });
    }
    const thread = await s.get('/admin/g/G1/channels/th-c1/access');
    assert.equal(thread.body.inert, 'thread');
    assert.equal(thread.body.parentId, 'c1');
    assert.equal(thread.body.rows, undefined);
    const cat = await s.get('/admin/g/G1/channels/cat1/access');
    assert.equal(cat.body.inert, 'category');
    assert.deepEqual(cat.body.channels, ['c1', 'c2']);
    assert.equal((await s.get('/admin/g/G1/personas/nobody/access')).status, 404);
  } finally {
    await s.close();
  }
});

test('access reads: who can act where and why — only G’s access roles named, the bot’s limits said, timed', async () => {
  const ctx = setupDeps([], {}, { botCaps: { c2: ['VIEW_CHANNEL', 'READ_HISTORY'] } });
  ctx.permissions.setRole('r-g2', { caps: WRITE, scope: { all: true }, guildId: 'G2' });
  ctx.permissions.setRole('r-g1-chat', { caps: WRITE, scope: { channels: ['c1'] }, guildId: 'G1' });
  ctx.permissions.addPersonaRoles('p1', ['r-g1', 'r-g1-chat', 'r-g2']);
  ctx.permissions.setChannel('p1', 'G1', 'c2', WRITE);
  ctx.permissions.setChannel('p1', 'G1', 'th-c1', WRITE); // does nothing: a thread
  ctx.permissions.setChannel('p1', 'G1', 'cat1', READ); // does nothing: a category
  const s = await signedIn(ctx);
  try {
    const c1 = await s.get('/admin/g/G1/channels/c1/access');
    assert.equal(c1.status, 200);
    assert.match(c1.headers.get('server-timing') ?? '', /^access;dur=\d+(\.\d+)?$/);
    assert.deepEqual(c1.body.channel, { id: 'c1', name: 'c1', type: 'text', categoryId: 'cat1', position: 0, announcement: false, grantable: true });
    assert.equal(c1.body.botBase, 'full');
    const row = c1.body.rows.find((r: { personaId: string }) => r.personaId === 'p1');
    assert.deepEqual(row.effective, WRITE);
    assert.equal(row.level, 'write');
    assert.equal(row.direct, null);
    assert.deepEqual(row.sources.map((x: AnySource) => x.kind + (x.name ? ':' + x.name : '')), ['role:r-g1', 'role:r-g1-chat', 'guildWide'], 'never G2’s role');
    assert.deepEqual(Object.keys(row).sort(), ['avatarUrl', 'base', 'botLacks', 'botLimited', 'direct', 'displayName', 'effective', 'extra', 'level', 'personaId', 'sources'].sort());

    // c2: the bot can only read there.
    const c2 = await s.get('/admin/g/G1/channels/c2/access');
    assert.equal(c2.body.botBase, 'read');
    const limited = c2.body.rows.find((r: { personaId: string }) => r.personaId === 'p1');
    assert.deepEqual(limited.effective, READ);
    assert.deepEqual(limited.direct, WRITE);
    assert.equal(limited.botLimited, true);
    assert.deepEqual(limited.botLacks, WRITE.filter((c) => !READ.includes(c)));
    assert.deepEqual(limited.sources[0], { kind: 'role', name: 'r-g1', caps: ['VIEW_CHANNEL'], how: 'all' });
    assert.deepEqual(limited.sources.find((x: AnySource) => x.kind === 'guildWide'), { kind: 'guildWide', caps: ['VIEW_CHANNEL'], shadowedBy: 'direct' });

    // The persona: per channel, its settings here, the grants that do nothing, G's roles only.
    const p = await s.get('/admin/g/G1/personas/p1/access');
    assert.equal(p.status, 200);
    assert.match(p.headers.get('server-timing') ?? '', /^access;dur=/);
    assert.deepEqual(p.body.persona, { id: 'p1', displayName: 'Persona One', avatarUrl: '' });
    assert.deepEqual(p.body.guildWide, ['VIEW_CHANNEL']);
    assert.equal(p.body.personaDefault, null);
    assert.equal(p.body.removed, false);
    assert.deepEqual(p.body.rows.map((r: { channelId: string }) => r.channelId), ['c1', 'c2', 'odd1'],
      'every channel with access of its own — odd1, of a kind the panel can’t give access on, too: the relay serves it with what capsFor gives');
    assert.deepEqual(p.body.rows.find((r: { channelId: string }) => r.channelId === 'odd1').effective, ctx.deps.capsFor('p1', 'odd1', 'G1'));
    assert.deepEqual(p.body.inactive, [
      { channelId: 'th-c1', caps: WRITE, reason: 'thread' },
      { channelId: 'cat1', caps: READ, reason: 'category' },
    ]);
    assert.deepEqual(p.body.roles.map((r: { name: string; channels: number }) => [r.name, r.channels]), [['r-g1', 3], ['r-g1-chat', 1]]);
    assert.equal('otherGuildRoleCount' in p.body, false, 'a guild admin isn’t told about other guilds');
    assert.ok(!JSON.stringify(p.body).includes('r-g2') && !JSON.stringify(c1.body).includes('r-g2'), 'another guild’s role is never named');
    assert.ok(!JSON.stringify(p.body.names).includes('cZ'));

    // A direct grant on odd1 (what slash /add stores when run in its chat) is a row, and does something.
    ctx.permissions.setChannel('p1', 'G1', 'odd1', WRITE);
    const o = await s.get('/admin/g/G1/personas/p1/access');
    const odd = o.body.rows.find((r: { channelId: string }) => r.channelId === 'odd1');
    assert.deepEqual(odd.direct, WRITE);
    assert.deepEqual(odd.effective, ctx.deps.capsFor('p1', 'odd1', 'G1'));
    assert.ok(!o.body.inactive.some((x: { channelId: string }) => x.channelId === 'odd1'), 'not “inactive”: it gives Write there');
    ctx.permissions.clearChannel('p1', 'G1', 'odd1');

    // A block with nothing to block, and a grant on a channel G doesn't have.
    ctx.permissions.unsetGuildDefault('p1', 'G1');
    ctx.permissions.setChannel('p1', 'G1', 'c1', []);
    ctx.permissions.setChannel('p1', 'G1', 'cZ', READ);
    const q = await s.get('/admin/g/G1/personas/p1/access');
    assert.deepEqual(q.body.inactive.filter((x: { reason: string }) => x.reason === 'blocks-nothing' || x.reason === 'missing'), [
      { channelId: 'c1', caps: [], reason: 'blocks-nothing' },
      { channelId: 'cZ', caps: READ, reason: 'missing' },
    ]);
    assert.deepEqual(q.body.names.channels.cZ, { id: 'cZ', name: null, unavailable: true }, 'another guild’s channel goes unnamed');
  } finally {
    await s.close();
  }
});

type AnySource = { kind: string; name?: string };

test('/channels: each channel’s place in Discord, whether it can hold access, and the categories', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    const r = await s.get('/admin/g/G1/channels');
    const byId = Object.fromEntries(r.body.channels.map((c: { id: string }) => [c.id, c]));
    assert.deepEqual(byId.c2, { id: 'c2', name: 'c2', type: 'text', categoryId: 'cat1', position: 1, announcement: false, grantable: true });
    assert.equal(byId['th-c1'].grantable, false);
    assert.equal(byId['th-c1'].parentId, 'c1');
    assert.equal(byId.cat1.grantable, false);
    assert.equal(byId.odd1.grantable, false);
    assert.deepEqual(r.body.categories, [{ id: 'cat1', name: 'cat1', position: 2 }]);
  } finally {
    await s.close();
  }
});

test('access summary: counts for every channel with access of its own (unknown kinds too); what of Write the bot lacks; reused for 5 s; any change drops it; too big is truncated, never refused', async () => {
  const ctx = setupDeps([], {}, { botCaps: { c2: [] } });
  ctx.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  ctx.identity.upsert({ id: 'p3', displayName: 'Nobody Here', avatar: '', token: hashToken('t3') });
  ctx.permissions.setChannel('p2', 'G1', 'c1', WRITE);
  const s = await signedIn(ctx);
  try {
    const one = await s.get('/admin/g/G1/access/summary');
    assert.equal(one.status, 200);
    assert.match(one.headers.get('server-timing') ?? '', /^access;dur=/);
    assert.deepEqual(one.body.channels, [
      { id: 'c1', botBase: 'full', botCantView: false, counts: { read: 0, write: 1, full: 0, custom: 1 } },
      { id: 'c2', botBase: null, botCantView: true, counts: { read: 0, write: 0, full: 0, custom: 0 } },
      { id: 'odd1', botBase: 'full', botCantView: false, counts: { read: 0, write: 0, full: 0, custom: 1 } },
    ]);
    // p1: guild-wide View only (custom), in c1 and odd1; p2: Write in c1; p3 has nothing here and isn't looked at.
    assert.deepEqual(one.body.personas, [
      { id: 'p1', counts: { read: 0, write: 0, full: 0, custom: 2 } },
      { id: 'p2', counts: { read: 0, write: 1, full: 0, custom: 0 } },
    ]);
    assert.equal(one.body.considered, 2);
    assert.equal(one.body.truncated, undefined);

    // Reused: a change behind the panel's back in Discord (the bot's caps) isn't seen for a moment …
    ctx.deps.botCaps = () => [];
    const two = await s.get('/admin/g/G1/access/summary');
    assert.equal(two.body.computedAt, one.body.computedAt);
    assert.deepEqual(two.body.channels, one.body.channels);
    // … but a permissions change drops it at once.
    ctx.deps.botCaps = (_g, cid) => (cid === 'c2' ? [] : ALL_CAPS);
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p2/grants', { channelId: 'c1', level: 'full' })).status, 200);
    const three = await s.get('/admin/g/G1/access/summary');
    assert.deepEqual(three.body.channels[0].counts, { read: 0, write: 0, full: 1, custom: 1 });

    // A bot that can send but not start threads: what of Write it lacks, by name (the list words it).
    ctx.deps.botCaps = (_g, cid) => (cid === 'c1' ? ALL_CAPS.filter((c) => c !== 'CREATE_THREADS') : cid === 'c2' ? ['VIEW_CHANNEL', 'READ_HISTORY'] : ALL_CAPS);
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p2/grants', { channelId: 'c1', level: 'write' })).status, 200);
    const four = await s.get('/admin/g/G1/access/summary');
    assert.deepEqual(four.body.channels.map((c: { id: string; botBase: string; botLacks?: string[] }) => [c.id, c.botBase, c.botLacks ?? null]), [
      ['c1', 'read', ['CREATE_THREADS']],
      ['c2', 'read', WRITE.filter((c) => !READ.includes(c))],
      ['odd1', 'full', null],
    ]);
  } finally {
    await s.close();
  }
  const ctx2 = setupDeps([]);
  ctx2.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  ctx2.permissions.setChannel('p2', 'G1', 'c1', WRITE);
  const t = await signedIn(ctx2, undefined, { accessCellCap: 5 }); // 2 personas × 3 channels = 6 > 5
  try {
    const r = await t.get('/admin/g/G1/access/summary');
    assert.equal(r.status, 200, 'never a 413');
    assert.equal(r.body.truncated, true);
    assert.deepEqual(r.body.channels.map((c: object) => Object.keys(c).sort()), [['botBase', 'botCantView', 'id'], ['botBase', 'botCantView', 'id'], ['botBase', 'botCantView', 'id']]);
    assert.deepEqual(r.body.personas, [{ id: 'p1' }, { id: 'p2' }]);
  } finally {
    await t.close();
  }
});

test('persona directory: at most 25, only id, name, picture and access here; exact id, then names that start with it, then the rest', async () => {
  const ctx = setupDeps([]);
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, '0');
    ctx.identity.upsert({ id: `dir-${n}`, displayName: `Zed ${n}`, avatar: '', token: hashToken(`t-${n}`) });
  }
  ctx.identity.upsert({ id: 'pa', displayName: 'Zulu', avatar: '', token: hashToken('t-pa') });
  ctx.identity.upsert({ id: 'pax', displayName: 'Pa Kettle', avatar: '', token: hashToken('t-pax') });
  ctx.identity.upsert({ id: 'q-1', displayName: 'Apa', avatar: '', token: hashToken('t-q1') });
  const s = await signedIn(ctx);
  try {
    const all = await s.get('/admin/g/G1/persona-directory?q=e');
    assert.equal(all.status, 200);
    assert.equal(all.body.personas.length, 25);
    for (const row of all.body.personas) assert.deepEqual(Object.keys(row), ['id', 'displayName', 'avatarUrl', 'hasAccessHere']);
    assert.match(all.headers.get('server-timing') ?? '', /^access;dur=/);

    const pa = (await s.get('/admin/g/G1/persona-directory?q=PA')).body.personas.map((p: { id: string }) => p.id);
    assert.deepEqual(pa, ['pa', 'pax', 'q-1'], 'exact id, then a name starting with it, then the rest');
    const none = (await s.get('/admin/g/G1/persona-directory')).body.personas;
    assert.equal(none.length, 25);
    assert.deepEqual(none.slice(0, 2).map((p: { displayName: string }) => p.displayName), ['Apa', 'Pa Kettle'], 'no q: alphabetical');
    const p1 = (await s.get('/admin/g/G1/persona-directory?q=persona one')).body.personas;
    assert.deepEqual(p1, [{ id: 'p1', displayName: 'Persona One', avatarUrl: '', hasAccessHere: true }]);
    assert.equal((await s.get('/admin/g/G1/persona-directory?q=zulu')).body.personas[0].hasAccessHere, false);
  } finally {
    await s.close();
  }
});

test('grants: expect — a change made since the panel loaded is 409 CONFLICT {current}; nothing is written or recorded', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  const g1 = () => ctx.permissions.getEntry('p1')?.policy?.guilds?.G1;
  const okRecords = () => ctx.deps.audit.read({ limit: 1000 }).filter((r) => r.ok && r.action.startsWith('persona.grant.')).length;
  try {
    const put = (body: unknown) => s.call('PUT', '/admin/g/G1/personas/p1/grants', body);
    assert.equal((await put({ channelId: 'c1', level: 'read', expect: null })).status, 200, 'nothing was there, as the panel saw');
    const records = okRecords();
    const before = storeBytes(ctx.dir);
    const stale = await put({ channelId: 'c1', level: 'write', expect: null });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'CONFLICT');
    assert.deepEqual(stale.body.error.current, READ);
    const staleDel = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c1', { expect: WRITE });
    assert.equal(staleDel.status, 409);
    assert.deepEqual(staleDel.body.error.current, READ);
    const staleWide = await put({ guildDefault: true, level: 'read', expect: null });
    assert.deepEqual([staleWide.status, staleWide.body.error.current], [409, ['VIEW_CHANNEL']]);
    const staleDeny = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=deny', { expect: [] });
    assert.equal(staleDeny.status, 409);
    assert.deepEqual(storeBytes(ctx.dir), before, 'nothing written, nothing recorded');
    assert.equal(okRecords(), records);

    // In any order, it's the same set.
    assert.equal((await put({ channelId: 'c1', level: 'write', expect: [...READ].reverse() })).status, 200);
    assert.deepEqual(g1()?.channels?.c1, WRITE);
    const del = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c1', { expect: WRITE, batchId: 'b-1_x' });
    assert.equal(del.status, 200);
    assert.deepEqual(ctx.deps.audit.read({ limit: 1 })[0].detail, { batchId: 'b-1_x' }, 'the batch is recorded');
    assert.equal((await s.call('DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=deny', { expect: ['VIEW_CHANNEL'] })).status, 200);

    for (const bad of [{ expect: 'VIEW_CHANNEL' }, { expect: [1] }, { batchId: 'has space' }, { batchId: 'x'.repeat(33) }, { batchId: 7 }]) {
      const r = await put({ channelId: 'c2', level: 'read', ...bad });
      assert.deepEqual([r.status, r.body.error.code], [400, 'INVALID'], JSON.stringify(bad));
    }
  } finally {
    await s.close();
  }
});

test('grants: the answer says what the persona can do now — in the channel, or guild-wide in how many channels at each level', async () => {
  const ctx = setupDeps([], {}, { botCaps: { c2: ['VIEW_CHANNEL', 'READ_HISTORY'] } });
  const s = await signedIn(ctx);
  try {
    const put = (body: unknown) => s.call('PUT', '/admin/g/G1/personas/p1/grants', body);
    const limited = await put({ channelId: 'c2', level: 'write' });
    assert.deepEqual(limited.body.effective.effective, READ);
    assert.equal(limited.body.effective.level, 'read');
    assert.equal(limited.body.effective.botLimited, true);
    assert.ok(limited.body.effective.botLacks.includes('SEND_MESSAGES'));
    assert.deepEqual(limited.body.effective.direct, WRITE);

    const wide = await put({ guildDefault: true, level: 'read' });
    assert.deepEqual(wide.body.effective, {
      guildWide: true, channels: 3, // c1, c2 and odd1: every channel with access of its own
      counts: { read: 3, write: 0, full: 0, custom: 0 },
      direct: { read: 1, write: 0, full: 0, custom: 0 }, // c2: Write directly, Read is what the bot allows
    });
    const removed = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c2');
    assert.deepEqual(removed.body.effective.effective, READ);
    assert.deepEqual(removed.body.effective.sources, [{ kind: 'guildWide', caps: READ }]);
  } finally {
    await s.close();
  }
});

test('grants: removing a thread’s grant answers with its parent’s access (where the relay checks it); a channel that is gone answers missing', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    // Only an old entry, or slash before it refused threads, holds these: the
    // panel's PUT refuses both.
    ctx.permissions.setChannel('p1', 'G1', 'th-c1', WRITE);
    ctx.permissions.setChannel('p1', 'G1', 'c-gone', WRITE);
    assert.equal((await s.call('PUT', '/admin/g/G1/personas/p1/grants', { channelId: 'c1', level: 'write' })).status, 200);
    const th = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=th-c1');
    assert.equal(th.status, 200);
    assert.equal(th.body.effective.parentId, 'c1', 'the thread uses c1’s access');
    assert.deepEqual(th.body.effective.effective, ctx.deps.capsFor('p1', 'c1', 'G1'));
    assert.deepEqual(th.body.effective.effective, WRITE, 'Write in c1 still reaches the thread');
    assert.deepEqual(th.body.effective.sources, [{ kind: 'direct', caps: WRITE }, { kind: 'guildWide', caps: ['VIEW_CHANNEL'], shadowedBy: 'direct' }], 'c1’s sources');
    // Removing c1's own grant: no parentId, and the guild-wide level is what is left.
    const c1 = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c1');
    assert.equal('parentId' in c1.body.effective, false);
    assert.deepEqual(c1.body.effective.effective, ['VIEW_CHANNEL']);
    const gone = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c-gone');
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.effective, { missing: true }, 'nothing to explain in a channel that isn’t there');
    assert.equal(ctx.permissions.getEntry('p1')?.policy?.guilds?.G1?.channels?.['c-gone'], undefined, 'and it was removed');
  } finally {
    await s.close();
  }
});

test('persona directory: one removed with /ban says so; ?ids= gives exactly those personas, in that order', async () => {
  const ctx = setupDeps([]);
  ctx.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  ctx.permissions.clearGuild('p2', 'G1');
  const s = await signedIn(ctx);
  try {
    const found = await s.get('/admin/g/G1/persona-directory?q=persona');
    assert.deepEqual(found.body.personas, [
      { id: 'p1', displayName: 'Persona One', avatarUrl: '', hasAccessHere: true },
      { id: 'p2', displayName: 'Persona Two', avatarUrl: '', hasAccessHere: false, removed: true },
    ], 'giving p2 access here lifts its removal: the panel is told before it asks');
    const ids = await s.get('/admin/g/G1/persona-directory?ids=' + encodeURIComponent('p2,nobody,p1,p2'));
    assert.equal(ids.status, 200);
    assert.deepEqual(ids.body.personas.map((p: { id: string }) => p.id), ['p2', 'p1'], 'in the order asked, unknown ids left out, each once');
    assert.equal(ids.body.personas[0].removed, true);
    assert.deepEqual((await s.get('/admin/g/G1/persona-directory?ids=')).body.personas, []);
    for (let i = 1; i <= 30; i++) ctx.identity.upsert({ id: `many-${i}`, displayName: `Many ${i}`, avatar: '', token: hashToken(`m-${i}`) });
    const many = await s.get('/admin/g/G1/persona-directory?ids=' + Array.from({ length: 30 }, (_, i) => `many-${i + 1}`).join(','));
    assert.equal(many.body.personas.length, 25, 'at most 25');
    // Another guild's /ban isn't this guild's business.
    ctx.permissions.liftBan('p2', 'G1');
    ctx.permissions.clearGuild('p2', 'G2');
    const elsewhere = await s.get('/admin/g/G1/persona-directory?ids=p2');
    assert.equal('removed' in elsewhere.body.personas[0], false);
  } finally {
    await s.close();
  }
});

test('grants: a channel answer names the Discord roles its mirror sources follow; a grant that ended a /ban says so', async () => {
  const ctx = setupDeps([]);
  // role1 (@Mods, G1's) can see c2.
  ctx.permissions.setMirrorLookup((gid, rid) => new Map(gid === 'G1' && rid === 'role1' ? [['c2', new Set<Capability>(['VIEW_CHANNEL', 'READ_HISTORY'])]] : []));
  ctx.permissions.setRole('mirror-g1', { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { mirrorRole: 'role1' }, guildId: 'G1' });
  ctx.permissions.addPersonaRoles('p1', ['mirror-g1']);
  ctx.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  const s = await signedIn(ctx);
  try {
    const put = (pid: string, body: unknown) => s.call('PUT', `/admin/g/G1/personas/${pid}/grants`, body);
    const set = await put('p1', { channelId: 'c2', level: 'write' });
    assert.equal(set.status, 200);
    assert.ok(set.body.effective.sources.some((x: { kind: string; mirror?: Array<{ id: string }> }) => x.kind === 'role' && x.mirror?.some((m) => m.id === 'role1')));
    assert.deepEqual(set.body.names, { discordRoles: { role1: { name: 'Mods', guildId: 'G1' } } }, 'the role the panel shows as @Mods');
    assert.equal('liftedBan' in set.body, false, 'nothing was lifted');
    const del = await s.call('DELETE', '/admin/g/G1/personas/p1/grants?channelId=c2');
    assert.deepEqual(del.body.names, { discordRoles: { role1: { name: 'Mods', guildId: 'G1' } } });
    assert.deepEqual((await put('p1', { channelId: 'c1', level: 'read' })).body.names, { discordRoles: {} }, 'c1: no mirror there, nothing to name');
    assert.equal('names' in (await put('p1', { guildDefault: true, level: 'read' })).body, false, 'guild-wide explains no channel');

    // Removed with /ban: a deny keeps it; the grant that gives access ends it, and says so — once.
    ctx.permissions.clearGuild('p2', 'G1');
    const deny = await put('p2', { channelId: 'c1', deny: true });
    assert.equal(deny.body.banned, true);
    assert.equal('liftedBan' in deny.body, false);
    assert.equal((await put('p2', { channelId: 'c2', level: 'read' })).body.error.code, 'BANNED', 'not without liftBan');
    const grant = await put('p2', { channelId: 'c2', level: 'read', liftBan: true });
    assert.equal(grant.body.liftedBan, true);
    assert.equal(grant.body.banned, false);
    assert.equal(ctx.permissions.isBanned('p2', 'G1'), false);
    assert.equal('liftedBan' in (await put('p2', { channelId: 'c2', level: 'write', liftBan: true })).body, false, 'only the grant that ended it');
  } finally {
    await s.close();
  }
});

// ── P8: Remove from guild and Resync ──

test('remove from guild: G’s access roles and grants go, the removal is recorded, other guilds are untouched; audited as persona.guild.remove', async () => {
  const ctx = setupDeps([]);
  ctx.permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
  ctx.permissions.addPersonaRoles('p1', ['r-g1', 'r-g2']);
  ctx.permissions.setChannel('p1', 'G1', 'c1', WRITE);
  ctx.permissions.setGuildDefault('p1', 'G2', READ);
  const s = await signedIn(ctx);
  try {
    const r = await s.call('POST', '/admin/g/G1/personas/p1/remove');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { rolesRemoved: ['r-g1'], accessFullyRevoked: true });
    assert.deepEqual(ctx.permissions.getRoleNames('p1'), ['r-g2'], 'only the role bound to G1');
    const entry = ctx.permissions.getEntry('p1')!;
    assert.deepEqual(entry.policy?.guilds?.G2, { default: READ }, 'Guild Two as it was');
    assert.deepEqual(entry.policy?.guilds?.G1, { default: [] }, 'every grant in G1 gone, guild-wide pinned to deny');
    assert.deepEqual(entry.bans, ['G1'], 'recorded: the persona can’t give itself access here again');
    assert.equal(ctx.deps.canAccessGuild('p1', 'G1'), false);
    assert.equal((await s.get('/admin/g/G1/personas/p1/access')).body.removed, true);
    const rec = ctx.deps.audit.read({ guildId: 'G1' }).find((x) => x.action === 'persona.guild.remove')!;
    assert.equal(rec.target, 'p1');
    assert.equal(rec.ok, true);
    assert.equal(rec.actor.id, 'admin1');
    assert.deepEqual(rec.before, { roles: ['r-g1'], guildPolicy: { default: ['VIEW_CHANNEL'], channels: { c1: WRITE } } });
    assert.deepEqual(rec.after, { accessFullyRevoked: true });

    // Unknown persona: 404, nothing recorded.
    const n = ctx.deps.audit.read({ guildId: 'G1' }).length;
    assert.equal((await s.call('POST', '/admin/g/G1/personas/nobody/remove')).status, 404);
    assert.equal(ctx.deps.audit.read({ guildId: 'G1' }).length, n);

    // An invariant break (access still resolves) is said, and recorded as not ok.
    ctx.deps.canAccessGuild = () => true;
    const odd = await s.call('POST', '/admin/g/G1/personas/p1/remove');
    assert.deepEqual(odd.body, { rolesRemoved: [], accessFullyRevoked: false });
    assert.equal(ctx.deps.audit.read({ guildId: 'G1' })[0].ok, false);
  } finally {
    await s.close();
  }
});

test('remove from guild is slash /ban: both leave the stores byte for byte the same (file-default persona included)', async () => {
  const { SlashHandler } = await import('../src/slash.js');
  for (const fileDefault of [undefined, ['VIEW_CHANNEL']]) {
    const panel = setupDeps([], {}, fileDefault ? { fileDefault } : {});
    const slash = setupDeps([], {}, fileDefault ? { fileDefault } : {});
    for (const c of [panel, slash]) {
      c.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') }); // no permissions entry
      c.permissions.setRole('r-g2', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 'G2' });
      c.permissions.addPersonaRoles('p1', ['r-g1', 'r-g2']);
      c.permissions.setChannel('p1', 'G1', 'c2', READ);
      c.permissions.setGuildDefault('p1', 'G2', READ);
    }
    const handler = new SlashHandler({
      identity: slash.identity, permissions: slash.permissions, superadmins: [], guildAdmins: {},
      capsFor: slash.deps.capsFor, canAccessGuild: slash.deps.canAccessGuild, resync: () => 0, newInviteCode: () => 'inv_x',
    });
    const s = await signedIn(panel);
    try {
      for (const pid of ['p1', 'p2']) {
        const reply = handler.handle({
          command: 'ban', guildId: 'G1', channelId: 'c1', channelName: 'c1',
          invoker: { id: 'admin1', name: 'Admin', hasManageGuild: true }, options: { persona: pid },
        });
        assert.match(reply, /No remaining access in this guild\.$/);
        assert.equal((await s.call('POST', `/admin/g/G1/personas/${pid}/remove`)).body.accessFullyRevoked, true);
      }
      assert.equal(
        readFileSync(join(panel.dir, 'permissions.json'), 'utf8'),
        readFileSync(join(slash.dir, 'permissions.json'), 'utf8'),
        `fileDefault ${JSON.stringify(fileDefault)}`,
      );
    } finally {
      await s.close();
      slash.cleanup();
    }
  }
});

test('resync: once per 10 s per persona (429 RATE_LIMITED {retryAfterMs}); only a super-admin is told how many channels went out', async () => {
  const ctx = setupDeps([]);
  ctx.identity.upsert({ id: 'p2', displayName: 'Persona Two', avatar: '', token: hashToken('t2') });
  const sent: string[] = [];
  ctx.deps.resync = (pid) => (sent.push(pid), 7);
  let t = 1_000_000;
  const s = await signedIn(ctx, undefined, { clock: () => t });
  try {
    const first = await s.call('POST', '/admin/g/G1/personas/p1/resync');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true }, 'no channel count for a guild admin: it is counted over every guild');
    const again = await s.call('POST', '/admin/g/G1/personas/p1/resync');
    assert.equal(again.status, 429);
    assert.equal(again.body.error.code, 'RATE_LIMITED');
    assert.equal(again.body.error.retryAfterMs, 10_000);
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p2/resync')).status, 200, 'per persona');
    t += 9_999;
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/resync')).body.error.retryAfterMs, 1);
    t += 1;
    assert.equal((await s.call('POST', '/admin/g/G1/personas/p1/resync')).status, 200);
    assert.deepEqual(sent, ['p1', 'p2', 'p1'], 'a refused resync sends nothing');
    const recs = ctx.deps.audit.read({ guildId: 'G1' }).filter((r) => r.action === 'persona.resync');
    assert.equal(recs.length, 3);
    for (const r of recs) {
      assert.equal(r.detail, undefined, 'the count is not in the guild’s audit');
      assert.equal(JSON.stringify(r).includes('pushed'), false);
    }
    assert.equal((await s.call('POST', '/admin/g/G1/personas/nobody/resync')).status, 404);
  } finally {
    await s.close();
  }
  const sup = setupDeps(['admin1']);
  sup.deps.resync = () => 7;
  const s2 = await signedIn(sup, []);
  try {
    assert.deepEqual((await s2.call('POST', '/admin/g/G1/personas/p1/resync')).body, { ok: true, pushed: 7 });
  } finally {
    await s2.close();
  }
});

test('persona rows: a guild-wide deny is flagged, and so are direct grants here that do nothing (as the persona’s access lists them)', async () => {
  const ctx = setupDeps([]);
  ctx.permissions.setChannel('p1', 'G1', 'th-c1', WRITE); // a thread
  ctx.permissions.setChannel('p1', 'G1', 'cat1', READ); // a category
  ctx.permissions.setChannel('p1', 'G1', 'c-gone', WRITE); // not one of G1's now
  ctx.permissions.setChannel('p1', 'G1', 'c2', []); // a block: guild-wide gives View, so it blocks that
  const s = await signedIn(ctx);
  const row = async () => (await s.get('/admin/g/G1/personas')).body.personas.find((p: { id: string }) => p.id === 'p1');
  const listed = async () => (await s.get('/admin/g/G1/personas/p1/access')).body.inactive.length;
  try {
    assert.equal((await row()).inactiveGrants, 3);
    assert.equal((await row()).guildWideDenied, false);
    assert.equal(await listed(), 3);
    await s.call('DELETE', '/admin/g/G1/personas/p1/grants?guildDefault=deny');
    assert.equal((await row()).guildWideDenied, true);
    assert.equal((await row()).inactiveGrants, 4, 'with guild-wide denied, the block has nothing left to block');
    assert.equal(await listed(), 4);
  } finally {
    await s.close();
  }
});

const MINT_GRANT = { caps: ['VIEW_CHANNEL'], scope: { all: true } };
// [the body, the field its refusal names]
const MINT_REFUSED: Array<[Record<string, unknown>, string]> = [
  [{ roles: ['r-g1'], maxUses: -1 }, 'maxUses'],
  [{ roles: ['r-g1'], maxUses: 0 }, 'maxUses'],
  [{ roles: ['r-g1'], subscriptions: [5] }, 'subscriptions'],
  // Roles, a grant, a mode, a count, subscriptions or an expiry given as null, '' or false is not sent (the tests below).
  [{ roles: ['r-g1'], maxUses: '5' }, 'maxUses'],
  [{ roles: ['r-g1'], maxUses: true }, 'maxUses'],
  [{ roles: ['r-g1'], subscriptions: 'c1' }, 'subscriptions'],
  [{ roles: ['r-g1'], mode: 'augmnet' }, 'mode'],
  // Dropped, roles that aren't a list would leave the grant alone, and an expiry that isn't a number of days would
  // never expire.
  [{ roles: 'r-g1', grant: MINT_GRANT }, 'roles'],
  [{ roles: ['r-g1'], expiresInDays: '7' }, 'expiresInDays'],
  [{ roles: ['r-g1'], expiresInDays: 0 }, 'expiresInDays'],
  [{ roles: ['r-g1'], expiresInDays: -1 }, 'expiresInDays'],
  [{ roles: ['r-g1'], expiresInDays: true }, 'expiresInDays'],
  // Past a date's range, where building the date would throw and answer 500.
  [{ roles: ['r-g1'], expiresInDays: 1e12 }, 'expiresInDays'],
];
for (const [body, field] of MINT_REFUSED) {
  test(`invites: a mint of ${JSON.stringify(body)}, which a claim would refuse, is refused by name and stores nothing`, async () => {
    const ctx = setupDeps([]);
    const s = await signedIn(ctx);
    try {
      const before = storeBytes(ctx.dir);
      const r = await s.call('POST', '/admin/g/G1/invites', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'INVALID', JSON.stringify(r.body));
      assert.ok(new RegExp(`\\b${field}\\b`).test(r.body.error.message), `names ${field}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(storeBytes(ctx.dir), before, 'nothing stored, nothing audited');
    } finally {
      await s.close();
    }
  });
}

test('invites: a mint whose maxUses JSON reads as infinite, 1e400, is refused by name and stores nothing', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    const before = storeBytes(ctx.dir);
    // Sent as text, since JSON.stringify would send Infinity as null, which the route leaves out.
    const r = await s.call('POST', '/admin/g/G1/invites', undefined, { raw: Buffer.from('{"roles":["r-g1"],"maxUses":1e400}'), type: 'application/json' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'INVALID', JSON.stringify(r.body));
    assert.match(r.body.error.message, /invite maxUses must be a finite number above 0/, JSON.stringify(r.body));
    assert.deepEqual(storeBytes(ctx.dir), before, 'nothing stored, nothing audited');
  } finally {
    await s.close();
  }
});

test('invites: a mint with a fractional count is stored, as it reads', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    const r = await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1'], maxUses: 2.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ctx.invites.get(r.body.code)?.maxUses, 2.5, JSON.stringify(ctx.invites.get(r.body.code)));
  } finally {
    await s.close();
  }
});

test('invites: a mint with expiresInDays expires that many days on, and one with it null, empty or false never expires', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    const week = await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1'], expiresInDays: 7 });
    assert.equal(week.status, 200, JSON.stringify(week.body));
    const at = Date.parse(ctx.invites.get(week.body.code)?.expiresAt ?? '');
    assert.ok(Math.abs(at - (Date.now() + 7 * 86_400_000)) < 60_000, `expires at ${new Date(at).toISOString()}`);
    for (const expiresInDays of [null, '', false]) {
      const r = await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1'], expiresInDays });
      assert.equal(r.status, 200, `${JSON.stringify(expiresInDays)}: ${JSON.stringify(r.body)}`);
      assert.equal(ctx.invites.get(r.body.code)?.expiresAt, undefined, JSON.stringify(expiresInDays));
    }
  } finally {
    await s.close();
  }
});

/** Hand-edits permissions.json and reloads it, as an operator's edit and a restart would. */
function editPermissions(ctx: ReturnType<typeof setupDeps>, edit: (file: any) => void): void {
  const path = (ctx.permissions as any).path as string;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  edit(file);
  writeFileSync(path, JSON.stringify(file));
  (ctx.permissions as any).reload();
}

test('role catalog: a name set aside at load is in use: refused unless replaced in its own guild, with the entry as the audit\'s before', async () => {
  const ctx = setupDeps(['admin1']);
  const twoKeys = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G1' };
  editPermissions(ctx, (f) => {
    f.roles['two-keys'] = twoKeys;
    f.roles['no-guild'] = { caps: ['VIEW_CHANNEL'], scope: { all: true } };
    f.roles['empty-guild'] = { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: '' };
  });
  const s = await signedIn(ctx, []);
  const post = (body: unknown) => s.call('POST', '/admin/roles', body);
  try {
    assert.equal(ctx.permissions.isQuarantined('two-keys'), true);
    const taken = await post({ name: 'two-keys', role: { caps: WRITE, scope: { all: true }, guildId: 'G2' } });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.equal(taken.body.error.code, 'EXISTS');
    assert.deepEqual(taken.body.error.existing, { guildId: 'G1', setAside: true });
    const otherGuild = await post({ name: 'two-keys', role: { caps: WRITE, scope: { all: true }, guildId: 'G2' }, replace: true, expectedGuildId: 'G2' });
    assert.equal(otherGuild.body.error?.code, 'GUILD_MISMATCH', JSON.stringify(otherGuild.body));
    assert.equal(ctx.permissions.isQuarantined('two-keys'), true, 'still set aside');
    const repaired = await post({ name: 'two-keys', role: { caps: WRITE, scope: { all: true }, guildId: 'G1' }, replace: true, expectedGuildId: 'G1' });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(ctx.permissions.isQuarantined('two-keys'), false);
    const rec = ctx.deps.audit.read({ limit: 1 })[0];
    assert.equal(rec.action, 'role.set');
    assert.deepEqual(rec.before, twoKeys);
    // An entry that names no guild has none to keep, so replace is enough.
    const noGuild = await post({ name: 'no-guild', role: { caps: READ, scope: { all: true }, guildId: 'G1' }, replace: true });
    assert.equal(noGuild.status, 200, JSON.stringify(noGuild.body));
    // Nor does one whose guild is '', which names none.
    assert.equal(ctx.permissions.isQuarantined('empty-guild'), true);
    const emptyGuild = await post({ name: 'empty-guild', role: { caps: READ, scope: { all: true }, guildId: 'G1' }, replace: true });
    assert.equal(emptyGuild.status, 200, JSON.stringify(emptyGuild.body));
  } finally {
    await s.close();
  }
});

test('a role set aside at load can be revoked from a persona by an admin of the guild its entry names, and is assigned by nobody', async () => {
  const ctx = setupDeps([]);
  editPermissions(ctx, (f) => {
    f.roles['aside-g1'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G1' };
    f.roles['aside-g2'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G2' };
    f.personas.p1.roles = ['aside-g1', 'aside-g2'];
  });
  const s = await signedIn(ctx);
  try {
    const assign = await s.call('POST', '/admin/g/G1/personas/p1/roles', { role: 'aside-g1' });
    assert.equal(assign.status, 403, JSON.stringify(assign.body));
    assert.match(assign.body.error.message, /role aside-g1 can't be read .*the relay's operator must fix it first/);
    const foreign = await s.call('DELETE', '/admin/g/G1/personas/p1/roles/aside-g2');
    assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
    const own = await s.call('DELETE', '/admin/g/G1/personas/p1/roles/aside-g1');
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual(ctx.permissions.getRoleNames('p1'), ['aside-g2']);
  } finally {
    await s.close();
  }
});

test('remove from guild takes off a role set aside at load naming that guild, and says and records it', async () => {
  const ctx = setupDeps([]);
  editPermissions(ctx, (f) => {
    f.roles['aside-g1'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G1' };
    f.roles['aside-g2'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G2' };
    f.personas.p1.roles = ['aside-g1', 'aside-g2'];
  });
  const s = await signedIn(ctx);
  try {
    const r = await s.call('POST', '/admin/g/G1/personas/p1/remove');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rolesRemoved, ['aside-g1']);
    assert.deepEqual(ctx.permissions.getRoleNames('p1'), ['aside-g2'], 'the other guild\'s set-aside role stays');
    const rec = ctx.deps.audit.read({ guildId: 'G1' }).find((x) => x.action === 'persona.guild.remove')!;
    assert.deepEqual(rec.before.roles, ['aside-g1']);
  } finally {
    await s.close();
  }
});

for (const asSuper of [false, true]) {
  test(`a role set aside at load naming another guild, or none it can read, is revoked by ${asSuper ? 'a super-admin' : 'no guild admin'}`, async () => {
    const ctx = setupDeps(asSuper ? ['admin1'] : []);
    editPermissions(ctx, (f) => {
      f.roles['aside-g2'] = { caps: ['VIEW_CHANNEL'], scope: { all: true, channels: ['c1'] }, guildId: 'G2' };
      f.roles['aside-noguild'] = { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: 5 };
      f.personas.p1.roles = ['aside-g2', 'aside-noguild'];
    });
    const s = await signedIn(ctx);
    try {
      for (const role of ['aside-g2', 'aside-noguild']) {
        const r = await s.call('DELETE', `/admin/g/G1/personas/p1/roles/${role}`);
        assert.equal(r.status, asSuper ? 200 : 403, `${role}: ${JSON.stringify(r.body)}`);
      }
      assert.deepEqual(ctx.permissions.getRoleNames('p1'), asSuper ? [] : ['aside-g2', 'aside-noguild']);
    } finally {
      await s.close();
    }
  });
}

test('invites: a mint whose roles are null, empty, false or 0 beside a grant mints the grant alone, as if roles were left out', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    const grant = { caps: ['VIEW_CHANNEL'], scope: { channels: ['c1'] } };
    for (const roles of [null, '', false, 0]) {
      const r = await s.call('POST', '/admin/g/G1/invites', { roles, grant });
      assert.equal(r.status, 200, `${JSON.stringify(roles)}: ${JSON.stringify(r.body)}`);
      const inv = ctx.invites.get(r.body.code) as Record<string, unknown> | undefined;
      assert.equal(inv?.roles, undefined, `${JSON.stringify(roles)} stored as ${JSON.stringify(inv)}`);
      assert.deepEqual(inv?.grant, grant, `${JSON.stringify(roles)} stored as ${JSON.stringify(inv)}`);
    }
  } finally {
    await s.close();
  }
});

test('invites: a mint with no roles and a grant of null, empty or false is refused as needing roles or a grant', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    for (const grant of [null, '', false]) {
      const before = storeBytes(ctx.dir);
      const r = await s.call('POST', '/admin/g/G1/invites', { grant });
      assert.equal(r.status, 400, `${JSON.stringify(grant)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.message, 'invite needs roles or a grant', `${JSON.stringify(grant)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(storeBytes(ctx.dir), before, `${JSON.stringify(grant)}: nothing stored`);
    }
  } finally {
    await s.close();
  }
});

test('invites: a mint whose mode or subscriptions are 0 stores them as sent', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    for (const extra of [{ mode: 0 }, { subscriptions: 0 }]) {
      const r = await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1'], ...extra });
      assert.equal(r.status, 200, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`);
      const inv = ctx.invites.get(r.body.code) as Record<string, unknown> | undefined;
      const key = Object.keys(extra)[0]!;
      assert.equal(inv?.[key], 0, `${JSON.stringify(extra)} stored as ${JSON.stringify(inv)}`);
    }
  } finally {
    await s.close();
  }
});

test('invites: a mint whose mode, count or subscriptions are null, empty or false mints as if they were left out', async () => {
  const ctx = setupDeps([]);
  const s = await signedIn(ctx);
  try {
    for (const extra of [
      { maxUses: null }, { maxUses: '' }, { maxUses: false }, { mode: null }, { mode: '' }, { mode: false },
      { subscriptions: null }, { subscriptions: '' }, { subscriptions: false },
    ]) {
      const r = await s.call('POST', '/admin/g/G1/invites', { roles: ['r-g1'], ...extra });
      assert.equal(r.status, 200, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`);
      const inv = ctx.invites.get(r.body.code) as Record<string, unknown> | undefined;
      const key = Object.keys(extra)[0]!;
      assert.equal(inv?.[key], undefined, `${JSON.stringify(extra)} stored as ${JSON.stringify(inv)}`);
    }
  } finally {
    await s.close();
  }
});

for (const asSuper of [false, true]) {
  test(`invites: a hand-edited invite whose roles aren't a list, as ${asSuper ? 'a super-admin' : 'a guild admin'}, is ${asSuper ? 'refused by name at a claim' : 'hidden'}, and the guild's invite list still answers`, async () => {
    const ctx = setupDeps(asSuper ? ['admin1'] : []);
    // A number: read as roles, it threw in the guild admin's list and in the claim's ban check.
    ctx.invites.mint({ code: 'roles-text', guildId: 'G1', roles: 5, mode: 'both', uses: 0 } as any);
    ctx.invites.mint({ code: 'plain', guildId: 'G1', roles: ['r-g1'], mode: 'both', uses: 0 } as any);
    const s = await signedIn(ctx);
    try {
      const list = await s.get('/admin/g/G1/invites');
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const codes = (list.body.invites as Array<{ code: string }>).map((i) => i.code);
      assert.ok(codes.includes('plain') && codes.includes('roles-text') === asSuper, JSON.stringify(codes));
      const before = storeBytes(ctx.dir);
      const claim = await s.call('POST', '/admin/g/G1/personas/p1/claim', { code: 'roles-text' });
      if (asSuper) {
        assert.equal(claim.status, 400, JSON.stringify(claim.body));
        assert.equal(claim.body.error.message, 'invite roles must be a list of access role names — whoever minted it must mint a new one', JSON.stringify(claim.body));
      } else {
        assert.equal(claim.status, 404, JSON.stringify(claim.body));
      }
      assert.deepEqual(storeBytes(ctx.dir), before, 'nothing changed');
    } finally {
      await s.close();
    }
  });
}
