/**
 * Name-based channel addressing for the portal surface.
 *
 * Ported from discord-mcpl's `channel-names.ts` (Sol-reviewed, 2026-08-04),
 * same doctrine, portal's shapes:
 *
 * WHY. Every portal tool used to require the raw Discord snowflake verbatim.
 * Models *regenerate* those token-by-token rather than copying them, and
 * snowflakes are worst-case objects for that: pure digit sequences, no
 * semantic redundancy, no checksum. The dangerous failure is not the mangled
 * id that bounces — it is the real-but-WRONG id plucked from context, which
 * delivers silently to the wrong room.
 *
 * DESIGN: accept back the string we already print. `toDescriptor`
 * (channels.ts) labels channels `#name (GuildName)` and `list_channels`
 * returns the same label, so anything visible in a listing is pasteable into
 * a send. Display form == address form, and every producer of that string
 * routes through {@link formatChannelLabel} so the two sides cannot drift.
 *
 * Guild qualification matters: bare `#general` collides across guilds, and a
 * persona in several servers hits that constantly. The qualified form resolves
 * normally; two same-named channels in ONE guild still fall through to the
 * ambiguity error, which then quotes ids because labels no longer separate
 * them.
 *
 * NO FUZZY MATCHING. Exact name, case-insensitive, leading `#` optional. A
 * "did you mean" would reintroduce silent wrong-room delivery in friendlier
 * packaging.
 *
 * IDS ARE A CO-EQUAL ADDRESS FORM, NOT A FAILURE STATE. The problem this
 * solves is monoculture — ids being the ONLY thing to paste. An id is stable
 * across renames, unambiguous by construction, and the only way to reach the
 * threads this resolver excludes (thread names are not unique even within one
 * channel). A raw snowflake and the `portal:<id>` composite pass through
 * untouched.
 *
 * Candidates are built from the client cache, which after portal#27 holds only
 * channels the persona has a capability in — and are filtered on that again
 * here, so a name can never address an ungranted channel, and an ungranted
 * `#general` cannot manufacture a spurious collision with a granted one.
 *
 * Free of any transport so it is unit-testable; the agent supplies candidates.
 */
import type { PortalChannel, PortalGuild } from '@animalabs/portal-protocol';

/** Discord snowflakes are 17-20 digits. Anything all-digits in that range is
 *  treated as an id and passed through untouched (backwards compatible). */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/**
 * THE canonical `#name (GuildName)` formatter. Display form == address form is
 * the load-bearing claim of this module: the string a listing prints must be
 * the string a tool accepts. Every producer routes through here. A channel
 * whose guild name is unknown (DM, or a guild the relay never described) is
 * labelled `#name` alone, which parses as the unqualified form.
 */
export function formatChannelLabel(name: string | null, guildName?: string | null): string {
  const base = `#${name ?? '?'}`;
  return guildName ? `${base} (${guildName})` : base;
}

export type ChannelRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; guild?: string };

/**
 * Parse an incoming channelId argument.
 *
 * Accepted:
 *   `123456789012345678`      -> id (passthrough)
 *   `portal:<channelId>`      -> id (the MCPL composite this server announces)
 *   `#general` / `general`    -> name, unqualified
 *   `#general (Connectome)`   -> name, guild-qualified
 *
 * Returns null for input that is neither a usable id nor a plausible name.
 */
export function parseChannelRef(raw: string): ChannelRef | null {
  const value = raw.trim();
  if (!value) return null;
  if (isSnowflake(value)) return { kind: 'id', id: value };

  // The MCPL composite, matched with the same predicate as parsePortalChannelId
  // (channels.ts) and deliberately no stricter.
  const parts = value.split(':');
  if (parts.length === 2 && parts[0] === 'portal' && parts[1]) {
    return { kind: 'id', id: parts[1] };
  }

  // `#name (Guild)` — guild in trailing parens. Guild names can contain almost
  // anything, so match the LAST parenthesised group and take the rest as name.
  const qualified = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(value);
  if (qualified && qualified[2].trim()) {
    const name = stripHash(qualified[1]);
    if (name) return { kind: 'name', name, guild: qualified[2].trim() };
  }

  const name = stripHash(value);
  return name ? { kind: 'name', name } : null;
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, '').trim();
}

/** A channel the persona can currently address, already capability-filtered. */
export interface ChannelCandidate {
  id: string;
  name: string;
  guildId: string | null;
  guildName?: string;
  type: PortalChannel['type'];
}

export function channelLabel(c: ChannelCandidate): string {
  return formatChannelLabel(c.name, c.guildName);
}

