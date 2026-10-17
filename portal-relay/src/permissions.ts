/**
 * Permissions store — *what* a persona may do, where. Separate from identity.
 * Guild/channel-aware policy with the resolution order:
 *
 *   channel override  ??  guild default  ??  persona default  ??  file default (deny)
 *
 * The resolved set is then intersected with what the bot can actually do in the
 * channel (computeCapabilities), so a persona is never told it can do something
 * Discord will reject. Live: hot-reloads + mutators, both firing onChange.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PermissionsBitField } from 'discord.js';
import type { GuildBasedChannel, GuildMember } from 'discord.js';
import type { Capability } from '@animalabs/portal-protocol';
import type {
  AccessRole,
  GuildPolicy,
  PermissionsFile,
  PersonaEntry,
  PersonaFileEntry,
  PersonaPolicy,
  Scope,
} from './config.js';
import { WatchedFile } from './file-watch.js';
import { ALL_CAPS } from './access.js';

export { ALL_CAPS };

/**
 * Mirror lookup: per-channel capabilities of a Discord role in a guild, keyed
 * by channel id. Keys = channels the role can VIEW (scope membership); values =
 * the caps the role's permission bits support there (full-fidelity mirroring,
 * used only by `mirrorCaps` roles — visibility-only roles just test `.has`).
 */
export type MirrorLookup = (guildId: string, roleId: string) => ReadonlyMap<string, ReadonlySet<Capability>>;

/** A bare PersonaPolicy on disk (legacy) lacks `roles`/`policy` keys. Normalise
 *  it to the entry shape so the store always holds `PersonaEntry`. */
function toEntry(raw: PersonaFileEntry): PersonaEntry {
  if (raw && ('roles' in raw || 'policy' in raw || 'bans' in raw)) return raw as PersonaEntry;
  return { policy: raw as PersonaPolicy };
}

/** Inverse of {@link toEntry}: persist a policy-only entry in the legacy inline
 *  shape (keeps existing files stable); use the new shape only when roles exist. */
function fromEntry(e: PersonaEntry): PersonaFileEntry {
  if (!e.roles?.length && !e.bans?.length) return e.policy ?? { default: [] };
  return {
    ...(e.roles?.length ? { roles: e.roles } : {}),
    ...(e.policy ? { policy: e.policy } : {}),
    ...(e.bans?.length ? { bans: e.bans } : {}),
  };
}

/** Drop what an edit left empty in one guild of a policy: an empty channel
 *  map, then a guild entry holding nothing, then an empty guilds map. (An
 *  empty entry resolves exactly like a missing one; it is only clutter.) */
function pruneGuild(pol: PersonaPolicy, guildId: string): void {
  const g = pol.guilds?.[guildId];
  if (!g) return;
  if (g.channels && !Object.keys(g.channels).length) delete g.channels;
  if (g.default === undefined && !g.channels) delete pol.guilds![guildId];
  if (pol.guilds && !Object.keys(pol.guilds).length) delete pol.guilds;
}

export type PermissionChange = {
  personaId: string;
  /** Granularity of what changed — drives how many channels the relay re-pushes. */
  scope: 'channel' | 'guild' | 'default' | 'reload';
  guildId?: string;
  channelId?: string;
};

export class PermissionsStore {
  private personas = new Map<string, PersonaEntry>();
  private roles = new Map<string, AccessRole>();
  /** Catalog entries refused at load (no guildId / malformed): excluded from
   *  resolution but written back verbatim on persist — quarantine, not
   *  deletion. A live entry created under the same name wins on merge. */
  private quarantinedRoles: Record<string, unknown> = {};
  private fileDefault: Capability[] = [];
  private listeners: Array<(c: PermissionChange) => void> = [];
  private file?: WatchedFile;
  private mirrorLookup?: MirrorLookup;

  constructor(private path: string) {
    this.reload();
  }

  /** Inject the live mirror lookup used to resolve `mirrorRole` scopes (and
   *  per-channel caps for `mirrorCaps` roles). Absent ⇒ mirror scopes resolve
   *  to deny (fail-closed). */
  setMirrorLookup(fn: MirrorLookup): void {
    this.mirrorLookup = fn;
  }

