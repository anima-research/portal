// A force-revoke must end resume as well as the live sessions: resume
// authenticates by key, not token (room-511 review of PR #40, sw-pt40 I2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { ServerFrame } from '@animalabs/portal-protocol';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import { Gateway, Session } from '../src/gateway.js';

test('revoking a persona closes its sessions, then drops its resume keys and stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-revoke-'));
  try {
    const identityPath = join(dir, 'identity.json');
    const permissionsPath = join(dir, 'permissions.json');
    writeFileSync(identityPath, JSON.stringify({ personas: [{ id: 'alice', displayName: 'Alice', avatar: '', token: 'tok-a' }] }));
    writeFileSync(permissionsPath, JSON.stringify({ personas: { alice: { default: [], guilds: {} } } }));
    const config: RelayConfig = {
      discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [],
      identityPath, permissionsPath,
      rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
      heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
      historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
      allowPathFiles: false, replyLink: false,
    };
    const relay = new Relay(config) as any;
    const calls: string[] = [];
    const real = relay.gateway;
    relay.gateway = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'closePersona' || prop === 'dropStream') {
          return (personaId: string) => { calls.push(`${String(prop)}(${personaId})`); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    relay.revokePersonaToken('alice');
    assert.deepEqual(calls, ['closePersona(alice)', 'dropStream(alice)']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Olive-1011's probe from her review (room-203 #70577): a revoke's sockets close
// after dropStream, since closePersona only begins the close and ws emits 'close'
// later. That late close must not bring the persona's resume key back.
test('a socket that closes after dropStream leaves no key to resume with', async () => {
  const gw = new Gateway({
    authenticate: (_t, p) => p,
    buildReady: async (s) => ({ sessionId: s.id, persona: { id: s.personaId, displayName: s.personaId, avatarUrl: '' }, guilds: [], channels: [], seq: gw.seqOf(s.personaId) }),
    handleRpc: async () => {},
  }, 30_000, { resumeRetentionMs: 100_000, log: () => {} });
  const g = gw as unknown as {
    onIdentify(s: Session, t: string, p: string): Promise<void>;
    onResume(s: Session, id: string, seq: number): void;
    onDisconnect(s: Session): void;
    sessionPersona: Map<string, unknown>;
  };
  const socket = () => {
    const frames: ServerFrame[] = [];
    const ws = { OPEN: 1, readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close: () => {}, terminate: () => {} };
    return { session: new Session(ws as unknown as WebSocket, gw), frames };
  };
  const a = socket();
  await g.onIdentify(a.session, 'tok', 'alice');
  gw.closePersona('alice'); // the fake ws's close() emits nothing; a real one emits 'close' later
  gw.dropStream('alice');
  g.onDisconnect(a.session); // the late 'close'
  assert.equal(g.sessionPersona.size, 0);
  const b = socket();
  g.onResume(b.session, a.session.id, 0);
  assert.equal(b.frames.at(-1)?.op, 'invalid_session');
});
