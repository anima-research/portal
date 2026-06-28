#!/usr/bin/env node
/**
 * portal-makeaudio — a Portal webhook-persona bot named "makeaudio".
 *
 * Trigger: @-mention the `makeaudio` persona in a message that contains one or
 * more Discord message links, e.g.
 *
 *     @makeaudio https://discord.com/channels/<g>/<c>/<m>  in a noir whisper
 *     @makeaudio <link1> <link2>            (concatenates both, displayname-tagged)
 *
 * Everything in the mention message that isn't a Discord message link is treated
 * as an optional *prompt prefix*. The bot fetches each linked message's content
 * verbatim and builds the fal.ai prompt:
 *
 *   - 1 link:   <prefix?>\n<linked message content verbatim>
 *   - N links:  <prefix?>\n<author1>: <content1>\n<author2>: <content2>\n…
 *
 * It calls the fal.ai seed-audio model, downloads the produced clip, and posts it
 * back into the same channel as a reply to the mention. The reply content starts
 * with a period ('.') so other bots ignore it.
 *
 * No Discord bot token of its own: it self-enrolls a tokenless persona from a
 * Portal invite and talks only to the relay over WS.
 *
 * No channel subscriptions needed: the relay dispatches a message to any persona
 * with a *live session* when that persona is role-mentioned or replied-to,
 * regardless of subscription (relay.ts deliverMessage). So makeaudio just keeps a
 * connection open and waits to be @-mentioned. (PORTAL_SUBSCRIPTIONS still lets
 * you opt into ambient channels if you ever want that.)
 *
 * Env:
 *   PORTAL_URL           relay WS url            (default wss://portal.animalabs.ai)
 *   PORTAL_INVITE        invite code            (required on first run, to enroll)
 *   PORTAL_PERSONA_NAME  display name           (default "makeaudio")
 *   PORTAL_CREDENTIALS   creds cache path       (default ~/.portal/makeaudio.creds.json)
 *   PORTAL_SUBSCRIPTIONS comma channel ids      (optional; default none — mentions
 *                                                are delivered without subscribing)
 *   FAL_KEY              fal.ai api key         (required)
 *   FAL_MODEL            fal model id           (default bytedance/seed-audio-1.0)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fal } from '@fal-ai/client';
import { PortalClient, loadOrEnrollCreds } from '../../portal-client/dist/src/index.js';

// ── Config ──
const URL_WS = process.env.PORTAL_URL ?? 'wss://portal.animalabs.ai';
const INVITE = process.env.PORTAL_INVITE ?? 'inv_eWHy-z-gbVsyA-KoXb2RTi3Q';
const PERSONA_NAME = process.env.PORTAL_PERSONA_NAME ?? 'makeaudio';
const CREDS_PATH =
  process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', 'makeaudio.creds.json');
const FAL_KEY = process.env.FAL_KEY ?? '2b577689-e3dc-40f9-9e06-89c0e6ad249d:ec02c54404adc4e2690d35b065d1586a';
const FAL_MODEL = process.env.FAL_MODEL ?? 'bytedance/seed-audio-1.0';
const RANGE_CAP = Number(process.env.MAKEAUDIO_RANGE_CAP ?? '100'); // max msgs in a from:/to: span
const SUBS_ENV = (process.env.PORTAL_SUBSCRIPTIONS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log('[makeaudio]', new Date().toISOString(), ...a);
const warn = (...a) => console.warn('[makeaudio]', new Date().toISOString(), ...a);

if (!FAL_KEY) {
  console.error('[makeaudio] FATAL: FAL_KEY is required');
  process.exit(1);
}
fal.config({ credentials: FAL_KEY });

// Matches discord / discordapp / ptb / canary message links.
const DISCORD_MSG_LINK =
  /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/g;
// `from:<link>` / `to:<link>` range markers.
const FROM_LINK = /\bfrom:\s*(\S+)/i;
const TO_LINK = /\bto:\s*(\S+)/i;

/** Extract {channelId, messageId} from a single Discord message link, or null. */
function linkOf(s) {
  const m = s && s.match(/discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/);
  return m ? { channelId: m[1], messageId: m[2] } : null;
}

// ── Helpers ──

/** Author display name for a fetched message. */
function authorName(msg) {
  const a = msg?.author;
  if (!a) return 'unknown';
  if (a.kind === 'persona') return a.displayName || 'persona';
  if (a.kind === 'user') return a.displayName || a.username || 'user';
  return 'system';
}

