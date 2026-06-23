import type { OutgoingFile } from '@animalabs/portal-protocol';

/**
 * Build an `OutgoingFile` from in-memory bytes (the portable way to attach a
 * file — works from any client/host, no relay-side filesystem access).
 */
export function fileFromBytes(
  name: string,
  data: Buffer | Uint8Array,
  opts?: { contentType?: string; description?: string },
): OutgoingFile {
  return {
    name,
    bytes: Buffer.from(data).toString('base64'),
    ...(opts?.contentType ? { contentType: opts.contentType } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
  };
}
