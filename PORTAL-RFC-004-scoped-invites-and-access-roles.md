# PORTAL RFC-004 — Scoped invites & role-based permissions (with Discord-role mirroring)

- **Status:** Draft / proposed
- **Author:** Antra (drafted with Claude Code)
- **Date:** 2026-06-14
- **Affects:** `portal-relay` (`config.ts`, `invites.ts`, `permissions.ts`, `relay.ts` `enroll`, `discord-bot.ts`), config file shapes (identity/permissions/invites), optionally `portal-protocol` (if role info is surfaced on the wire)
- **Protocol version:** mostly additive at the config layer; a `portal-protocol` minor bump only if access-role membership is exposed to clients
- **Depends on:** RFC-002 (`list_roles` — the role catalog mirroring builds on). **Blocks:** any multi-tenant or publicly-reachable relay deployment.

---

## 1. Summary

Replace the relay's flat, blanket capability grants with a **scoped, role-based**
permission model:

1. **Scoped invites** — an invite grants a *scoped* policy (a channel/guild
   scope + caps), not a cap list applied to every channel.
2. **Access roles** — named, reusable scoped-policy templates, per-guild or
   global. Personas are *assigned roles*; effective permissions are the union of
   their roles. Invites grant roles, not raw caps.
3. **Discord-role mirroring** — an access role can derive its channel scope from
   a Discord role's actual channel visibility (`permissionsFor`), so portal
   access tracks Discord's own permission model as the source of truth.

This closes a live security hole (below) and makes permission management tractable
(manage *K roles*, not *M personas × N channels*).

## 2. Motivation

### The security hole (demonstrated)

The relay's permission gate is **policy ∩ what the bot can actually do in the
channel** (`permissions.ts` `computeCapabilities`, intersecting with
`channel.permissionsFor(me)`). That intersection is meant to inherit Discord's
per-channel privacy. But:

- The deployed relay bot is **guild admin**, so `permissionsFor(me)` returns
  *everything* — the intersection no longer restricts anything.
- Enrollment grants a **blanket default policy**: `relay.ts` `enroll()` calls
  `permissions.setPersonaDefault(personaId, invite.caps)`, applied to *every*
  channel with no per-channel restriction (`PersonaPolicy.default`).

Net: **any invite-holder can read history of and post into private channels.**
Verified live — a freshly-enrolled persona's `list_channels` returned a private
channel with `capabilities=[VIEW_CHANNEL,READ_HISTORY,SEND_MESSAGES,…]`, i.e. full
read+write. Channel privacy is fully bypassed for enrolled personas.

### Why keep the bot admin

Admin is *desirable*: in a multi-tenant relay, some personas legitimately should
reach private channels, and the bot must be able to act there on their behalf. So
the gate belongs in the **relay's policy layer**, not in clipping the bot's
Discord perms. (De-admining would prevent the relay from ever serving a private
channel, even for authorized personas.)

### Tractability

Per-persona, per-channel cap lists don't scale. With self-registration minting
personas on demand, the only sustainable model is **roles**: define access once,
assign it many times.

## 3. Background — current model

- **Invite** (`config.ts` `InviteTemplate`): `{ code, label?, caps, subscriptions?,
  namePrefix?, maxUses?, uses?, expiresAt? }`.
- **Enrollment** (`relay.ts` `enroll`): mints persona, then
  `permissions.setPersonaDefault(id, invite.caps)` — a global default applied
  everywhere.
- **Policy** (`config.ts`): `PersonaPolicy { default: Capability[]; guilds?:
  Record<guildId, { default?: Capability[]; channels?: Record<channelId,
  Capability[]> }> }`.
- **Resolve** (`permissions.ts` `resolve`): channel-override ?? guild-default ??
  persona-default ?? file-default (deny) → a `Set<Capability>`; then
  `computeCapabilities(set, channel, me)` intersects with the bot's channel perms.
- The `PermissionsStore` already supports per-guild + per-channel overrides — the
  machinery exists; enrollment just doesn't *use* it.

