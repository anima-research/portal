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
  calls = { create: 0, rename: 0 };
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

  async discoverPooledRoles(_guildId: string, prefix: string): Promise<Array<{ id: string; name: string }>> {
    await this.delay();
    return [...this.roles].filter(([, n]) => n.startsWith(prefix)).map(([id, name]) => ({ id, name }));
  }
}

test('fresh bind reuses a free role and renames it', async () => {
  const ops = new FakeRoleOps();
  ops.seed('portal-old');
  const pool = new RolePool(ops, 50, PREFIX);

  const roleId = await pool.bind(GUILD, 'p-grok', 'grok43');

  assert.equal(ops.roles.get(roleId), 'portal-grok43');
  assert.equal(ops.calls.rename, 1);
  assert.equal(ops.calls.create, 0);
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

test('concurrent reconnects get distinct roles — no double-pick, no spurious create', async () => {
  const ops = new FakeRoleOps(5); // latency so binds interleave across awaits
  ops.seed('portal-a');
  ops.seed('portal-b');
  ops.seed('portal-c');
  const pool = new RolePool(ops, 50, PREFIX);

  const [r1, r2, r3] = await Promise.all([
    pool.bind(GUILD, 'p1', 'x'),
    pool.bind(GUILD, 'p2', 'y'),
    pool.bind(GUILD, 'p3', 'z'),
  ]);

  assert.equal(new Set([r1, r2, r3]).size, 3, 'each persona got a distinct role');
  assert.equal(ops.calls.create, 0, 'reused the 3 free roles, created none');
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
