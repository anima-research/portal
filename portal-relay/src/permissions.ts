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
import type { Capability } from '@connectome/portal-protocol';
import type { GuildPolicy, PermissionsFile, PersonaPolicy } from './config.js';
import { WatchedFile } from './file-watch.js';

export type PermissionChange = {
  personaId: string;
  /** Granularity of what changed — drives how many channels the relay re-pushes. */
  scope: 'channel' | 'guild' | 'default' | 'reload';
  guildId?: string;
  channelId?: string;
};

export class PermissionsStore {
  private personas = new Map<string, PersonaPolicy>();
  private fileDefault: Capability[] = [];
  private listeners: Array<(c: PermissionChange) => void> = [];
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

  onChange(cb: (c: PermissionChange) => void): void {
    this.listeners.push(cb);
  }
  private emit(c: PermissionChange): void {
    for (const cb of this.listeners) cb(c);
  }

  // ── Resolution ──

  /** The policy-level capability set (before ∩ Discord reality). */
  resolve(personaId: string, guildId: string | null, channelId: string): Set<Capability> {
    const pol = this.personas.get(personaId);
    if (!pol) return new Set(this.fileDefault);
    if (guildId) {
      const g = pol.guilds?.[guildId];
      if (g) {
        if (g.channels?.[channelId]) return new Set(g.channels[channelId]);
        if (g.default) return new Set(g.default);
      }
    }
    return new Set(pol.default);
  }

  getPolicy(personaId: string): PersonaPolicy | undefined {
    return this.personas.get(personaId);
  }

  // ── Mutations (persist + emit) ──

  setPersonaDefault(personaId: string, caps: Capability[]): void {
    const pol = this.ensure(personaId);
    pol.default = caps;
    this.persist();
    this.emit({ personaId, scope: 'default' });
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
    const g = this.personas.get(personaId)?.guilds?.[guildId];
    if (g?.channels) {
      delete g.channels[channelId];
      this.persist();
      this.emit({ personaId, scope: 'channel', guildId, channelId });
    }
  }

  removePersona(personaId: string): void {
    if (this.personas.delete(personaId)) {
      this.persist();
      this.emit({ personaId, scope: 'reload' });
    }
  }

  private ensure(personaId: string): PersonaPolicy {
    let pol = this.personas.get(personaId);
    if (!pol) this.personas.set(personaId, (pol = { default: [] }));
    return pol;
  }
  private ensureGuild(personaId: string, guildId: string): GuildPolicy {
    const pol = this.ensure(personaId);
    pol.guilds ??= {};
    return (pol.guilds[guildId] ??= {});
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as PermissionsFile;
    const oldJson = new Map([...this.personas].map(([id, p]) => [id, JSON.stringify(p)]));
    this.fileDefault = next.default ?? [];
    this.personas = new Map(Object.entries(next.personas ?? {}));
    if (this.listeners.length) {
      const ids = new Set([...oldJson.keys(), ...this.personas.keys()]);
      for (const id of ids) {
        const before = oldJson.get(id);
        const after = this.personas.has(id) ? JSON.stringify(this.personas.get(id)) : undefined;
        if (before !== after) this.emit({ personaId: id, scope: 'reload' });
      }
    }
  }

  private persist(): void {
    const data: PermissionsFile = {
      default: this.fileDefault.length ? this.fileDefault : undefined,
      personas: Object.fromEntries(this.personas),
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