  startWatching(): void {
    this.file = new WatchedFile(this.path, () => this.reload());
    this.file.start();
  }
  stopWatching(): void {
    this.file?.stop();
  }

  onChange(cb: (c: PermissionChange) => void): void {
    this.listeners.push(cb);
  }
  private emit(c: PermissionChange): void {
    for (const cb of this.listeners) cb(c);
  }

  // ── Resolution ──

  /**
   * The policy-level capability set (before ∩ Discord reality). The union
   * (most-permissive) of every assigned access role whose scope includes this
   * channel, plus any legacy inline policy. Default-deny: an entry with no
   * matching role/scope resolves to the empty set.
   */
  resolve(personaId: string, guildId: string | null, channelId: string): Set<Capability> {
    const entry = this.personas.get(personaId);
    if (!entry) return new Set(this.fileDefault);
    return this.resolveEntry(entry, guildId, channelId);
  }

  /** resolve() for an entry as given — the store's own, or a hypothetical one
   *  (the admin panel's previews: "if this grant were set"). */
  resolveEntry(entry: PersonaEntry, guildId: string | null, channelId: string): Set<Capability> {
    if (guildId && entry.bans?.includes(guildId)) return new Set();
    const out = this.resolveForRoles(entry.roles ?? [], guildId, channelId);
    if (entry.policy) {
      for (const c of this.resolvePolicy(entry.policy, guildId, channelId)) out.add(c);
    }
    return out;
  }

  /**
   * Caps for an operation with no existing channel (e.g. creating one at the
   * guild root). Only unrestricted grants apply: a role bound to this guild
   * with scope all:true (unless it's a full-fidelity mirror), and the
   * persona's default for this guild, else its persona-wide default; a persona
   * with no entry gets the file-level default, as resolve() gives it. Channel
   * and mirror scopes remain local, even if they happen to cover every
   * currently cached channel.
   */
  resolveGuild(personaId: string, guildId: string): Set<Capability> {
    const entry = this.personas.get(personaId);
    if (!entry) return new Set(this.fileDefault);
    const out = new Set<Capability>();
    for (const name of entry.roles ?? []) {
      const role = this.roles.get(name);
      if (!role || role.guildId !== guildId) continue;
      // Match resolveForRoles precedence for hand-authored mixed scopes:
      // full-fidelity mirrors stay local even if the scope also has all:true.
      const isMirror = 'mirrorRole' in role.scope || 'mirrorRoles' in role.scope;
      if (isMirror && role.mirrorCaps) continue;
      if ('all' in role.scope && role.scope.all === true) {
        for (const cap of role.caps) out.add(cap);
      }
    }
    const policy = entry.policy;
    if (policy) {
      // A hand-edited policy can lack its default; read that as empty, as resolve() does.
      for (const cap of policy.guilds?.[guildId]?.default ?? policy.default ?? []) out.add(cap);
    }
    return out;
  }

  /**
   * Policy-level caps a hypothetical persona holding exactly `roleNames` would
   * have in (guildId, channelId). Backs resolve(), and lets callers attribute
   * WHICH held role contributes access (slash /caps, /remove explanations).
   */
  resolveForRoles(roleNames: string[], guildId: string | null, channelId: string): Set<Capability> {
    const out = new Set<Capability>();
    for (const name of roleNames) {
      const role = this.roles.get(name);
      if (!role) continue;
      const isMirror = 'mirrorRole' in role.scope || 'mirrorRoles' in role.scope;
      if (isMirror && role.mirrorCaps) {
        // Full-fidelity mirror: caps = mask ∩ what the mirrored role(s) can do here.
        const derived = this.mirrorCapsAt(role.scope, role.guildId, guildId, channelId);
        for (const c of role.caps) if (derived.has(c)) out.add(c);
      } else if (this.scopeIncludes(role.scope, role.guildId, guildId, channelId)) {
        for (const c of role.caps) out.add(c);
      }
    }
    return out;
  }

