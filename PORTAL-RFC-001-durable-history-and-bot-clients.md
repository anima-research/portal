# PORTAL RFC-001 — Durable message identity, pre-connect/restart history, and first-class bot clients

- **Status:** ✅ Implemented (2026-06-14) — P0 + P1 + P2
- **Author:** Antra (drafted with Claude Code)
- **Date:** 2026-06-14
- **Affects:** `portal-protocol` (wire types), `portal-relay` (`message-store.ts`, `relay.ts`, `discord-bot.ts`, new `history-cache.ts`), `portal-client` (cache), `portal-mcpl` (tools)
- **Protocol version:** targets a `portal-protocol` minor bump (0.1.x → 0.2.0)

> ## Implementation notes (what shipped vs. the draft)
> Built with the review's three corrections folded in:
> 1. **C1 ids encode the channel** — `rm_<container>_<msgId>` (container = thread id
>    when threaded, else channel id), *not* just the message snowflake. This is
>    load-bearing: C2's re-fetch needs the channel, and cursor decode + reply-id
>    derivation are pure string ops (`makeRelayId`/`parseRelayId` in
>    `message-store.ts`).
> 2. **A6 pulled into P0** — a thin persisted attribution map
>    `{discordMsgId → {channelId, threadId, guildId, personaId, webhookId}}`
>    (`PORTAL_ATTRIBUTION`). Without it, per-persona edit ownership can't survive a
>    restart (all personas share a webhook, so Discord can't tell us who authored
>    a message). It's correctness, not just latency.
> 3. **C2 adopts webhooks before the ownership check** — `webhooks.ensureLoaded()`
>    re-adopts a channel's webhooks post-restart so `editMessage` works and the
>    `ownsWebhook` check isn't falsely empty.
>
> Also fixed a real **clean-restart bug** found while building the acceptance test:
> `gateway.close()` could hang (it now hard-terminates sockets with a 2s race), so
> the listen port frees promptly.
>
> **Verified:** offline unit tests (deterministic ids, attribution-survives-restart,
> ownership safety, history-cache TTL/LRU/invalidate — `test/message-store.test.ts`,
> `test/history-cache.test.ts`) **and** live against antra's server:
> `scripts/restart.mjs` (the P0 acceptance gate, incl. cross-persona edit rejected
> after restart) and `scripts/p1-live.mjs` (member reads, mention resolution,
> inbound edit→`message_update`, `list_pins`). Native reaction ingest is wired but
> needs a human reactor to exercise live.

---

## 1. Summary

Portal today assumes its clients are *new* agents that come into existence at
connect time and only care about the live stream from that point forward. That
assumption is baked into how messages are identified: a `RelayMessageId` is a
random per-process UUID with no durable relationship to the underlying Discord
message.

That breaks an emerging and important class of client: an **existing Discord bot
that wants to become a portal client** — i.e. give up its own gateway connection
and route through the shared relay — while preserving behaviour that depends on
**deep history**, **stable message identity across restarts**, and
**snowflake-addressable messages** (Discord URLs, persisted conversation state).
ChapterX (`chatperx` / "chapter3") is the concrete driver, but the same needs
apply to any migration of a stateful bot.

This RFC proposes:

1. **Durable, snowflake-correlated message identity** so ids survive relay
   restarts and clients can address messages by Discord snowflake.
2. **Pre-connect / restart history** that "just works" (it nearly already does —
   the relay fetches live from Discord — the gap is identity and cursors).
3. A set of **adjacent capabilities** (member/role reads, mention resolution,
   pinned-message reads + events, inbound human edits + native reactions, a
   read-cache for the shared rate-limit budget) that together make Portal a
   viable host for a full stateful bot, not just a greenfield agent.

The core (items 1–2) is small — **~3–6 engineer-days** — because Discord itself
is the durable message store; we are fixing *identity*, not building a database.

---

## 2. Motivation & use cases

- **Bot consolidation.** The whole point of Portal is "many agents, one bot
  slot." Today that only pays off for greenfield agents. The biggest immediate
  win is migrating *existing* bots (ChapterX et al.) off their own bot slots —
  but they carry state and history expectations a greenfield agent doesn't.
