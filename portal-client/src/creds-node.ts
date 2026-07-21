/**
 * Node credential persistence — the `0600` JSON file store, plus the original
 * path-based `loadOrEnrollCreds` API (kept verbatim for existing consumers:
 * portal-mcpl, portal-makeaudio, cc-cli). Node-only; the browser entry never
 * imports this module.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadOrEnroll, type CredsStore, type PortalCredentials } from './enroll.js';
import type { WsFactory } from './ws-compat.js';

/** A `CredsStore` backed by a JSON file written with mode 0600. */
export function fileCredsStore(credsPath: string): CredsStore {
  return {
    load() {
      if (!existsSync(credsPath)) return null;
      const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as Partial<PortalCredentials>;
      return raw.personaId && raw.token ? { personaId: raw.personaId, token: raw.token } : null;
    },
    save(creds) {
      mkdirSync(dirname(credsPath), { recursive: true });
      writeFileSync(credsPath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
    },
  };
}

/**
 * Load persisted credentials, or enroll once and persist them. Idempotent: the
 * first run of a new agent enrolls and writes `credsPath`; every run after just
 * reads it. Returns the credentials to hand to a PortalClient.
 */
export async function loadOrEnrollCreds(opts: {
  url: string;
  /** Where minted creds are cached (JSON: { personaId, token }). */
  credsPath: string;
  /** Required only when no creds exist yet. */
  invite?: string;
  desiredName?: string;
  avatar?: string;
  wsFactory?: WsFactory;
}): Promise<PortalCredentials> {
  try {
    return await loadOrEnroll(fileCredsStore(opts.credsPath), opts);
  } catch (err) {
    // Preserve the original, path-bearing error message.
    if (err instanceof Error && err.message.startsWith('no saved credentials')) {
      throw new Error(
        `no saved credentials at ${opts.credsPath} and no invite/desiredName to enroll with`,
      );
    }
    throw err;
  }
}