/** Strip leading/embedded mentions of *our* persona role/user from the text. */
function stripOurMentions(content) {
  // Remove every role/user mention token. The relay routes a persona address via
  // its bound role mention (<@&id>); we also drop plain user mentions just in case.
  return content.replace(/<@[!&]?\d+>/g, ' ');
}

// Custom-emoji tokens like <:WeAreNotACar:1500233350986727475> or animated
// <a:name:id> — strip them from any text fed to the model.
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const DOTTED_FACE = '\u{1FAE5}'; // 🫥 — Discord shortcode :dotted_face:/:dotted_line_face:

/** Normalize message text for TTS: drop custom-emoji tokens, URLs (incl. image /
 *  CDN links), and bare www links, then tidy leftover whitespace. Attachments and
 *  images are never included to begin with (we only ever read `content`). */
function cleanText(s) {
  return (s || '')
    .replace(CUSTOM_EMOJI, '')
    .replace(/https?:\/\/\S+/gi, '') // any URL, including image/attachment links
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Whether a fetched source message should be excluded from the prompt:
 *   - content starts with '.' (bot-hidden / our own status & audio messages)
 *   - it carries a :dotted_face: (🫥) reaction (manual opt-out)
 * NB: reaction-based suppression needs the relay to populate reactions in
 * fetch_history (see README "Reaction suppression"); harmless no-op until then. */
function isSuppressed(m) {
  if ((m.content || '').replace(/^\s+/, '').startsWith('.')) return true;
  for (const r of m.reactions || []) {
    const e = r.emoji || '';
    if (e === DOTTED_FACE || /dotted[_ ]?(line[_ ]?)?face/i.test(e)) return true;
  }
  return false;
}

/**
 * Parse the mention message into:
 *   - range:  { from, to } when `from:<link> … to:<link>` is present (a contiguous
 *             span of messages in one channel, inclusive)
 *   - links:  individual {channelId, messageId} for bare links (non-range mode)
 *   - prefix: everything else (mentions + markers + links stripped)
 */
function parseTrigger(content) {
  let rest = content;

  // Range mode takes precedence: from:<link> … to:<link>.
  const fromM = content.match(FROM_LINK);
  const toM = content.match(TO_LINK);
  const from = fromM && linkOf(fromM[1]);
  const to = toM && linkOf(toM[1]);
  let range = null;
  if (from && to) {
    range = { from, to };
    rest = rest.replace(FROM_LINK, ' ').replace(TO_LINK, ' ');
  }

  // Remaining bare links (used only when not in range mode).
  const links = [];
  for (const m of rest.matchAll(DISCORD_MSG_LINK)) {
    links.push({ channelId: m[2], messageId: m[3] });
  }
  rest = rest.replace(DISCORD_MSG_LINK, ' ');

  const prefix = cleanText(stripOurMentions(rest).replace(/\s+/g, ' '));
  return { range, links: range ? [] : links, prefix };
}

/** Fetch a single Discord message by snowflake via the relay's fetch_history. */
async function fetchLinkedMessage(client, channelId, messageId) {
  // before/after are exclusive snowflake bounds → a 1-wide window isolates the
  // target message (relay accepts raw snowflakes as cursors, RFC-001).
  const before = (BigInt(messageId) + 1n).toString();
  const after = (BigInt(messageId) - 1n).toString();
  const { messages } = await client.fetchHistory({
    channelId,
    before,
    after,
    limit: 1,
  });
  const hit = messages.find((m) => m.nativeId === messageId) ?? messages[0];
  if (!hit) throw new Error(`message ${messageId} not found in channel ${channelId}`);
  return hit;
}

/**
 * Fetch the inclusive span of messages between two links in the same channel,
 * chronological order. Returns { messages, truncated } — `truncated` is true when
 * the span was larger than RANGE_CAP (only the most recent RANGE_CAP are kept).
 */
async function fetchRange(client, from, to) {
  if (from.channelId !== to.channelId) {
    throw new Error('from: and to: links must be in the same channel');
  }
  const a = BigInt(from.messageId);
  const b = BigInt(to.messageId);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const { messages } = await client.fetchHistory({
    channelId: from.channelId,
    before: (hi + 1n).toString(),
    after: (lo - 1n).toString(),
    limit: RANGE_CAP,
  });
  // fetch_history returns newest-first within the window → chronological order.
  const ordered = messages.slice().reverse();
  // The relay pages backward from `before`, so an over-cap span drops the OLDEST.
  const truncated = ordered.length >= RANGE_CAP;
  if (ordered.length === 0) {
    throw new Error(`no messages found in range in channel ${from.channelId}`);
  }
  return { messages: ordered, truncated };
}

/** Download the produced audio and return { bytes(base64), name, contentType }. */
async function downloadAudio(audioUrl) {
  const res = await fetch(audioUrl);
  if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  let ext = 'mp3';
  const m = /\.(mp3|wav|ogg|flac|m4a|aac)(?:\?|$)/i.exec(audioUrl);
  if (m) ext = m[1].toLowerCase();
  else if (/wav/.test(contentType)) ext = 'wav';
  else if (/ogg/.test(contentType)) ext = 'ogg';
  return { bytes: buf.toString('base64'), name: `makeaudio.${ext}`, contentType };
}

/** Human-readable reason from a fal error. fal ValidationError (HTTP 422) carries
 *  the real detail in `body.detail[]` (e.g. content-policy flags) — `e.message` is
 *  just the generic "Unprocessable Entity". */
function falErrorReason(e) {
  const detail = e?.body?.detail;
  if (Array.isArray(detail) && detail.length) {
    const msgs = detail.map((d) => d?.msg || d?.type).filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  }
  if (typeof detail === 'string' && detail) return detail;
  return String(e?.message || e);
}

/** Pull the audio url out of fal's seed-audio response (schema-tolerant). */
function extractAudioUrl(data) {
  if (!data) return undefined;
  return (
    data.audio?.url ??
    data.audio_url ??
    data.url ??
    (Array.isArray(data.audios) ? data.audios[0]?.url : undefined) ??
    (Array.isArray(data.audio) ? data.audio[0]?.url : undefined)
  );
}

// ── Core handler ──

async function handleTrigger(client, selfPersonaId, msg) {
  const { range, links, prefix } = parseTrigger(msg.content);
  if (!range && links.length === 0) {
    await postReply(
      client,
      msg,
      '. makeaudio: mention me with Discord message link(s), or a `from:<link> to:<link>` range.',
    );
    return;
  }

  // Gather the source messages, either a from:/to: span or individual links.
  let fetched = [];
  let truncated = false;
  if (range) {
    log(`trigger from ${authorName(msg)} in #${msg.channelId}: range ${range.from.messageId}→${range.to.messageId}, prefix=${JSON.stringify(prefix)}`);
    try {
      const r = await fetchRange(client, range.from, range.to);
      fetched = r.messages;
      truncated = r.truncated;
    } catch (e) {
      warn('range fetch failed', String(e?.message || e));
      await postReply(client, msg, `. makeaudio: ⚠️ couldn't read that range — ${String(e?.message || e)}`);
      return;
    }
  } else {
    log(`trigger from ${authorName(msg)} in #${msg.channelId}: ${links.length} link(s), prefix=${JSON.stringify(prefix)}`);
    for (const link of links) {
      try {
        fetched.push(await fetchLinkedMessage(client, link.channelId, link.messageId));
      } catch (e) {
        warn('fetch failed', link, String(e?.message || e));
        await postReply(client, msg, `. makeaudio: ⚠️ couldn't read message ${link.messageId} — ${String(e?.message || e)}`);
        return;
      }
    }
  }

  // Drop suppressed source messages: those starting with '.' (bot-hidden) or
  // tagged with a :dotted_face: reaction.
  const suppressed = fetched.length - (fetched = fetched.filter((m) => !isSuppressed(m))).length;
  if (suppressed) log(`suppressed ${suppressed} message(s) (dot-prefixed / :dotted_face:)`);

  // A range, or 2+ links, gets per-message `displayname:` tagging; a single
  // message is read verbatim. Custom-emoji tokens are stripped from the text.
  const multi = fetched.length > 1;
  const blocks = fetched
    .map((m) => {
      const text = cleanText(m.content);
      return text ? (multi ? `${authorName(m)}: ${text}` : text) : '';
    })
    .filter((s) => s && s.trim().length); // drop empty (emoji/attachment-only) lines
  const prompt = [prefix, ...blocks].filter((s) => s && s.length).join('\n');
  if (!prompt.trim()) {
    await postReply(client, msg, '. makeaudio: ⚠️ nothing to read — no usable text after suppressing hidden/emoji-only messages.');
    return;
  }

  // Posted once we submit the job to fal. We edit THIS message into the success
  // or failure notice so a request always has exactly one status message.
  const ack = await postReply(
    client,
    msg,
    `. makeaudio: 🎧 audio submitted for processing (${fetched.length} message${multi ? 's' : ''}${truncated ? `, capped at ${RANGE_CAP}` : ''}, ${prompt.length} chars)…`,
  );
  log(`fal ${FAL_MODEL} prompt (${prompt.length} chars): ${JSON.stringify(prompt.slice(0, 200))}`);

  let audioUrl;
  try {
    const result = await fal.subscribe(FAL_MODEL, { input: { prompt }, logs: false });
    audioUrl = extractAudioUrl(result?.data);
    log('fal done', result?.requestId, 'audioUrl=', audioUrl);
  } catch (e) {
    const reason = falErrorReason(e);
    warn('fal error', reason, e?.status ? `(status ${e.status})` : '');
    await setStatus(client, msg, ack, `. makeaudio: ⚠️ generation failed — ${reason}`);
    return;
  }
  if (!audioUrl) {
    await setStatus(client, msg, ack, '. makeaudio: ⚠️ generation failed — the model returned no audio.');
    return;
  }

  let file;
  try {
    file = await downloadAudio(audioUrl);
  } catch (e) {
    warn('download error', String(e?.message || e));
    await setStatus(client, msg, ack, `. makeaudio: ⚠️ couldn't fetch the generated file — ${String(e?.message || e)}\n${audioUrl}`);
    return;
  }

  try {
    await client.sendMessage({
      channelId: msg.channelId,
      threadId: msg.threadId,
      replyToId: msg.id,
      content: '.', // leading period hides it from other bots
      files: [file],
    });
    log('posted audio reply to', msg.id);
    await setStatus(client, msg, ack, '. makeaudio: ✅ audio ready.');
  } catch (e) {
    warn('send error', String(e?.message || e));
    await setStatus(client, msg, ack, `. makeaudio: ⚠️ couldn't post the audio — ${String(e?.message || e)}`);
  }
}

/** Post a reply (content always starts with '.'); returns the result or undefined. */
function postReply(client, msg, content) {
  return client
    .sendMessage({ channelId: msg.channelId, threadId: msg.threadId, replyToId: msg.id, content })
    .catch((e) => {
      warn('post failed', String(e?.message || e));
      return undefined;
    });
}

/** Edit the status (ack) message in place; fall back to a fresh reply. */
async function setStatus(client, msg, ack, content) {
  if (ack?.messageId) {
    try {
      await client.editMessage(ack.messageId, content);
      return ack;
    } catch (e) {
      warn('status edit failed, posting fresh', String(e?.message || e));
    }
  }
  return postReply(client, msg, content);
}

// ── Main ──

async function main() {
  const creds = await loadOrEnrollCreds({
    url: URL_WS,
    credsPath: CREDS_PATH,
    invite: INVITE,
    desiredName: PERSONA_NAME,
  });
  log(`persona ${PERSONA_NAME} → ${creds.personaId}`);

  const client = new PortalClient({
    url: URL_WS,
    token: creds.token,
    personaId: creds.personaId,
    subscriptions: SUBS_ENV,
  });

  const inFlight = new Set(); // de-dupe re-delivered events on resume

  client.on('error', (e) => warn('client error', String(e?.message || e)));
  client.on('close', ({ code, willReconnect }) =>
    log(`ws closed code=${code} reconnect=${willReconnect}`),
  );
  // Visibility on automatic recovery (the initial connect is logged in main()).
  client.on('resumed', (replayed) => log(`reconnected — session resumed (${replayed} events replayed)`));
  client.on('ready', () => log('session ready (fresh identify)'));

  client.on('message', ({ message, addressedToMe, reasons }) => {
    // Only act on direct addresses to us via a mention.
    if (!addressedToMe) return;
    if (!reasons.includes('role_mention') && !reasons.includes('name_mention')) return;
    // Never react to our own posts (avoid loops).
    if (message.author?.kind === 'persona' && message.author.personaId === creds.personaId) return;
    if (inFlight.has(message.id)) return;
    inFlight.add(message.id);
    handleTrigger(client, creds.personaId, message)
      .catch((e) => warn('handler crash', String(e?.stack || e)))
      .finally(() => inFlight.delete(message.id));
  });

  await client.connect();
  log(`connected to ${URL_WS} — waiting for @mentions (no subscriptions needed)`);
  if (SUBS_ENV.length > 0) log(`also subscribed to ambient channels: ${SUBS_ENV.join(', ')}`);

  // Keep alive.
  process.on('SIGINT', () => {
    log('shutting down');
    client.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    client.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[makeaudio] FATAL', e);
  process.exit(1);
});