## 4. Problem statement

1. Invites grant capabilities with **no scope** → private channels leak.
2. Permissions are tracked **per-persona** → unmanageable as personas multiply.
3. There is **no way to express "what a Discord role can see"** in portal terms,
   so portal access can't be kept in sync with the guild's real access model.

## 5. Proposed design

### 5.1 Terminology — two different "roles"

- **Addressing roles** (exist today): pooled `portal-*` mentionable Discord roles
  bound to personas for @-mention routing. Cosmetic/routing only. *Unchanged.*
- **Access roles** (this RFC): relay-side RBAC groupings defining a scoped
  capability policy. New concept; relay-internal config (not new Discord roles).

### 5.2 Scope

```ts
type Scope =
  | { channels: string[] }         // explicit channel allow-list
  | { mirrorRole: string }         // a Discord role id; scope = channels it can view
  | { mirrorRoles: string[] }      // several role ids; scope = union of channels they can view
  | { all: true };                 // every channel (admin-ish; use sparingly)
```

A scope answers "**which channels** does this grant apply in." Caps answer "**what**
may be done there."

### 5.3 Scoped invites (Phase 1 — closes the hole)

`InviteTemplate` gains a grant scope; enrollment stamps a **default-deny** guild
policy with allows only inside the scope:

```ts
interface InviteTemplate {
  code: string; label?: string;
  // NEW — exactly one of `roles` or `grant` (grant is the inline form):
  roles?: string[];                       // access-role names (preferred)
  grant?: { caps: Capability[]; scope: Scope };
  guildId?: string;                       // which guild the grant/scope applies to
  subscriptions?: string[]; namePrefix?: string;
  maxUses?: number; uses?: number; expiresAt?: string;
  // DEPRECATED: `caps` (blanket) — treated as { grant: { caps, scope: {all} } } with a warning.
}
```

Enrollment (`relay.ts`) translates the scope into a `PersonaPolicy`:

```
scope.channels → guilds[g] = { default: [], channels: { <each>: caps } }
scope.mirrorRole → guilds[g] = { default: [], channels: { <visible channel>: caps } }  // computed
scope.all → guilds[g] = { default: caps }                                              // current behaviour
```

`default: []` (deny) means anything outside the scope — including private channels —
resolves to no capabilities.

### 5.4 Access roles (Phase 2 — tractability)

A roles section in the permissions file (hot-reloaded like the rest):

```ts
interface AccessRole {
  caps: Capability[];
  scope: Scope;
  guildId?: string;   // bind to a guild (required for mirrorRole); omit for global
}

interface PermissionsFile {
  default?: Capability[];
  roles?: Record<string, AccessRole>;                 // NEW
  personas: Record<string, {
    roles?: string[];                                 // NEW — assigned access roles
    policy?: PersonaPolicy;                            // legacy per-persona override
  }>;
}
```

Invites reference `roles: string[]`. Enrollment sets `personas[id].roles = invite.roles`.

**Resolution** (`permissions.resolve`) becomes: for `(persona, guild, channel)`,
union the caps of every assigned role whose scope includes `channel` in `guild`,
union the legacy `policy`, then (as today) `∩ computeCapabilities` against the
bot's channel perms (a hard ceiling — admin bot = no extra ceiling, so the role
scope is the operative gate). Most-permissive-wins across roles.

### 5.5 Discord-role mirroring (Phase 3)

For `scope: { mirrorRole: roleId }`, the relay computes the channel set from
Discord itself: a channel is in scope iff
`channel.permissionsFor(discordRole).has(ViewChannel)`. So an access role can mean
*"exactly the channels the Discord @staff role can see."*

Mirroring is what makes the admin bot safe: the bot *can* act anywhere, but each
persona is gated to its mirrored role's visibility. A private channel is reachable
only by personas whose mirrored Discord role can actually see it. This safety
property depends entirely on the mirror set being **correct at resolve time** —
hence the cache invariant below is load-bearing, not an optimisation detail.

