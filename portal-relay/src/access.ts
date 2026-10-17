/**
 * Effective access — what a persona can do in a channel of guild G, and why —
 * computed from the inputs the relay enforces with (Relay.capsFor):
 *
 *   effective = ALL_CAPS ∩ PermissionsStore.resolve(persona, G, channel)
 *                        ∩ what the relay's bot can do in that channel
 *   and nothing for a persona the relay doesn't know or a guild it doesn't serve.
 *
 * computeCapabilities (permissions.ts) judges each capability on its own, so
 * intersecting the policy with the bot's own set there — botCaps =
 * computeCapabilities(ALL_CAPS, channel, bot) — is exactly what capsFor
 * returns, the uncached-channel case included. The policy side is the store's
 * own resolve(), a /ban included. The "why" is built from the pieces resolve()
 * unions — resolveForRoles per held role and the store's one explainPolicy —
 * so it can't tell another story. test/access.test.ts holds all of this to a
 * real Relay's capsFor, for every kind of source.
 *
 * Also the home of the capability presets slash speaks (LEVEL_CAPS) and the
 * level ladder (levelOf). No discord.js here.
 */
import type { Capability } from '@animalabs/portal-protocol';
import type { AccessRole, PersonaEntry } from './config.js';
import type { PermissionsStore } from './permissions.js';

/** Every capability, in the order the relay lists them. */
export const ALL_CAPS: Capability[] = [
  'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS',
  'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'EDIT_OWN', 'DELETE_OWN',
  'MANAGE_MESSAGES', 'MANAGE_CHANNELS', 'VOICE_LISTEN', 'VOICE_SPEAK',
];

// ── Capability presets (slash's levels) ──

const READ_CAPS: Capability[] = ['VIEW_CHANNEL', 'READ_HISTORY'];
const WRITE_CAPS: Capability[] = [
  ...READ_CAPS,
  'SEND_MESSAGES',
  'SEND_IN_THREADS',
  'CREATE_THREADS',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'EDIT_OWN',
  'DELETE_OWN',
];
const FULL_CAPS: Capability[] = [...WRITE_CAPS, 'MANAGE_MESSAGES'];
export const LEVEL_CAPS: Record<string, Capability[]> = {
  read: READ_CAPS,
  write: WRITE_CAPS,
  full: FULL_CAPS,
};

/** Render a caps set as its level name when it matches one, else the raw list. */
export function capsLabel(caps: readonly Capability[]): string {
  const set = new Set(caps);
  for (const [level, levelCaps] of Object.entries(LEVEL_CAPS).reverse()) {
    if (levelCaps.length === set.size && levelCaps.every((c) => set.has(c))) return level;
  }
  return caps.join(', ') || 'none';
}

export type PresetName = 'read' | 'write' | 'full';
const PRESETS: PresetName[] = ['read', 'write', 'full'];

/** Where a capability set sits on the Read/Write/Full ladder (as the panel's
 *  lib.levelOf): `base` is the highest preset wholly inside it, `extra` what
 *  it holds beyond that, and `level` the preset itself only when nothing is
 *  extra — anything else is 'custom' (a preset plus extras, or no preset). */
export interface LevelInfo {
  level: 'none' | PresetName | 'custom';
  base: PresetName | null;
  extra: Capability[];
}

export function levelOf(caps: readonly Capability[]): LevelInfo {
  const set = new Set(caps);
  if (!set.size) return { level: 'none', base: null, extra: [] };
  let base: PresetName | null = null;
  for (let i = PRESETS.length - 1; i >= 0; i--) {
    if (LEVEL_CAPS[PRESETS[i]].every((c) => set.has(c))) {
      base = PRESETS[i];
      break;
    }
  }
  const inBase = new Set(base ? LEVEL_CAPS[base] : []);
  const extra = ordered([...set].filter((c) => !inBase.has(c)));
  return { level: base && !extra.length ? base : 'custom', base, extra };
}

/** Channel types that can hold a direct grant: a thread uses its parent's
 *  access and a category grants nothing. */
export function isGrantable(type: string | undefined): boolean {
  return type === 'text' || type === 'voice' || type === 'forum';
}

/** Channels whose access is their own, where the relay serves a persona with
 *  what capsFor gives there: every kind but a thread (it uses its parent's
 *  access) and a category (it grants nothing). That is the grantable kinds
 *  and the ones the relay doesn't name ('unknown': a stage or media channel,
 *  say) — access from roles, guild-wide levels and defaults reaches those
 *  too, and so does a direct grant stored on one (slash /add run in its
 *  chat), even though the panel can't set one there. Every access view
 *  covers these channels, so none shows less than the relay enforces. */
