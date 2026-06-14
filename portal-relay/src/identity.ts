/**
 * Identity store — *who* a persona is: id, display name, avatar, auth token.
 * Separate from permissions (see permissions.ts). Live: hot-reloads on file
 * edit and exposes mutators; both paths fire onChange so the relay can emit
 * persona_update (and rename pooled roles).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Persona } from '@connectome/portal-protocol';
import type { IdentityFile, PersonaIdentity } from './config.js';
import { WatchedFile } from './file-watch.js';

export type IdentityChange =
  | { kind: 'upsert'; id: string; prev?: PersonaIdentity; next: PersonaIdentity }
  | { kind: 'remove'; id: string; prev: PersonaIdentity };

export class IdentityStore {
  private byId = new Map<string, PersonaIdentity>();
  private byToken = new Map<string, string>(); // token → id
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

  authenticate(token: string, personaId: string): PersonaIdentity | null {
    const id = this.byToken.get(token);
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

  /** Create or update a persona. Token/displayName/avatar all settable. */
  upsert(p: PersonaIdentity): void {
    const prev = this.byId.get(p.id);
    if (prev && prev.token !== p.token) this.byToken.delete(prev.token);
    this.byId.set(p.id, p);
    this.byToken.set(p.token, p.id);
    this.persist();
    this.emit({ kind: 'upsert', id: p.id, prev, next: p });
  }

  remove(id: string): void {
    const prev = this.byId.get(id);
    if (!prev) return;
    this.byId.delete(id);
    this.byToken.delete(prev.token);
    this.persist();
    this.emit({ kind: 'remove', id, prev });
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as IdentityFile;
    if (!Array.isArray(next.personas)) throw new Error('identity file: personas must be an array');
    const oldById = this.byId;
    this.byId = new Map();
    this.byToken = new Map();
    for (const p of next.personas) {
      if (this.byId.has(p.id)) throw new Error(`duplicate persona id ${p.id}`);
      if (this.byToken.has(p.token)) throw new Error(`duplicate token for ${p.id}`);
      this.byId.set(p.id, p);
      this.byToken.set(p.token, p.id);
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
