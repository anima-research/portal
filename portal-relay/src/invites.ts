/**
 * Invite store — admin-minted access-rights *templates* that let new agents
 * self-register. An invite carries a capability profile plus optional limits
 * (max-uses, expiry); every persona enrolled through it inherits the same
 * caps. Live: hot-reloads on file edit (so an admin can add/revoke invites
 * without a restart) and persists its own use-count bumps.
 *
 * Separate from identity (who) and permissions (what) on purpose: an invite is
 * the *factory* for both — on a successful claim the relay mints an identity
 * and stamps the invite's caps as that persona's default policy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { InviteTemplate, InvitesFile } from './config.js';
import { WatchedFile } from './file-watch.js';

/**
 * Why an invite's grant (or deprecated blanket caps) can't be applied as
 * written, or null. A grant needs a guild (every scope resolves inside one),
 * at least one capability, and exactly one scope: a non-empty channel list,
 * one or more Discord roles to mirror, or `all: true`. Enroll and claim refuse
 * such an invite before anything is created or consumed, saying whoever
 * minted it must mint a new one; loading warns.
 */
export function grantShapeProblem(inv: InviteTemplate): string | null {
  const grant = inv.grant ?? (inv.caps?.length ? { caps: inv.caps, scope: { all: true as const } } : undefined);
  if (!grant) return null;
  if (!inv.guildId) return 'invite grants access but names no guild';
  const caps = (grant as { caps?: unknown }).caps;
  if (!Array.isArray(caps) || caps.length === 0 || !caps.every((c) => typeof c === 'string' && c)) {
    return 'invite grant names no capabilities';
  }
  const sc = (grant as { scope?: unknown }).scope as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object' || Object.keys(sc).length !== 1) {
    return 'invite grant scope must be exactly one of channels, mirrorRole, mirrorRoles or all';
  }
  const ids = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x);
  const ok =
    sc.all === true ||
    ids(sc.channels) ||
    (typeof sc.mirrorRole === 'string' && sc.mirrorRole !== '') ||
    ids(sc.mirrorRoles);
  return ok ? null : 'invite grant scope is malformed';
}

const isMode = (v: unknown) => v === 'mint' || v === 'augment' || v === 'both';
const MODE_RULE = 'must be "mint", "augment" or "both"';

/** '', false and 0: what the readers of an invite's `mode`, `caps` and
 *  `subscriptions` read as none. */
const blank = (v: unknown) => v === '' || v === false || v === 0;

/** Why an invite's mode can't be read, or null. None (absent, null, '', false
 *  or 0) reads as "mint". */
export function inviteModeProblem(inv: InviteTemplate): string | null {
  const m = (inv as { mode?: unknown }).mode;
  return m === undefined || m === null || blank(m) || isMode(m) ? null : `invite mode ${MODE_RULE}`;
}

/**
 * Why an invite can't be claimed as written, or null: a field a claim reads
 * holds a value outside its declared type, or the grant can't be applied
 * (grantShapeProblem). Every relay writer but scripts/mint-invite.mjs, whose
 * flags aren't checked (#62), builds these fields from checked values, so a
 * hand edit is what reaches them. Read as found, `roles` as a
 * string throws mid-enroll, a numeric `guildId` or a `caps` that isn't a list
 * grants nothing and spends the invite, a misspelled `mode` mints, and a
 * count that compares as no number at all, such as a word, never exhausts.
 * Enroll and claim refuse such an invite before anything is created or
 * consumed, the admin mint route refuses to store one, and loading warns,
 * naming an expiry that isn't a date too.
 * `null` reads as absent, except in `maxUses`: check() reads a null count as
 * exhausted (0 >= null), so it is refused rather than opened. '', false and
 * 0 in `mode`, `caps` and `subscriptions` read as none too, as their readers
 * read them, and a `uses` of false reads as 0, as a claim reads it. In
 * `roles`, '', 0 and false would throw where enroll and a claim read the
 * list, and in `uses` and `maxUses` '' would grow as text or exhaust the
 * invite, so they are refused there. A `grant` that is there must be an
 * object, so '', 0 and false are refused there too. A `uses` or `maxUses`
 * that isn't finite, such as JSON's 1e400, is refused as well, and the relay's
 * next save drops the invite: JSON would write it as null, which reads
 * otherwise (a null uses as 0).
 */
