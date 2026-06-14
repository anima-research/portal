# PORTAL RFC-002 — `list_roles` RPC (role catalog for name-based authorization)

- **Status:** ✅ Implemented (2026-06-14)
- **Author:** Antra (drafted with Claude Code)
- **Date:** 2026-06-14
- **Affects:** `portal-protocol` (`rpc.ts`), `portal-relay` (`relay.ts`, `discord-bot.ts`), `portal-mcpl` (tool surface)

> **Implementation note:** `DiscordBot` doesn't hold the role-pool prefix (only
> `RolePool` does), so `listRoles(guildId, poolPrefix)` takes the prefix as a
> param and the relay passes `config.rolePool.prefix` —
> `this.bot.listRoles(p.guildId, this.config.rolePool.prefix)`. Exposed as the
> `list_roles` MCPL tool too. Verified live (`scripts/p1-live.mjs`): 42 roles
> against antra's guild, `@everyone` present, `pooled` true exactly for `portal-*`,
> and every `PortalMember.roles[]` id resolves via the catalog.
- **Protocol version:** folds into the RFC-001 minor bump (→ 0.2.0); purely additive
- **Depends on:** nothing. **Blocks:** ChapterX portal-connector P3 (role-name auth).

---

## 1. Summary

Add one read-only RPC, `list_roles({ guildId }) → { roles: PortalRole[] }`, that
returns a guild's role catalog (id + name + pooled flag). It mirrors the existing
`list_members` RPC and reuses the already-defined-but-unused `PortalRole` type.

## 2. Motivation

Portal exposes role **ids** everywhere — `PortalMember.roles: RoleId[]`,
`PortalMessage.mentions.roles: RoleId[]` — but never role **names**. Any client
that authorizes on role *names* is stuck.

The concrete driver is the **ChapterX portal-connector**. ChapterX gates
`.steer` and `.history` commands, and populates `DiscordMessage.authorRoles`, by
role **name** (its discord.js path does `member.roles.cache.map(r => r.name)`).
Deployed `config.yaml` files list `authorized_roles`/`steer_roles` as names. To
run ChapterX through portal without rewriting every config, the connector must
resolve `RoleId → name`, which today is impossible.

This is also the natural companion to RFC-001's `list_members` (A1) and
`resolve_mentions` (A2): members give you `roleId[]` per user, and you need a
catalog to make those ids meaningful.

## 3. Design

### Protocol (`portal-protocol/src/rpc.ts`)

`PortalRole` already exists (`members.ts`), currently unused:

```ts
export interface PortalRole {
  id: RoleId;
  guildId: GuildId;
  name: string;
  /** Whether this role is one of the relay's pooled persona-addressing roles. */
  pooled: boolean;
}
```

Add the params/result and the `RpcMethods` entry (the single source of truth, so
the relay handler table and client method surface both derive from it):

```ts
export interface ListRolesParams { guildId: GuildId; }
export interface ListRolesResult { roles: PortalRole[]; }

// in RpcMethods:
list_roles: { params: ListRolesParams; result: ListRolesResult };
```

Export `PortalRole` from the package index if not already.

### Relay handler (`portal-relay/src/relay.ts`)

Mirror the `list_members` case:

```ts
case 'list_roles': {
  const p = params as RpcParams<'list_roles'>;
  return { roles: this.bot.listRoles(p.guildId) };
}
```

### Bot method (`portal-relay/src/discord-bot.ts`)

There is already a prefix-filtered role reader (used for the persona role pool).
Generalize it into a full catalog reader that flags pooled roles by the pool
prefix:

```ts
listRoles(guildId: string): PortalRole[] {
  const guild = this.client.guilds.cache.get(guildId);
  if (!guild) return [];
  return [...guild.roles.cache.values()].map((r) => ({
    id: r.id,
    guildId,
    name: r.name,
    pooled: r.name.startsWith(this.rolePoolPrefix), // default "portal-"
  }));
}
```

(Thread the pool prefix in, or import the shared constant the role-pool uses.)

### Availability — no privileged intent required

Unlike `list_members` (which needs the privileged **GuildMembers** intent and so
returns `membersAvailable: false` when absent), **roles arrive with the base
`Guilds` intent** and are kept in `guild.roles.cache`. So `list_roles` is
**always** fully populated — no `rolesAvailable` flag is needed. This is worth
documenting because it means name-based authorization is reliable even on relay
bots that lack GuildMembers (where `list_members` degrades).

> Caveat: which **members** hold a role still depends on the GuildMembers intent
> (that's `list_members`'s problem). `list_roles` only resolves *what roles
> exist and their names* — exactly the missing half.

## 4. Client usage (illustrative — what ChapterX will do)

```ts
// build a guildId → (roleId → name) map, lazily, with a short TTL
const { roles } = await client.call('list_roles', { guildId });
const nameById = new Map(roles.map((r) => [r.id, r.name]));

// fetchMemberRoles(userId, guildId): names
const { members } = await client.call('list_members', { guildId, query });
const m = members.find((x) => x.userId === userId);
return m ? m.roles.map((id) => nameById.get(id)).filter(Boolean) : null;
```

## 5. Compatibility & testing

- **Additive** — new method only; safe under the RFC-001 minor bump. Clients that
  ignore unknown methods are unaffected.
- **Test (live, mirrors `scripts/p1-live.mjs`):** call `list_roles` against
  antra's guild, assert the `@everyone` role and the pooled `portal-*` roles
  appear, `pooled` is true exactly for the prefixed ones, and a known custom role
  resolves to its name. Cross-check: take a `PortalMember.roles[]` from
  `list_members` and confirm every id resolves via the `list_roles` catalog.
- **Unit:** `listRoles` maps cache → `PortalRole[]` and flags `pooled` by prefix.

## 6. Effort

~half a day: ~10 lines of protocol, one relay case, one bot method generalized
from the existing prefix reader, plus the live assertion in the P1 script.