  /** Legacy per-persona policy resolution: channel ?? guild-default ?? default. */
  private resolvePolicy(pol: PersonaPolicy, guildId: string | null, channelId: string): Set<Capability> {
    return new Set(this.explainPolicy(pol, guildId, channelId).caps);
  }

  /**
   * Which part of an inline policy decides (guildId, channelId), and what it
   * gives: the channel's own entry ([] blocks), else the guild's default
   * ([] denies), else the persona default. The one place this order lives —
   * resolve() and the admin panel's explanations both go through it.
   */
  explainPolicy(
    pol: PersonaPolicy,
    guildId: string | null,
    channelId: string,
  ): { source: 'channel' | 'guildDefault' | 'personaDefault'; caps: Capability[] } {
    if (guildId) {
      const g = pol.guilds?.[guildId];
      if (g) {
        if (g.channels?.[channelId]) return { source: 'channel', caps: g.channels[channelId] };
        if (g.default) return { source: 'guildDefault', caps: g.default };
      }
    }
    return { source: 'personaDefault', caps: pol.default ?? [] };
  }

  /** Does a scope grant apply in (guildId, channelId)? Fail-closed for mirrors. */
  private scopeIncludes(
    scope: Scope,
    roleGuildId: string | undefined,
    guildId: string | null,
    channelId: string,
  ): boolean {
    // Roles are guild-scoped, PERIOD (2026-07-31): every scope kind is gated on
    // the role's guild binding. scope:{all} means "all channels of MY guild",
    // never fleet-wide — before this, `all` returned true without consulting
    // roleGuildId, making the binding decorative on non-mirror roles (and a
    // guild admin's /add-role silently fleet-wide). Unbound roles are dropped
    // at load; `!roleGuildId` here is belt-and-braces fail-closed.
    if ('all' in scope) return scope.all === true && !!roleGuildId && roleGuildId === guildId;
    if ('channels' in scope) {
      if (!roleGuildId || roleGuildId !== guildId) return false;
      return scope.channels.includes(channelId);
    }
    // mirror{Role,Roles}: inherently per-guild; deny if no guild, cross-guild, or no lookup.
    if (!guildId) return false;
    if (!roleGuildId || roleGuildId !== guildId) return false;
    const mv = this.mirrorLookup;
    if (!mv) return false; // fail-closed: never a stale allow
    // Union: in scope iff ANY mirrored role can view the channel.
    const roleIds = 'mirrorRoles' in scope ? scope.mirrorRoles : [scope.mirrorRole];
    return roleIds.some((rid) => mv(guildId, rid).has(channelId));
  }

  /** Per-channel caps the mirrored Discord role(s) hold at (guildId, channelId):
   *  the union across mirrored roles. Fail-closed like {@link scopeIncludes} —
   *  no guild, cross-guild, or no lookup ⇒ empty set. */
  private mirrorCapsAt(
    scope: Scope,
    roleGuildId: string | undefined,
    guildId: string | null,
    channelId: string,
  ): Set<Capability> {
    const out = new Set<Capability>();
    if (!('mirrorRole' in scope) && !('mirrorRoles' in scope)) return out;
    if (!guildId) return out;
    if (!roleGuildId || roleGuildId !== guildId) return out;
    const mv = this.mirrorLookup;
    if (!mv) return out; // fail-closed
    const roleIds = 'mirrorRoles' in scope ? scope.mirrorRoles : [scope.mirrorRole];
    for (const rid of roleIds) {
      const caps = mv(guildId, rid).get(channelId);
      if (caps) for (const c of caps) out.add(c);
    }
    return out;
  }

  /** What a persona with no entry of its own resolves to, everywhere (a copy). */
  getFileDefault(): Capability[] {
    return [...this.fileDefault];
  }

  getPolicy(personaId: string): PersonaPolicy | undefined {
    return this.personas.get(personaId)?.policy;
  }

  /** The inline policy a merge should start from: the persona's own, or —
   *  for a persona with no entry yet — the file default it resolves to
   *  today (so creating its entry does not take that away). Cloned. */
  basePolicy(personaId: string): PersonaPolicy {
    const e = this.personas.get(personaId);
    if (!e) return { default: [...this.fileDefault] };
    return e.policy ? structuredClone(e.policy) : { default: [] };
  }

