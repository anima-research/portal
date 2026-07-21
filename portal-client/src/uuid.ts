/**
 * Portable UUID v4 — used only to correlate RPC frames, so per-session
 * uniqueness is all that matters.
 *
 * `crypto.randomUUID` is global in Node ≥19 and in browser *secure contexts*;
 * a sideloaded WebView app served over plain http is NOT a secure context, so
 * fall back to `getRandomValues` (available everywhere) and assemble v4 by hand.
 */
export function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

interface Crypto {
  randomUUID?(): string;
  getRandomValues?(array: Uint8Array): Uint8Array;
}
