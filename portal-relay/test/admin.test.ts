import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminConfig } from '../src/config.js';
import { IdentityStore, generateToken, hashToken } from '../src/identity.js';
import { PermissionsStore } from '../src/permissions.js';
import { InviteStore } from '../src/invites.js';
import { AdminServer, type AdminDeps } from '../src/admin/server.js';
import { deriveAdminGuilds } from '../src/admin/oauth.js';
import { SessionStore } from '../src/admin/sessions.js';
import { AuditLog } from '../src/admin/audit.js';
import { canManageGuild, canAuthorRoles } from '../src/admin/authz.js';

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
  const guildAdmin = { ...base, adminGuilds: new Set(['G1']), isSuper: false };
  const superAdmin = { ...base, adminGuilds: new Set<string>(), isSuper: true };
  assert.equal(canManageGuild(guildAdmin, 'G1'), true);
  assert.equal(canManageGuild(guildAdmin, 'G2'), false);
  assert.equal(canManageGuild(superAdmin, 'anything'), true);
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
  assert.equal(store.consumeState(state), true);
  assert.equal(store.consumeState(state), false, 'state is single-use');
  assert.equal(store.consumeState('never-issued'), false);
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

function setupDeps(superadmins: string[]): {
  deps: AdminDeps;
  identity: IdentityStore;
  permissions: PermissionsStore;
  invites: InviteStore;
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
    sessionTtlMs: 60_000,
    auditPath: join(dir, 'audit.jsonl'),
    cookieSecure: false,
  };
  const identity = new IdentityStore(idPath, '');
  const permissions = new PermissionsStore(permPath);
  const invites = new InviteStore(invPath);
  const channels: Record<string, string[]> = { G1: ['c1', 'c2'] };
  let codeN = 0;
  const deps: AdminDeps = {
    config,
    identity,
    permissions,
    invites,
    audit: new AuditLog(config.auditPath),
    listGuilds: () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }],
    listRoles: () => [{ id: 'role1', guildId: 'G1', name: 'Mods', pooled: false }],
    listChannels: (gid) => (channels[gid] ?? []).map((id) => ({ id, name: id, type: 'text' })),
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
  };
  return { deps, identity, permissions, invites, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

async function login(base: string, guilds: unknown[]): Promise<string> {
  // 1. /login → state cookie + redirect carrying the same state.
  const loginRes = await fetch(`${base}/admin/login`, { redirect: 'manual' });
  assert.equal(loginRes.status, 302);
  const stateCookie = parseSetCookie(loginRes, 'portal_admin_state');
  assert.ok(stateCookie, 'state cookie set');
  const loc = new URL(loginRes.headers.get('location')!);
  assert.equal(loc.searchParams.get('state'), stateCookie);

  // 2. /callback with matching state → session cookie.
  const cbRes = await fetch(
    `${base}/admin/callback?code=abc&state=${stateCookie}`,
    { redirect: 'manual', headers: { cookie: `portal_admin_state=${stateCookie}` } },
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
    assert.deepEqual(inv.invites.map((i: { code: string }) => i.code), ['in-g1', 'aug-g1']);

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
      body: JSON.stringify({ name: 'newrole', role: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }),
    });
    assert.equal(res.status, 200);
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

test('integration: tampered oauth state is rejected', async () => {
  const { deps, cleanup } = setupDeps([]);
  const server = new AdminServer(deps, fakeDiscordFetch([]));
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    // Cookie and query state disagree → 400, no session minted.
    const res = await fetch(
      `${base}/admin/callback?code=abc&state=forged`,
      { redirect: 'manual', headers: { cookie: 'portal_admin_state=real' } },
    );
    assert.equal(res.status, 400);
    assert.equal(parseSetCookie(res, 'portal_admin_session'), undefined);
  } finally {
    await server.close();
    cleanup();
  }
});