- **Restart resilience.** The relay is a single shared process. When it
  restarts (deploy, crash, host reboot), **every** connected client currently
  loses the ability to resolve any message id it held. For a multi-tenant shared
  service this is the difference between "a blip" and "every agent's references
  are now dangling."
- **Correlation with the outside world.** Discord message URLs, audit logs,
  cross-channel references, and a bot's own persisted conversation state are all
  keyed by **Discord snowflake**. A client that can never see the snowflake
  can't participate in any of that.

### Driving example: ChapterX

ChapterX builds model context by paging channel history to arbitrary depth and
resolves `.history first:<url> last:<url>` ranges **by Discord snowflake**. It
persists conversation/cache state across its own restarts. None of this survives
contact with opaque, per-process relay ids. (See companion analysis; not
repeated here.)

---

## 3. Background — how it works today

Grounded in the current code:

- **History is already fetched live from Discord.** `discord-bot.ts:335`
  `fetchHistory()` calls `channel.messages.fetch({ limit, before })` and pages up
  to any depth. The relay holds the bot token, so **Discord is the durable
  message store** — the relay does not need to persist message *content*.
- **Client-visible ids are random and per-process.** `message-store.ts:55`
  mints `rm_${randomUUID()}`. The `MessageStore` keeps `byRelay` / `byDiscord`
  maps **in memory only** (cap 50,000, FIFO eviction). The header comment already
  flags this: *"In-memory for now. TODO: persist (SQLite) so relay restarts don't
  orphan historical ids."*
- **Every `PortalMessage.id` is that relay id.** `relay.ts:451`
  (`id: ref.relayId`). The **Discord snowflake is never exposed** on the wire
  (`portal-protocol/.../message.ts:62`).
- **Cursors and mutation targets resolve through the in-memory store.**
  - `fetch_history` `before`/`after` → `store.getByRelayId(...)?.discordMsgId`
    (`relay.ts:203-204`).
  - `edit` / `delete` / `react` → `store.getByRelayId(...)` then need
    `webhookId` + `threadId` (`relay.ts:165/174/187`; `webhook-pool.ts:108/112`).
  - `ensureForDiscord` (`message-store.ts`) already mints refs on demand for
    messages predating the process (used by `buildPortalMessage`, `relay.ts:411`).

---

## 4. Problem statement

Three failures across (re)connect and restart, plus one missing primitive:

1. **Unstable identity.** After a relay restart the same Discord message gets a
   *new* `rm_<uuid>`. Any id a client persisted is dead (`getByRelayId` →
   `undefined`).
2. **Silent cursor breakage.** A `before`/`after` cursor whose relay id isn't in
   the live store (post-restart, or evicted past the 50k cap) resolves to
   `undefined`, which the code treats as *"no cursor"* — so `fetch_history`
   silently returns the **latest** page instead of the requested one. Pagination
   fails without an error.
3. **Lost mutation targets.** `edit`/`delete`/`react` against a pre-restart
   message can't find the `webhookId`/`threadId`, so an agent can no longer edit
   or delete its own older messages.
4. **No snowflake addressing.** Clients can't map a Discord URL/snowflake to a
   portal message at all, nor correlate ids across a restart, because the
   snowflake is never on the wire.

---

## 5. Proposed changes

### Core (required for the driving use case)

#### C1 — Deterministic, snowflake-derived `RelayMessageId` *(keystone)*

Replace `rm_${randomUUID()}` with a **pure function of the Discord message
identity**, e.g. `rm_${discordMsgId}` (snowflakes are globally unique).
Consequence:

- Ids are **stable across restarts** (fixes #1).
- `before`/`after` decode straight to a snowflake **without the in-memory store
  or the 50k cap** (fixes #2). Cursor resolution becomes a pure string op.
- Snowflake correlation becomes trivial (helps #4).

**Design note / decision:** this reverses a deliberate "client ids are opaque"
choice (`message-store.ts` header: *"Clients only ever see RelayMessageIds."*).
For trusted agent clients, opacity was never load-bearing. If we want to *keep*
opacity, the alternative is a deterministic **hash** of the snowflake **plus a
persisted hash→snowflake map** — that restores restart-stability but loses the
"resolve a cursor without the store" win, so it is strictly more work. **
Recommended: snowflake-derived id** (optionally prefixed/namespaced), paired with
C3 below.

**Compatibility:** changes the *meaning* and *format* of `RelayMessageId`.
Requires an audit + migration of anything that persisted old `rm_<uuid>` values
(`portal-client` cache, `portal-mcpl` state — note its watermarks are keyed by
`createdAt`, so likely unaffected — and `mcpl-harness`). Recommend shipping under
a protocol minor bump and treating any pre-existing persisted ids as a one-time
invalidation.

#### C2 — Store-miss fallback that re-fetches from Discord

For `edit`/`delete`/`react`/reply resolution, when the store has no `MessageRef`
(post-restart, or a message predating the process), **fetch the message by
snowflake from Discord** (`channel.messages.fetch(id)`), which returns
`webhookId` and thread context, then `record()` it. The relay verifies it **owns
the webhook** (`ownsWebhook`, already used in `buildPortalMessage`) before
permitting an edit/delete. Fixes #3. Make the resolution path in
`relay.ts:165/174/187` an async "ensure-or-fetch" rather than a bare
`getByRelayId`.

#### C3 — Expose the Discord snowflake on the wire

Add an **additive** `nativeId` (Discord snowflake) field to `PortalMessage`
(and, for symmetry and future-proofing, a `native` id on `PortalChannel` /
`PortalGuild`). Lets clients correlate Discord URLs/snowflakes directly instead
of reverse-engineering the id encoding, and keeps that correlation working even
if we later decide to make `RelayMessageId` opaque again. Cheap, no break.

> C1 + C3 together cleanly separate the two concerns: **C1** = restart-stable
> addressing & store-free cursors; **C3** = explicit outside-world correlation.
> Doing both means the relay id can stay an internal contract while `nativeId`
> is the documented correlation key.

#### C4 — `fetch_history` accepts snowflake cursors directly *(small)*

Allow `before`/`after` to be **either** a `RelayMessageId` **or** a raw Discord
snowflake (discriminated, or just "try relay id, else treat as snowflake"). This
lets a migrating bot page using snowflakes it already has persisted, without a
round-trip to first obtain a relay id. Pairs naturally with C1/C3.

### Adjacent (make Portal a viable host for a *full* stateful bot)

These are not strictly required for "history available," but every one is a
known blocker for migrating ChapterX-class bots and is worth scoping in the same
RFC so the protocol grows coherently rather than piecemeal.

#### A1 — Member / role read API

Add `list_members({ guildId, query?, limit? })` and member-role lookup so
clients can do authorization gating (ChapterX gates `.history`/`.steer` on member
roles) and richer mention handling. The relay already warms member caches
(`warmMembers`) when it has the `GuildMembers` intent. (PORTAL.md "Next steps
#2".) Gate behind a capability; degrade gracefully when the intent is absent.

#### A2 — First-class mention resolution

Today outgoing `@name` resolution is opportunistic and cache-based
(`resolveOutgoingMentions`, `discord-bot.ts`). Expose an explicit
`resolve_mentions`/`resolve_handles` RPC (and/or always populate resolved
`mentions.users` on inbound `PortalMessage`) so a client can reliably turn
`<@username>` ↔ id without guessing. Depends on A1 for the data.

#### A3 — Inbound human edits + native reaction ingest

Emit `message_update` for **human** edits and `reaction_add`/`reaction_remove`
for **native** (human) reactions, not just persona pseudo-reactions. ChapterX
queues both today. The relay already receives the gateway events
(`messageUpdate`, and reaction handlers exist on the discord.js client) — this is
mostly plumbing them through as protocol events. (PORTAL.md "Next steps #4".)

#### A4 — Pinned-message reads + events

Add `list_pins({ channelId })` and `pins_update` events. This is the load-bearing
gap for ChapterX specifically: its entire behaviour model is driven by *pinned*
`.config` / `.steer` / `.sleep` messages, and Portal has **no pin concept at
all**. Even read-only pin support unblocks that pattern; pin/unpin mutation can
come later behind a capability. (Worth noting the bot already special-cases the
`/pins` REST endpoint to dodge a Cloudflare rate-limit — the relay should own
that quirk once, centrally, rather than every client re-implementing it.)

#### A5 — History read-cache (protect the shared rate-limit budget)

Every `fetch_history` is live Discord REST (≤100/page) against the **one shared
bot's** ~50 req/s budget, now contended across *all* personas. A migrating bot
that builds deep context frequently will dominate that bucket. Add a relay-side
**LRU page cache** keyed by snowflake, populated by both gateway events and
fetches, with short TTL / event-driven invalidation. Correctness-neutral,
load-critical. Composes naturally with the snowflake-keyed store from C1.

#### A6 — Optional attribution persistence (edit-latency optimization)

With C2, recovering `webhookId` for a pre-restart edit costs one Discord
refetch. If editing old messages is hot, persist *only*
`{ discordMsgId → webhookId, personaId, threadId }` to SQLite (the existing TODO
at `message-store.ts:11`). Note: **not** on the critical path for history — we do
not need to persist message content, only this thin attribution row.

---

## 6. What we explicitly do **not** need

- **Persisting message content / a relay-side message database.** Discord is the
  durable store; `fetchHistory` reads it live. This is the key realization that
  makes the core cheap. (The `message-store.ts` "persist (SQLite)" TODO should be
  re-scoped to "persist the *id/attribution mapping*," per A6 — not the messages.)

---

## 7. Phasing & effort

| Phase | Items | Effort | Unblocks |
|---|---|---|---|
| **P0 — Durable history core** | C1, C2, C3, C4 + restart tests | **~3–6 days** | Pre-connect/restart history, snowflake addressing, edit/delete of old messages |
| **P1 — Bot-parity reads** | A1, A2, A4 (read-only pins), A3 | ~6–10 days | Auth gating, mention fidelity, config-via-pins, full inbound event parity |
| **P2 — Hardening** | A5 (read-cache), A6 (attribution persist) | ~2–4 days | Shared-budget safety, edit latency |

P0 is independently shippable and is the prerequisite for ChapterX history.
P1 items are independent of each other and can land in any order. P2 is
optimization.

---

## 8. Test plan (P0)

A restart-simulation integration test is the acceptance gate:

1. Connect client → `fetch_history` deep (beyond the live store) → assert ids are
   snowflake-derived and `nativeId` is present and correct.
2. **Restart the relay process.** Reconnect.
3. Re-resolve the **same** ids held from before the restart → succeed.
4. `fetch_history` with a `before`/`after` cursor minted *before* the restart →
   returns the **correct** page (not the latest). Also test a raw-snowflake
   cursor (C4).
5. `edit` / `delete` a persona's **own pre-restart** message → succeeds via the
   C2 Discord-refetch fallback; assert webhook ownership is enforced.
6. Negative: editing a message the relay's webhook does **not** own → rejected.

Plus unit tests for deterministic id derivation (same snowflake → same id, across
process boundaries) and cursor decoding.

---

## 9. Open questions / decisions to make

1. **Opaque vs. snowflake-derived relay id (C1).** Recommended: snowflake-derived
   + explicit `nativeId` (C3). Confirm we're comfortable dropping id opacity for
   trusted clients, or commit to the hash-plus-persisted-map alternative.
2. **Id namespacing.** Should the relay id encode channel/guild
   (`rm_<guild>_<channel>_<msg>`) or just the message snowflake? Snowflakes are
   globally unique, so the message id alone suffices — but a namespaced id is
   self-describing for debugging.
3. **Migration of existing persisted ids.** One-time invalidation under a minor
   protocol bump, or a translation shim? Recommend invalidation given how young
   the ecosystem is.
4. **Pin mutation scope (A4).** Read-only first, or read+pin/unpin in one go?
5. **Member intent dependency (A1/A2).** Define graceful degradation when the
   `GuildMembers` privileged intent is off for a given relay bot.

---

## 10. Backward compatibility

- C3, C4, A1–A6 are **additive** (new fields / new RPCs / new events) — safe
  under a minor bump for clients that ignore unknown fields.
- C1 is the only **breaking** change (id semantics). Bundle it into the same
  minor bump, document the one-time id invalidation, and audit `portal-client`,
  `portal-mcpl`, and `mcpl-harness` before release.
