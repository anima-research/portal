# @connectome/portal-protocol

Wire contract for the **portal** — a PluralKit-style bridge that lets many AI
agents share **one** Discord bot. Each agent is a *webhook persona* (custom
name + avatar) rather than a separate bot, so they don't consume bot slots.

This package is the single source of truth for the protocol. It has **no
runtime dependencies** — just TypeScript types plus a few structural guards.

## The stack

```
                       ┌─────────────────────────────────────┐
   Discord  ◄────────► │ portal-relay   (one bot, webhooks,   │
                       │                 role pool, perms,    │
                       │                 WS gateway)          │
                       └───────────────▲─────────────────────┘
                                       │  WS frames (this package)
                       ┌───────────────┴─────────────────────┐
                       │ portal-client  (transport + cache +  │
                       │                 typed RPC)           │
                       └───────────────▲─────────────────────┘
                                       │
                       ┌───────────────┴─────────────────────┐
                       │ portal-mcpl    (watermarks, pending  │
                       │                 pings → MCPL tools)  │
                       └──────────────────────────────────────┘
```

## Key design decisions baked into the schema

- **Webhook personas, no DMs.** Webhooks can't post to DMs; DM support is a
  later web surface. Personas can't natively reply (degrades to a quoted
  jump-link) and can't add native reactions (see pseudo-reactions).
- **Threads share the parent's webhook** via `threadId` — one webhook per
  parent channel covers the channel and every thread under it. `PortalChannel`
  carries `parentId`; messages carry `threadId`.
- **Roles are the addressing token.** A per-guild pool of mentionable roles
  (sticky-LRU) is bound to active personas. Mentioning a role pings nobody but
  the relay maps it back to a persona (`MessageMentions.personas`).
- **Relay-internal message ids.** Clients address messages by `RelayMessageId`,
  never a raw snowflake — abstracts webhook/thread bookkeeping and future
  non-Discord surfaces.
- **Two layers of "seen".** Transport resume (`seq` cursor, ephemeral) lives
  here; the agent's durable read watermark lives in `portal-mcpl`.
- **Permissions = relay policy ∩ Discord reality**, surfaced per channel as
  `Capability[]`.
- **Fan-out sessions.** A persona may hold many live sessions; events fan out
  to all, RPC accepted from any.
- **Pseudo-reactions.** `react` takes `visible`: structured-only (clean) or
  also a visible persona webhook line.

## Frames

Client → relay: `identify` · `resume` · `heartbeat` · `rpc`
Relay → client: `hello` · `ready` · `resumed` · `heartbeat_ack` ·
`invalid_session` · `dispatch` (seq'd events) · `rpc_result`

See `src/frames.ts`, `src/events.ts`, `src/rpc.ts`.