export type ResolveResult =
  /** `matched` is present when a name resolved, absent when the input was
   *  already an id (nothing was looked up). */
  | { ok: true; id: string; matched?: ChannelCandidate }
  | { ok: false; reason: 'not-found' | 'ambiguous'; message: string };

/** Ordinary message channels — also what the tie-break prefers over a
 *  same-named voice channel. (The relay maps announcement channels to 'text'.) */
const TEXTLIKE: ReadonlySet<string> = new Set(['text']);

/** Kinds addressable by NAME. Everything else stays reachable by id only:
 *  categories/forums are not sendable, and thread names are not unique even
 *  within one channel, so admitting them would fire the ambiguity error
 *  constantly. An allowlist of named kinds, deliberately not "all but a few":
 *  a new kind defaults to id-only until someone classifies it. */
const NAME_ADDRESSABLE: ReadonlySet<string> = new Set([...TEXTLIKE, 'voice']);

export function isNameAddressableKind(kind: string): boolean {
  return NAME_ADDRESSABLE.has(kind);
}

/**
 * Candidates from the client cache. Applies the capability filter BEFORE
 * matching — the security-relevant step, kept out of the matcher so it is
 * testable on its own.
 */
export function buildCandidates(
  channels: Iterable<PortalChannel>,
  guilds: Iterable<PortalGuild>,
): ChannelCandidate[] {
  const guildName = new Map<string, string>();
  for (const g of guilds) guildName.set(g.id, g.name);
  const out: ChannelCandidate[] = [];
  for (const c of channels) {
    if (!c || !c.name) continue;
    if (!NAME_ADDRESSABLE.has(c.type)) continue;
    if (!c.capabilities || c.capabilities.length === 0) continue;
    out.push({
      id: c.id,
      name: c.name,
      guildId: c.guildId,
      guildName: c.guildId ? guildName.get(c.guildId) : undefined,
      type: c.type,
    });
  }
  return out;
}

/**
 * Resolve a parsed name against candidates. The caller MUST have applied the
 * capability filter already (buildCandidates does).
 */
export function resolveChannelName(
  ref: { name: string; guild?: string },
  candidates: ChannelCandidate[],
): ResolveResult {
  const wantName = ref.name.toLowerCase();
  const wantGuild = ref.guild?.toLowerCase();

  let matches = candidates.filter((c) => c.name.toLowerCase() === wantName);
  if (wantGuild) {
    matches = matches.filter((c) => (c.guildName ?? '').toLowerCase() === wantGuild);
  }

  // TIE-BREAK BY TYPE before declaring ambiguity: a stock Discord server ships
  // a VOICE channel named "General" beside text #general, and matching is
  // case-insensitive, so this collision is the default state of an ordinary
  // server. Only applied when it fully disambiguates.
  if (matches.length > 1) {
    const textlike = matches.filter((c) => TEXTLIKE.has(c.type));
    if (textlike.length === 1) matches = textlike;
  }

  if (matches.length === 1) return { ok: true, id: matches[0].id, matched: matches[0] };

  if (matches.length === 0) {
    const near = candidates.filter((c) => c.name.toLowerCase() === wantName);
    if (wantGuild && near.length) {
      return {
        ok: false,
        reason: 'not-found',
        message:
          `No channel #${ref.name} in a guild named "${ref.guild}". ` +
          `That name exists elsewhere: ${near.map(channelLabel).join(', ')}`,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message:
        `No addressable channel named #${ref.name}` +
        (ref.guild ? ` in "${ref.guild}"` : '') +
        `. Use list_channels to see what is addressable, or pass the channel id.`,
    };
  }

  // Ambiguous. Quote qualified LABELS (themselves valid addresses). When two
  // matches share a label the label cannot separate them and a label-only
  // message is a dead end — so include the id, which is the only
  // distinguishing fact.
  const labels = matches.map(channelLabel);
  const labelsDistinguish = new Set(labels).size === matches.length;
  const options = matches
    .map((c) => (labelsDistinguish
      ? `"${channelLabel(c)}"`
      : `"${channelLabel(c)}" [${c.type}] (id ${c.id})`))
    .join(', ');
  return {
    ok: false,
    reason: 'ambiguous',
    message: `#${ref.name} is ambiguous — ${matches.length} channels match. Re-send with one of: ${options}`,
  };
}

/** Resolve any accepted channel reference (id, composite, or label). */
export function resolveChannelRef(raw: string, candidates: () => ChannelCandidate[]): ResolveResult {
  const parsed = parseChannelRef(raw);
  if (!parsed) {
    return { ok: false, reason: 'not-found', message: `Unusable channel reference: "${raw}"` };
  }
  if (parsed.kind === 'id') return { ok: true, id: parsed.id };
  return resolveChannelName(parsed, candidates());
}
