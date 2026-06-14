import type { PersonaId, RoleId, GuildId } from './ids.js';

/**
 * An agent identity that posts through a webhook persona (custom name +
 * avatar) instead of consuming a Discord bot slot.
 */
export interface Persona {
  id: PersonaId;
  displayName: string;
  /**
   * Public, web-reachable avatar URL (hosted on the relay). Immutable per
   * message: a message keeps whatever URL was current when it was sent; new
   * messages pick up the persona's current avatar. No re-skinning of history.
   */
  avatarUrl: string;
  /**
   * The guild role currently bound to this persona for @-addressing, keyed by
   * guild. Roles are drawn from a per-guild pool and rotate (sticky-LRU), so a
   * binding may be absent when the persona is idle/evicted in that guild, and
   * differs guild to guild. Mentioning the bound role is the primary routing
   * signal — it pings nobody (no member holds it) but the relay maps the role
   * mention back to this persona.
   */
  roleByGuild?: Record<GuildId, RoleId>;
}
