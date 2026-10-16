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

/** Whether an invite has expired by `nowMs`. No expiresAt (absent or null)
 *  means no expiry. Any other value must be a timestamp string, and one that
 *  isn't, or doesn't parse, counts as expired: failing open would leave a
 *  bearer code claimable forever, the worst default an invite store can have.
 *  The claim check, the prune and the outstanding-mint count share it. */
export function inviteExpired(inv: InviteTemplate, nowMs: number): boolean {
  const expiresAt: unknown = inv.expiresAt;
  if (expiresAt == null) return false;
  if (typeof expiresAt !== 'string' || !expiresAt) return true;
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= nowMs;
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
    if (inviteExpired(inv, nowMs)) return 'expired';
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
    if (this.byCode.has(template.code)) throw new Error(`duplicate invite code ${codePrefix(template.code)}`);
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
      if (byCode.has(inv.code)) throw new Error(`duplicate invite code ${codePrefix(inv.code)}`);
      byCode.set(inv.code, inv);
      // Tell the operator now, rather than when a claimant is turned away.
      const problem = inviteLoadProblem(inv);
      if (problem) console.error(`[portal-relay] invite "${inviteName(inv, inv.code)}" ${problem}`);
    }
    this.byCode = byCode;
  }

  private persist(): void {
    this.pruneExpired();
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
   * expiresAt that isn't a timestamp string counts as long-expired (fail
   * closed, as check() reads it), so the first write drops such an invite;
   * the load warning has named it by then.
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [code, inv] of this.byCode) {
      if (inv && inviteExpired(inv, cutoff)) this.byCode.delete(code);
    }
  }
}

/** How logs name an invite: its label, or the start of its code. The code is a
 *  bearer credential, so a log line never carries it whole: an unlabelled
 *  invite is shown by a prefix of at most half its code, capped at the 12
 *  characters the mint audit shows, which for a generated `inv_` code find it
 *  in the invites file. */
export function inviteName(inv: InviteTemplate, code: string): string {
  return inv.label || codePrefix(code);
}

/** The start of an invite code, for a log line or an audit record: at most
 *  half the code, and at most the 12 characters that find a generated `inv_`
 *  code in the invites file. A live code is a bearer credential, so neither
 *  carries it whole. */
