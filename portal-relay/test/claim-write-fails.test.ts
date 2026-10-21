// An invite claim writes several files in turn: the invite's use
// (invites.json), then for enroll the persona (identity.json), and its grant
// (permissions.json). Each store writes its file as it changes, and a write
// can throw, so a claim can stop partway. These tests make one file
// unwritable (a directory where the file was) and check what each stop
// leaves: a claim whose use couldn't be saved changes nothing, so its code
// can be claimed at once; a claim that stopped after its use was saved has
// spent that use, so a single-use code isn't claimable again, after a restart
// too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';

const GUILD = 'g1';
const EXISTING = 'existing-1';
const BANNED = 'banned-1';
const GRANT = { caps: ['VIEW_CHANNEL'], scope: { all: true } };
// A relay-made code's length (inv_ + 24), so an audit record keeps a prefix of it.
const LONG_CODE = 'inv_aaaaaaaaaaaaaaaaaaaaaaaa';
const LONG_CODE_2 = 'inv_cccccccccccccccccccccccc';

function files() {
  return {
    'identity.json': {
      personas: [
        { id: EXISTING, displayName: 'Existing', avatar: '', token: 'tok-e' },
        { id: BANNED, displayName: 'Banned', avatar: '', token: 'tok-b' },
      ],
    },
    'permissions.json': {
      roles: { 'r-read': { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD } },
      personas: { [EXISTING]: { default: [] }, [BANNED]: { policy: { default: [] }, bans: [GUILD] } },
    },
    'invites.json': {
      invites: [
        { code: 'mint-once', maxUses: 1, grant: GRANT, guildId: GUILD },
        { code: 'augment-once', mode: 'augment', maxUses: 1, grant: GRANT, guildId: GUILD },
        // Roles, a grant, and (claimed by an admin for BANNED) a ban to lift:
        // every write an augment makes after its use.
        { code: 'augment-all', mode: 'augment', maxUses: 1, roles: ['r-read'], grant: GRANT, guildId: GUILD },
        // Used once already, with two left.
        { code: 'mint-thrice', maxUses: 3, uses: 1, grant: GRANT, guildId: GUILD },
        { code: LONG_CODE, mode: 'augment', maxUses: 1, grant: GRANT, guildId: GUILD },
        { code: LONG_CODE_2, mode: 'augment', maxUses: 1, grant: GRANT, guildId: GUILD },
      ],
    },
  };
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-claim-io-'));
  for (const [name, body] of Object.entries(files())) writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}

function makeRelay(dir: string) {
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: join(dir, 'identity.json'),
    permissionsPath: join(dir, 'permissions.json'),
    invitesPath: join(dir, 'invites.json'),
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  relay.bot = {
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    memberNameMatches: () => false,
    membersComplete: () => true,
    isGuildAllowed: (gid: string) => gid === GUILD,
  };
  return relay;
}

/** Put a directory where the file was, so the store's next write of it throws. */
function breakFile(dir: string, name: string): void {
  rmSync(join(dir, name));
  mkdirSync(join(dir, name));
}

/** Put the file back as the test began, so the next claim can get as far as its own checks. */
function restoreFile(dir: string, name: string): void {
  rmSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(files()[name as keyof ReturnType<typeof files>]));
}

