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
    if (inv.expiresAt) {
      const at = Date.parse(inv.expiresAt);
      // Fail CLOSED on an unparseable expiry: `NaN <= now` is false, so the
      // naive comparison silently turned a malformed timestamp into a
      // never-expiring invite — the most dangerous default a bearer-code
      // store can have.
      if (!Number.isFinite(at) || at <= nowMs) return 'expired';
    }
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
   * unparseable expiresAt counts as long-expired (fail closed, matches check).
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [code, inv] of this.byCode) {
      if (!inv?.expiresAt) continue;
      const at = Date.parse(inv.expiresAt);
      if (!Number.isFinite(at) || at <= cutoff) this.byCode.delete(code);
    }
  }
}