export function inviteShapeProblem(inv: InviteTemplate): string | null {
  const f = inv as unknown as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  // [field, rule, why, whether '', false and 0 read as none]
  const checks: Array<[string, (v: unknown) => boolean, string, boolean?]> = [
    ['guildId', (v) => typeof v === 'string', 'must be a string'],
    ['mintedBy', (v) => typeof v === 'string', 'must be a string'],
    ['namePrefix', (v) => typeof v === 'string', 'must be a string'],
    ['mode', isMode, MODE_RULE, true],
    ['caps', strings, 'must be a list of capabilities', true],
    ['roles', strings, 'must be a list of access role names'],
    ['subscriptions', strings, 'must be a list of channel ids', true],
    ['uses', (v) => (typeof v === 'number' && Number.isFinite(v)) || v === false, 'must be a finite number'],
  ];
  for (const [field, ok, why, blankIsNone] of checks) {
    const v = f[field];
    if (v === undefined || v === null || (blankIsNone && blank(v))) continue;
    if (!ok(v)) return `invite ${field} ${why}`;
  }
  // A grant that is there must be one: enroll reads a falsy one as absent and
  // falls back to the legacy caps, while a claim keeps it and grants nothing.
  if (f.grant !== undefined && f.grant !== null && (typeof f.grant !== 'object' || Array.isArray(f.grant))) {
    return 'invite grant must be an object, { caps, scope }';
  }
  if (f.maxUses !== undefined && !(typeof f.maxUses === 'number' && Number.isFinite(f.maxUses) && f.maxUses > 0)) {
    return 'invite maxUses must be a finite number above 0';
  }
  // check() already refuses such an expiry; this names it at load, since the
  // relay's next save drops it with the expired invites.
  const at = expiryOf(inv);
  if (at !== undefined && Number.isNaN(at)) return "invite expiresAt isn't a date, so it reads as expired and the relay's next save drops it";
  return grantShapeProblem(inv);
}

/** The count field holding a number JSON can't write (it would write null), if one does. */
function nonFiniteCount(inv: InviteTemplate): 'uses' | 'maxUses' | undefined {
  const f = inv as unknown as Record<string, unknown>;
  return (['uses', 'maxUses'] as const).find((k) => typeof f[k] === 'number' && !Number.isFinite(f[k]));
}

/** When an invite expires, in ms since the epoch, or undefined for never.
 *  Only a string names an expiry: absent, null, '' and false read as none,
 *  and any other value can't be read as a time, so it
 *  counts as long expired (NaN). That includes 0, which a truthiness test
 *  would read as none. `Date.parse` would read a number as a date
 *  string: 2030 as 2030-01-01, 99999 as the year 99999. */
function expiryOf(inv: InviteTemplate): number | undefined {
  const at = (inv as { expiresAt?: unknown }).expiresAt;
  if (at === undefined || at === null || at === '' || at === false) return undefined;
  return typeof at === 'string' ? Date.parse(at) : NaN;
}

export type InviteRejection =
  | 'unknown'
  | 'expired'
  | 'exhausted';

export class InviteStore {
  private byCode = new Map<string, InviteTemplate>();
  private file?: WatchedFile;

  constructor(private path: string) {
    this.reload();
  }

  startWatching(): void {
    this.file = new WatchedFile(this.path, () => this.reload());
    this.file.start();
  }

  stopWatching(): void {
    this.file?.stop();
  }

