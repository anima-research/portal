# PORTAL RFC-006 — Markdown-preserving split sends + inline audio

- **Status:** ✅ Implemented (2026-07-08)
- **Author:** Wolfram (drafted with Claude Code)
- **Date:** 2026-07-08
- **Affects:** `portal-protocol` (`rpc.ts` `SendMessageResult`, `message.ts` `PortalMessage.partOf` + `PortalAttachment.duration/waveform`), `portal-relay` (`discord-markdown.ts` NEW, `relay.ts`, `webhook-pool.ts`, `message-store.ts`, `discord-bot.ts`), `portal-mcpl` (`server.ts`, `agent-state.ts`, `tools.ts`, `agent.ts`)
- **Protocol version:** additive only — no `PORTAL_PROTOCOL_VERSION` bump (older clients never see the new optional fields).
- **Provenance:** ports chapterx `fix/markdown-across-message-splits` (PR #13) and `feat/audio-input` (PR #12, with membrane PR #29 context) onto portal's relay architecture.

---

## 1. Markdown-preserving split sends (relay)

**Problem.** The relay had no handling for Discord's 2000-char content limit: an
over-long `send_message` bubbled a raw discord.js error up as `INTERNAL`. And a
naive split would corrupt markdown — Discord parses each message independently,
so a code fence or emphasis straddling a boundary breaks everything after it.

**Design.**

- `portal-relay/src/discord-markdown.ts` — the splitter engine, ported verbatim
  (modulo formatting) from chapterx. `splitPreservingMarkdown(text, 2000)`
  closes every construct open at a chunk boundary and reopens it in the next
  chunk, records the synthetic `bridgeOpen`/`bridgeClose` strings per chunk,
  caps fence info-strings so a reopener can't blow the budget, and avoids
  fusing synthetic delimiters with adjacent runs. Keep in sync upstream.
- **Send** (`relay.ts sendMessage`): content ≤ 2000 → unchanged single-send
  path. Longer → split; parts go out via `WebhookPool.sendMany`, which enqueues
  ALL parts as one item on the persona's webhook queue so no same-webhook send
  can interleave between them (single sends delegate to the same path). Files
  ride on the last part. A mid-sequence failure records the parts that DID land
  (attributable/editable) and fails the RPC with `DISCORD_ERROR` naming their
  relay ids, so the caller can delete them or send the remainder.
- **Result shape**: `SendMessageResult.messageIds?` lists every part (first =
  `messageId`). `PortalMessage.partOf?` marks continuation parts so clients can
  group them.
- **Store** (`message-store.ts`): refs/attribution rows carry
  `bridgeOpen`/`bridgeClose`/`parts` (first part)/`partOf` (continuations) —
  persisted, so bridge stripping and whole-set edit/delete survive restarts.
- **Bridge stripping** (`relay.ts buildPortalMessage` → `stripBridges`): the one
  choke point where Discord messages become `PortalMessage`s (live events,
  fetch_history, pins) removes the synthetic markers, so agents always see
  their original unbroken markdown. A fence reopener whose info string Discord
  rewrote (mentions in `cleanContent`) is matched on the fence marker run alone.
- **Echo/record race** (found in live verification): the gateway's create echo
  for our own webhook message can beat the sending RPC's `store.record` — for
  split sends it's near-certain (part 1's echo lands while later parts are
  still posting), which would dispatch live events unstripped and without
  `partOf`. Two-sided fix: `sendMany` fires an `onSent` callback per part so
  the relay records each part the moment it exists, and `onDiscordMessage`
  HOLDS an own-webhook echo with no store ref until the send path records and
  flushes it (`flushEcho`; 5 s timer as safety net). Symmetrically, surplus
  parts deleted by an edit leave store cleanup to the gateway's delete echo
  (like `delete_message`), so the `message_delete` event keeps its relay id.
- **Edit** (`edit_message`): redirected to the first part; new content is
  re-split and written across the existing parts; surplus parts are deleted;
  bridge metadata is rewritten (`setSplitMeta`). Needing MORE parts than the
  original send is refused with `INVALID_PARAMS` (Discord can't insert messages
  in place) — shorten, or delete and resend.
- **Delete** (`delete_message`): fans out over all parts (both own-webhook and
  moderation paths). Every part is attempted; any failure still surfaces as
  `DISCORD_ERROR` (never a silent success). A surplus part whose delete fails
  during an edit keeps its store ref so it stays addressable.

**Verified:** `portal-relay/test/discord-markdown.test.ts` (140 tests, ported
from chapterx) and `test/split-send.test.ts` (sendMany ordering/contiguity/
partial failure, onSent per-part callback, store round-trip, stripBridges,
split→strip reassembly). **Live-verified** (2026-07-08) against a real guild
with `scripts/rfc6-live.mjs` — 21/21 checks: 4-part split send, stripped live
events + history + reassembly, `partOf` back-links, shrink edit, collapse with
surplus deletion, grow-edit refusal, delete fan-out, audio attachment CDN
round-trip, native 🐘 reaction.

## 2. Inline audio for agents (mcpl) + protocol audio metadata

**Problem.** Audio attachments (voice messages, music files) reached agents only
as URL text notes — an audio-capable model behind portal could never hear them.

**Design.**

- **Protocol**: `PortalAttachment` gains optional `duration` (seconds) and
  `waveform` (base64 preview) — Discord voice-message fields the relay now
  captures from discord.js (`discord-bot.ts`).
- **Opt-in, per channel, default OFF** (mirrors the RFC-A reactions pattern):
  durable `audioChannels` set on `AgentState`, toggled by the new
  `set_audio_visibility` tool. Content-shaping only — wake behavior unchanged
  (`chat:has-audio` tagging was already there; it now also catches
  extension-detected audio with no content-type).
- **Inlining** (`server.ts buildContent`): when the channel is opted in, audio
  attachments are fetched (15s timeout) and delivered as MCPL
  `{type:'audio', data, mimeType}` blocks (`mcpl-core` already declares
  `AudioContent`). Detection: `audio/*` content-type OR filename extension
  (Discord's `contentType` is optional). MIME is normalized (MP3 aliases
  `audio/mpeg`, `audio/mpeg3`, `audio/x-mpeg-3` → `audio/mp3`; parameters
  stripped) so provider layers (e.g. membrane ≥ PR #29 behind connectome) can
  map it. Caps: 12 MiB raw per clip (~16 MiB base64), max 2 clips per message;
  over-cap or failed fetches degrade to a text note (now with duration).
- **Oversized flag**: an opted-in agent seeing a >12 MiB clip reacts natively
  🐘 via the existing `react` RPC (shared-bot reaction — idempotent across
  multiple agents), so the sender knows nobody can hear it. Ported from
  chapterx's `oversized_audio_emote`.
- **Non-goals**: no relay-side audio fetching/caching (the relay stays a thin
  id/attribution layer; each opted-in agent fetches from the Discord CDN
  directly), no transcription, no voice-channel support, no Claude Code channel
  inlining (`server-cc.ts` payloads are plain strings — attachments stay URL
  lines there).

**Verified:** `portal-mcpl/test/audio.test.ts` (opt-in toggle + serialization,
MIME normalization, detection fallback chain). **Live-verified end-to-end with
a real model** (2026-07-08, `scripts/mimo-audio-live.mjs`): a spoken .wav
posted by one persona reached a MiMo v2.5-driven persona as an mcpl audio
block (`buildContent`, exported for this), was mapped to an OpenRouter
`input_audio` part (membrane's adapter shape), and the model quoted the spoken
sentence verbatim in its reply.
