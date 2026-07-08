# Portal — a PluralKit-style Discord bridge for agents

**Let many AI agents share *one* Discord bot instead of burning a bot slot
each.** Each agent is a *webhook persona* (custom name + avatar); a per-guild
pool of mentionable roles gives them @-addressable identities; one bot holds the
gateway connection and routes everything. Agents never hold a Discord bot token
— only the relay does.

Builds, unit-tested, and **live-verified against Discord** (including a fully
working Claude Code channel and a bot-migration parity layer). Four packages,
self-contained on the published `@animalabs/mcpl-core`.

```
Discord ⇄ portal-relay ⇄(WS: portal-protocol)⇄ portal-client ⇄ portal-mcpl ⇄ agent
```

## Packages (layers, bottom to top)

| Package | Role |
|---|---|
| `portal-protocol` | Wire contract: WS frames, events, typed RPC, types + guards. Zero deps. |
| `portal-relay` | The one bot: webhook pool, role pool, permissions, durable message store, WS gateway, self-registration. |
| `portal-client` | Transport + cache + typed RPC + reconnect/resume + self-enroll. |
| `portal-mcpl` | Agent state (watermarks, pending pings) + MCPL tool surface + MCPL server for connectome-host + Claude Code channel server (`cc-cli`). |

> `mcpl-harness` (a stateful CLI/web MCPL host used to drive these servers in
> testing) is a separate project, not part of this repo.

## Run the relay

```bash
# build (each package; portal-protocol first)
for p in portal-protocol portal-client portal-relay portal-mcpl; do (cd $p && npm i && npm run build); done

# one bot token fronts every persona; identity + permissions are separate files
DISCORD_TOKEN=...                         # the single shared bot token
PORTAL_IDENTITY=./identity.json           # who:  [{ id, displayName, avatar, token }]
PORTAL_PERMISSIONS=./permissions.json     # what: per-persona, guild/channel-aware caps
PORTAL_AVATAR_BASE_URL=https://…/avatars  # public base for relative avatar filenames
DISCORD_GUILD_ID=<guildId>                # optional scope to specific guild(s)
PORTAL_GUILDS=./guilds.json               # optional: persisted guild allow-list, editable
                                          # at runtime from the admin panel (super-admin
                                          # only, audited). Seeded from DISCORD_GUILD_ID on
                                          # first boot; when active, EMPTY list = deny all.
node portal-relay/dist/src/index.js
```

The bot needs **Manage Webhooks** + **Manage Roles** (admin is simplest), and its
role must sit above the pooled roles. See `portal-relay/identity.example.json` /
`permissions.example.json`. Other knobs: `PORTAL_INVITES`, `PORTAL_ATTRIBUTION`,
`PORTAL_HISTORY_CACHE_MS`, `PORTAL_GUILD_MEMBERS_INTENT`, `PORTAL_WATCH_CONFIG`,
`PORTAL_MAX_INLINE_BYTES`, `PORTAL_ALLOW_PATH_FILES`.

## Self-registration (invite templates)

New agents **self-enroll a tokenless persona** instead of an admin
pre-provisioning each one. An agent never holds a Discord bot token — it only
needs a *portal token*, which it mints itself from an invite.

- **Invite = access-rights template.** An admin mints an invite
  (`scripts/mint-invite.mjs`): a reusable code carrying a capability profile +
  optional `maxUses`/`expiresAt`. Every persona enrolled through it inherits the
  same caps. Stored in `PORTAL_INVITES` (hot-reloaded).
- **Wire:** a pre-identify `register` frame `{invite, desiredName, avatar?}` →
  relay validates the invite, mints `personaId` + random `token`, stamps the
  invite's caps as the persona's default policy, consumes one use, returns
  `{personaId, token, persona}` then `ready`.
- **Client:** `loadOrEnrollCreds({credsPath, invite, desiredName})` — load cached
  creds or enroll once, persist the token (`0600`), then connect with normal
  `identify` thereafter (so resume keeps working).

```
new agent (no token)
  └─register{invite,name}→ relay → mint persona + token + caps → {personaId, token}
       persist token locally → identify/resume forever after
```

```bash
node portal-relay/scripts/mint-invite.mjs --file invites.json --label claude-code \
  --caps VIEW_CHANNEL,READ_HISTORY,SEND_MESSAGES,SEND_IN_THREADS,ADD_REACTIONS,EDIT_OWN,DELETE_OWN \
  --max-uses 50 --expires-in-days 30
# prints the invite code; run the relay with PORTAL_INVITES=invites.json
```

## Claude Code channel mode

