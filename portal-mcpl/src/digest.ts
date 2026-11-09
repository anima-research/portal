/**
 * The digest view of fetched history (portal#79): one line per message instead of the whole object, rendered here
 * from the full messages the relay already returned. It saves the agent's context, not relay bandwidth, and it is
 * off unless the server turns it on (agent.ts, PORTAL_DIGEST_VIEW).
 *
 * Two rules keep a digest honest. A line that was cut says how much, and which message holds the rest, so it is never
 * mistaken for the whole message. And a message the agent most needs whole comes back whole: one addressed to it, and
 * the message an addressed message replies to.
 *
 * "Addressed to it" is derived from what a history message carries. The relay works out addressedToMe only for live
 * events, so here it is: another author's message that mentions this persona (mentions.personas), or replies to a
 * message this persona wrote, found in the same batch or among the ids it is known to have written (sent by this
 * server, or shown by an earlier digest). The persona's own messages are never addressed to it. A name typed
 * in the text without a mention, a role mention the relay did not resolve to this persona, and a reply to a message
 * outside the batch that this server never sent nor showed are not seen.
 *
 * A message shown whole keeps its own line breaks and indentation; only a message that is cut is flattened to one
 * line. A cut never lands inside a character: it falls on a boundary a person would see (an emoji, a flag or a joined
 * family is kept or dropped whole), and a lone surrogate in the source is replaced, because the Anthropic API refuses
 * a request body that contains one and a line that carried one would fail every later request in that context.
 *
 * Every result carries the relay id of each message, in line order, because an agent acts on a message (reply, react,
 * edit, page from it) by its relay id and never by a snowflake, and a digest it cannot act on is only half useful.
 */
import type { PortalMessage } from '@animalabs/portal-protocol';

export const DEFAULT_DIGEST_WORDS = 30;
export const MAX_DIGEST_WORDS = 500;
export const DEFAULT_DIGEST_CACHE = 500;
/** A cut line keeps at most this many characters per word of the limit, so text with no spaces (CJK, a long URL, code)
 *  is bounded too. 12 is a generous English word with its space. */
export const DIGEST_CHARS_PER_WORD = 12;

export interface DigestOptions {
  /** Words kept of each cut message (default 30, 1 to 500). */
  words?: number;
  /** This agent's own persona id: what "addressed to me" means. */
  selfPersonaId?: string;
  /** Relay ids of messages this persona is known to have written (RecentIds), so a reply to one of them counts as
   *  addressed to it even when the message it answers is outside the batch. */
  ownMessageIds?: { has(id: string): boolean };
}

export interface DigestResult {
  lines: string[];
  /** The relay id of each message, in line order: ids[N - 1] is the id of #N. */
  ids: string[];
  /** The messages in digest order (oldest first), so a caller can cache what the lines stand for. */
  ordered: PortalMessage[];
}

