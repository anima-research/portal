/**
 * Per-guild pool of mentionable roles used as @-addressing tokens for personas.
 *
 * Each persona gets its OWN dedicated role, created on demand and reused for
 * that persona forever. Bindings are persisted (`persistPath`) so a restart
 * re-adopts each persona's exact role instead of reshuffling the pool — the
 * historical source of mention-corruption (a restart used to free every role,
 * then reassign them to whoever reconnected first).
 *
 * Roles ping nobody (no member holds them); they exist only to autocomplete by
 * name and to give a stable routing signal — a role mention resolves back to
 * the bound persona.
 *
 * At the guild role cap (`size`) the pool frees a slot by DELETING a role —
 * an unowned/orphan role first, else the least-recently-used persona's role.
 * It never renames a role onto a new owner: deletion fails safe (a stale
 * historical mention renders as a dead "@deleted-role") whereas renaming fails
 * wrong (the mention silently retargets to a different, real persona).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

/** The Discord-side role operations the pool needs. Implemented by DiscordBot. */
export interface RoleOps {
  /** Create a new mentionable role in the guild; resolve its id. */
  createRole(guildId: string, name: string): Promise<string>;
  /** Rename an existing role (used only when a persona's own displayName changes). */
  renameRole(guildId: string, roleId: string, name: string): Promise<void>;
  /** Delete a role (eviction / unbind). Must resolve even if already gone. */
  deleteRole(guildId: string, roleId: string): Promise<void>;
  /** Roles already present in the guild that match our pool prefix, oldest
   *  first — adopted on boot so restarts reuse roles instead of leaking. */
  discoverPooledRoles(guildId: string, prefix: string): Promise<Array<{ id: string; name: string }>>;
}

interface GuildPool {
  /** roleId → personaId (null = free/available). */
  bindings: Map<string, string | null>;
  /** roleId → current Discord role name (kept in sync on discover/create/rename). */
  names: Map<string, string>;
  /** personaId → roleId. */
  byPersona: Map<string, string>;
  /** personaIds in LRU order, most-recently-used last. */
  lru: string[];
  discovered: boolean;
}

export class RolePool {
  private guilds = new Map<string, GuildPool>();
  /** Per-guild serialization tail. bind()/unbind() mutate a guild's pool across
   *  awaits; without this, simultaneous reconnects interleave and double-pick a
   *  role or spuriously create/duplicate one. */
  private guildLocks = new Map<string, Promise<unknown>>();