  /** Was this persona banned from `guildId` (and not granted access there since)? */
  isBanned(personaId: string, guildId: string): boolean {
    return this.personas.get(personaId)?.bans?.includes(guildId) ?? false;
  }

  /** An admin of `guildId` granted this persona access there again: the ban
   *  no longer applies. Returns whether there was one. */
  liftBan(personaId: string, guildId: string): boolean {
    const e = this.personas.get(personaId);
    if (!e?.bans?.includes(guildId)) return false;
    e.bans = e.bans.filter((g) => g !== guildId);
    if (!e.bans.length) delete e.bans;
    this.persist();
    this.emit({ personaId, scope: 'guild', guildId });
    return true;
  }

  getRoleNames(personaId: string): string[] {
    return this.personas.get(personaId)?.roles ?? [];
  }

  /** The access-role catalog (read-only view). */
  getRole(name: string): AccessRole | undefined {
    return this.roles.get(name);
  }

  /** The full access-role catalog (read-only snapshot) — admin panel pickers. */
  allRoles(): Record<string, AccessRole> {
    return Object.fromEntries([...this.roles].map(([k, v]) => [k, structuredClone(v)]));
  }

  /** A persona's raw entry (roles + inline policy), cloned. Admin panel reads. */
  getEntry(personaId: string): PersonaEntry | undefined {
    const e = this.personas.get(personaId);
    return e ? structuredClone(e) : undefined;
  }

  /**
   * Cheap policy-level upper bound: could this persona have *any* capability in
   * `guildId`? Used to avoid minting addressing roles in guilds a persona can't
   * touch. Conservative — returns the policy grant (a superset of effective caps,
   * before ∩ Discord), so it never reports "no access" where access exists.
   *
   * `channelInGuild(channelId)` tells whether an explicit `channels`-scope id
   * belongs to this guild (channel ids are global, so the store can't know).
   */
  couldAccessGuild(
    personaId: string,
    guildId: string,
    channelInGuild: (channelId: string) => boolean,
  ): boolean {
    const entry = this.personas.get(personaId);
    if (!entry) return this.fileDefault.length > 0; // file default applies everywhere
    if (entry.bans?.includes(guildId)) return false;
    for (const name of entry.roles ?? []) {
      const role = this.roles.get(name);
      if (!role || role.caps.length === 0) continue;
      // Guild-scoped, PERIOD — same gate as scopeIncludes (2026-07-31).
      if (!role.guildId || role.guildId !== guildId) continue;
      const s = role.scope;
      if ('all' in s) {
        if (s.all) return true;
        continue;
      }
      if ('channels' in s) {
        if (s.channels.some(channelInGuild)) return true;
        continue;
      }
      // mirror{Role,Roles}: grants here iff a mirrored role can see ≥1 channel.
      const mv = this.mirrorLookup;
      if (!mv) continue; // fail-closed
      const rids = 'mirrorRoles' in s ? s.mirrorRoles : [s.mirrorRole];
      if (rids.some((rid) => mv(guildId, rid).size > 0)) return true;
    }
    const pol = entry.policy;
    if (pol) {
      const g = pol.guilds?.[guildId];
      if (g) {
        if (g.default && g.default.length > 0) return true;
        if (g.channels && Object.values(g.channels).some((caps) => caps.length > 0)) return true;
        // Mirror resolvePolicy exactly (channel ?? guild ?? default): an
        // UNDEFINED g.default is transparent — channels not in g.channels
        // still fall through to the legacy persona default — while an
        // explicit deny ({default: []}, e.g. /ban) shadows it. Getting this
        // wrong under-reports for the canonical legacy persona shape
        // (nonempty default + channel-only guild entries) and unbinds
        // addressing roles / silences ambient dispatch while resolve()
        // still grants.
        if (g.default === undefined && pol.default.length > 0) return true;
      } else if (pol.default.length > 0) {
        return true; // legacy global default applies where no guild entry says otherwise
      }
    }
    return false;
  }

  // ── Mutations (persist + emit) ──

