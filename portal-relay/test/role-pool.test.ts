import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RolePool, type RoleOps } from '../src/role-pool.js';

const GUILD = 'g1';
const PREFIX = 'portal-';

/** In-memory Discord role state + call counters. `latencyMs` inserts an await so
 *  concurrent binds actually interleave (exposes races when serialization is off). */
class FakeRoleOps implements RoleOps {
  private seq = 0;
  roles = new Map<string, string>(); // roleId → name
  calls = { create: 0, rename: 0, delete: 0 };
  constructor(private latencyMs = 0) {}

  private async delay(): Promise<void> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  /** Seed a pre-existing role (simulates roles already in the guild before boot). */
  seed(name: string): string {
    const id = `role_${++this.seq}`;
    this.roles.set(id, name);
    return id;
  }

  async createRole(_guildId: string, name: string): Promise<string> {
    await this.delay();
    const id = `role_${++this.seq}`;
    this.roles.set(id, name);
    this.calls.create++;
    return id;
  }

  async renameRole(_guildId: string, roleId: string, name: string): Promise<void> {
    await this.delay();
    this.roles.set(roleId, name);
    this.calls.rename++;
  }

  async deleteRole(_guildId: string, roleId: string): Promise<void> {
    await this.delay();
    this.roles.delete(roleId);
    this.calls.delete++;
  }

  async discoverPooledRoles(_guildId: string, prefix: string): Promise<Array<{ id: string; name: string }>> {
    await this.delay();
    return [...this.roles].filter(([, n]) => n.startsWith(prefix)).map(([id, name]) => ({ id, name }));
  }
}

test('fresh bind never hijacks an unrelated free role — creates its own', async () => {
  const ops = new FakeRoleOps();
  const orphan = ops.seed('portal-old'); // a free role named for a DIFFERENT persona
  const pool = new RolePool(ops, 50, PREFIX);

  const roleId = await pool.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(ops.roles.get(roleId), 'portal-grok43');
  assert.notEqual(roleId, orphan, 'did not reuse the unrelated free role');
  assert.equal(ops.calls.rename, 0, 'no rename — an unrelated role is never reattributed');
  assert.equal(ops.calls.create, 1, 'created its own dedicated role');
  assert.equal(ops.roles.get(orphan), 'portal-old', 'the unrelated role is left intact');
});

test('a free role ALREADY named for this persona is re-adopted (no create, no rename)', async () => {
  const ops = new FakeRoleOps();
  const own = ops.seed('portal-grok43'); // e.g. legacy role or a prior boot's role
  const pool = new RolePool(ops, 50, PREFIX);

  const roleId = await pool.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(roleId, own, 're-adopted its own existing role');
  assert.equal(ops.calls.create, 0);
  assert.equal(ops.calls.rename, 0);
});

test('bind creates a role when none are free', async () => {
  const ops = new FakeRoleOps();
  const pool = new RolePool(ops, 50, PREFIX);

  const roleId = await pool.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(ops.roles.get(roleId), 'portal-grok43');
  assert.equal(ops.calls.create, 1);
  assert.equal(ops.calls.rename, 0);
});

test('same persona re-binding is idempotent (cached)', async () => {
  const ops = new FakeRoleOps();
  const pool = new RolePool(ops, 50, PREFIX);
  const first = await pool.bind(GUILD, 'p-grok', 'grok43');
  const second = await pool.bind(GUILD, 'p-grok', 'grok43');
  assert.equal(first, second);
  assert.equal(ops.calls.create, 1);
  assert.equal(ops.calls.rename, 0);
});

test('across a restart, a persona re-adopts its own role — no rename, no duplicate', async () => {
  const ops = new FakeRoleOps();

  // Boot 1: grok43 binds → a portal-grok43 role now exists in the guild.
  const pool1 = new RolePool(ops, 50, PREFIX);
  const role1 = await pool1.bind(GUILD, 'p-grok', 'grok43');
  const createsAfterBoot1 = ops.calls.create;
  const renamesAfterBoot1 = ops.calls.rename;

  // Boot 2: fresh pool (in-memory state lost), same guild roles discovered.
  const pool2 = new RolePool(ops, 50, PREFIX);
  const role2 = await pool2.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(role2, role1, 'reclaims the same physical role');
  assert.equal(ops.calls.create, createsAfterBoot1, 'no new role created on restart');
  assert.equal(ops.calls.rename, renamesAfterBoot1, 'no rename on restart (already named)');
  // Exactly one portal-grok43 role exists — no duplicate accumulated.
  assert.equal([...ops.roles.values()].filter((n) => n === 'portal-grok43').length, 1);
});

test('at cap, eviction DELETES the LRU role — never renames it onto the new owner', async () => {
  const ops = new FakeRoleOps();
  const pool = new RolePool(ops, 2, PREFIX); // cap of 2 forces eviction on the 3rd

  const rA = await pool.bind(GUILD, 'pA', 'A');
  await pool.bind(GUILD, 'pB', 'B');
  const rC = await pool.bind(GUILD, 'pC', 'C'); // at cap → evict LRU (pA)

  assert.equal(ops.calls.rename, 0, 'no rename — a stale mention is never reattributed to a new persona');
  assert.equal(ops.calls.delete, 1, 'the evicted role was physically deleted');
  assert.equal(ops.roles.has(rA), false, "pA's role is gone → its old mentions render as a dead role");
  assert.equal(pool.getRoleFor(GUILD, 'pA'), undefined, 'pA is no longer bound');
  assert.notEqual(rC, rA, 'pC got a fresh role, not pA’s renamed');
  assert.equal(ops.roles.get(rC), 'portal-C');
});