#### Cache + invalidation (push-event driven)

`channel.permissionsFor(role)` reads two layers, and Discord pushes an event for
each — **both arrive under the base `Guilds` intent the bot already requests**
(`discord-bot.ts` line ~139; `listRoles` already documents that role data is
always populated from this intent). No new or privileged intent is needed.

| Layer that affects visibility | Event(s) | Already wired? |
|---|---|---|
| Per-channel permission overwrites | `channelCreate` / `channelUpdate` / `channelDelete` | **Yes** (`channelChange` / `channelDelete`) |
| Role's guild-level permissions (incl. `@everyone`) | `roleCreate` / `roleUpdate` / `roleDelete` | **No — add (this RFC)** |

The relay keeps a per-`(guildId, roleId)` cache of visible channel ids, computed
lazily by a new `channelsVisibleToRole(guildId, roleId)` helper. Invalidation:

- **`roleUpdate`/`roleCreate`/`roleDelete`** → drop the cache entry for that
  `(guild, role)`. Position-only changes (role reordering) don't affect visibility
  and can be skipped. `@everyone` updates arrive as a normal `roleUpdate` and must
  bust **every** mirror entry in that guild (it underlies most baseline
  visibility).
- **`channelCreate`/`channelUpdate`/`channelDelete`** → an overwrite edit on one
  channel can change visibility for *any* role, so invalidate **by guild** (drop
  all role entries for that guild), not by a single role.

#### Fail-closed invariant (required)

Push events are necessary but **not sufficient**: events can be dropped across
gateway reconnects/resumes, and `GUILD_ROLE_UPDATE` does not replay history. The
resolver therefore must never serve a stale *allow*:

> On resolve, if the mirror set for a `(persona → mirrorRole)` is **absent or
> marked stale**, recompute it synchronously from `permissionsFor` (cheap; reads
> warm cache) — **or deny**. Never fall back to a previously-cached allow.

Push invalidation then makes the **periodic re-sync a backstop**, not the primary
freshness mechanism — covering the missed-event/reconnect window rather than being
relied on for correctness. On `ready`/reconnect, flush the whole mirror cache so
the first resolve after a gap always recomputes.

**Multi-role mirroring (`mirrorRoles`).** Where a guild's `@everyone` isn't a
useful baseline (e.g. a lobby/holding area) and access is gated by several
Discord roles, a scope may mirror a **set**: `scope: { mirrorRoles: [a, b, c] }`
resolves to the **union** of those roles' visible channels (per-guild, fail-closed
like the single form). A persona's effective access is then driven by the set of
access roles it's assigned — different sets → different levels. (Composing several
single-`mirrorRole` access roles achieves the same union but lets each carry its
own caps; `mirrorRoles` is the compact, shared-caps form.)

> v1 mirrors **visibility** (which channels) and applies the role's declared caps
> within them. A later refinement could mirror finer-grained per-channel perms
> (e.g. can-view-but-not-send) directly from Discord overwrites.

**Full-fidelity mirroring (`mirrorCaps`, implemented 2026-07-14).** The
refinement above exists as an opt-in flag on the access role:

```
{ caps, scope: { mirrorRole }, guildId, mirrorCaps: true }
```

With `mirrorCaps: true`, `caps` becomes a **mask**: the effective grant in a
channel is `caps ∩ the caps the mirrored Discord role's permission bits support
there` (post-overwrite, computed per channel by the mirror cache). So a persona
mirroring `@everyone` can read-but-not-post exactly where members can —
visibility-only mirroring would have let it post anywhere it could see, because
the *bot's* perms (not the mirrored role's) are the only Discord-side clamp.
`EDIT_OWN`/`DELETE_OWN` have no Discord permission bit (members always manage
their own messages); they derive from the role's `SendMessages`. Union across
`mirrorRoles` applies before the mask. Default (`false`/absent) keeps v1
semantics — existing role catalogs are unaffected.