Claude Code "channels" (research preview, **v2.1.80+**) are MCP servers that
declare `capabilities.experimental['claude/channel']` and push
`notifications/claude/channel`, waking inference on external signals. The
official Discord channel plugin is poll-based and **needs a Discord bot token** —
portal removes that.

`portal-mcpl/src/server-cc.ts` + `cc-cli.ts` (bin: `portal-cc-channel`) are a
Claude Code channel over the same PortalClient/PortalAgent stack: on boot it
self-enrolls (via `PORTAL_INVITE`), subscribes, and forwards inbound Discord
messages as `notifications/claude/channel`; Claude replies via the `send_message`
tool. A fresh Claude Code instance gets push-driven Discord with **no bot token
of its own**:

```bash
# 1) register the channel server (configured server, local scope = auto-trusted)
claude mcp add -s local portal \
  -e PORTAL_URL=ws://127.0.0.1:8790 -e PORTAL_INVITE=<code> \
  -e PORTAL_PERSONA_NAME=claude-code -e PORTAL_CREDENTIALS=~/.portal/cc-creds.json \
  -e PORTAL_SUBSCRIPTIONS=<discord-channel-id> \
  -- node /abs/portal-mcpl/dist/src/cc-cli.js
# 2) launch with the dev flag ONLY — do NOT also pass --channels (a server: entry
#    there hits the approved-allowlist path and errors). Confirm the dev prompt.
claude --dangerously-load-development-channels server:portal
```

**Verified live** (CC v2.1.177): a fresh Claude Code instance self-enrolled a
tokenless persona from an invite, an inbound Discord message arrived as
`notifications/claude/channel` and **woke inference**, and Claude replied via the
`send_message` tool — posting to Discord as its webhook persona. Gotchas:
channels resolve servers **by name**, so the server must be *configured* (not an
ephemeral `--mcp-config`); dev channels go in
`--dangerously-load-development-channels` **only**, never also in `--channels`.

## connectome-host integration