  setPersonaDefault(personaId: string, caps: Capability[]): void {
    this.ensurePolicy(personaId).default = caps;
    this.persist();
    this.emit({ personaId, scope: 'default' });
  }

  /** Replace a persona's entire inline policy (RFC-004 scoped-grant enrollment). */
  setPersonaPolicy(personaId: string, policy: PersonaPolicy): void {
    this.ensure(personaId, false).policy = policy;
    this.persist();
    this.emit({ personaId, scope: 'reload' });
  }

  /** Assign access roles to a persona (RFC-004 role-based enrollment). */
  setPersonaRoles(personaId: string, roles: string[]): void {
    this.ensure(personaId, false).roles = roles;
    this.persist();
    this.emit({ personaId, scope: 'reload' });
  }

  /** Union additional roles into a persona's set (RFC-005 claim_invite / admin
   *  augment). Returns the resulting role list. */
  addPersonaRoles(personaId: string, roles: string[]): string[] {
    const e = this.ensure(personaId);
    e.roles = [...new Set([...(e.roles ?? []), ...roles])];
    this.persist();
    this.emit({ personaId, scope: 'reload' });
    return e.roles;
  }

  /** Remove a single role from a persona (RFC-005 revoke). Returns the result. */
  removePersonaRole(personaId: string, role: string): string[] {
    const e = this.ensure(personaId);
    e.roles = (e.roles ?? []).filter((r) => r !== role);
    this.persist();
    this.emit({ personaId, scope: 'reload' });
    return e.roles;
  }

  setGuildDefault(personaId: string, guildId: string, caps: Capability[]): void {
    const g = this.ensureGuild(personaId, guildId);
    g.default = caps;
    this.persist();
    this.emit({ personaId, scope: 'guild', guildId });
  }

  setChannel(personaId: string, guildId: string, channelId: string, caps: Capability[]): void {
    const g = this.ensureGuild(personaId, guildId);
    (g.channels ??= {})[channelId] = caps;
    this.persist();
    this.emit({ personaId, scope: 'channel', guildId, channelId });
  }

  clearChannel(personaId: string, guildId: string, channelId: string): void {
    const pol = this.personas.get(personaId)?.policy;
    const g = pol?.guilds?.[guildId];
    if (g?.channels) {
      delete g.channels[channelId];
      pruneGuild(pol!, guildId);
      this.persist();
      this.emit({ personaId, scope: 'channel', guildId, channelId });
    }
  }

  /** Remove a persona's guild-wide setting in `guildId` (neither a level nor
   *  a deny): channels there without their own grant fall back to the
   *  persona default. A guild entry left with nothing in it is deleted.
   *  Returns whether there was a setting to remove. */
  unsetGuildDefault(personaId: string, guildId: string): boolean {
    const pol = this.personas.get(personaId)?.policy;
    const g = pol?.guilds?.[guildId];
    if (!g || g.default === undefined) return false;
    delete g.default;
    pruneGuild(pol!, guildId);
    this.persist();
    this.emit({ personaId, scope: 'guild', guildId });
    return true;
  }

  /** Ban a persona from one guild (/ban): drops every channel grant, pins the
   *  guild default to [] (an explicit deny — deleting the subtree would fall
   *  back to the persona default instead), and records the ban, so nothing
   *  the persona does itself (claiming an invite again) restores access
   *  there; only an admin of that guild granting access lifts it. Guild-
   *  scoped access ROLES are removed separately by the caller. */
  clearGuild(personaId: string, guildId: string): void {
    // ensureGuild (not personas.get) so a persona with NO permissions entry
    // gets one pinned to deny — otherwise a /ban of a file-default persona
    // would silently no-op and the file default would keep applying. (ensure
    // seeds the new entry from the file default, so the ban denies exactly
    // this guild and the persona's standing elsewhere is unchanged.)
    const g = this.ensureGuild(personaId, guildId);
    g.default = [];
    delete g.channels;
    const e = this.ensure(personaId);
    if (!e.bans?.includes(guildId)) e.bans = [...(e.bans ?? []), guildId];
    this.persist();
    this.emit({ personaId, scope: 'guild', guildId });
  }

