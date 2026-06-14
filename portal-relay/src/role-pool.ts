/**
 * Per-guild pool of mentionable roles used as @-addressing tokens for personas.
 *
 * Roles ping nobody (no member holds them), but they autocomplete by name and
 * give a clean routing signal: a role mention resolves back to the bound
 * persona. Bindings are sticky-LRU — a persona keeps its role while active;
 * when the pool is exhausted the least-recently-used binding is reclaimed and
 * the role renamed for its new owner (rename, never delete — avoids audit-log
 * churn and role rate limits).
 *
 * Routing resolves against the binding that was live at message-receive time,
 * so the only failure mode is a stale autocomplete entry, which is rare because
 * autocomplete shows the current owner.
 */

/** The Discord-side role operations the pool needs. Implemented by DiscordBot. */
export interface RoleOps {
  /** Create a new mentionable role in the guild; resolve its id. */
  createRole(guildId: string, name: string): Promise<string>;
  /** Rename an existing role (used on rebind). */
  renameRole(guildId: string, roleId: string, name: string): Promise<void>;
  /** Roles already present in the guild that match our pool prefix, oldest
   *  first — adopted on boot so restarts reuse roles instead of leaking. */
  discoverPooledRoles(guildId: string, prefix: string): Promise<Array<{ id: string; name: string }>>;
}

interface GuildPool {
  /** roleId → personaId (null = free/available). */
  bindings: Map<string, string | null>;
  /** personaId → roleId. */
  byPersona: Map<string, string>;
  /** personaIds in LRU order, most-recently-used last. */
  lru: string[];
  discovered: boolean;
}

export class RolePool {
  private guilds = new Map<string, GuildPool>();

  constructor(
    private ops: RoleOps,
    private size: number,
    private prefix: string,
  ) {}

  private roleName(displayName: string): string {
    // Discord role names: <=100 chars. Prefix marks ours for discovery.
    return `${this.prefix}${displayName}`.slice(0, 100);
  }

  private async ensureDiscovered(guildId: string): Promise<GuildPool> {
    let pool = this.guilds.get(guildId);
    if (pool?.discovered) return pool;
    pool ??= { bindings: new Map(), byPersona: new Map(), lru: [], discovered: false };
    this.guilds.set(guildId, pool);
    const existing = await this.ops.discoverPooledRoles(guildId, this.prefix);
    for (const r of existing) {
      if (!pool.bindings.has(r.id)) pool.bindings.set(r.id, null);
    }
    pool.discovered = true;
    return pool;
  }

  /** Ensure `personaId` has a bound, mentionable role in `guildId`; return it. */
  async bind(guildId: string, personaId: string, displayName: string): Promise<string> {
    const pool = await this.ensureDiscovered(guildId);

    const existing = pool.byPersona.get(personaId);
    if (existing) {
      this.touch(pool, personaId);
      return existing;
    }

    // 1) reuse a free role
    for (const [roleId, owner] of pool.bindings) {
      if (owner === null) {
        await this.ops.renameRole(guildId, roleId, this.roleName(displayName));
        this.assign(pool, roleId, personaId);
        return roleId;
      }
    }

    // 2) create a new role if under cap
    if (pool.bindings.size < this.size) {
      const roleId = await this.ops.createRole(guildId, this.roleName(displayName));
      pool.bindings.set(roleId, null);
      this.assign(pool, roleId, personaId);
      return roleId;
    }

    // 3) evict the LRU binding and repurpose its role
    const victim = pool.lru[0];
    const victimRole = victim ? pool.byPersona.get(victim) : undefined;
    if (!victim || !victimRole) {
      throw new Error(`Role pool exhausted in guild ${guildId} and no victim found`);
    }
    pool.byPersona.delete(victim);
    pool.lru.shift();
    pool.bindings.set(victimRole, null);
    await this.ops.renameRole(guildId, victimRole, this.roleName(displayName));
    this.assign(pool, victimRole, personaId);
    return victimRole;
  }

  /** Rename a persona's bound roles in every guild (live displayName change). */
  async rename(personaId: string, displayName: string): Promise<void> {
    for (const [guildId, pool] of this.guilds) {
      const roleId = pool.byPersona.get(personaId);
      if (roleId) await this.ops.renameRole(guildId, roleId, this.roleName(displayName));
    }
  }

  /** Current persona bound to a role (for inbound mention → routing). */
  resolveRole(guildId: string, roleId: string): string | undefined {
    return this.guilds.get(guildId)?.bindings.get(roleId) ?? undefined;
  }

  getRoleFor(guildId: string, personaId: string): string | undefined {
    return this.guilds.get(guildId)?.byPersona.get(personaId);
  }

  /** All guild→role bindings for a persona (for the Persona view). */
  roleByGuildFor(personaId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [guildId, pool] of this.guilds) {
      const r = pool.byPersona.get(personaId);
      if (r) out[guildId] = r;
    }
    return out;
  }

  private assign(pool: GuildPool, roleId: string, personaId: string): void {
    pool.bindings.set(roleId, personaId);
    pool.byPersona.set(personaId, roleId);
    this.touch(pool, personaId);
  }

  private touch(pool: GuildPool, personaId: string): void {
    const i = pool.lru.indexOf(personaId);
    if (i >= 0) pool.lru.splice(i, 1);
    pool.lru.push(personaId);
  }
}
