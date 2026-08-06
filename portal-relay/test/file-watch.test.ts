// WatchedFile self-write suppression — review regression (PR #15, H2).
// The old time-window suppression discarded EVERY change for 2s after any
// self-write, so a store persisting at machine rate silently disabled
// hot-reload of the file an operator hand-edits to revoke a code. Suppression
// is now by content identity: only a byte-identical file skips reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchedFile } from '../src/file-watch.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

test('own writes are suppressed; an external edit right after a self-write still reloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-watch-'));
  const path = join(dir, 'store.json');
  writeFileSync(path, '{"v":0}\n');
  let reloads = 0;
  const wf = new WatchedFile(path, () => { reloads++; }, 50);
  wf.start();
  try {
    // Pure self-write: no reload.
    wf.write('{"v":1}\n');
    await sleep(400);
    assert.equal(reloads, 0, 'self-write must not reload');

    // Machine-rate self-write immediately followed by an external edit (the
    // operator revoking a code mid-mint). The old window logic dropped this.
    wf.write('{"v":2}\n');
    writeFileSync(path, '{"v":"operator-edit"}\n');
    const saw = await waitFor(() => reloads >= 1, 3000);
    assert.ok(saw, 'external edit during the self-write window must reload');
  } finally {
    wf.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
