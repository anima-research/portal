import type { OutgoingFile } from '@animalabs/portal-protocol';

/**
 * Build an `OutgoingFile` from in-memory bytes (the portable way to attach a
 * file — works from any client/host, no relay-side filesystem access).
 */
export function fileFromBytes(
  name: string,
  data: Uint8Array,
  opts?: { contentType?: string; description?: string },
): OutgoingFile {
  return {
    name,
    bytes: toBase64(data),
    ...(opts?.contentType ? { contentType: opts.contentType } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
  };
}

/** Base64-encode without assuming Node (`Buffer`) or a DOM (`btoa`) — prefer
 *  whichever is present. Chunked so the fallback avoids huge call-spreads. */
function toBase64(data: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(d: Uint8Array): { toString(enc: string): string } } })
    .Buffer;
  if (B) return B.from(data).toString('base64');
  const btoaFn = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (!btoaFn) throw new Error('no base64 encoder available (neither Buffer nor btoa)');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoaFn(binary);
}