### 5.6 What this fixes, concretely

- A `guest` invite → `guest` role scoped `{ channels: [<public ids>] }` → enrolled
  personas **cannot** see or post in private channels.
- A `staff` role `{ mirrorRole: <discord staff role> }` → those personas see
  exactly what staff sees, no manual channel list.

## 6. Phasing & effort

| Phase | Items | Effort | Unblocks |
|---|---|---|---|
| **P1 — Scoped invites** | `InviteTemplate.grant/roles`, enrollment → default-deny scoped policy, deprecate blanket `caps` | ~0.5–1 day | Closes the private-channel hole |
| **P2 — Access roles** | roles section, persona→role assignment, union resolution, invites grant roles | ~1–2 days | Tractable permission management |
| **P3 — Discord mirroring** | `mirrorRole` scope via `permissionsFor`, cache + event refresh | ~1–2 days | Portal access tracks Discord's model |

P1 is independently shippable and is the security fix.

## 7. Security considerations

- **Default-deny everywhere.** Scopes are allow-lists; the implicit default is no
  access. A persona with no roles/grant can do nothing.
- **`∩ Discord reality` stays** as a ceiling (never grant more than the bot can
  do) even though the role scope is the operative gate under an admin bot.
- **`scope: {all}` is the dangerous one** — reserve it for explicitly-trusted
  admin personas; never the default for an open invite.
- **Mirror staleness:** a Discord role losing channel access must propagate;
  hence event-driven refresh + periodic re-sync, and recompute on each resolve if
  the cache is stale.
- **Invites remain bearer credentials** (RFC notes from the gateway review still
  apply: rate-limiting + unidentified-session caps are a separate hardening item).
- **Addressing roles follow access.** The `portal-*` addressing-role pool only
  mints a Discord role for a persona in guilds where it has rights
  (`couldAccessGuild` — a policy-level superset check). A persona scoped to one
  guild no longer leaves stray addressing roles in every other bridged guild,
  and can't be @-addressed into a guild it can't act in.

## 8. Testing

- **Unit:** scope → policy translation (channels/mirror/all); resolve unions
  multiple roles; default-deny outside scope; `mirrorRole` scope from a fake
  channel/role/overwrite fixture.
- **Live (mirrors `scripts/p1-live.mjs`):** mint a `#test`-scoped invite; enroll;
  assert `list_channels` shows the in-scope channel with caps **and** a private
  channel with **empty** capabilities (and `fetch_history` on it → `FORBIDDEN`).
  Then a `mirrorRole` role and assert scope matches the Discord role's visibility.
- **Regression:** a legacy blanket-`caps` invite still works (as `scope:{all}`)
  but logs a deprecation warning.

## 9. Open questions

1. **Access roles: relay-internal config vs real Discord roles.** Recommended:
   relay-internal (config + hot-reload); mirroring *reads* Discord roles. Avoids
   cluttering the guild (the addressing pool already creates real roles).
2. **Multi-role resolution:** union (most-permissive) — confirmed direction.
3. **Global vs per-guild roles:** `{channels}`/`{all}` can be global (channel ids
   are unique); `{mirrorRole}` is inherently per-guild.
4. **Deprecation:** keep blanket `caps` working as `scope:{all}` + warn, or hard-
   require a scope on new invites? Recommend: accept legacy but require scope for
   any newly-minted invite via `mint-invite.mjs`.
5. **Finer-grained mirroring** (per-channel send/react from overwrites) — defer to
   a follow-up.

## 10. Backward compatibility

- **Additive at the config layer.** Existing identity/permissions files keep
  working; the `roles` section and persona `roles` are optional.
- The one behavioural change is **enrollment no longer grants blanket access** —
  intentional (it's the fix). Existing invites with bare `caps` are honoured as
  `scope:{all}` with a warning; re-mint them scoped.
- No wire break unless we later surface access-role membership to clients (then a
  `portal-protocol` minor bump).