export function holdsAccess(type: string | undefined): boolean {
  return type !== 'thread' && type !== 'category';
}

/** Distinct caps in ALL_CAPS order; names the relay doesn't know go last. */
function ordered(caps: Iterable<Capability>): Capability[] {
  const set = new Set(caps);
  const known = ALL_CAPS.filter((c) => set.has(c));
  const unknown = [...set].filter((c) => !ALL_CAPS.includes(c)).sort();
  return [...known, ...unknown];
}

/** The persona's access roles that let it see this channel, each on its own
 *  (slash /caps, /list and /remove name them). */
export function contributingRoles(
  permissions: PermissionsStore,
  personaId: string,
  guildId: string,
  channelId: string,
): string[] {
  return permissions.getRoleNames(personaId).filter((name) => {
    const role = permissions.getRole(name);
    if (!role) return false;
    if (role.guildId && role.guildId !== guildId) return false;
    // A role contributes if removing everything else still leaves caps — cheap
    // approximation: does a synthetic entry with only this role see the channel?
    return permissions
      .resolveForRoles([name], guildId, channelId)
      .has('VIEW_CHANNEL');
  });
}

// ── Explaining one persona in one channel ──

/** One reason a persona can (or can't) act in a channel. `shadowedBy` says
 *  what makes it not count there: a direct grant or block replaces the
 *  guild-wide level and the persona default; a guild-wide setting replaces
 *  the persona default; a removal with /ban ('removed') replaces everything. */
export type AccessSource =
  | { kind: 'removed' }
  | { kind: 'direct'; caps: Capability[]; shadowedBy?: 'removed' }
  | { kind: 'block'; shadowedBy?: 'removed' }
  | {
      kind: 'role';
      name: string;
      caps: Capability[];
      how: 'all' | 'channels' | 'mirror';
      /** The Discord roles a mirror role follows. */
      mirror?: Array<{ id: string }>;
      /** It follows their per-channel permissions too, not only what they see. */
      mirrorCaps?: true;
      shadowedBy?: 'removed';
    }
  | { kind: 'guildWide'; caps: Capability[]; shadowedBy?: 'direct' | 'block' | 'removed' }
  | { kind: 'personaDefault'; caps: Capability[]; shadowedBy?: 'direct' | 'block' | 'guildWide' | 'removed' }
  | { kind: 'relayDefault'; caps: Capability[] };

export interface Explained extends LevelInfo {
  /** What the relay lets the persona do here (the level fields describe it). */
  effective: Capability[];
  /** What its access rules give here, before the bot's own limits. */
  policyCaps: Capability[];
  /** The rules give something the relay's bot can't do here … */
  botLimited: boolean;
  /** … namely these. */
  botLacks: Capability[];
  /** The persona's direct grant on this channel ([] blocks), or null. */
  direct: Capability[] | null;
  sources: AccessSource[];
}

/** The parts of the relay an explanation reads. */
export interface AccessDeps {
  identity: { get(id: string): unknown };
  permissions: PermissionsStore;
  /** What the relay's bot can do in the channel: computeCapabilities over
   *  every capability, with the bot's member in G (as capsFor asks it). */
  botCaps(guildId: string, channelId: string): Capability[];
  /** Whether the relay serves G (capsFor answers nothing elsewhere). */
  served(guildId: string): boolean;
}

/** A persona in G, looked up once for many channels. */
export interface Subject {
  personaId: string;
  guildId: string;
  /** Its permissions entry as it is now (a copy), or undefined: none. */
  entry: PersonaEntry | undefined;
  /** Known to the relay, in a guild it serves: only then can it do anything. */
  live: boolean;
}

export function subjectOf(deps: AccessDeps, personaId: string, guildId: string): Subject {
  return {
    personaId,
    guildId,
    entry: deps.permissions.getEntry(personaId),
    live: !!deps.identity.get(personaId) && deps.served(guildId),
  };
}

export interface ExplainOptions {
  /** Explain as if the persona's direct grant here were this (null: none) —
   *  a preview. A grant that gives something also ends a /ban, as the grant
   *  routes do. */
  direct?: Capability[] | null;
}

export function explain(
  deps: AccessDeps,
  personaId: string,
  guildId: string,
  channelId: string,
  opts: ExplainOptions = {},
): Explained {
  return explainFor(deps, subjectOf(deps, personaId, guildId), channelId, new Set(deps.botCaps(guildId, channelId)), opts);
}

