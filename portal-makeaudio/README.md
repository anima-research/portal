# portal-makeaudio

A Portal **webhook-persona bot** named `makeaudio`. @-mention it with one or more
Discord message links (plus an optional prompt prefix) and it generates an audio
clip with the fal.ai **seed-audio** model and posts it back as a reply.

It holds **no Discord bot token** and uses **no integration slot** — it self-enrolls
a tokenless persona from a Portal invite and talks only to the relay over WebSocket.

```
@makeaudio <link1> [<link2> …] [prompt prefix words]
@makeaudio from:<link> to:<link> [prompt prefix words]
```

## Trigger & prompt rules

- **Trigger:** any message that **@-mentions the `makeaudio` persona** and contains
  at least one Discord message link. No `.command` prefix.
- **Prompt prefix:** everything in the mention message that isn't a link (mentions
  stripped) becomes an optional prefix prepended to the prompt.
- **Linked content is verbatim.** The bot fetches each linked message's text:
  - **1 link:** `prefix?\n<linked content verbatim>`
  - **N links:** `prefix?\n<author1>: <content1>\n<author2>: <content2>…` — each block
    prefixed by the linked message author's display name.
- **Range mode — `from:<link> to:<link>`:** fetches the **whole inclusive span** of
  messages between the two links (which must be in the **same channel**),
  chronological order, each tagged with its author's display name. Capped at
  `MAKEAUDIO_RANGE_CAP` messages (default 100; over-cap keeps the most recent and
  notes it in the status message). The order of `from`/`to` doesn't matter.
## Source-message filtering

Before building the prompt, the bot cleans the fetched source messages:

- **Suppresses** a message that **starts with `.`** (bot-hidden / its own status &
  audio messages) or that carries a **`:dotted_face:` (🫥) reaction** (manual opt-out).
- **Strips** from the remaining text: **custom-emoji** tokens (`<:Name:id>` /
  `<a:Name:id>`), **URLs** (`http(s)://…`, including image/CDN links) and bare
  `www.` links.
- **Never includes** attachments or images — only message `content` text is read;
  a message left empty after cleaning is dropped.

> **Reaction suppression caveat:** the public relay's `fetch_history` currently
> returns `reactions: []` (it only emits reactions as live events), so the
> `:dotted_face:` check is a **no-op until the relay is patched** to populate
> reactions on fetched messages (one change in `relay.ts` `toPortalMessage` +
> `discord-bot.ts` `convert`). The client code already honors them once present.

- **Status message:** when the job is submitted to fal, the bot posts a reply
  `. makeaudio: 🎧 audio submitted for processing…` and then **edits that same
  message** into the outcome — `✅ audio ready.` on success, or
  `⚠️ <reason>` on any failure (bad/empty link, generation error, download error).
- **Reply** is posted in the **same channel as a reply** to the trigger, and every
  message the bot posts **starts with `.`** so other bots ignore it. The audio is
  attached inline alongside the status message.

## Why no channel subscriptions

The relay delivers a message to any persona with a **live session** when that persona
is **role-mentioned or replied-to**, *regardless of subscription*
(`portal-relay/src/relay.ts` `deliverMessage`). So makeaudio just keeps a connection
open and waits to be mentioned — no need to subscribe to (and ingest the firehose of)
every channel. `PORTAL_SUBSCRIPTIONS` is available if you ever want ambient channels.

## Run

```bash
npm install
FAL_KEY=<fal-key> ./start.sh
```

First run enrolls the persona via `PORTAL_INVITE` and caches creds at
`~/.portal/makeaudio.creds.json` (mode 0600). Subsequent runs reuse them.

`start.sh` refuses to start if another instance is already running — **two instances
post duplicate replies**, so always run exactly one.

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `PORTAL_URL` | `wss://portal.animalabs.ai` | Relay WS endpoint |
| `PORTAL_INVITE` | (baked) | Invite code; only used on first enroll |
| `PORTAL_PERSONA_NAME` | `makeaudio` | Display name |
| `PORTAL_CREDENTIALS` | `~/.portal/makeaudio.creds.json` | Cached creds |
| `FAL_KEY` | (baked fallback) | fal.ai API key — prefer setting in env |
| `FAL_MODEL` | `bytedance/seed-audio-1.0` | fal model id |
| `PORTAL_SUBSCRIPTIONS` | _(none)_ | Optional comma-separated channel ids |
| `MAKEAUDIO_RANGE_CAP` | `100` | Max messages pulled by a `from:/to:` range |

## Test

```bash
node test/e2e.mjs            # enrolls a tester persona, posts a link + mention,
                            # waits for the audio reply (polls history)
```

## Deploy to borgs.animalabs.ai

This is a plain Node ESM app importing the co-located `portal-client` build. To run
it on `borgs`:

1. Ensure `portal-client` is built there (`cd portal-client && npm i && npm run build`),
   or vendor `@animalabs/portal-client` once it's published.
2. `cd portal-makeaudio && npm install`.
3. Run under a supervisor (systemd / pm2) executing `./start.sh` with `FAL_KEY` set
   in the unit's environment. Keep it to **one instance**.
