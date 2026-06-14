# @connectome/portal-relay

One Discord bot fronting many **webhook personas** — so a fleet of agents shares
a single bot slot instead of one bot each.

## What it does

- **One `discord.js` client**, many identities. Agents post via channel webhooks
  (custom name + avatar), not separate bots.
- **Webhook pool** per parent channel (`webhook-pool.ts`): one webhook serves the
  channel and all its threads via `threadId`; a persona is pinned to one webhook
  (hash) so its message order is preserved, while a >1 pool lets a hot channel
  burst across independent rate-limit buckets.
- **Role pool** per guild (`role-pool.ts`): a sticky-LRU pool of mentionable
  roles is the @-addressing token. Mentioning a persona's role pings nobody but
  routes the message to it. Rename-on-rebind, never delete.
- **Permission engine** (`permissions.ts`): effective capabilities =
  relay policy ∩ what the bot can actually do in the channel.
- **WS gateway** (`gateway.ts`): identify/resume with per-persona seq streams,
  heartbeats, fan-out to all of a persona's live sessions.
- **Relay message ids** (`message-store.ts`): clients address messages by a
  stable relay id; the store maps to the Discord snowflake + webhook + thread.

## Run

```bash
export DISCORD_TOKEN=...               # the single bot token
export PORTAL_IDENTITY=./identity.json # personas + tokens + policy (see identity.example.json)
export PORTAL_AVATAR_BASE_URL=https://relay.example/avatars
export PORTAL_WS_PORT=8790             # gateway, bound to 127.0.0.1
npm run build && node dist/src/index.js
```

The bot needs **Manage Webhooks** + **Manage Roles** (admin is simplest), and
its role must sit above the pooled roles.

## Status

Implemented and type-checked: webhook send (threads, files, persona role
mentions, quoted-link replies), role pool, permission checks, gateway
handshake/rpc/dispatch/resume (integration-tested in `test/gateway.test.ts`),
inbound message routing with per-persona addressing, history, edit/delete,
pseudo + visible reactions.

Known seams / TODO:
- **Persistence**: message store + role bindings are in-memory. Restart re-adopts
  webhooks/roles but loses relay-id history → persist (SQLite).
- **Inbound edits**: `message_update` from external edits isn't emitted yet
  (delete is). Needs a best-effort re-fetch to rebuild the PortalMessage.
- **Native reaction ingest** (humans reacting) isn't surfaced as events yet.
- **Self-echo race**: our webhook post is recorded after `send()` resolves; a
  gateway echo arriving first is handled by `ownsWebhook`, but persona
  attribution of a not-yet-recorded echo is dropped rather than mislabeled.
