/**
 * Mirror cache (RFC-004 §5.5) — per-(guild, role) map of channel id → the
 * portal caps that Discord role holds there, backing `mirrorRole` access-role
 * scopes. Keys double as the role's visible-channel set (scope membership);
 * values back full-fidelity `mirrorCaps` roles.
 *
 * Fail-closed by construction: a miss recomputes synchronously from Discord's
 * warm gateway cache rather than serving a stale allow. Push events
 * (role/channel updates) invalidate entries; (re)connect flushes everything, so
 * the first resolve after a gateway gap always recomputes. The periodic
 * re-sync (if any) is then a backstop, not the primary freshness mechanism.
 */
import type { Capability } from '@animalabs/portal-protocol';
import type { DiscordBot } from './discord-bot.js';

export class MirrorCache {
  /** guildId → roleId → (channelId → caps the role holds there) */
  private cache = new Map<string, Map<string, Map<string, Set<Capability>>>>();

  constructor(private bot: DiscordBot) {}

  /** Per-channel caps `roleId` holds in `guildId` (keys = channels it can
   *  view). Recomputes (and caches) on a miss. */
  lookup(guildId: string, roleId: string): Map<string, Set<Capability>> {
    let byRole = this.cache.get(guildId);
    let entry = byRole?.get(roleId);
    if (!entry) {
      entry = this.bot.roleCapsByChannel(guildId, roleId);
      if (!byRole) this.cache.set(guildId, (byRole = new Map()));
      byRole.set(roleId, entry);
    }
    return entry;
  }

  /** A role's perms changed. @everyone underlies baseline visibility, so its
   *  change busts every role entry in the guild; otherwise just that role. */
  invalidateRole(guildId: string, roleId: string): void {
    const byRole = this.cache.get(guildId);
    if (!byRole) return;
    if (roleId === this.bot.everyoneRoleId(guildId)) byRole.clear();
    else byRole.delete(roleId);
  }

  /** A channel's overwrites changed — can shift visibility for *any* role, so
   *  drop the whole guild. */
  invalidateGuild(guildId: string): void {
    this.cache.delete(guildId);
  }

  /** Flush everything (call on gateway ready/reconnect). */
  clear(): void {
    this.cache.clear();
  }
}
