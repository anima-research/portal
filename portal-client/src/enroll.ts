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
import { WebSocket } from 'ws';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { PORTAL_PROTOCOL_VERSION, isServerFrame } from '@animalabs/portal-protocol';

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
  /** Provide a WebSocket impl (tests). Defaults to ws. */
  wsFactory?: (url: string) => WebSocket;
}

export interface PortalCredentials {
  personaId: string;
  token: string;
}

/** One-shot: open WS, register, return minted credentials, close. */
export function enroll(opts: EnrollOptions): Promise<PortalCredentials> {
  const ws = opts.wsFactory ? opts.wsFactory(opts.url) : new WebSocket(opts.url);
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

    ws.on('message', (data: Buffer | string) => {
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
  wsFactory?: (url: string) => WebSocket;
}): Promise<PortalCredentials> {
  if (existsSync(opts.credsPath)) {
    const raw = JSON.parse(readFileSync(opts.credsPath, 'utf8')) as Partial<PortalCredentials>;
    if (raw.personaId && raw.token) return { personaId: raw.personaId, token: raw.token };
  }
  if (!opts.invite || !opts.desiredName) {
    throw new Error(
      `no saved credentials at ${opts.credsPath} and no invite/desiredName to enroll with`,
    );
  }
  const creds = await enroll({
    url: opts.url,
    invite: opts.invite,
    desiredName: opts.desiredName,
    avatar: opts.avatar,
    wsFactory: opts.wsFactory,
  });
  mkdirSync(dirname(opts.credsPath), { recursive: true });
  writeFileSync(opts.credsPath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  return creds;
}
