/**
 * Display-name collisions at persona creation.
 *
 * A persona posts under its display name, so a name that reads as someone
 * else's is impersonation: a persona minted as "antra" posts as antra. The
 * relay used to take any name enrollment asked for. Names are compared by
 * {@link nameKey}, which folds the ways two names can look alike without being
 * byte-equal — case, compatibility forms (full-width, ligatures), accents,
 * zero-width and other invisible characters, separators and punctuation, and
 * the common Cyrillic/Greek letters that pass for Latin ones.
 *
 * Checked only when a persona is CREATED (renames are operator hand-edits of
 * the identity file); see Relay.enroll for which names a creation must avoid.
 */

/** Letters (lower-cased) that render like a Latin letter: Cyrillic, Greek,
 *  Latin small capitals, and digits that pass for letters. A compact subset of
 *  Unicode TR39's confusables — the forms that actually read as a name. */
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't',
  у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y', һ: 'h',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  ω: 'w', ɑ: 'a', ɡ: 'g', ı: 'i', ℓ: 'l',
  // Latin small capitals (ᴀɴᴛʀᴀ).
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l',
  ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
  // Digits read as letters.
  '0': 'o', '1': 'l',
};

/** Cherokee capitals shaped like Latin capitals, by code point; folded through
 *  their lower-case forms, which is what nameKey sees after lower-casing. */
const CHEROKEE_LATIN: Array<[number, string]> = [
  [0x13aa, 'a'], [0x13f4, 'b'], [0x13df, 'c'], [0x13a0, 'd'], [0x13ac, 'e'], [0x13c0, 'g'],
  [0x13bb, 'h'], [0x13a5, 'i'], [0x13ab, 'j'], [0x13e6, 'k'], [0x13de, 'l'], [0x13b7, 'm'],
  [0x13e2, 'p'], [0x13a1, 'r'], [0x13da, 's'], [0x13a2, 't'], [0x13d9, 'v'], [0x13b3, 'w'],
  [0x13c3, 'z'],
];
for (const [cp, latin] of CHEROKEE_LATIN) {
  const capital = String.fromCodePoint(cp);
  LOOKALIKES[capital] = latin;
  LOOKALIKES[capital.toLowerCase()] = latin;
}

/** Letter pairs that read as one letter once squeezed together. */
const SEQUENCES: Array<[RegExp, string]> = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
];

/** The comparison key for a display name: equal keys = names that read alike.
 *  Empty when the name has no letters or digits at all. `capitalIAsL` folds
 *  capital I to l before lower-casing ("Iinn" reads as "linn"); that fold is
 *  case-dependent, so names are compared on both keys (see nameKeys). */
export function nameKey(name: string, opts: { capitalIAsL?: boolean } = {}): string {
  let s = name.normalize('NFKC');
  if (opts.capitalIAsL) s = s.replace(/I/g, 'l');
  const folded = s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const ch of folded) out += LOOKALIKES[ch] ?? ch;
  out = out.replace(/[^\p{L}\p{N}]/gu, '');
  for (const [re, to] of SEQUENCES) out = out.replace(re, to);
  return out;
}

/** Every key a name compares by: plain (case-insensitive) and with capital I
 *  read as l. Two names read alike when their key sets meet — so "iris" still
 *  matches "Iris", and "Iinn" matches "linn". Empty keys are left out. */
export function nameKeys(name: string): string[] {
  return [...new Set([nameKey(name), nameKey(name, { capitalIAsL: true })])].filter(Boolean);
}