  /** Run `fn` after any in-flight op for `guildId`, serialized. */
  private withGuildLock<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.guildLocks.get(guildId) ?? Promise.resolve();
    const result = prev.then(fn);
    // Store an error-swallowing tail so one failed op doesn't poison the chain.
    this.guildLocks.set(guildId, result.then(() => {}, () => {}));
    return result;
  }

  constructor(
    private ops: RoleOps,
    private size: number,
    private prefix: string,
    private persistPath?: string,
  ) {}

  private roleName(displayName: string): string {
    // Discord role names: <=100 chars. Prefix marks ours for discovery.
    return `${this.prefix}${displayName}`.slice(0, 100);
  }

  // ── Persistence (persona→role ownership, survives restart) ──

  private loadPersisted(): Record<string, Record<string, string>> {
    if (!this.persistPath || !existsSync(this.persistPath)) return {};
    try {
      return JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, Record<string, string>>;
    } catch (e) {
      console.error('[portal-relay] role-pool state unreadable, ignoring:', (e as Error).message);
      return {};
    }
  }

  /** Persist every guild's persona→role map atomically. Cheap: called on each
   *  bind/unbind, and the file is small (one line per active persona). */
  private persist(): void {
    if (!this.persistPath) return;
    const out: Record<string, Record<string, string>> = {};
    for (const [guildId, pool] of this.guilds) {
      const m: Record<string, string> = {};
      for (const [personaId, roleId] of pool.byPersona) m[personaId] = roleId;
      if (Object.keys(m).length) out[guildId] = m;
    }
    try {
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(out, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[portal-relay] role-pool state persist failed:', (e as Error).message);
    }
  }

  private async ensureDiscovered(guildId: string): Promise<GuildPool> {
    let pool = this.guilds.get(guildId);
    if (pool?.discovered) return pool;
    pool ??= { bindings: new Map(), names: new Map(), byPersona: new Map(), lru: [], discovered: false };
    this.guilds.set(guildId, pool);
    const existing = await this.ops.discoverPooledRoles(guildId, this.prefix);
    const liveNames = new Map<string, string>();
    for (const r of existing) {
      if (!pool.bindings.has(r.id)) pool.bindings.set(r.id, null);
      pool.names.set(r.id, r.name);
      liveNames.set(r.id, r.name);
    }
    // Restore persisted ownership for roles that still exist on Discord. This is
    // what stops the restart reshuffle: a persona re-adopts its exact role id.
    const saved = this.loadPersisted()[guildId] ?? {};
    for (const [personaId, roleId] of Object.entries(saved)) {
      if (!liveNames.has(roleId)) continue; // role deleted out-of-band → drop
      if (pool.bindings.get(roleId)) continue; // already owned (shouldn't happen)
      pool.bindings.set(roleId, personaId);
      pool.byPersona.set(personaId, roleId);
      pool.lru.push(personaId);
    }
    pool.discovered = true;
    return pool;
  }

  /** Ensure `personaId` has a bound, mentionable role in `guildId`; return it.
   *  Serialized per guild so concurrent reconnects don't race the pool. */
  bind(guildId: string, personaId: string, displayName: string): Promise<string> {
    return this.withGuildLock(guildId, () => this.bindLocked(guildId, personaId, displayName));
  }

  private async bindLocked(guildId: string, personaId: string, displayName: string): Promise<string> {
    const pool = await this.ensureDiscovered(guildId);

    const existing = pool.byPersona.get(personaId);
    if (existing) {
      this.touch(pool, personaId);
      return existing;
    }

    const wanted = this.roleName(displayName);

    // 1) Adopt a free role ALREADY named for this persona (migration from the
    //    legacy rename-pool, or a pre-persistence restart). Never adopt a free
    //    role named for someone else — that would reattribute their mentions.
    for (const [roleId, owner] of pool.bindings) {
      if (owner !== null) continue;
      if (pool.names.get(roleId) === wanted) {
        this.assign(pool, roleId, personaId);
        this.persist();
        return roleId;
      }
    }

    // 2) Under cap → create a fresh dedicated role for this persona.
    if (pool.bindings.size >= this.size) await this.freeOneSlot(guildId, pool);
    const roleId = await this.ops.createRole(guildId, wanted);
    pool.bindings.set(roleId, null);
    pool.names.set(roleId, wanted);
    this.assign(pool, roleId, personaId);
    this.persist();
    return roleId;
  }

  /** Make room at the role cap by DELETING a role (never renaming onto a new
   *  owner). Prefer an unowned/orphan role; otherwise evict the LRU persona. */
  private async freeOneSlot(guildId: string, pool: GuildPool): Promise<void> {
    let orphan: string | null = null;
    for (const [roleId, owner] of pool.bindings) {
      if (owner === null) {
        orphan = roleId;
        break;
      }
    }
    if (orphan) {
      pool.bindings.delete(orphan);
      pool.names.delete(orphan);
      await this.ops.deleteRole(guildId, orphan);
      return;
    }
    const victim = pool.lru[0];
    const victimRole = victim ? pool.byPersona.get(victim) : undefined;
    if (!victim || !victimRole) {
      throw new Error(`Role pool exhausted in guild ${guildId} and no victim found`);
    }
    pool.byPersona.delete(victim);
    pool.lru.shift();
    pool.bindings.delete(victimRole);
    pool.names.delete(victimRole);
    await this.ops.deleteRole(guildId, victimRole);
  }

  /** Release a persona's role in a guild (lost access, or persona removed):
   *  delete the Discord role so its stale mentions die cleanly. No-op if unbound. */
  unbind(guildId: string, personaId: string): Promise<void> {
    return this.withGuildLock(guildId, async () => {
      const pool = this.guilds.get(guildId);
      const roleId = pool?.byPersona.get(personaId);
      if (!pool || !roleId) return;
      pool.byPersona.delete(personaId);
      pool.bindings.delete(roleId);
      pool.names.delete(roleId);
      const i = pool.lru.indexOf(personaId);
      if (i >= 0) pool.lru.splice(i, 1);
      await this.ops.deleteRole(guildId, roleId);
      this.persist();
    });
  }

  /** Release a persona everywhere (identity removal). */
  async unbindAll(personaId: string): Promise<void> {
    for (const guildId of [...this.guilds.keys()]) await this.unbind(guildId, personaId);
  }

  /** Rename a persona's OWN bound roles in every guild (live displayName change).
   *  Safe: the role id stays owned by the same persona, so no mention is retargeted. */
  async rename(personaId: string, displayName: string): Promise<void> {
    for (const [guildId, pool] of this.guilds) {
      const roleId = pool.byPersona.get(personaId);
      if (roleId) {
        await this.ops.renameRole(guildId, roleId, this.roleName(displayName));
        pool.names.set(roleId, this.roleName(displayName));
      }
    }
    this.persist();
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