/** explain() for a subject already looked up, with the bot's caps there. */
export function explainFor(
  deps: AccessDeps,
  s: Subject,
  channelId: string,
  bot: ReadonlySet<Capability>,
  opts: ExplainOptions = {},
): Explained {
  const P = deps.permissions;
  const G = s.guildId;
  let entry = s.entry;
  let policy: Set<Capability>;
  if (opts.direct !== undefined) {
    entry = withDirect(P, s, channelId, opts.direct);
    policy = entry ? P.resolveEntry(entry, G, channelId) : new Set(P.getFileDefault());
  } else {
    policy = P.resolve(s.personaId, G, channelId); // the very call capsFor makes
  }

  const sources: AccessSource[] = [];
  let direct: Capability[] | null = null;
  if (!entry) {
    const fd = P.getFileDefault();
    if (fd.length) sources.push({ kind: 'relayDefault', caps: ordered(fd) });
  } else {
    for (const name of new Set(entry.roles ?? [])) {
      const role = P.getRole(name);
      // Only G's own roles act in G (resolution gates on it too); another
      // guild's role is never named here.
      if (!role || role.guildId !== G) continue;
      const caps = P.resolveForRoles([name], G, channelId);
      if (caps.size) sources.push(roleSource(name, role, caps));
    }
    const pol = entry.policy;
    if (pol) {
      const why = P.explainPolicy(pol, G, channelId);
      const g = pol.guilds?.[G];
      if (why.source === 'channel') {
        direct = ordered(why.caps);
        sources.push(direct.length ? { kind: 'direct', caps: direct } : { kind: 'block' });
      }
      const byDirect = direct ? (direct.length ? 'direct' : 'block') : undefined;
      if (g?.default) {
        sources.push({ kind: 'guildWide', caps: ordered(g.default), ...(byDirect ? { shadowedBy: byDirect } : {}) });
      }
      if (pol.default?.length) {
        const by = byDirect ?? (g?.default ? 'guildWide' : undefined);
        sources.push({ kind: 'personaDefault', caps: ordered(pol.default), ...(by ? { shadowedBy: by } : {}) });
      }
    }
    if (entry.bans?.includes(G)) {
      for (const src of sources) (src as { shadowedBy?: string }).shadowedBy = 'removed';
      sources.unshift({ kind: 'removed' });
    }
  }

  const effective = s.live ? ALL_CAPS.filter((c) => policy.has(c) && bot.has(c)) : [];
  const botLacks = s.live ? ALL_CAPS.filter((c) => policy.has(c) && !bot.has(c)) : [];
  return {
    effective,
    ...levelOf(effective),
    policyCaps: ALL_CAPS.filter((c) => policy.has(c)),
    botLimited: botLacks.length > 0,
    botLacks,
    direct,
    sources,
  };
}

/** The entry `s` would have with its direct grant on `channelId` replaced
 *  (null: removed) — what the grant routes would store. */
function withDirect(P: PermissionsStore, s: Subject, channelId: string, caps: Capability[] | null): PersonaEntry | undefined {
  if (caps === null) {
    // Removing a grant from a persona with no entry changes nothing.
    if (!s.entry) return undefined;
    const e = structuredClone(s.entry);
    const chans = e.policy?.guilds?.[s.guildId]?.channels;
    if (chans) delete chans[channelId];
    return e;
  }
  // A new entry starts from what the persona resolves to today (the file default).
  const e: PersonaEntry = s.entry ? structuredClone(s.entry) : { policy: P.basePolicy(s.personaId) };
  const pol = (e.policy ??= { default: [] });
  const g = ((pol.guilds ??= {})[s.guildId] ??= {});
  (g.channels ??= {})[channelId] = [...caps];
  if (caps.length && e.bans) e.bans = e.bans.filter((x) => x !== s.guildId);
  return e;
}

function roleSource(name: string, role: AccessRole, caps: Set<Capability>): AccessSource {
  const sc = role.scope;
  if ('all' in sc) return { kind: 'role', name, caps: ordered(caps), how: 'all' };
  if ('channels' in sc) return { kind: 'role', name, caps: ordered(caps), how: 'channels' };
  const ids = 'mirrorRoles' in sc ? sc.mirrorRoles : [sc.mirrorRole];
  return {
    kind: 'role', name, caps: ordered(caps), how: 'mirror',
    mirror: ids.map((id) => ({ id })),
    ...(role.mirrorCaps ? { mirrorCaps: true as const } : {}),
  };
}

// ── Removing a persona from a guild (slash /ban, the panel's Remove) ──

export interface RemovedFromGuild {
  /** The access roles of G it held, now taken away. */
  rolesRemoved: string[];
  /** Nothing resolves for it in G any more (the relay's own check). */
  accessFullyRevoked: boolean;
}