  /** Create/replace a named access role in the catalog (super-admin authoring,
   *  RFC-005 §5.3). A reload-scope emit re-pushes caps to any persona that
   *  references the role. */
  setRole(name: string, role: AccessRole): void {
    if (!role.guildId) throw new Error('roles are guild-scoped: guildId is required');
    this.roles.set(name, role);
    this.persist();
    for (const [pid, e] of this.personas) {
      if (e.roles?.includes(name)) this.emit({ personaId: pid, scope: 'reload' });
    }
  }

  /** Remove a named access role from the catalog. Personas referencing it lose
   *  those caps on their next action (live revocation, §5.8). */
  removeRole(name: string): boolean {
    if (!this.roles.delete(name)) return false;
    this.persist();
    for (const [pid, e] of this.personas) {
      if (e.roles?.includes(name)) this.emit({ personaId: pid, scope: 'reload' });
    }
    return true;
  }

  removePersona(personaId: string): void {
    if (this.personas.delete(personaId)) {
      this.persist();
      this.emit({ personaId, scope: 'reload' });
    }
  }

  /**
   * The persona's entry, created if missing. A persona with no entry resolves
   * to the FILE default everywhere, and once it has an entry that default no
   * longer applies — so a new entry starts from a copy of it (`seed`), and an
   * edit in one guild leaves the persona's access everywhere else as it was.
   * Enrollment, which sets the whole entry from an invite, does not seed.
   */
  private ensure(personaId: string, seed = true): PersonaEntry {
    let e = this.personas.get(personaId);
    if (!e) {
      e = seed && this.fileDefault.length ? { policy: { default: [...this.fileDefault] } } : {};
      this.personas.set(personaId, e);
    }
    return e;
  }
  private ensurePolicy(personaId: string): PersonaPolicy {
    const e = this.ensure(personaId);
    return (e.policy ??= { default: [] });
  }
  private ensureGuild(personaId: string, guildId: string): GuildPolicy {
    const pol = this.ensurePolicy(personaId);
    pol.guilds ??= {};
    return (pol.guilds[guildId] ??= {});
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as PermissionsFile;
    const oldJson = new Map([...this.personas].map(([id, p]) => [id, JSON.stringify(p)]));
    const oldRolesJson = JSON.stringify([...this.roles].sort());
    this.fileDefault = next.default ?? [];
    // Roles are guild-scoped, PERIOD: a role without a guild binding (or a
    // malformed entry) is INERT (fail-closed) rather than resolving
    // fleet-wide. Loud, because a catalog entry silently granting nothing is
    // a debugging trap. Quarantined — not dropped — so the next persist()
    // doesn't destroy config the operator intends to repair.
    this.quarantinedRoles = {};
    this.roles = new Map(
      Object.entries(next.roles ?? {}).filter(([name, role]) => {
        if (!role || !role.guildId) {
          console.error(
            `[portal-relay] permissions: role "${name}" has no guildId — roles are guild-scoped; ` +
              `treating it as INERT until it gets one (entry preserved on save)`,
          );
          this.quarantinedRoles[name] = role;
          return false;
        }
        return true;
      }),
    );
    this.personas = new Map(
      Object.entries(next.personas ?? {}).map(([id, raw]) => [id, toEntry(raw)]),
    );
    // A persona-wide default applies in EVERY guild the relay serves. Nothing
    // in the relay writes one any more (invite grants are guild-bound); one on
    // disk was put there by hand or by an older relay — say so loudly.
    const wide = [...this.personas].filter(([, e]) => (e.policy?.default?.length ?? 0) > 0).map(([id]) => id);
    if (wide.length) {
      console.error(
        `[portal-relay] permissions: ${wide.length} persona(s) hold a persona-wide default, which applies in every ` +
          `served guild: ${wide.join(', ')} — review, and re-scope to a guild if that was not intended`,
      );
    }
    if (this.listeners.length) {
      // A role-catalog edit can change effective caps for any persona that
      // references a role, so treat such an entry as changed too.
      const rolesChanged = JSON.stringify([...this.roles].sort()) !== oldRolesJson;
      const ids = new Set([...oldJson.keys(), ...this.personas.keys()]);
      for (const id of ids) {
        const before = oldJson.get(id);
        const after = this.personas.has(id) ? JSON.stringify(this.personas.get(id)) : undefined;
        const usesRoles = (this.personas.get(id)?.roles?.length ?? 0) > 0;
        if (before !== after || (rolesChanged && usesRoles)) {
          this.emit({ personaId: id, scope: 'reload' });
        }
      }
    }
  }