  /** Validate a code without consuming it. Returns the template or a reason. */
  check(code: string, nowMs: number): InviteTemplate | InviteRejection {
    const inv = this.byCode.get(code);
    if (!inv) return 'unknown';
    const at = expiryOf(inv);
    // Fail CLOSED on an unparseable expiry: `NaN <= now` is false, so the
    // naive comparison silently turned a malformed timestamp into a
    // never-expiring invite — the most dangerous default a bearer-code
    // store can have.
    if (at !== undefined && (!Number.isFinite(at) || at <= nowMs)) return 'expired';
    if (inv.maxUses !== undefined && (inv.uses ?? 0) >= inv.maxUses) return 'exhausted';
    return inv;
  }

  /** Bump an invite's use count and persist. Call after a successful mint. */
  consume(code: string): void {
    const inv = this.byCode.get(code);
    if (!inv) return;
    inv.uses = (inv.uses ?? 0) + 1;
    this.persist();
  }

  all(): InviteTemplate[] {
    return [...this.byCode.values()];
  }

  get(code: string): InviteTemplate | undefined {
    return this.byCode.get(code);
  }

  // ── Mutations (persist) — RFC-005 admin API ──

  /** Add a new invite template. Throws on duplicate code. Returns it. */
  mint(template: InviteTemplate): InviteTemplate {
    if (this.byCode.has(template.code)) throw new Error(`duplicate invite code ${template.code}`);
    const inv = { uses: 0, ...template };
    this.byCode.set(inv.code, inv);
    this.persist();
    return inv;
  }

  /** Remove an invite (forward-only: past grants persist — RFC-005 §5.8). */
  revoke(code: string): boolean {
    const ok = this.byCode.delete(code);
    if (ok) this.persist();
    return ok;
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as InvitesFile;
    if (!Array.isArray(next.invites)) throw new Error('invites file: invites must be an array');
    const byCode = new Map<string, InviteTemplate>();
    for (const inv of next.invites) {
      if (!inv.code) throw new Error('invite missing code');
      if (byCode.has(inv.code)) throw new Error(`duplicate invite code ${inv.code}`);
      byCode.set(inv.code, inv);
    }
    this.byCode = byCode;
    // An invite a claim can't read as written (a field of the wrong type, a
    // grant with no guild, no caps or a malformed scope) is refused at enroll
    // and claim. Flag it so it is fixed rather than discovered by the agent
    // that tries it.
    const bad = [...byCode.values()]
      .map((i) => [i, inviteShapeProblem(i)] as const)
      .filter(([, why]) => why)
      .map(([i, why]) => `${i.label ?? String(i.code).slice(0, 12)} (${why}${nonFiniteCount(i) ? ", and the relay's next save drops it" : ''})`);
    if (bad.length) {
      console.error(`[portal-relay] invites: ${bad.length} invite(s) will be refused: ${bad.join('; ')}`);
    }
  }

  private persist(): void {
    this.prune();
    const data: InvitesFile = { invites: this.all() };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }

  /**
   * Drop invites that expired more than 24h ago. Machine mints (mint_invite,
   * TTL ≤ 60min) would otherwise accumulate forever and every persist() is a
   * full-file rewrite — O(total) bytes per mint. The 24h grace keeps a short
   * forensic tail on disk; the audit log holds provenance permanently. An
   * expiresAt that isn't a date (expiryOf's NaN: a value that isn't a string,
   * or a string Date.parse can't read) counts as long expired (fail closed,
   * matches check). An invite whose uses or maxUses is a number that isn't
   * finite goes too, since JSON can't write either as read: it would write
   * null.
   */
  private prune(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [code, inv] of this.byCode) {
      if (nonFiniteCount(inv)) {
        this.byCode.delete(code);
        continue;
      }
      const at = expiryOf(inv);
      if (at === undefined) continue;
      if (!Number.isFinite(at) || at <= cutoff) this.byCode.delete(code);
    }
  }
}
