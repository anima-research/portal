# PORTAL RFC-006 — Voice transport: STT ingress, floor-client duties, grant-checked output

- **Status:** Draft / proposed (rev 3 — shrunk to the transport contract)
- **Authors:** Ra & Weft (Claude); ownership boundary by antra; floor design relocated per Sol's split ruling
- **Date:** 2026-08-06 (rev 3; rev 1 2026-08-05)
- **Affects:** `portal-relay` (voice-bot from PR #13, new voice-output path, floor-client duties), `portal-protocol` (voice events — minor bump, already in PR #13's branch)
- **Depends on:** PR #13 (STT ingress: per-speaker Scribe, `utteranceId`, ephemeral partials, durable finals); **FLOOR-RFC-001** (`anima-research/floor-control` PR #1) for every selection/floor concept — this document contains none of its own
- **Decision record:** rev 1 designed a Portal-owned floor/orchestrator; antra ruled Portal transports and must stay simple ("Portal is the road; floor control is the traffic signal" — Sol's phrasing of the same boundary); the floor design moved to FLOOR-RFC-001 under its own two-day convergence. This revision is the residue: what Portal does at the Discord edge, and nothing else. The Melodeus stack boundary from rev 2 stands: Melodeus (iOS, legacy relay, Host `modules.ttsRelay`, AF #68) is a separate stack this RFC does not touch; its findings appear only as prior art in FLOOR-RFC-001's motivation.

---

## 1. Summary

Portal moves voice to and from Discord. It transcribes, it transports, it
reports, and — on its own output path — it enforces. It never selects who
speaks, owns no room policy, and holds no floor state beyond what a grant
hands it.

Responsibilities, complete list:

1. **Discord audio in → decoded per-speaker media / transcript events out**
   (PR #13): one relay voice connection per guild, per-human-speaker Scribe
   sessions, ephemeral partials (display-plane, replace-in-place by
   `utteranceId`, never sequenced or replayed), durable finals delivered as
   ordinary room traffic — non-waking, per subscription.
2. **Floor-client duties (traffic feed + evidence).** For a floor-managed
   room, Portal submits finalized utterances with **structural addressing
   evidence** (explicit target if resolver-confirmed, current
   conversational addressee, or none) and preserved authenticated
   provenance to the floor service. Evidence, never a decision: the active
   logic selects; Portal's submission is one input to the book.
3. **Binding claims.** Portal registers the rooms it relays with the floor
   service using its preserved Discord guild/channel provenance
   (`discord://<guild>/<channel>` plus Portal's origin locator), per
   FLOOR-RFC-001 §5 — a provisional, authenticated claim that makes the
   binding addressable and lets discord-mcpl and Portal deterministically
   claim the *same* binding. Portal never merges bindings or mints room
   identity.
4. **Grant-checked voice output.** The new Portal voice-output path (built
   fresh; no Melodeus component) synthesizes through voice-kit with the
   resident's voice-registry choice, keys server-side only — and **requires
   a valid grant before `openStream()`**: transport-side enforcement of
   FLOOR-RFC-001's voluntary-compliance model on the one path Portal owns.
   Carrier-clear is checked at open on the same path. No valid grant, no
   synthesis, no fee.
5. **Boundary reporting.** On barge-in or truncation, Portal aborts
   playback/synthesis and reports the voiced/unvoiced boundary (exact where
   character timing allows, `estimated: true` otherwise) into the grant's
   terminal receipt, and reflects what was actually heard in the room
   record.
6. **Join/leave and media consent state.** Voice join is explicit and
   visible; listening/speaking state shows in the room; operator and
   resident both have an immediate stop. Raw audio is not retained beyond
   the STT session; partials are never persisted; finals are durable
   channel events under existing channel ACLs.

## 2. What Portal explicitly does not do

- No responder selection, no room policy, no floor ownership (FLOOR-RFC-001
  owns all three).
- No wake decisions: transcripts arrive as non-waking room traffic; the
  wake, when there is one, is the floor service's grant event on its own
  client surface (e.g. the floor MCPL adapter's `floor:*` tagged addressed
  events). Portal does not deliver addressed wakes on the floor's behalf.
- No second speech band: anything human-readable Portal emits (voice-join
  notices, transcription-started lines) is ordinary channel traffic under
  Portal's visible identity, consistent with FLOOR-RFC-001's two-band rule.
- No client-distributed provider keys, no per-device synthesis: the output
  path is central, keys stay server-side.
- Nothing Melodeus: separate stack, untouched.

## 3. Interfaces

- **To the floor service** (its transport-neutral API): binding
  claims; utterance submissions `{roomId-binding, utteranceId, speaker,
  finalizedAt, addressingEvidence, provenance}`; grant validation on the
  output path; terminal-receipt boundary reports.
- **From PR #13** (unchanged): `voice_join`/`voice_leave` tools under the
  `portal.voice` feature set; `voiceTranscript`/`voiceStatus` events;
  `VOICE_LISTEN` permission.
- **Output path** (new, small): accept a granted resident's response
  stream, verify grant + carrier-clear, synthesize via voice-kit +
  voice-registry, inject into the Discord voice channel, report the
  boundary. Inference-abort-on-barge-in is coordinated with the resident's
  host through the grant receipt (the abort/keep-spoken-text idea credited
  to AF #68 as prior art, re-implemented at this seam).

## 4. Conformance (Portal's slice of FLOOR-RFC-001's exit gates)

Portal is the transport in the voice gate: one human utterance → one
submission with evidence → (floor service selects) → exactly one synthesis
opened *with a valid grant*, no audible overlap asserted at the mixed
sink, barge-in aborts with the boundary in the receipt, the losing
resident spends zero, restart leaves no zombie grant honored — a stale
grant (dead `processEpoch`/`logicEpoch`) presented to the output path is
refused. Plus rev 1's surviving portal-local tests: partials never
sequenced/replayed (PR #13's suite), finals non-waking, consent state
visible.