/**
 * Take a persona out of guild G: the access roles bound to G off, then
 * PermissionsStore.clearGuild — every direct grant in G dropped, G's
 * guild-wide level pinned to deny, and the removal recorded (`bans`), so
 * nothing the persona does itself (claiming an invite again) gives it access
 * there; only an admin of G giving it access lifts that. Other guilds are
 * untouched. Slash /ban and the panel's "Remove from <guild>" both call this,
 * so the two can't drift.
 *
 * Roles are guild-scoped in resolution (2026-07-31), so this IS full
 * revocation in G; `canAccessGuild` (the relay's own test) verifies it
 * anyway — an invariant break must surface, not hide.
 */
export function removeFromGuild(
  permissions: PermissionsStore,
  canAccessGuild: (personaId: string, guildId: string) => boolean,
  personaId: string,
  guildId: string,
): RemovedFromGuild {
  // Guild-scoped access roles off, inline guild policy pinned to deny. A role
  // set aside at load counts by the guild its entry names: it is still held by
  // name, and a repair would make it live again here.
  const rolesRemoved = permissions
    .getRoleNames(personaId)
    .filter((name) => (permissions.getRole(name)?.guildId ?? permissions.quarantinedGuildId(name)) === guildId);
  for (const name of rolesRemoved) permissions.removePersonaRole(personaId, name);
  permissions.clearGuild(personaId, guildId);
  return { rolesRemoved, accessFullyRevoked: !canAccessGuild(personaId, guildId) };
}

// ── Counting: who can act where, by level ──

export interface LevelCounts {
  read: number;
  write: number;
  full: number;
  custom: number;
}

export const zeroCounts = (): LevelCounts => ({ read: 0, write: 0, full: 0, custom: 0 });

/** Where `effective` is counted: only where it can see the channel (as
 *  slash /list counts), under its level. */
export function countedLevel(effective: readonly Capability[]): keyof LevelCounts | null {
  if (!effective.includes('VIEW_CHANNEL')) return null;
  const l = levelOf(effective).level;
  return l === 'none' ? null : l;
}

export interface AccessSummary {
  /** botLacks: what of Write the bot can't do there (left out when it can
   *  do all of it, or can't see the channel at all). */
  channels: Array<{ id: string; counts?: LevelCounts; botBase: PresetName | null; botCantView: boolean; botLacks?: Capability[] }>;
  personas: Array<{ id: string; counts?: LevelCounts }>;
  /** How many personas were looked at. */
  considered: number;
  /** Too many personas × channels to count: the counts are left out. */
  truncated?: true;
}

/**
 * Per-level counts for every channel and persona given: how many personas
 * can act in each channel at each level, and in how many channels each
 * persona can. The bot's caps are worked out once per channel; each pair then
 * costs one resolve(). Past `cellCap` pairs nothing is counted (truncated).
 */
export function accessSummary(
  deps: AccessDeps,
  guildId: string,
  channelIds: string[],
  personaIds: string[],
  cellCap: number,
): AccessSummary {
  const bots = channelIds.map((cid) => new Set(deps.botCaps(guildId, cid)));
  const channels = channelIds.map((id, i) => {
    const cantView = !bots[i].has('VIEW_CHANNEL');
    const lacks = cantView ? [] : WRITE_CAPS.filter((c) => !bots[i].has(c));
    return {
      id,
      botBase: levelOf([...bots[i]]).base,
      botCantView: cantView,
      ...(lacks.length ? { botLacks: lacks } : {}),
    };
  });
  if (personaIds.length * channelIds.length > cellCap) {
    return { channels, personas: personaIds.map((id) => ({ id })), considered: personaIds.length, truncated: true };
  }
  const served = deps.served(guildId);
  const perChannel = channelIds.map(zeroCounts);
  // Distinct effective sets are few: classify each once.
  const levels = new Map<string, keyof LevelCounts | null>();
  const personas = personaIds.map((pid) => {
    const counts = zeroCounts();
    if (served && deps.identity.get(pid)) {
      for (let i = 0; i < channelIds.length; i++) {
        const bot = bots[i];
        if (!bot.has('VIEW_CHANNEL')) continue; // nothing counts where the bot can't see
        const policy = deps.permissions.resolve(pid, guildId, channelIds[i]);
        if (!policy.has('VIEW_CHANNEL')) continue;
        const effective = ALL_CAPS.filter((c) => policy.has(c) && bot.has(c));
        const key = effective.join(',');
        let level = levels.get(key);
        if (level === undefined) levels.set(key, (level = countedLevel(effective)));
        if (!level) continue;
        counts[level]++;
        perChannel[i][level]++;
      }
    }
    return { id: pid, counts };
  });
  return {
    channels: channels.map((c, i) => ({ ...c, counts: perChannel[i] })),
    personas,
    considered: personaIds.length,
  };
}
