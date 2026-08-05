# PORTAL RFC-006 — Voice floor authority & multi-speaker orchestration

- **Status:** Draft / proposed
- **Author:** Ra & Weft (Claude), incorporating Sol's 2026-08-05 voice audit, red pens, and audit amendment
- **Date:** 2026-08-05
- **Affects:** `portal-relay` (voice-bot, new floor orchestrator, new voice output), `portal-protocol` (voice floor frames/events — minor bump), `portal-mcpl` (addressed wake delivery, `portal.voice` feature set), voice-kit (consumed as provider seam), voice-registry (resident → voice mapping)
- **Depends on:** the voice-STT ingress leg (PR #13: per-speaker Scribe, `utteranceId`, durable finals); `voice-kit`/`voice-registry` receiving anima-research homes (exact heads preserved, provenance READMEs). **Blocks:** any multi-agent voice deployment; discord-mcpl `feat/voice-physics` merge (held until floor-before-open is real).
- **Exit gate:** the audit's minimum completion test, verbatim, plus the audible-nonoverlap amendment (§8).

---

## 1. Summary

One Portal-owned control plane for voice: a **short-lived floor lease granted
before inference and before TTS**. Exactly one resident is selected and woken
per human utterance; losing candidates spend **zero provider inference and zero
synthesis**. One central output path synthesizes through voice-kit with
server-side keys and injects into Discord voice. Every acoustic guarantee is a
property of the lease and the single output path — never an assumption about
any client's local playback queue.

Topology is **shared-Portal-voice-bot first** (one mixer, one connection,
identity via voice + caption). The lease protocol is designed so per-resident
Discord bot bodies can consume it later with a floor-token check before
`TtsProvider.openStream()`; that follow-up inherits this RFC unchanged.

**Stack boundary (antra, 2026-08-05):** Melodeus — the iOS client, the
legacy TTS relay, Host `modules.ttsRelay`, and AF PR #68 — is a **separate
stack**. This RFC does not touch it: no component of Melodeus is converted,
repointed, retired, or superseded here, and no mutual compatibility is
required. Melodeus findings from the audit appear below strictly as
prior-art evidence — lessons that shaped this design, about a stack this
design leaves alone. Any Melodeus-side migration is separately scoped by
antra if and when she chooses.

## 2. Motivation

Sol's 2026-08-05 audit: every hard primitive exists at least once, but nothing
grants a floor before inference/TTS, so the stated goals — one speaker, no
overlap, no wasted TTS fees — are structurally unmet. Two findings sharpen the
requirements. Both are prior-art evidence from the separate Melodeus stack
(§1 boundary) — cited as lessons, not as components this RFC modifies:

- **Cost leaks are pre-acoustic.** The legacy relay lets every listening
  client synthesize the same utterance (duplicate billing); the Discord
  voice-physics WIP opens TTS before carrier-clear (pays for losing/waiting
  speakers). Preventing *audible* overlap is not the same as preventing
  *spend*; the lease must gate both, upstream.
- **Audit amendment (2026-08-05 19:51):** Melodeus iOS's device-local
  nonoverlap is *intended serialization*, not a demonstrated acoustic-floor
  guarantee (`globalLastTask` serializes scheduling across voices, but each
  bot owns a separate `AVAudioPlayerNode`, and the task can complete at
  buffer-schedule time rather than audible completion). No client queue may
  be cited as an overlap guarantee; the e2e test must assert audible
  nonoverlap at the sink.

## 3. The floor lease

### 3.1 Lease object

```jsonc
{
  "leaseId": "fl_...",            // unique per grant
  "floorEpoch": 41,                // monotonic per channel within a process
  "revision": 3,                   // bumps on any mutation of this lease
  "processEpoch": "pe_...",        // Portal process identity (see §3.4)
  "channelId": "…", "guildId": "…",
  "utteranceId": "u_...",          // the transcript this lease answers
  "speakerAgent": "persona:…",    // selected resident identity, explicit
  "grantedAt": 1754000000000,
  "leaseUntil": 1754000012000      // positive, finite expiry — always
}
```

Rules (each is a named test in the conformance suite):

- **Grant-before-cost.** No addressed wake, no provider inference, no
  `openStream()` without a live lease naming that resident. The completion
  invariant is explicit: a losing candidate performs zero provider inference
  and zero synthesis.
- **Positive expiry.** `leaseUntil` is always finite; a lease cannot be
  granted open-ended. Extension = revision bump on the same `leaseId`, never
  silence.
- **Revoke-before-regrant.** A new lease for a channel may only be granted
  after the prior lease reached a terminal state and its receipt was emitted.
  No two live leases per channel, ever — including during handoff.
- **Carrier-clear precedes `openStream()`.** The output path checks the
  acoustic medium *and* lease liveness immediately before opening synthesis.
  Occupied medium or dead lease ⇒ synthesis never opens, no fee accrues.
- **No lease survives Portal restart.** Leases are `processEpoch`-scoped. A
  consumer observing a new `processEpoch` treats every prior lease as revoked.
  Restart therefore cannot leave a zombie floor (named test: kill Portal
  mid-lease, restart, verify clean grant path and no double-speak).
- **Idempotent terminal receipt.** Every lease ends in exactly one logical
  terminal state — `completed | revoked | expired | aborted` — carried by a
  receipt that is safe to re-send and deduped by `leaseId` by consumers. The
  receipt carries the voiced/unvoiced boundary when synthesis was cut
  (exact where known, `estimated: true` otherwise).

### 3.2 Selection & addressing

Per utterance, the orchestrator selects **at most one** resident:

1. **Explicit target** — the transcript names a resident (resolver-confirmed).
2. **Current conversational addressee** — sticky last-interaction state for
   the channel, same policy family as discord-mcpl's sticky reply.
3. **Ask / hold** — no target resolvable: nobody wakes, nobody infers; the
   room gets a visible held-utterance indicator. Never wake-everyone.

Only the selected resident receives an **addressed wake** (wake-band tags).
Other residents may receive the final transcript as non-waking context, and
only according to subscription/privacy policy (§6). PR #13's non-waking
fanout is the ingress primitive this consumes; it is not the finished
behavior on its own.

### 3.3 Flow (one utterance, end to end)

1. Human speech → Portal's shared listener (PR #13) emits durable final with
   `utteranceId`.
2. Orchestrator selects per §3.2, or holds.
3. Lease granted **before** anything costs money.
4. Addressed wake to `speakerAgent` alone; non-waking context per policy.
5. Response text streams toward the output path; carrier-clear + lease
   liveness checked; only then `openStream()` through voice-kit, voice chosen
   from voice-registry, keys server-side only (no client-distributed
   ElevenLabs keys, no per-device duplicate synthesis — the prior-art cost
   holes from §2, excluded by construction).
6. Human barge-in (energy VAD) ⇒ abort playback and synthesis and — where
   still live — the inference; terminal receipt `aborted` with the boundary;
   transcript reflects what was actually heard.
7. Ledger row (§5) written at terminal receipt.

### 3.4 Process epoch

`processEpoch` is minted at Portal start and carried on every grant and
receipt. It is the restart-safety mechanism (leases die with the process) and
the correlation key for the ledger. This mirrors the desired/effective/epoch
pattern converging in the Connectome shared-config design — same epistemics:
disk is never proof, the process attests what it is actually enforcing.

## 4. Output topology

**v1 (this RFC): shared Portal voice bot.** One voice connection, one mixer,
one synthesis pipeline. Speaker identity conveyed by registry voice +
text-channel caption naming the resident.

**v2 (designed-for, not built here): per-resident Discord bot bodies.** Each
body presents its lease token; discord-mcpl checks it before
`TtsProvider.openStream()`. The discord `feat/voice-physics` branch (rebased,
held unmerged) becomes v2's base once its synthesis-open moves behind the
floor check. Nothing in §3 changes between v1 and v2.

**The voice output seam is new and Portal-owned.** A narrowly named Portal
voice-output transport carries the selected resident's response text from the
host to the Portal synthesis path under the lease. Per the §1 stack boundary,
this is built fresh: Host `modules.ttsRelay`, the Melodeus relay, and AF #68
are not repointed, retired, or closed by this train — they belong to the
other stack and stay exactly as they are. (AF #68's abort/keep-spoken-text
*idea* — inference abort on barge-in with the voiced prefix preserved — is
prior art this design independently needs; it is re-implemented at the new
seam, not migrated.)

## 5. Usage ledger

Metadata-only, per utterance/lease, distinguishing (Sol red pen #6):

`sttSeconds` · `inferenceSelected` / `inferenceCancelled` ·
`ttsChars` · `synthesisOpened` / `synthesisCancelled` ·
`voicedDurationMs` · `interruption` (by whom/when/boundary kind) ·
`estimatedCost`. Plus `leaseId`, `floorEpoch`, `processEpoch`, terminal state,
and hold/cancel reasons. Content never appears in the ledger.

The "save on TTS fees" goal becomes auditable here: `synthesisOpened` for a
losing candidate is a bug with a row pointing at it.

## 6. Consent, privacy, visibility

- The room always shows listening/speaking state (voice-channel presence +
  indicator), and offers an immediate stop (operator and resident both).
- Non-waking transcript fanout is governed by subscription/privacy policy:
  residents receive ambient speech context only where they could already read
  the channel, and the policy surface says so explicitly.
- Retention: partials are never persisted (display-plane, from PR #13);
  finals are durable channel events under existing channel ACLs; raw audio is
  not retained beyond the STT session.
- Resident voice choice lives in voice-registry and is the resident's to
  change through its own authenticated path.

## 7. Development & verification strategy

Per Sol: lease semantics need no production keys. Development runs synthetic
STT/TTS provider adapters (voice-kit seams) and local Discord fixtures; the
conformance suite drives the named tests in §3.1 plus selection policy and
ledger rows entirely offline. Production ElevenLabs provisioning and
deployment ownership are Antra's decisions, orthogonal to this RFC.

## 8. Exit gate

The audit's minimum completion test, verbatim — one human + two residents,
one spoken turn: one canonical final transcript; exactly one resident wakes;
exactly one TTS request opens; no audible overlap; barge-in stops audio and
synthesis; the voiced boundary (exact or marked-estimated) reaches the
resident; the losing resident makes zero inference/TTS calls; restart leaves
no zombie lease; the room shows listening/speaking state and offers immediate
stop — **plus** the amendment's sharpening: audible nonoverlap is asserted at
the sink (mixed output), not inferred from any client's scheduling queue.

## 9. Open questions

1. Hold behavior UX: how long does a held utterance stay claimable, and does
   the indicator prompt in-channel or only in room state?
2. Barge-in policy for bot-vs-bot (v2): collision yield exists in the physics
   branch; does v1's single mixer need any bot-priority rule at all?
3. Whether the ledger surfaces to residents (own rows only?) or stays
   operator-scoped until the shared config/observability facility lands.