  private persist(): void {
    const quarantined = Object.keys(this.quarantinedRoles).length;
    const data: PermissionsFile = {
      default: this.fileDefault.length ? this.fileDefault : undefined,
      roles:
        this.roles.size || quarantined
          ? ({ ...this.quarantinedRoles, ...Object.fromEntries(this.roles) } as PermissionsFile['roles'])
          : undefined,
      personas: Object.fromEntries(
        [...this.personas].map(([id, e]) => [id, fromEntry(e)]),
      ),
    };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }
}

// ── Intersection with Discord reality (unchanged behaviour, now takes a Set) ──

const F = PermissionsBitField.Flags;

const CAP_REQUIRES: Partial<Record<Capability, bigint>> = {
  VIEW_CHANNEL: F.ViewChannel,
  READ_HISTORY: F.ReadMessageHistory,
  SEND_MESSAGES: F.SendMessages,
  SEND_IN_THREADS: F.SendMessagesInThreads,
  CREATE_THREADS: F.CreatePublicThreads,
  ATTACH_FILES: F.AttachFiles,
  ADD_REACTIONS: F.AddReactions,
  MENTION_EVERYONE: F.MentionEveryone,
  MANAGE_MESSAGES: F.ManageMessages,
  MANAGE_CHANNELS: F.ManageChannels,
  VOICE_LISTEN: F.Connect,
  VOICE_SPEAK: F.Speak,
};

/** The portal caps a permission bitfield supports (per-channel, post-overwrite).
 *  Backs full-fidelity `mirrorCaps` roles: what could a member holding exactly
 *  this role do here? EDIT_OWN/DELETE_OWN have no Discord bit (members always
 *  manage their own messages) — gated on SendMessages, mirroring
 *  {@link computeCapabilities}. */
/** Whether an access role can grant anything at all: some capability, over a
 *  scope that names something (every channel, at least one channel, or at
 *  least one Discord role to mirror). Only such a role ends a /ban. */
export function roleGrantsAccess(role: AccessRole | undefined): boolean {
  if (!role || !role.caps?.length) return false;
  const sc = role.scope as Record<string, unknown>;
  if (sc.all === true) return true;
  const named = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x !== '');
  return named(sc.channels) || (typeof sc.mirrorRole === 'string' && sc.mirrorRole !== '') || named(sc.mirrorRoles);
}

export function capsFromPerms(perms: Readonly<PermissionsBitField>): Set<Capability> {
  const out = new Set<Capability>();
  for (const cap of ALL_CAPS) {
    const required = CAP_REQUIRES[cap];
    if (required === undefined) {
      if (perms.has(F.SendMessages)) out.add(cap);
      continue;
    }
    if (perms.has(required)) out.add(cap);
  }
  return out;
}

/** effective = policy-allowed ∩ what the bot can actually do in the channel. */
export function computeCapabilities(
  allowed: Set<Capability>,
  channel: GuildBasedChannel | undefined,
  me: GuildMember | null | undefined,
): Capability[] {
  const botPerms = channel && me ? channel.permissionsFor(me) : null;
  const out: Capability[] = [];
  for (const cap of ALL_CAPS) {
    if (!allowed.has(cap)) continue;
    const required = CAP_REQUIRES[cap];
    if (required === undefined) {
      // Policy-only cap (EDIT_OWN/DELETE_OWN): gate on being able to send.
      if (botPerms && !botPerms.has(F.SendMessages)) continue;
      out.push(cap);
      continue;
    }
    if (!botPerms || !botPerms.has(required)) continue;
    out.push(cap);
  }
  return out;
}
