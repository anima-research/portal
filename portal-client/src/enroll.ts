/**
 * Self-enrollment helpers.
 *
 * A brand-new agent with no persona/token opens a short-lived WS connection,
 * presents an invite (an admin-minted access-rights template) plus a desired
 * name, and receives minted credentials. The credentials are then persisted and
 * used by a normal PortalClient `identify` (which also gives transport resume).
 *
 * This is deliberately separate from PortalClient: the client stays a pure
 * identify/resume transport, and enrollment is a one-shot bootstrap.
 */
import { PORTAL_PROTOCOL_VERSION, isServerFrame } from '@animalabs/portal-protocol';
import { resolveWsFactory, type WsFactory } from './ws-compat.js';

export interface EnrollOptions {
  url: string;
  /** Invite code (access-rights template). */
  invite: string;
  /** Desired display name for the new persona. */
  desiredName: string;
  /** Optional avatar filename/URL. */
  avatar?: string;
  /** Timeout for the enroll handshake (default 15000ms). */
  timeoutMs?: number;
  /** Provide a WebSocket impl. Defaults to the package entry's factory. */
  wsFactory?: WsFactory;
}

export interface PortalCredentials {
  personaId: string;
  token: string;
}

/** One-shot: open WS, register, return minted credentials, close. */
export function enroll(opts: EnrollOptions): Promise<PortalCredentials> {
  const ws = resolveWsFactory(opts.wsFactory)(opts.url);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<PortalCredentials>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error('enroll timed out'))),
      timeoutMs,
    );

    ws.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isServerFrame(frame)) return;
      const f = frame as { op: string; d?: Record<string, unknown> };
      if (f.op === 'hello') {
        ws.send(
          JSON.stringify({
            op: 'register',
            d: {
              protocolVersion: PORTAL_PROTOCOL_VERSION,
              invite: opts.invite,
              desiredName: opts.desiredName,
              ...(opts.avatar ? { avatar: opts.avatar } : {}),
            },
          }),
        );
      } else if (f.op === 'registered') {
        const d = f.d as { personaId: string; token: string };
        done(() => resolve({ personaId: d.personaId, token: d.token }));
      } else if (f.op === 'invalid_session') {
        const reason = (f.d as { reason?: string })?.reason ?? 'rejected';
        done(() => reject(new Error(`enroll rejected: ${reason}`)));
      }
    });
    ws.on('error', (err: Error) => done(() => reject(err)));
    ws.on('close', () => done(() => reject(new Error('connection closed before register'))));
  });
}

/**
 * Where minted credentials live between runs. Environment-specific: the Node
 * entry ships a `0600` file store (`fileCredsStore`); a browser/WebView app
 * supplies its own (e.g. `webStorageCredsStore`, or the platform storage API).
 */
export interface CredsStore {
  load(): Promise<PortalCredentials | null> | PortalCredentials | null;
  save(creds: PortalCredentials): Promise<void> | void;
}

/**
 * Load persisted credentials from `store`, or enroll once and persist them.
 * Idempotent: the first run of a new agent enrolls and saves; every run after
 * just loads. Returns the credentials to hand to a PortalClient.
 */
export async function loadOrEnroll(
  store: CredsStore,
  opts: {
    url: string;
    /** Required only when no creds exist yet. */
    invite?: string;
    desiredName?: string;
    avatar?: string;
    wsFactory?: WsFactory;
  },
): Promise<PortalCredentials> {
  const existing = await store.load();
  if (existing?.personaId && existing.token) return existing;
  if (!opts.invite || !opts.desiredName) {
    throw new Error('no saved credentials and no invite/desiredName to enroll with');
  }
  const creds = await enroll({
    url: opts.url,
    invite: opts.invite,
    desiredName: opts.desiredName,
    avatar: opts.avatar,
    wsFactory: opts.wsFactory,
  });
  await store.save(creds);
  return creds;
}

/**
 * A `CredsStore` over any Web-Storage-shaped API (localStorage & friends) —
 * the easy default for browser/WebView clients.
 */
export function webStorageCredsStore(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key = 'portal-credentials',
): CredsStore {
  return {
    load() {
      const raw = storage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<PortalCredentials>;
        return parsed.personaId && parsed.token
          ? { personaId: parsed.personaId, token: parsed.token }
          : null;
      } catch {
        return null;
      }
    },
    save(creds) {
      storage.setItem(key, JSON.stringify(creds));
    },
  };
}
