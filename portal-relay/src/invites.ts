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
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= nowMs) return 'expired';
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
    const data: InvitesFile = { invites: this.all() };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }
}
