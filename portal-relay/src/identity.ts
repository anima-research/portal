/**
 * Identity store — *who* a persona is: id, display name, avatar, auth token.
 * Separate from permissions (see permissions.ts). Live: hot-reloads on file
 * edit and exposes mutators; both paths fire onChange so the relay can emit
 * persona_update (and rename pooled roles).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Persona } from '@animalabs/portal-protocol';
import type { IdentityFile, PersonaIdentity } from './config.js';
import { WatchedFile } from './file-watch.js';

export type IdentityChange =
  | { kind: 'upsert'; id: string; prev?: PersonaIdentity; next: PersonaIdentity }
  | { kind: 'remove'; id: string; prev: PersonaIdentity };

const TOKEN_HASH_PREFIX = 'sha256:';

/**
 * Hash a plaintext token for at-rest storage / comparison (RFC-005 §5.9). Persona
 * tokens are high-entropy random secrets, so a fast cryptographic hash suffices —
 * there is no low-entropy password to brute-force, so no slow KDF is needed. A
 * leaked `identity.json` then can't be replayed (it holds only hashes).
 */
export function hashToken(plain: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(plain).digest('hex');
}

/** Mint a fresh plaintext persona token (delivered to the agent, stored hashed). */
export function generateToken(): string {
  return `pt_${randomBytes(24).toString('base64url')}`;
}

/** Whether a stored token value is already hashed-at-rest. */
export function isHashedToken(v: string): boolean {
  return v.startsWith(TOKEN_HASH_PREFIX);
}

export class IdentityStore {
  private byId = new Map<string, PersonaIdentity>();
  private byHash = new Map<string, string>(); // at-rest token hash → id
  private listeners: Array<(c: IdentityChange) => void> = [];
  private file?: WatchedFile;

  constructor(
    private path: string,
    private avatarBaseUrl: string,
  ) {
    this.reload();
  }

  startWatching(): void {
    this.file = new WatchedFile(this.path, () => this.reload());
    this.file.start();
  }

  stopWatching(): void {
    this.file?.stop();
  }

  onChange(cb: (c: IdentityChange) => void): void {
    this.listeners.push(cb);
  }

  private emit(c: IdentityChange): void {
    for (const cb of this.listeners) cb(c);
  }

  // ── Reads ──

  /** Authenticate a presented plaintext token against the at-rest hash. */
  authenticate(token: string, personaId: string): PersonaIdentity | null {
    const id = this.byHash.get(hashToken(token));
    const p = id ? this.byId.get(id) : undefined;
    return p && p.id === personaId ? p : null;
  }

  get(id: string): PersonaIdentity | undefined {
    return this.byId.get(id);
  }

  all(): PersonaIdentity[] {
    return [...this.byId.values()];
  }

  avatarUrl(p: PersonaIdentity): string {
    if (/^https?:\/\//.test(p.avatar)) return p.avatar;
    return this.avatarBaseUrl && p.avatar ? `${this.avatarBaseUrl}/${p.avatar}` : p.avatar;
  }

  toPersona(p: PersonaIdentity, roleByGuild?: Record<string, string>): Persona {
    return {
      id: p.id,
      displayName: p.displayName,
      avatarUrl: this.avatarUrl(p),
      ...(roleByGuild && Object.keys(roleByGuild).length ? { roleByGuild } : {}),
    };
  }

  // ── Mutations (persist + emit) ──

  /** Create or update a persona. The `token` field MUST already be hashed
   *  (use {@link hashToken}); the store never sees plaintext at rest. */
  upsert(p: PersonaIdentity): void {
    const prev = this.byId.get(p.id);
    if (prev && prev.token !== p.token) this.byHash.delete(prev.token);
    this.byId.set(p.id, p);
    this.byHash.set(p.token, p.id);
    this.persist();
    this.emit({ kind: 'upsert', id: p.id, prev, next: p });
  }

  remove(id: string): void {
    const prev = this.byId.get(id);
    if (!prev) return;
    this.byId.delete(id);
    this.byHash.delete(prev.token);
    this.persist();
    this.emit({ kind: 'remove', id, prev });
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as IdentityFile;
    if (!Array.isArray(next.personas)) throw new Error('identity file: personas must be an array');
    const oldById = this.byId;
    this.byId = new Map();
    this.byHash = new Map();
    let plaintextSeen = 0;
    for (const p of next.personas) {
      if (this.byId.has(p.id)) throw new Error(`duplicate persona id ${p.id}`);
      if (this.byHash.has(p.token)) throw new Error(`duplicate token for ${p.id}`);
      if (!isHashedToken(p.token)) plaintextSeen++;
      this.byId.set(p.id, p);
      this.byHash.set(p.token, p.id);
    }
    if (plaintextSeen > 0) {
      // RFC-005 §5.9: tokens are hashed-at-rest. A plaintext token can't match a
      // hashed `identify` and so will never authenticate — warn loudly rather
      // than fail silently. Run scripts/rotate-tokens.mjs to migrate (forced
      // rotation: new tokens are minted, hashed, and must be redelivered).
      console.error(
        `[portal-relay] WARNING: ${plaintextSeen} identity token(s) are not hashed; ` +
          `they will NOT authenticate. Migrate with scripts/rotate-tokens.mjs.`,
      );
    }
    // Diff → emit (only meaningful once listeners are attached, i.e. post-boot).
    if (this.listeners.length) {
      for (const [id, next2] of this.byId) {
        const prev = oldById.get(id);
        if (!prev || prev.displayName !== next2.displayName || prev.avatar !== next2.avatar || prev.token !== next2.token) {
          this.emit({ kind: 'upsert', id, prev, next: next2 });
        }
      }
      for (const [id, prev] of oldById) {
        if (!this.byId.has(id)) this.emit({ kind: 'remove', id, prev });
      }
    }
  }

  private persist(): void {
    const data: IdentityFile = { personas: this.all() };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }
}