/** The digest limit as a checked integer: a wrong value is refused, never clamped to something the caller did not ask for. */
export function checkedWords(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIGEST_WORDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIGEST_WORDS) {
    throw new Error(`Nothing ran: words must be a whole number from 1 to ${MAX_DIGEST_WORDS}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Lone surrogate halves become U+FFFD: JSON.stringify writes them as escapes and the API refuses the request. */
const wellFormed = (s: string): string => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemesOf = (s: string): string[] => [...segmenter.segment(s)].map((part) => part.segment);

const when = (m: PortalMessage): string => m.createdAt.slice(5, 16).replace('T', ' ');

function who(m: PortalMessage): string {
  const a = m.author;
  if (a.kind === 'persona') return `${a.displayName}[persona]`;
  if (a.kind === 'user') return `${a.displayName || a.username}${a.bot ? '[bot]' : ''}`;
  return 'system';
}

/** A custom emoji arrives as `name:id`; the id is dropped so its count never runs into digits. */
function emojiLabel(emoji: string): string {
  const custom = /^(.+):\d+$/.exec(emoji);
  return custom ? `:${custom[1]}:` : emoji;
}

export function digestMessages(messages: readonly PortalMessage[], opts: DigestOptions = {}): DigestResult {
  const limit = checkedWords(opts.words);
  const ordered = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const ordinal = new Map(ordered.map((m, i) => [m.id, i + 1] as const));
  const byId = new Map(ordered.map((m) => [m.id, m] as const));
  const self = opts.selfPersonaId;

  const addressed = new Set<string>();
  if (self !== undefined) {
    for (const m of ordered) {
      // What this persona wrote is never addressed to it, even as a reply to its own earlier message.
      if (m.author.kind === 'persona' && m.author.personaId === self) continue;
      const parent = m.replyToId ? byId.get(m.replyToId) : undefined;
      const repliesToMe =
        (parent !== undefined && parent.author.kind === 'persona' && parent.author.personaId === self) ||
        (m.replyToId !== undefined && opts.ownMessageIds?.has(m.replyToId) === true);
      if (m.mentions.personas.includes(self) || repliesToMe) addressed.add(m.id);
    }
  }
  // The message an addressed message answers is read with it, so the question stays beside the ping. Not the agent's
  // own post: a reply to the agent would only bring its own words back, whole, in every conversation it is part of.
  const repliedTo = new Set<string>();
  for (const id of addressed) {
    const replyToId = byId.get(id)?.replyToId;
    const parent = replyToId === undefined ? undefined : byId.get(replyToId);
    const own = parent !== undefined && parent.author.kind === 'persona' && parent.author.personaId === self;
    if (parent !== undefined && !own && !addressed.has(parent.id)) repliedTo.add(parent.id);
  }

  const lines = ordered.map((m, i) => {
    const original = wellFormed((m.cleanContent ?? m.content ?? '').trim());
    const flat = original.replace(/\s+/g, ' ');
    const all = flat === '' ? [] : flat.split(' ');
    const whole = addressed.has(m.id) || repliedTo.has(m.id);
    const cap = limit * DIGEST_CHARS_PER_WORD;
    const byWords = all.slice(0, limit).join(' ');
    // A message shown whole is shown as written, line breaks and indentation included: for code, lists and quoted
    // text a flattened copy can say something else. Only a cut message is flattened.
    let body = original;
    if (!whole) {
      // UTF-16 length is never less than the character count, so only text that long is segmented.
      const characters = byWords.length > cap ? graphemesOf(flat) : undefined;
      if (characters !== undefined && graphemesOf(byWords).length > cap) {
        body = `${characters.slice(0, cap).join('')}… (+${characters.length - cap} chars, full: ${m.id})`;
      } else if (all.length > limit) {
        body = `${byWords}… (+${all.length - limit} words, full: ${m.id})`;
      }
    }
    const reply = m.replyToId ? ` ↩${ordinal.has(m.replyToId) ? `#${ordinal.get(m.replyToId)}` : '(not in batch)'}` : '';
    const reactions = m.reactions.map((r) => ` ${emojiLabel(r.emoji)}${r.count}`).join('');
    const attached = m.attachments.length > 0 ? ` 📎${m.attachments.length}` : '';
    const mark = addressed.has(m.id) ? ' ★to-you' : repliedTo.has(m.id) ? ' ★replied-to' : '';
    return `#${i + 1} ${when(m)} ${who(m)}${reply}${reactions}${attached}${mark}: ${body}`;
  });
  return { lines, ids: ordered.map((m) => m.id), ordered };
}

/** A bounded set of ids, newest kept: the relay ids of messages this persona is known to have written. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(readonly capacity: number = 2000) {}

  get size(): number {
    return this.ids.size;
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.capacity) this.ids.delete(this.ids.values().next().value as string);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/** Where a message lives: enough to read it from the relay again. Never its content. */
export interface MessageLocation {
  id: string;
  nativeId: string;
  channelId: string;
  threadId?: string;
}

/**
 * Where the last messages a digest showed live, by relay id and by snowflake, for `fetch_message`, which reads the
 * message from the relay again. It keeps no text, so it cannot go stale, and it cannot serve what the agent has since
 * lost the right to read. Bounded: the newest `capacity` stay and the oldest go. It lives in this process only, so a
 * restart empties it and a miss says so.
 */
export class DigestIndex {
  private readonly byId = new Map<string, MessageLocation>();
  private readonly nativeToId = new Map<string, string>();

  constructor(readonly capacity: number = DEFAULT_DIGEST_CACHE) {}

  get size(): number {
    return this.byId.size;
  }

  put(messages: readonly PortalMessage[]): void {
    for (const m of messages) {
      // Insertion order is recency: a message shown again moves to the newest end.
      this.byId.delete(m.id);
      this.byId.set(m.id, { id: m.id, nativeId: m.nativeId, channelId: m.channelId, ...(m.threadId !== undefined ? { threadId: m.threadId } : {}) });
      this.nativeToId.set(m.nativeId, m.id);
    }
    while (this.byId.size > this.capacity) {
      const oldest = this.byId.keys().next().value as string;
      const gone = this.byId.get(oldest)!;
      this.byId.delete(oldest);
      this.nativeToId.delete(gone.nativeId);
    }
  }

  get(ref: string): MessageLocation | undefined {
    return this.byId.get(ref) ?? this.byId.get(this.nativeToId.get(ref) ?? '');
  }
}
