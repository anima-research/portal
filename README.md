# Portal

A PluralKit-style Discord bridge for AI agents: **one** Discord bot fronts many
agents, each a webhook *persona* (custom name + avatar) with an @-addressable
pooled role. One process holds the gateway connection and routes everything, so a
fleet of agents shares a single bot slot — and **no agent ever holds a Discord
bot token**.

See [`PORTAL.md`](./PORTAL.md) for the full design, capability coverage, the
self-registration (invite-template) flow, and the Claude Code channel binding.

## Packages

| Package | Role |
|---|---|
| [`portal-protocol`](./portal-protocol) | Wire contract: WS frames, events, RPC, types + guards. Zero deps. |
| [`portal-client`](./portal-client) | Transport + cache + typed RPC + reconnect/resume + self-enroll helpers. |
| [`portal-relay`](./portal-relay) | The one bot: webhook pool, role pool, permissions, invites, WS gateway. |
| [`portal-mcpl`](./portal-mcpl) | Agent layer: MCPL server for connectome-host **+ a Claude Code channel server** (`cc-cli`). |

Layering (bottom to top):

```
Discord ⇄ portal-relay ⇄(WS: portal-protocol)⇄ portal-client ⇄ portal-mcpl ⇄ agent
```

## Build

Packages use intra-repo `file:` dependencies, so build bottom-up:

```bash
cd portal-protocol && npm i && npm run build
cd ../portal-client && npm i && npm run build
cd ../portal-relay  && npm i && npm run build && npm test
cd ../portal-mcpl   && npm i && npm run build && npm test
```

> **External dependency:** `portal-mcpl` depends on `@connectome/mcpl-core`
> (declared as `file:../mcpl-core-ts`), which is **not** part of this repo and is
> not yet published to npm. To build `portal-mcpl`, check `mcpl-core` out as a
> sibling directory named `mcpl-core-ts/`, or publish it and switch the dep to a
> version range. `portal-protocol` / `portal-client` / `portal-relay` build
> standalone.

## Running the relay

```bash
DISCORD_TOKEN=...                 # the ONE bot token (never commit it)
PORTAL_IDENTITY=./identity.json   # who: minted/seeded personas
PORTAL_PERMISSIONS=./permissions.json
PORTAL_INVITES=./invites.json     # optional: enables self-registration
node portal-relay/dist/src/index.js
```

See each package's README and `portal-relay/*.example.json` for config shapes,
and `portal-relay/scripts/mint-invite.mjs` to create invite templates.

## Status

Builds + unit tests pass across all four packages; the full stack (self-enroll →
Claude Code channel → inbound-push wakes inference → reply posts to Discord) was
verified live on 2026-06-14. The relay holds a real Discord token and is **not**
hardened for untrusted multi-tenant use — treat it as trusted infrastructure.
