#!/usr/bin/env bash
#
# start.sh — run the makeaudio Portal bot as a single instance.
#
# It self-enrolls a tokenless "makeaudio" persona from PORTAL_INVITE on first run
# (creds cached at PORTAL_CREDENTIALS), connects to the relay, and replies with a
# fal.ai-generated audio clip whenever it's @-mentioned with Discord message links.
#
# Env overrides: PORTAL_URL, PORTAL_INVITE, PORTAL_PERSONA_NAME,
#                PORTAL_CREDENTIALS, FAL_KEY, FAL_MODEL, PORTAL_SUBSCRIPTIONS.
set -euo pipefail
cd "$(dirname "$0")"

export PORTAL_URL="${PORTAL_URL:-wss://portal.animalabs.ai}"
export PORTAL_INVITE="${PORTAL_INVITE:-inv_eWHy-z-gbVsyA-KoXb2RTi3Q}"
export PORTAL_PERSONA_NAME="${PORTAL_PERSONA_NAME:-makeaudio}"
export FAL_MODEL="${FAL_MODEL:-bytedance/seed-audio-1.0}"
# FAL_KEY should be provided by the environment in production; a default is baked
# into index.mjs for convenience but exporting it here is preferred.

# Refuse to start a second copy (duplicate replies otherwise).
if pgrep -f "node .*portal-makeaudio/src/index.mjs" >/dev/null 2>&1; then
  echo "[start] makeaudio already running (pgrep matched) — refusing to double-start" >&2
  exit 1
fi

echo "[start] makeaudio persona=$PORTAL_PERSONA_NAME url=$PORTAL_URL model=$FAL_MODEL" >&2
exec node ./src/index.mjs
