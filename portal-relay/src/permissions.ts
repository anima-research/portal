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

/** Mirror-visibility lookup: channel ids a Discord role can view in a guild. */
export type MirrorVisibility = (guildId: string, roleId: string) => Set<string>;

/** A bare PersonaPolicy on disk (legacy) lacks `roles`/`policy` keys. Normalise
 *  it to the entry shape so the store always holds `PersonaEntry`. */
function toEntry(raw: PersonaFileEntry): PersonaEntry {
  if (raw && ('roles' in raw || 'policy' in raw)) return raw as PersonaEntry;
  return { policy: raw as PersonaPolicy };
}

/** Inverse of {@link toEntry}: persist a policy-only entry in the legacy inline
 *  shape (keeps existing files stable); use the new shape only when roles exist. */
function fromEntry(e: PersonaEntry): PersonaFileEntry {
  if (!e.roles?.length) return e.policy ?? { default: [] };
  return e.policy ? { roles: e.roles, policy: e.policy } : { roles: e.roles };
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
  private fileDefault: Capability[] = [];
  private listeners: Array<(c: PermissionChange) => void> = [];
  private file?: WatchedFile;
  private mirrorVisibility?: MirrorVisibility;

  constructor(private path: string) {
    this.reload();
  }

  /** Inject the live mirror-visibility lookup used to resolve `mirrorRole`
   *  scopes. Absent ⇒ mirrorRole scopes resolve to deny (fail-closed). */
  setMirrorVisibility(fn: MirrorVisibility): void {
    this.mirrorVisibility = fn;
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
    const out = new Set<Capability>();
    for (const name of entry.roles ?? []) {
      const role = this.roles.get(name);
      if (role && this.scopeIncludes(role.scope, role.guildId, guildId, channelId)) {
        for (const c of role.caps) out.add(c);
      }
    }
    if (entry.policy) {
      for (const c of this.resolvePolicy(entry.policy, guildId, channelId)) out.add(c);
    }
    return out;
  }

  /** Legacy per-persona policy resolution: channel ?? guild-default ?? default. */
  private resolvePolicy(pol: PersonaPolicy, guildId: string | null, channelId: string): Set<Capability> {
    if (guildId) {
      const g = pol.guilds?.[guildId];
      if (g) {
        if (g.channels?.[channelId]) return new Set(g.channels[channelId]);
        if (g.default) return new Set(g.default);
      }
    }
    return new Set(pol.default);
  }

  /** Does a scope grant apply in (guildId, channelId)? Fail-closed for mirrors. */
  private scopeIncludes(
    scope: Scope,
    roleGuildId: string | undefined,
    guildId: string | null,
    channelId: string,
  ): boolean {
    if ('all' in scope) return scope.all === true;
    if ('channels' in scope) return scope.channels.includes(channelId);
    // mirror{Role,Roles}: inherently per-guild; deny if no guild, cross-guild, or no lookup.
    if (!guildId) return false;
    if (roleGuildId && roleGuildId !== guildId) return false;
    const mv = this.mirrorVisibility;
    if (!mv) return false; // fail-closed: never a stale allow
    // Union: in scope iff ANY mirrored role can view the channel.
    const roleIds = 'mirrorRoles' in scope ? scope.mirrorRoles : [scope.mirrorRole];
    return roleIds.some((rid) => mv(guildId, rid).has(channelId));
  }

  getPolicy(personaId: string): PersonaPolicy | undefined {
    return this.personas.get(personaId)?.policy;
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
    for (const name of entry.roles ?? []) {
      const role = this.roles.get(name);
      if (!role || role.caps.length === 0) continue;
      const s = role.scope;
      if ('all' in s) {
        if (s.all) return true;
        continue;
      }
      if ('channels' in s) {
        if (s.channels.some(channelInGuild)) return true;
        continue;
      }
      // mirror{Role,Roles}: per-guild; grants here iff a mirrored role can see ≥1 channel.
      if (role.guildId && role.guildId !== guildId) continue;
      const mv = this.mirrorVisibility;
      if (!mv) continue; // fail-closed
      const rids = 'mirrorRoles' in s ? s.mirrorRoles : [s.mirrorRole];
      if (rids.some((rid) => mv(guildId, rid).size > 0)) return true;
    }
    const pol = entry.policy;
    if (pol) {
      if (pol.default.length > 0) return true; // legacy global default applies everywhere
      const g = pol.guilds?.[guildId];
      if (g) {
        if (g.default && g.default.length > 0) return true;
        if (g.channels && Object.values(g.channels).some((caps) => caps.length > 0)) return true;
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
    this.ensure(personaId).policy = policy;
    this.persist();
    this.emit({ personaId, scope: 'reload' });
  }

  /** Assign access roles to a persona (RFC-004 role-based enrollment). */
  setPersonaRoles(personaId: string, roles: string[]): void {
    this.ensure(personaId).roles = roles;
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
    const g = this.personas.get(personaId)?.policy?.guilds?.[guildId];
    if (g?.channels) {
      delete g.channels[channelId];
      this.persist();
      this.emit({ personaId, scope: 'channel', guildId, channelId });
    }
  }

  /** Create/replace a named access role in the catalog (super-admin authoring,
   *  RFC-005 §5.3). A reload-scope emit re-pushes caps to any persona that
   *  references the role. */
  setRole(name: string, role: AccessRole): void {
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

  private ensure(personaId: string): PersonaEntry {
    let e = this.personas.get(personaId);
    if (!e) this.personas.set(personaId, (e = {}));
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
    this.roles = new Map(Object.entries(next.roles ?? {}));
    this.personas = new Map(
      Object.entries(next.personas ?? {}).map(([id, raw]) => [id, toEntry(raw)]),
    );
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
    const data: PermissionsFile = {
      default: this.fileDefault.length ? this.fileDefault : undefined,
      roles: this.roles.size ? Object.fromEntries(this.roles) : undefined,
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
};

const ALL_CAPS: Capability[] = [
  'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS',
  'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'EDIT_OWN', 'DELETE_OWN',
  'MANAGE_MESSAGES', 'MANAGE_CHANNELS',
];

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
