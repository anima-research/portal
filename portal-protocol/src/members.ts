import type { GuildId, RoleId, UserId } from './ids.js';

/** A guild member, for authorization gating + mention resolution (RFC A1). */
export interface PortalMember {
  userId: UserId;
  username: string;
  /** Global display name, falling back to username. */
  displayName: string;
  /** Per-guild nickname, if set. */
  nickname: string | null;
  bot: boolean;
  /** Role ids held in the guild. */
  roles: RoleId[];
}

/** A guild role (for resolving role mentions / authorization). */
export interface PortalRole {
  id: RoleId;
  guildId: GuildId;
  name: string;
  /** Whether this role is one of the relay's pooled persona-addressing roles. */
  pooled: boolean;
}