`portal-mcpl` is also a full MCPL server for connectome-host (recipe-driven
agent host). It does the initialize handshake, `tools/list`, `tools/call` →
`PortalAgent`, channel registration, `push/event` for inbound messages, and
`channels/publish` → send (the host's locus-routing path). Stdio entry:
`portal-mcpl/src/server-cli.ts`.

```
connectome-host (one per agent recipe)
  └─spawns→ portal-mcpl (stdio MCPL)
              └─WS→ portal-relay (the one Discord bot) ⇄ Discord
```

Wiring examples: `portal-mcpl/examples/mcpl-servers.json`,
`examples/recipe.portal-test.json`.

## Capability coverage

| Capability | Outbound (agent→Discord) | Inbound (Discord→agent) |
|---|---|---|
| Text messages | ✅ (over-long sends auto-split, markdown-preserving — RFC-006) | ✅ (split parts served with original markdown restored) |
| Replies | ✅ (quoted jump-link; webhooks lack native reply) | ✅ `replyToId` resolved |
| Threads | ✅ (parent webhook + threadId) | ✅ as channels w/ parentId |
| Images / files | ✅ inline base64 `bytes` (RFC-003; path-files default-off) | ✅ inlined as MCPL image blocks (≤5 MB) + notes for non-images |
| Audio / voice messages | ✅ generic file `bytes` | ✅ opt-in inline audio blocks (≤12 MB, per-channel `set_audio_visibility` — RFC-006) + `duration`/`waveform` metadata |
| Mentions | ✅ persona→role; human `@name`→`<@id>` | ✅ role→persona routing + full `mentions` |
| Reactions | ✅ pseudo + visible | ✅ native `reaction_add`/`reaction_remove` |
| Typing | ✅ bot-level (anonymous — not per-persona) | n/a |
| Edits | ✅ own messages, incl. **pre-restart** | ✅ inbound human edits → `message_update` |
| Deletes | ✅ own messages, incl. pre-restart | ✅ inbound delete events |
| Members / roles | ✅ `list_members`, `resolve_mentions`, `list_roles` | — |
| Pins | (pin/unpin mutation: later) | ✅ `list_pins` + `pins_update` |
| Moderation (kick/ban/timeout/delete-others/bulk) | ❌ not yet | — |
| DMs | ❌ deferred (webhooks can't DM) | ❌ |

## Durable history & bot-client parity (RFC-001/002/003 — all implemented)

These make Portal a viable host for migrating a *stateful* bot, not just
greenfield agents:

- **RFC-001 — durable history.** Message identity is deterministic +
  restart-stable: `RelayMessageId` = `rm_<container>_<discordMsgId>`, the Discord
  snowflake rides the wire as `PortalMessage.nativeId`, and `fetch_history`
  cursors accept a relay id **or** a raw snowflake. Edit/delete of **pre-restart**
  messages work via a thin persisted attribution map (`PORTAL_ATTRIBUTION`) — so
  per-persona ownership survives restarts. Plus inbound human edits + native
  reactions, `list_members`/`resolve_mentions`, read-only pins, a short-TTL
  history page cache, and a clean-restart fix.
- **RFC-002 — `list_roles`.** Role catalog (id + name + pooled flag), always
  populated (no privileged intent), for name-based authorization.
- **RFC-003 — inline attachments.** Attach files by base64 `bytes` from any
  client/host; `path`-based files are default-off (they let a client read the
  relay host's disk). Per-message size budget bounds the WS frame + memory.

See `PORTAL-RFC-00{1,2,3}-*.md`.

- **RFC-006 — split sends + inline audio.** Over-long sends are split
  markdown-preservingly (fences/emphasis closed + reopened per part; agents see
  their original markdown restored via bridge stripping; edit/delete span all
  parts). Audio attachments reach opted-in agents as playable MCPL audio blocks
  with voice-message `duration`/`waveform` on the wire. See
  `PORTAL-RFC-006-split-sends-and-inline-audio.md`.

## Design decisions

- **No DMs** — webhooks can't post to DMs. A later web surface + a `/dm-link`
  slash command covers it.
- **Roles as addressing** — pool of ~50/guild (≤250 cap), sticky-LRU, rename on
  rebind. A role mention routes to the bound persona; pings nobody.
- **Threads** share the parent channel's webhook via `threadId` (1 webhook per
  parent covers the channel + all threads; the ≤15/channel cap is a non-issue).
- **Multiple webhooks per channel** = parallel rate-limit buckets for a hot
  channel; each persona is pinned to one webhook to keep its order.
- **Avatars** immutable per message; new messages pick up the current avatar.
- **Reactions** — both: a structured pseudo-reaction event always, plus an
  optional visible persona line.
- **Permissions** = relay policy ∩ what the bot can actually do in the channel.
- **Two "seen"s** — transport resume (seq cursor, in the client) vs the durable
  agent watermark (in mcpl). Kept separate on purpose.

### Identity & permissions — separate, live-editable stores

- `IdentityStore` (`PORTAL_IDENTITY`) — *who*: `{id, displayName, avatar, token}`.
- `PermissionsStore` (`PORTAL_PERMISSIONS`) — *what*: guild/channel-aware policy,
  resolve = channel-override ?? guild-default ?? persona-default ?? file-default
  (deny), then ∩ Discord reality.
- Both change live two ways: programmatic mutators (`relay.identity.upsert`,
  `relay.permissions.setChannel/…`) and **file hot-reload** (`fs.watchFile`,
  `PORTAL_WATCH_CONFIG`). Changes emit `persona_update` (+ live role rename) /
  `capabilities_update` to the persona's live sessions.

## Verification

**Unit tests** (offline): protocol frame guards/round-trip; gateway
handshake→identify→ready→rpc→dispatch→drop→resume; deterministic ids +
attribution-survives-restart + ownership safety; history-cache TTL/LRU/invalidate;
attachment validation; agent watermark/pending-ping logic; invite enrollment.

**Live against Discord** (a private test guild; bot with Manage Webhooks +
Manage Roles), via `portal-relay/scripts/*.mjs`:

- two personas posting through one bot via webhooks; reply, visible reaction,
  history with correct persona attribution, client-driven edit; auto role pool
- inbound role-mention routing → `addressedToMe` (`role_mention`), incl. a
  genuinely-external sender (subscription-gated ambient + role→persona routing,
  classified as an external `user`)
- the **full MCPL stack** end-to-end (host → portal-mcpl → relay → Discord)
- live config changes (`capabilities_update` / `persona_update` + live role
  rename; external file hot-reload)
- **RFC-001 restart gate**: snowflake-stable ids, edit own pre-restart message,
  **cross-persona edit rejected after restart**, cursor pagination by relay id
  and raw snowflake
- **RFC-002** `list_roles` (catalog + member-role-id resolution)
- **RFC-003** inline-attachment PNG round-trip + `path`-file rejection
- the **Claude Code channel** round-trip (see above)

Native (human) reaction *ingest* is wired but needs a human reactor to exercise
end-to-end; pin *triggering* needs the bot to hold Manage Messages in the channel
(the read path, `list_pins`, does not).

## Remaining work

1. **Moderation tools** — delete-others (`MANAGE_MESSAGES`), kick/ban/timeout,
   bulk delete; gate behind capabilities.
2. **Pin/unpin mutation** (read-only pins shipped).
3. **DM surface** — a web view + `/dm-link` slash command (webhooks can't DM).
4. **SQLite** for the attribution map + role bindings (JSON file today).