export function codePrefix(code: unknown): string {
  const text = String(code);
  return `${text.slice(0, Math.min(12, Math.floor(text.length / 2)))}…`;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The invite fields that decide what a claim grants and who may make it,
 * checked for shape before enroll or augment reads them: `mode`, `maxUses`,
 * `uses`, `roles`, legacy `caps`, and `grant` with its scope. The file is
 * hand-editable, and the code reads several of these by presence or as
 * found: a string where an array belongs would be read one character at a
 * time (as role names, capabilities or channel ids), `scope: { all: false }`
 * would grant everything because `all` is tested by presence, a misspelled
 * `mode` would make an augment-only invite mint personas, and a non-numeric
 * `maxUses` or `uses` would never exhaust. Returns the reason, or null when the shapes
 * are sound. Names are not checked: an unknown role, capability or channel
 * grants nothing.
 */
export function inviteShapeError(inv: InviteTemplate): string | null {
  // An optional field given as null reads as absent, as the code downstream
  // has always read it (?., ?? and !grant).
  const mode: unknown = inv.mode;
  if (mode != null && mode !== 'mint' && mode !== 'augment' && mode !== 'both') {
    return 'invite mode must be "mint", "augment" or "both"';
  }
  // maxUses is the exception to null reading as absent: check() has always
  // compared a null maxUses as a limit of 0, so such an invite is exhausted.
  const maxUses: unknown = inv.maxUses;
  if (maxUses !== undefined && !(Number.isInteger(maxUses) && (maxUses as number) >= 0)) {
    return 'invite maxUses must be a non-negative integer';
  }
  // The relay keeps `uses`, but in the same file: a string would never reach
  // maxUses, and consume() would concatenate onto it.
  const uses: unknown = inv.uses;
  if (uses != null && !(Number.isInteger(uses) && (uses as number) >= 0)) {
    return 'invite uses must be a non-negative integer';
  }
  if (inv.roles != null && !isStringArray(inv.roles)) return 'invite roles must be an array of strings';
  if (inv.caps != null && !isStringArray(inv.caps)) return 'invite caps must be an array of strings';
  // A guild the strict comparisons downstream could never match would leave
  // the persona with an inert grant and the invite spent.
  const guildId: unknown = inv.guildId;
  if (guildId != null && typeof guildId !== 'string') return 'invite guildId must be a string';
  // A falsy minter would skip the machine-mint recheck as if an admin had minted it.
  const mintedBy: unknown = inv.mintedBy;
  if (mintedBy != null && (typeof mintedBy !== 'string' || !mintedBy)) return 'invite mintedBy must be a non-empty string';
  const grant: unknown = inv.grant;
  if (grant == null) return null;
  if (typeof grant !== 'object') return 'invite grant must be an object';
  const { caps, scope } = grant as { caps?: unknown; scope?: unknown };
  if (!isStringArray(caps)) return 'invite grant caps must be an array of strings';
  // A grant of no capability, like a mirror or a channel list that names
  // nothing, applies as deny-all with the invite spent.
  if (caps.length === 0) return 'invite grant caps must name at least one capability';
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return 'invite grant scope must be an object';
  // A Scope is exactly one of its four forms; code downstream branches on
  // which key is present, so a second key or a false `all` would be misread.
  const kinds = ['channels', 'mirrorRole', 'mirrorRoles', 'all'].filter((key) => key in scope);
  if (kinds.length !== 1) {
    return 'invite grant scope must have exactly one of channels, mirrorRole, mirrorRoles or all';
  }
  const value = (scope as Record<string, unknown>)[kinds[0]!];
  if (kinds[0] === 'all' && value !== true) return 'invite grant scope all must be true';
  if ((kinds[0] === 'channels' || kinds[0] === 'mirrorRoles') && !isStringArray(value)) {
    return `invite grant scope ${kinds[0]} must be an array of strings`;
  }
  if (kinds[0] === 'mirrorRole' && typeof value !== 'string') return 'invite grant scope mirrorRole must be a string';
  // A mirror that names no role matches no channel: a deny-all persona with the invite spent.
  if ((kinds[0] === 'mirrorRole' && !value) || (kinds[0] === 'mirrorRoles' && ((value as string[]).length === 0 || (value as string[]).some((id) => !id)))) {
    return 'invite grant scope must name at least one mirrored role';
  }
  if (kinds[0] === 'channels' && ((value as string[]).length === 0 || (value as string[]).some((id) => !id))) {
    return 'invite grant scope channels must name at least one channel';
  }
  // Channels and mirrors are guild-scoped: without a guild, the grant would
  // apply as deny-all, or name no guild a mirror role can live in.
  if (kinds[0] === 'channels' && !inv.guildId) return 'invite grant scope channels needs the invite\'s guildId';
  if ((kinds[0] === 'mirrorRole' || kinds[0] === 'mirrorRoles') && !inv.guildId) return 'invite mirror grant is missing guildId';
  return null;
}

/** The fields only an enrollment reads, `namePrefix` and `subscriptions`.
 *  Enroll refuses a malformed one; a claim on an existing persona doesn't
 *  read them. Returns the reason, or null. */
export function inviteEnrollFieldError(inv: InviteTemplate): string | null {
  if (inv.namePrefix != null && typeof inv.namePrefix !== 'string') return 'invite namePrefix must be a string';
  if (inv.subscriptions != null && !isStringArray(inv.subscriptions)) return 'invite subscriptions must be an array of strings';
  return null;
}

/** What the file shows an invite can't do, for the load warning, as the end
 *  of a sentence about it: "can't be claimed" for a malformed field every
 *  claim reads or an expiresAt that isn't a timestamp string (every claim
 *  reads it as expired), and "can't enroll a persona" for a malformed field
 *  only an enrollment reads, on an invite that can enroll. Null when none. */
export function inviteLoadProblem(inv: InviteTemplate): string | null {
  const shape = inviteShapeError(inv);
  if (shape) return `can't be claimed: ${shape}`;
  const expiresAt: unknown = inv.expiresAt;
  if (expiresAt != null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    return "can't be claimed: invite expiresAt must be a timestamp string, so every claim reads it as expired";
  }
  if (inv.mode !== 'augment') {
    const enroll = inviteEnrollFieldError(inv);
    if (enroll) return `can't enroll a persona: ${enroll}`;
  }
  return null;
}