function readJson(dir: string, name: string): any {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

/** Run fn with console.error captured, and return what it printed. */
async function captureErrors(fn: () => unknown): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

function usesOnDisk(dir: string, code: string): number {
  return readJson(dir, 'invites.json').invites.find((i: any) => i.code === code).uses ?? 0;
}

for (const name of ['identity.json', 'permissions.json']) {
  test(`enroll: when ${name} can't be written, the claim fails after its use is saved, and the single-use code is spent`, async () => {
    const dir = makeDir();
    try {
      const relay = makeRelay(dir);
      breakFile(dir, name);
      await assert.rejects(relay.enroll({ invite: 'mint-once', desiredName: 'first' }), /EISDIR/);
      assert.equal(usesOnDisk(dir, 'mint-once'), 1, 'the use reached disk before the failed write');
      restoreFile(dir, name);
      assert.deepEqual(await relay.enroll({ invite: 'mint-once', desiredName: 'second' }), { error: 'invite exhausted' });
      // A restart reads the same count.
      assert.deepEqual(await makeRelay(dir).enroll({ invite: 'mint-once', desiredName: 'third' }), { error: 'invite exhausted' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("enroll: when invites.json can't be written, the claim stops before writing anything else, says so, and the code can be claimed at once", async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    breakFile(dir, 'invites.json');
    let failed: any;
    const logged = await captureErrors(async () => {
      failed = await relay.enroll({ invite: 'mint-once', desiredName: 'first' });
    });
    assert.match(failed.error, /couldn't save the invite's use.*trying again with the same invite is safe.*whoever runs the relay can see why in its log/);
    assert.doesNotMatch(failed.error, /EISDIR|invites\.json/, "the answer leaves out the store's error");
    assert.match(logged, /failed while recording its use.*EISDIR/s, "the relay's log keeps the store's error");
    assert.equal(relay.invites.get('mint-once').uses ?? 0, 0, 'the unsaved use is not counted in memory');
    assert.deepEqual(relay.identity.all().map((p: any) => p.id), [EXISTING, BANNED], 'no persona in memory');
    assert.deepEqual(readJson(dir, 'identity.json'), files()['identity.json'], 'identity.json unchanged');
    assert.deepEqual(readJson(dir, 'permissions.json'), files()['permissions.json'], 'permissions.json unchanged');
    restoreFile(dir, 'invites.json');
    // The next save of invites.json, for something else, carries no use for the failed claim.
    relay.invites.mint({ code: 'other', maxUses: 1, grant: GRANT, guildId: GUILD });
    assert.equal(usesOnDisk(dir, 'mint-once'), 0, 'a later save writes no use');
    const ok = await relay.enroll({ invite: 'mint-once', desiredName: 'second' });
    assert.ok('token' in ok, `the code is claimable without a restart: ${JSON.stringify(ok)}`);
    assert.deepEqual(await relay.enroll({ invite: 'mint-once', desiredName: 'third' }), { error: 'invite exhausted' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("augment: when permissions.json can't be written, the claim fails after its use is saved, says so, and the single-use code is spent", async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    breakFile(dir, 'permissions.json');
    const logged = await captureErrors(() =>
      assert.throws(
        () => relay.applyInviteAugment(EXISTING, 'augment-once'),
        (e: any) =>
          e.code === 'INTERNAL' &&
          /use was recorded, so the use stays spent and the claim may be partly applied/.test(e.message) &&
          !/EISDIR|permissions\.json/.test(e.message),
      ),
    );
    assert.match(logged, /failed after recording its use.*EISDIR/s, "the relay's log keeps the store's error");
    assert.equal(usesOnDisk(dir, 'augment-once'), 1, 'the use reached disk before the failed write');
    restoreFile(dir, 'permissions.json');
    assert.throws(() => relay.applyInviteAugment(EXISTING, 'augment-once'), /invite exhausted/);
    assert.throws(() => makeRelay(dir).applyInviteAugment(EXISTING, 'augment-once'), /invite exhausted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("augment: when invites.json can't be written, the claim changes nothing (no role, grant or ban lift), says so, and the code can be claimed at once", async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    const before = JSON.stringify(relay.permissions.getEntry(BANNED));
    breakFile(dir, 'invites.json');
    assert.throws(
      () => relay.applyInviteAugment(BANNED, 'augment-all', { byAdmin: true }),
      (e: any) =>
        e.code === 'INTERNAL' &&
        /stopped before writing anything else; trying again with the same invite is safe/.test(e.message) &&
        !/EISDIR|invites\.json/.test(e.message),
    );
    assert.equal(relay.invites.get('augment-all').uses ?? 0, 0, 'the unsaved use is not counted in memory');
    assert.equal(JSON.stringify(relay.permissions.getEntry(BANNED)), before, 'roles, policy and ban unchanged in memory');
    assert.ok(relay.permissions.isBanned(BANNED, GUILD), 'still banned');
    assert.deepEqual(readJson(dir, 'permissions.json'), files()['permissions.json'], 'permissions.json unchanged');
    restoreFile(dir, 'invites.json');
    const ok = relay.applyInviteAugment(BANNED, 'augment-all', { byAdmin: true });
    assert.deepEqual(ok, { roles: ['r-read'], liftedBans: [GUILD] }, 'claimable at once, and it applies all of the invite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("augment: when permissions.json can't be written, an admin's claim that lifts a ban fails after its use is saved, and the use is spent", async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    breakFile(dir, 'permissions.json');
    assert.throws(
      () => relay.applyInviteAugment(BANNED, 'augment-all', { byAdmin: true }),
      (e: any) => e.code === 'INTERNAL' && /use was recorded/.test(e.message),
    );
    assert.equal(usesOnDisk(dir, 'augment-all'), 1, 'the use reached disk before the ban lift failed to save');
    restoreFile(dir, 'permissions.json');
    assert.throws(() => relay.applyInviteAugment(BANNED, 'augment-all', { byAdmin: true }), /invite exhausted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a use that can't be saved leaves an invite's earlier count as it was", async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    breakFile(dir, 'invites.json');
    const failed = await relay.enroll({ invite: 'mint-thrice', desiredName: 'first' });
    assert.ok('error' in failed);
    assert.equal(relay.invites.get('mint-thrice').uses, 1, 'the earlier count, in memory');
    restoreFile(dir, 'invites.json');
    relay.invites.mint({ code: 'other', maxUses: 1, grant: GRANT, guildId: GUILD });
    assert.equal(usesOnDisk(dir, 'mint-thrice'), 1, 'and on disk after the next save');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim_invite: a claim that fails on a write, after its use is saved or before, is answered INTERNAL and audited with the code shortened and the guild; a success keeps only the prefix too', async () => {
  const dir = makeDir();
  try {
    const relay = makeRelay(dir);
    const records: any[] = [];
    relay.audit = { append: (rec: any) => records.push(rec) };
    const rpc = async (code: string) => {
      const frames: any[] = [];
      const session = { personaId: EXISTING, send: (frame: unknown) => frames.push(frame) } as unknown as Session;
      await relay.handleRpc(session, { id: 'c', method: 'claim_invite', params: { code } });
      return frames[0].d;
    };
    breakFile(dir, 'permissions.json');
    const failed = await rpc(LONG_CODE);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'INTERNAL');
    assert.deepEqual(
      { action: records[0].action, ok: records[0].ok, target: records[0].target, guildId: records[0].guildId },
      { action: 'claim_invite', ok: false, target: `${LONG_CODE.slice(0, 12)}…`, guildId: GUILD },
    );
    restoreFile(dir, 'permissions.json');
    // A use that can't be saved: answered INTERNAL, saying trying again is
    // safe, and audited with that message.
    breakFile(dir, 'invites.json');
    const unsaved = await rpc(LONG_CODE_2);
    assert.equal(unsaved.error.code, 'INTERNAL');
    assert.match(unsaved.error.message, /stopped before writing anything else; trying again with the same invite is safe/);
    assert.deepEqual(
      { ok: records[1].ok, target: records[1].target, guildId: records[1].guildId, error: records[1].detail.error },
      { ok: false, target: `${LONG_CODE_2.slice(0, 12)}…`, guildId: GUILD, error: unsaved.error.message },
    );
    restoreFile(dir, 'invites.json');
    // A refusal (the use is spent) is answered as before and not audited.
    const refused = await rpc(LONG_CODE);
    assert.equal(refused.error.code, 'INVALID_PARAMS');
    assert.equal(records.length, 2);
    // The code whose use couldn't be saved is claimed again, and the success
    // keeps only its prefix.
    const ok = await rpc(LONG_CODE_2);
    assert.equal(ok.ok, true);
    assert.deepEqual({ target: records[2].target, guildId: records[2].guildId, ok: records[2].ok }, { target: `${LONG_CODE_2.slice(0, 12)}…`, guildId: GUILD, ok: true });
    // A short, hand-chosen code is hidden outright.
    const short = await rpc('augment-once');
    assert.equal(short.ok, true);
    assert.equal(records[3].target, '(code hidden)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