test('an orphan free role is deleted (not renamed) to make room before evicting a live persona', async () => {
  const ops = new FakeRoleOps();
  ops.seed('portal-orphan'); // 1 unowned role occupies the single slot
  const pool = new RolePool(ops, 1, PREFIX); // cap of 1

  const r = await pool.bind(GUILD, 'p1', 'one');

  assert.equal(ops.calls.rename, 0, 'orphan reclaimed by delete, never renamed');
  assert.equal(ops.calls.delete, 1, 'the orphan role was deleted to free the slot');
  assert.equal(ops.roles.get(r), 'portal-one');
});

test('concurrent reconnects get distinct dedicated roles — no double-pick', async () => {
  const ops = new FakeRoleOps(5); // latency so binds interleave across awaits
  ops.seed('portal-a'); // unrelated free roles — must NOT be hijacked
  ops.seed('portal-b');
  ops.seed('portal-c');
  const pool = new RolePool(ops, 50, PREFIX);

  const [r1, r2, r3] = await Promise.all([
    pool.bind(GUILD, 'p1', 'x'),
    pool.bind(GUILD, 'p2', 'y'),
    pool.bind(GUILD, 'p3', 'z'),
  ]);

  assert.equal(new Set([r1, r2, r3]).size, 3, 'each persona got a distinct role');
  assert.equal(ops.calls.create, 3, 'each got its own dedicated role — unrelated frees left alone');
  assert.equal(ops.calls.rename, 0, 'no renames — no mention reattribution');
  // Each persona resolves to its own role and vice-versa.
  assert.equal(pool.getRoleFor(GUILD, 'p1'), r1);
  assert.equal(pool.resolveRole(GUILD, r1), 'p1');
  assert.equal(pool.resolveRole(GUILD, r2), 'p2');
  assert.equal(pool.resolveRole(GUILD, r3), 'p3');
});

test('concurrent restart reclaim: matching names, zero renames/creates', async () => {
  const ops = new FakeRoleOps(5);
  ops.seed('portal-x');
  ops.seed('portal-y');
  ops.seed('portal-z');
  const pool = new RolePool(ops, 50, PREFIX);

  const roles = await Promise.all([
    pool.bind(GUILD, 'p1', 'x'),
    pool.bind(GUILD, 'p2', 'y'),
    pool.bind(GUILD, 'p3', 'z'),
  ]);

  assert.equal(new Set(roles).size, 3);
  assert.equal(ops.calls.rename, 0, 'each reclaimed its own name — no renames');
  assert.equal(ops.calls.create, 0);
  assert.equal(ops.roles.get(roles[0]), 'portal-x');
});

// ── Persistence (PORTAL_ROLE_POOL_STATE) ──

import { mkdtempSync, writeFileSync as fsWrite, readFileSync as fsRead } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), 'role-pool-test-')), 'state.json');
}

test('persistence: restart re-adopts the exact role id even when the display name changed while down', async () => {
  const ops = new FakeRoleOps();
  const state = tmpState();

  const pool1 = new RolePool(ops, 50, PREFIX, state);
  const role1 = await pool1.bind(GUILD, 'p-grok', 'grok43');

  // Relay restarts; persona reconnects under a NEW displayName. Name-based
  // re-adoption cannot solve this — only persisted ownership can.
  const pool2 = new RolePool(ops, 50, PREFIX, state);
  const role2 = await pool2.bind(GUILD, 'p-grok', 'grok44');

  assert.equal(role2, role1, 'same physical role re-adopted by persisted id, not by name');
  assert.equal(ops.calls.create, 1, 'no second role created');
  assert.equal(ops.roles.get(role1), 'portal-grok44', 'name drift healed on its OWN role');
  assert.equal(ops.calls.rename, 1, 'exactly the drift-healing rename');
});

test('persistence: a persisted role deleted out-of-band is dropped and a fresh one created', async () => {
  const ops = new FakeRoleOps();
  const state = tmpState();

  const pool1 = new RolePool(ops, 50, PREFIX, state);
  const role1 = await pool1.bind(GUILD, 'p-grok', 'grok43');

  ops.roles.delete(role1); // someone deleted the role in the Discord UI

  const pool2 = new RolePool(ops, 50, PREFIX, state);
  const role2 = await pool2.bind(GUILD, 'p-grok', 'grok43');

  assert.notEqual(role2, role1, 'stale persisted binding was not resurrected');
  assert.equal(ops.roles.get(role2), 'portal-grok43');
  assert.equal(pool2.resolveRole(GUILD, role2), 'p-grok');
});

test('persistence: a corrupt state file is ignored, not fatal', async () => {
  const ops = new FakeRoleOps();
  const state = tmpState();
  fsWrite(state, '{ this is not json');

  const pool = new RolePool(ops, 50, PREFIX, state);
  const role = await pool.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(ops.roles.get(role), 'portal-grok43', 'pool still functions');
  // And the file heals: the new binding round-trips.
  const saved = JSON.parse(fsRead(state, 'utf8')) as Record<string, Record<string, string>>;
  assert.equal(saved[GUILD]['p-grok'], role);
});

test('unbind deletes Discord-side first, then memory and disk', async () => {
  const ops = new FakeRoleOps();
  const state = tmpState();
  const pool = new RolePool(ops, 50, PREFIX, state);
  const role = await pool.bind(GUILD, 'p-grok', 'grok43');

  await pool.unbind(GUILD, 'p-grok');

  assert.equal(ops.calls.delete, 1);
  assert.equal(ops.roles.has(role), false, 'Discord role gone');
  assert.equal(pool.getRoleFor(GUILD, 'p-grok'), undefined, 'memory unbound');
  const saved = JSON.parse(fsRead(state, 'utf8')) as Record<string, Record<string, string>>;
  assert.equal(saved[GUILD]?.['p-grok'], undefined, 'disk unbound');
});
