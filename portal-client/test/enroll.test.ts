import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enroll, loadOrEnrollCreds } from '../src/enroll.js';

const PORT = 8795;

/** Minimal relay stand-in: sends `hello`, answers `register` with `registered`
 *  (or `invalid_session` for invite "bad"). Counts how many registers it saw. */
function fakeRelay(port: number) {
  let registers = 0;
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 'hello', d: { protocolVersion: 1, heartbeatIntervalMs: 30000 } }));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.op !== 'register') return;
      registers++;
      if (frame.d.invite === 'bad') {
        ws.send(JSON.stringify({ op: 'invalid_session', d: { resumable: false, reason: 'invite unknown' } }));
        return;
      }
      ws.send(
        JSON.stringify({
          op: 'registered',
          d: {
            personaId: `minted-${registers}`,
            token: `tok-${registers}`,
            persona: { id: `minted-${registers}`, displayName: frame.d.desiredName, avatarUrl: '' },
          },
        }),
      );
    });
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    registers: () => registers,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

test('enroll: returns minted creds; rejects bad invite', async () => {
  const relay = fakeRelay(PORT);
  try {
    const creds = await enroll({ url: relay.url, invite: 'good', desiredName: 'Claude Code' });
    assert.equal(creds.personaId, 'minted-1');
    assert.equal(creds.token, 'tok-1');

    await assert.rejects(
      () => enroll({ url: relay.url, invite: 'bad', desiredName: 'x' }),
      /invite unknown/,
    );
  } finally {
    await relay.close();
  }
});

test('loadOrEnrollCreds: enrolls once then reuses the cached file', async () => {
  const relay = fakeRelay(PORT + 1);
  const dir = mkdtempSync(join(tmpdir(), 'portal-creds-'));
  const credsPath = join(dir, 'nested', 'creds.json');
  try {
    const a = await loadOrEnrollCreds({ url: relay.url, credsPath, invite: 'good', desiredName: 'cc' });
    assert.equal(relay.registers(), 1);
    assert.ok(existsSync(credsPath));

    // second call: no new register, returns the same persisted creds
    const b = await loadOrEnrollCreds({ url: relay.url, credsPath, invite: 'good', desiredName: 'cc' });
    assert.equal(relay.registers(), 1);
    assert.deepEqual(a, b);

    const onDisk = JSON.parse(readFileSync(credsPath, 'utf8'));
    assert.equal(onDisk.personaId, a.personaId);

    // without saved creds and without an invite → error
    await assert.rejects(
      () => loadOrEnrollCreds({ url: relay.url, credsPath: join(dir, 'absent.json') }),
      /no saved credentials/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await relay.close();
  }
});
