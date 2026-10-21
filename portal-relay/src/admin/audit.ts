/**
 * Append-only audit log (RFC-005 §5.5). One JSON object per line (JSONL). Every
 * admin mutation — and every `claim_invite` that changed something, or may
 * have — appends a record; failed authz attempts are recorded too (§7). The
 * panel's Audit tab reads it, guild-filtered.
 *
 * JSONL is append-only *by convention*: a shell user can still edit the file. A
 * tamper-evident hash chain is a future hardening (noted in the RFC review), not
 * built here. For now the value is traceability of in-band (API) changes, which
 * is the gap the RFC set out to close.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * An invite code as a claim's audit record keeps it, and as the panel's audit
 * view shows any record's code. Codes are bearer credentials, so only a prefix
 * is kept or shown: 12 characters of a relay-made code (inv_ + 24), and none
 * of a shorter, hand-chosen one, since a prefix of it could be most of it.
 */
export function auditCode(code: string): string {
  return code.length >= 28 ? `${code.slice(0, 12)}…` : '(code hidden)';
}

export interface AuditActor {
  /** Discord user id for admin actions, or the persona id for self-service. */
  id: string;
  name: string;
  /** 'admin' = panel/API action; 'persona' = self-service (claim_invite). */
  kind: 'admin' | 'persona';
}

export interface AuditRecord {
  ts: string; // ISO timestamp
  actor: AuditActor;
  action: string; // e.g. 'invite.mint', 'persona.roles.set', 'authz.denied'
  /** What was acted on (invite code, persona id, role name, …). */
  target?: string;
  guildId?: string;
  /** Whether the action succeeded (false for denied/blocked attempts). */
  ok: boolean;
  before?: unknown;
  after?: unknown;
  /** Free-form extra context (reason for denial, request path, …). */
  detail?: Record<string, unknown>;
}

export class AuditLog {
  constructor(
    private path: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Append one record. Never throws into the request path — logs on failure. */
  append(rec: Omit<AuditRecord, 'ts'>): void {
    const full: AuditRecord = { ts: new Date(this.now()).toISOString(), ...rec };
    try {
      appendFileSync(this.path, JSON.stringify(full) + '\n');
    } catch (e) {
      console.error('[portal-admin] audit append failed:', (e as Error).message);
    }
  }

  /**
   * Read records, newest first, optionally filtered to a guild and capped. Reads
   * the whole file (fine at expected volumes; revisit if the log grows large).
   */
  read(opts: { guildId?: string; limit?: number } = {}): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    const limit = opts.limit ?? 200;
    const lines = readFileSync(this.path, 'utf8').split('\n');
    const out: AuditRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line) as AuditRecord;
      } catch {
        continue; // skip a corrupt line rather than fail the whole read
      }
      if (opts.guildId && rec.guildId !== opts.guildId) continue;
      out.push(rec);
    }
    return out;
  }
}
