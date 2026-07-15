/**
 * Discord-limit message chunking.
 *
 * Discord rejects message content over 2000 chars ("Invalid Form Body,
 * BASE_TYPE_MAX_LENGTH"). Long agent messages (trailing prose, field notes)
 * must be SPLIT, never truncated or dropped.
 *
 * Chunks are verbatim substrings of the input — no trimming, no re-joining,
 * no glue characters. (ChapterX regression lesson: chunk-merge glue that
 * altered whitespace taught models to imitate the mangled output. Split-only
 * is safe: concatenating the chunks reproduces the original exactly.)
 *
 * Split preference at each cut: last blank line ("\n\n") within the window,
 * else last newline, else last space, else a hard cut at the limit.
 */

/** Discord hard limit is 2000; leave headroom for safety. */
export const CHUNK_LIMIT = 1900;

export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.25) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.25) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.25) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
