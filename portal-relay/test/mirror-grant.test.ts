// Inline mirror grants (invite `grant` with a mirrorRole/mirrorRoles scope)
// materialize as shared content-addressed access roles at enroll/claim time,
// so they resolve LIVE against Discord visibility. Pins the regression that
// motivated this: a channel created AFTER enrollment must become visible to
// the persona without any re-enroll or policy hand-edit (the old snapshot
// behavior froze the channel list at enroll time and new rooms stayed
// invisible until an operator noticed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import { Gateway } from '../src/gateway.js';
import { parseClientFrame } from '@animalabs/portal-protocol';
import type { AccessRole, RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const CHAN_A = 'chan-a';
const CHAN_NEW = 'chan-new'; // created "after enrollment" in the live test
const DISCORD_ROLE = 'dr-everyone';
const EXISTING = 'existing-1';
const RW = ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL'] as const;

/** Invites whose deciding fields have the wrong shape, each with the reason
 *  enroll gives (and augment, unless the entry names augment's own refusal).
 *  Read as found, a string where an array belongs is taken one character at a
 *  time, `all: false` grants everything, a misspelled mode mints, and a
 *  non-numeric maxUses or uses never exhausts. */
const MALFORMED_GRANTS: Array<[string, Record<string, unknown>, RegExp, { code: string; message: RegExp }?]> = [
  ['shape-roles-string', { roles: 'reader' }, /invite roles must be an array of strings/],
  ['shape-roles-mixed', { roles: ['reader', 7] }, /invite roles must be an array of strings/],
  ['shape-caps-string', { caps: 'SEND_MESSAGES' }, /invite caps must be an array of strings/],
  ['shape-grant-caps-string', { grant: { caps: 'SEND_MESSAGES', scope: { all: true } } }, /invite grant caps must be an array of strings/],
  ['shape-grant-scope-null', { grant: { caps: [...RW], scope: null } }, /invite grant scope must be an object/],
  ['shape-grant-channels-string', { grant: { caps: [...RW], scope: { channels: CHAN_A } } }, /invite grant scope channels must be an array of strings/],
  ['shape-grant-mirrorRoles-string', { grant: { caps: [...RW], scope: { mirrorRoles: DISCORD_ROLE } } }, /invite grant scope mirrorRoles must be an array of strings/],
  ['shape-grant-mirrorRole-number', { grant: { caps: [...RW], scope: { mirrorRole: 7 } } }, /invite grant scope mirrorRole must be a string/],
  ['shape-scope-all-false', { grant: { caps: [...RW], scope: { all: false } } }, /invite grant scope all must be true/],
  ['shape-scope-all-false-channels', { grant: { caps: [...RW], scope: { all: false, channels: [CHAN_A] } } }, /exactly one of channels, mirrorRole, mirrorRoles or all/],
  ['shape-scope-empty', { grant: { caps: [...RW], scope: {} } }, /exactly one of channels, mirrorRole, mirrorRoles or all/],
  ['shape-maxUses-string', { maxUses: 'one' }, /invite maxUses must be a non-negative integer/],
  ['shape-uses-string', { uses: 'x' }, /invite uses must be a non-negative integer/],
  // The integer and non-negative conditions each refuse on their own.
  ['shape-uses-negative', { uses: -1 }, /invite uses must be a non-negative integer/],
  ['shape-uses-fraction', { uses: 0.5 }, /invite uses must be a non-negative integer/],
  ['shape-maxUses-fraction', { maxUses: 2.5 }, /invite maxUses must be a non-negative integer/],
  // A scope that isn't an object never reaches the `in` checks.
  ['shape-scope-string', { grant: { caps: [...RW], scope: 'all' } }, /invite grant scope must be an object/],
  ['shape-scope-number', { grant: { caps: [...RW], scope: 7 } }, /invite grant scope must be an object/],
  ['shape-scope-array', { grant: { caps: [...RW], scope: [CHAN_A] } }, /invite grant scope must be an object/],
  // Grants that would apply as deny-all with the invite spent (the #25 symptom).
  ['shape-guildId-number', { guildId: 7 }, /invite guildId must be a string/],
  ['shape-mirrorRoles-empty', { grant: { caps: [...RW], scope: { mirrorRoles: [] } } }, /must name at least one mirrored role/],
  ['shape-mirrorRole-empty', { grant: { caps: [...RW], scope: { mirrorRole: '' } } }, /must name at least one mirrored role/],
  ['shape-channels-guildless', { guildId: undefined, grant: { caps: [...RW], scope: { channels: [CHAN_A] } } }, /channels needs the invite's guildId/],
  // A falsy minter would skip the machine-mint recheck.
  ['shape-mintedBy-empty', { mintedBy: '' }, /invite mintedBy must be a non-empty string/],
  // Augment's mode gate stays first, so a misspelled mode is refused there as not claimable.
  ['shape-mode-typo', { mode: 'augmnet' }, /invite mode must be "mint", "augment" or "both"/, { code: 'FORBIDDEN', message: /not claimable/ }],
  // A machine mint's recheck reads the grant too: the shape check runs first.
  ['shape-mint-scope-null', { mintedBy: EXISTING, grant: { caps: [...RW], scope: null } }, /invite grant scope must be an object/],
];

function makeRelay(roles: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-mirror-'));
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify({ personas: [{ id: EXISTING, displayName: 'Existing', avatar: '', token: 'tok-e' }] }),
  );
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({
      roles,
      personas: {
        [EXISTING]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN_A]: ['VIEW_CHANNEL'] } } } },
      },
    }),
  );
  writeFileSync(
    join(dir, 'invites.json'),
    JSON.stringify({
      invites: [
        { code: 'mirror-mint', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-aug', mode: 'augment', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-noguild', mode: 'both', maxUses: 1, grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } } },
        { code: 'mirror-emptyguild', mode: 'both', maxUses: 1, guildId: '', grant: { caps: [...RW], scope: { mirrorRoles: [DISCORD_ROLE] } } },
        // Hand-edited grant fields of the wrong shape (see MALFORMED_GRANTS).
        ...MALFORMED_GRANTS.map(([code, fields]) => ({ code, mode: 'both', maxUses: 1, guildId: GUILD, ...fields })),
      ],
    }),
  );

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

  // What the mirrored Discord role can currently see, per channel: the fake
  // mirror lookup reads this map live, mimicking MirrorCache over a real bot.
  const visible = new Map<string, string[]>([[CHAN_A, [...RW]]]);
  relay.mirror = { lookup: (g: string, r: string) => (g === GUILD && r === DISCORD_ROLE ? visible : new Map()), invalidateGuild: () => {}, invalidateRole: () => {}, flush: () => {} };

  // Discord-side perms wide open so effective caps = pure policy resolution.
  relay.bot = {
    channelForPerms: (cid: string) =>
      cid === CHAN_A || cid === CHAN_NEW
        ? { guildId: GUILD, permissionsFor: () => ({ has: () => true }) }
        : undefined,
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    memberNameMatches: () => false,
    membersComplete: () => true,
    listChannelMetas: () => [],
    isGuildAllowed: (gid: string) => gid === GUILD,
  };
  relay.roles = {
    getRoleFor: () => 'role', roleByGuildFor: () => ({}),
    bind: async () => 'role', unbind: async () => {},
  };
  relay.gateway = {
    activePersonas: () => [], streamPersonas: () => [], hasStream: () => false,
    sessionsOf: () => [], personaSubscribed: () => false, dispatch: () => {}, seqOf: () => 0,
  };

  const caps = (pid: string, cid: string) => [...relay.capsFor(pid, cid, GUILD)].sort();
  const changes: unknown[] = [];
  relay.identity.onChange((change: unknown) => changes.push(change));
  relay.permissions.onChange((change: unknown) => changes.push(change));
  const snapshot = () => structuredClone({
    identities: relay.identity.all(),
    permissions: [...relay.permissions.personas],
    roles: relay.permissions.allRoles(),
    invites: relay.invites.all(),
    files: ['identity.json', 'permissions.json', 'invites.json'].map((file) => readFileSync(join(dir, file), 'utf8')),
    changes,
  });
  return { relay, visible, caps, snapshot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('enroll with a mirror grant materializes a live access role, not a snapshot', async () => {
  const t = makeRelay();
  try {
    const enrolled = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'newbie' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const pid = enrolled.personaId;

    // Assigned a content-addressed role, no frozen inline channel list.
    const roles = t.relay.permissions.getRoleNames(pid) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], /^mirror-[0-9a-f]{8}$/);
    const role = t.relay.permissions.getRole(roles[0]);
    assert.deepEqual(role, { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE }, guildId: GUILD });
    assert.equal(t.relay.permissions.getPolicy(pid), undefined);

    // Resolves through the live mirror on the channel visible today...
    assert.deepEqual(t.caps(pid, CHAN_A), [...RW]);

    // ...and — the regression this exists to pin — on a channel created
    // AFTER enrollment, with no re-enroll and no policy edit.
    assert.deepEqual(t.caps(pid, CHAN_NEW), []);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(pid, CHAN_NEW), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('identical mirror grants share one catalog role across enrollments', async () => {
  const t = makeRelay();
  try {
    const a = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    const b = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
    assert.ok(!('error' in a) && !('error' in b));
    const [ra] = t.relay.permissions.getRoleNames(a.personaId) as string[];
    const [rb] = t.relay.permissions.getRoleNames(b.personaId) as string[];
    assert.equal(ra, rb);
  } finally {
    t.cleanup();
  }
});

test('augment claim adds the live role and leaves the existing inline policy intact', () => {
  const t = makeRelay();
  try {
    t.relay.applyInviteAugment(EXISTING, 'mirror-aug');
    const roles = t.relay.permissions.getRoleNames(EXISTING) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], /^mirror-[0-9a-f]{8}$/);
    // Union semantics: mirror caps arrive, the pre-existing channel grant survives.
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(EXISTING, CHAN_NEW), [...RW]);
    const pol = t.relay.permissions.getPolicy(EXISTING);
    assert.deepEqual(pol?.guilds?.[GUILD]?.channels?.[CHAN_A], ['VIEW_CHANNEL']);
  } finally {
    t.cleanup();
  }
});

for (const code of ['mirror-noguild', 'mirror-emptyguild']) {
  test(`${code}: enroll and augment reject without mutations or invite consumption`, async () => {
    const t = makeRelay();
    try {
      const before = t.snapshot();
      const request = { invite: code, desiredName: 'lost', subscriptions: [CHAN_A] };
      const enrolled = await t.relay.enroll(request);
      assert.match(enrolled.error, /invite mirror grant is missing guildId/);
      assert.deepEqual(t.snapshot(), before);
      assert.deepEqual(request.subscriptions, [CHAN_A]);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, code), {
        code: 'INVALID_PARAMS', message: /invite mirror grant is missing guildId/,
      });
      assert.deepEqual(t.snapshot(), before);
      assert.equal(t.relay.invites.check(code, Date.now()).code, code);
    } finally {
      t.cleanup();
    }
  });
}

for (const [code, , reason, augmentRefusal] of MALFORMED_GRANTS) {
  test(`${code}: enroll and augment reject a malformed invite field without mutations or invite consumption`, async () => {
    // A role whose one-letter name a string `roles` would be read as.
    const t = makeRelay({ r: { caps: ['MANAGE_CHANNELS', 'VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD } });
    try {
      const before = t.snapshot();
      const enrolled = await t.relay.enroll({ invite: code, desiredName: 'shaped' });
      assert.match(enrolled.error ?? '', reason, JSON.stringify(enrolled));
      assert.deepEqual(t.snapshot(), before);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, code), augmentRefusal ?? { code: 'INVALID_PARAMS', message: reason });
      assert.deepEqual(t.snapshot(), before);
      assert.equal(t.relay.invites.check(code, Date.now()).code, code);
    } finally {
      t.cleanup();
    }
  });
}

for (const [source, field, value] of [
  ['registration', 'desiredName', 42],
  ['registration', 'desiredName', false],
  ['registration', 'desiredName', {}],
  ['registration', 'desiredName', []],
  ['registration', 'avatar', 42],
  ['registration', 'avatar', {}],
  ['registration', 'subscriptions', 42],
  ['registration', 'subscriptions', CHAN_A],
  ['registration', 'subscriptions', [CHAN_A, 42]],
  ['invite', 'namePrefix', 17],
  ['invite', 'namePrefix', false],
  ['invite', 'namePrefix', {}],
  ['invite', 'namePrefix', []],
  ['invite', 'subscriptions', 42],
  ['invite', 'subscriptions', { length: 1 }],
  ['invite', 'subscriptions', CHAN_A],
  ['invite', 'subscriptions', [CHAN_A, 42]],
] as const) {
  test(`malformed ${source} ${field}=${JSON.stringify(value)} rejects without restoring a removed mirror role`, async () => {
    const t = makeRelay();
    try {
      const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
      const [name] = t.relay.permissions.getRoleNames(first.personaId);
      t.relay.permissions.removeRole(name);
      assert.deepEqual(t.relay.permissions.getRoleNames(first.personaId), [name]);
      assert.deepEqual(t.caps(first.personaId, CHAN_A), []);
      t.relay.invites.mint({
        code: 'request-validation', guildId: GUILD, maxUses: 1, subscriptions: [CHAN_A],
        grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } },
        ...(source === 'invite' ? { [field]: value } : {}),
      });
      const before = t.snapshot();

      // The wire guard deliberately routes without full field validation.
      // Exercise that parsed frame through Gateway and the real Relay handler.
      const frame = parseClientFrame(JSON.stringify({
        op: 'register',
        d: {
          protocolVersion: 1, invite: 'request-validation', desiredName: 'next',
          ...(source === 'registration' ? { [field]: value } : {}),
        },
      }));
      assert.ok(frame);
      const sent: unknown[] = [];
      const closed: unknown[] = [];
      const gateway = new Gateway({
        authenticate: () => null,
        enroll: (data) => t.relay.enroll(data),
        buildReady: async () => { throw new Error('invalid registration reached ready'); },
        handleRpc: async () => {},
      }, 30_000);
      let thrown: unknown;
      try {
        await (gateway as any).onFrame({
          // `open`: the socket can still carry frames (Session.open). The
          // gateway handles no frame from a socket that can't, and checks
          // again once enrollment returns, before it replies.
          id: 'sess-invalid-register', identified: false, open: true, touch: () => {},
          send: (out: unknown) => sent.push(out),
          close: (...args: unknown[]) => closed.push(args),
        }, frame);
      } catch (error) {
        thrown = error;
      }

      assert.deepEqual(t.snapshot(), before, 'a rejected request must not recreate the catalog role or mutate any store');
      assert.deepEqual(t.caps(first.personaId, CHAN_A), [], 'existing references stay inert');
      assert.equal(thrown, undefined, 'the claimant receives an error frame rather than a thrown frame-handler error');
      assert.deepEqual(sent, [{
        op: 'invalid_session',
        d: { resumable: false, reason: `${source} ${field} must be ${field === 'subscriptions' ? 'an array of strings' : 'a string'}` },
      }]);
      assert.deepEqual(closed, [[4003, 'register failed']]);
    } finally {
      t.cleanup();
    }
  });
}

test('omitted or blank registration names retain the agent default', async () => {
  const t = makeRelay();
  try {
    for (const desiredName of [undefined, '', '   ']) {
      const result = await t.relay.enroll({ invite: 'mirror-mint', desiredName });
      assert.ok(!('error' in result), JSON.stringify(result));
      assert.equal(result.persona.displayName, 'agent');
    }
  } finally {
    t.cleanup();
  }
});

test('valid registration preflight preserves name, avatar, and merged subscriptions', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({
      code: 'preflight-valid', guildId: GUILD, namePrefix: 'worker', subscriptions: [CHAN_A, CHAN_NEW],
      grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } },
    });
    const request = {
      invite: 'preflight-valid', desiredName: '  Friendly Name  ',
      avatar: 'https://example.org/avatar.png', subscriptions: [CHAN_A],
    };
    const result = await t.relay.enroll(request);
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.match(result.personaId, /^worker-/);
    assert.equal(result.persona.displayName, 'Friendly Name');
    assert.equal(result.persona.avatarUrl, request.avatar);
    assert.deepEqual(request.subscriptions, [CHAN_A, CHAN_NEW]);
    assert.deepEqual(t.caps(result.personaId, CHAN_A), [...RW]);
    assert.equal(t.relay.invites.get(request.invite).uses, 1);
  } finally {
    t.cleanup();
  }
});

const mismatches: [string, Record<string, unknown>][] = [
  ['guild', { guildId: 'other-guild' }],
  ['cap set', { caps: ['VIEW_CHANNEL'] }],
  ['role-id set', { scope: { mirrorRoles: [DISCORD_ROLE, 'another-role'] } }],
  ['all scope', { scope: { all: true } }],
  ['channel scope', { scope: { channels: [CHAN_A] } }],
  ['mixed all/mirror scope', { scope: { all: true, mirrorRole: DISCORD_ROLE } }],
  ['mixed channel/mirror scope', { scope: { channels: [CHAN_A], mirrorRole: DISCORD_ROLE } }],
  ['mirrorCaps', { mirrorCaps: true }],
  ['missing scope', { scope: undefined }],
  ['null scope', { scope: null }],
  ['string scope', { scope: DISCORD_ROLE }],
  ['missing caps', { caps: undefined }],
  ['null caps', { caps: null }],
  ['string caps', { caps: 'VIEW_CHANNEL' }],
  ['numeric caps', { caps: 1 }],
  ['non-string cap', { caps: [...RW, 1] }],
  ['missing mirror role id', { scope: { mirrorRole: undefined } }],
  ['numeric mirror role id', { scope: { mirrorRole: 1 } }],
  ['null mirror role ids', { scope: { mirrorRoles: null } }],
  ['string mirror role ids', { scope: { mirrorRoles: DISCORD_ROLE } }],
  ['non-string mirror role id', { scope: { mirrorRoles: [DISCORD_ROLE, 1] } }],
  ['null mirrorCaps', { mirrorCaps: null }],
  ['numeric mirrorCaps', { mirrorCaps: 0 }],
  ['string mirrorCaps', { mirrorCaps: 'false' }],
  // An invite's scope may name one mirror key, and so may a role it reuses.
  ['both mirror keys', { scope: { mirrorRole: DISCORD_ROLE, mirrorRoles: [DISCORD_ROLE] } }],
];

for (const [dimension, replacement] of mismatches) {
  test(`colliding mirror role (${dimension}): both claims reject before any mutation`, async () => {
    const t = makeRelay();
    try {
      const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
      assert.ok(!('error' in first));
      const [name] = t.relay.permissions.getRoleNames(first.personaId);
      t.relay.permissions.setRole(name, { ...t.relay.permissions.getRole(name), ...replacement });
      const before = t.snapshot();

      const second = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
      assert.match(second.error, /invite mirror grant conflicts with existing role/);
      assert.ok(second.error.includes(name));
      assert.deepEqual(t.snapshot(), before);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), {
        code: 'INVALID_PARAMS', message: /invite mirror grant conflicts with existing role/,
      });
      assert.deepEqual(t.snapshot(), before);
    } finally {
      t.cleanup();
    }
  });
}

for (const [kind, role] of [
  ['guildless', { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }],
  ['null', null],
] as const) {
  test(`quarantined ${kind} role: claims preserve the occupied name and existing references`, async () => {
    const seed = makeRelay();
    let name: string;
    try {
      const enrolled = await seed.relay.enroll({ invite: 'mirror-mint', desiredName: 'seed' });
      assert.ok(!('error' in enrolled));
      [name] = seed.relay.permissions.getRoleNames(enrolled.personaId);
    } finally {
      seed.cleanup();
    }

    const t = makeRelay({ [name!]: role });
    try {
      t.relay.permissions.addPersonaRoles(EXISTING, [name!]);
      assert.equal(t.relay.permissions.getRole(name!), undefined);
      assert.equal(t.relay.permissions.hasRoleName(name!), true);
      const before = t.snapshot();

      const enrolled = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'new' });
      assert.match(enrolled.error, /invite mirror grant conflicts with quarantined role/);
      assert.ok(enrolled.error.includes(name!));
      assert.deepEqual(t.snapshot(), before);

      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), {
        code: 'INVALID_PARAMS', message: /invite mirror grant conflicts with quarantined role/,
      });
      assert.deepEqual(t.snapshot(), before);
      assert.deepEqual(t.caps(EXISTING, CHAN_A), ['VIEW_CHANNEL']);
    } finally {
      t.cleanup();
    }
  });
}

test('equivalent single/plural mirror scopes and duplicate caps reuse the existing role unchanged', async () => {
  const t = makeRelay();
  try {
    const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    assert.ok(!('error' in first));
    const [name] = t.relay.permissions.getRoleNames(first.personaId);
    const equivalent: AccessRole = {
      guildId: GUILD, caps: ['VIEW_CHANNEL', ...RW].reverse(),
      scope: { mirrorRoles: [DISCORD_ROLE, DISCORD_ROLE] }, mirrorCaps: false,
    };
    t.relay.permissions.setRole(name, equivalent);
    t.relay.invites.mint({
      code: 'equivalent', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW, 'VIEW_CHANNEL'].reverse(), scope: { mirrorRoles: [DISCORD_ROLE] } },
    });
    const second = await t.relay.enroll({ invite: 'equivalent', desiredName: 'second' });
    assert.ok(!('error' in second), JSON.stringify(second));
    const claimed = t.relay.applyInviteAugment(EXISTING, 'equivalent');
    assert.deepEqual(t.relay.permissions.getRoleNames(second.personaId), [name]);
    assert.deepEqual(claimed.roles, [name]);
    assert.deepEqual(t.relay.permissions.allRoles(), { [name]: equivalent });
    assert.deepEqual(t.caps(second.personaId, CHAN_A), [...RW]);
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
    assert.equal(t.relay.invites.get('equivalent').uses, 2);
  } finally {
    t.cleanup();
  }
});

test('an invite with roles and a mirror grant gives both, at enrollment and at a claim', async () => {
  const t = makeRelay();
  try {
    t.relay.permissions.setRole('some-role', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD });
    t.relay.invites.mint({
      code: 'roles-and-mirror', guildId: GUILD, mode: 'both', maxUses: 2, roles: ['some-role'],
      grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } },
    });
    const enrolled = await t.relay.enroll({ invite: 'roles-and-mirror', desiredName: 'both' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const names = t.relay.permissions.getRoleNames(enrolled.personaId);
    const mirror = names.find((n) => n.startsWith('mirror-'));
    assert.ok(names.includes('some-role') && mirror, JSON.stringify(names));
    assert.deepEqual(t.caps(enrolled.personaId, CHAN_A), [...RW]);
    const claimed = t.relay.applyInviteAugment(EXISTING, 'roles-and-mirror');
    assert.ok(claimed.roles.includes('some-role') && claimed.roles.includes(mirror!), JSON.stringify(claimed.roles));
  } finally {
    t.cleanup();
  }
});

test('a rejected augment changes nothing: no roles granted, invite not consumed', () => {
  const t = makeRelay();
  try {
    // Roles plus a mirror grant missing its guild: the whole claim is invalid.
    t.relay.invites.mint({
      code: 'roles-and-bad-mirror', label: 'x', mode: 'augment', maxUses: 1, roles: ['some-role'],
      grant: { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'r1' } },
    });
    t.relay.permissions.setRole('some-role', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD });
    const before = t.relay.permissions.getRoleNames(EXISTING);
    for (let i = 0; i < 2; i++) {
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'roles-and-bad-mirror'), /missing guildId/);
    }
    assert.deepEqual(t.relay.permissions.getRoleNames(EXISTING), before, 'no roles granted by a rejected claim');
    assert.equal(t.relay.invites.get('roles-and-bad-mirror').uses ?? 0, 0, 'no use consumed');
  } finally {
    t.cleanup();
  }
});

test('multi-role grants normalize role order and duplicates for both naming and reuse', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({
      code: 'multi', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW], scope: { mirrorRoles: ['other-role', DISCORD_ROLE] } },
    });
    const first = await t.relay.enroll({ invite: 'multi', desiredName: 'first' });
    assert.ok(!('error' in first));
    const [name] = t.relay.permissions.getRoleNames(first.personaId);
    const equivalent: AccessRole = {
      guildId: GUILD, caps: [...RW],
      scope: { mirrorRoles: ['other-role', DISCORD_ROLE, 'other-role'] },
    };
    t.relay.permissions.setRole(name, equivalent);
    t.relay.invites.mint({
      code: 'multi-reordered', mode: 'both', guildId: GUILD,
      grant: { caps: [...RW].reverse(), scope: { mirrorRoles: [DISCORD_ROLE, 'other-role', DISCORD_ROLE] } },
    });
    const second = await t.relay.enroll({ invite: 'multi-reordered', desiredName: 'second' });
    assert.ok(!('error' in second), JSON.stringify(second));
    const claimed = t.relay.applyInviteAugment(EXISTING, 'multi-reordered');
    assert.deepEqual(t.relay.permissions.getRoleNames(second.personaId), [name]);
    assert.deepEqual(claimed.roles, [name]);
    assert.deepEqual(t.relay.permissions.allRoles(), { [name]: equivalent });
    assert.equal(t.relay.invites.get('multi-reordered').uses, 2);
  } finally {
    t.cleanup();
  }
});

test('optional fields given as null read as absent, as they always have', async () => {
  const t = makeRelay();
  try {
    t.relay.invites.mint({
      code: 'nulls', guildId: GUILD, mode: null, uses: null, roles: null, caps: null,
      namePrefix: null, subscriptions: null, mintedBy: null,
      grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } },
    });
    const enrolled = await t.relay.enroll({ invite: 'nulls', desiredName: null, avatar: null, subscriptions: null });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    assert.equal(enrolled.persona.displayName, 'agent');
    assert.deepEqual(t.caps(enrolled.personaId, CHAN_A), [...RW]);

    // A null grant grants nothing, as an absent one does: a default-deny persona.
    t.relay.invites.mint({ code: 'null-grant', guildId: GUILD, grant: null });
    const bare = await t.relay.enroll({ invite: 'null-grant', desiredName: 'bare' });
    assert.ok(!('error' in bare), JSON.stringify(bare));
    assert.deepEqual(t.caps(bare.personaId, CHAN_A), []);
  } finally {
    t.cleanup();
  }
});

test('a claim never recreates a removed role that personas still name', async () => {
  const t = makeRelay();
  try {
    const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    const [name] = t.relay.permissions.getRoleNames(first.personaId);
    t.relay.permissions.removeRole(name);
    assert.deepEqual(t.caps(first.personaId, CHAN_A), [], 'the admin revoked these caps');
    const before = t.snapshot();
    const again = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
    assert.match(again.error ?? '', /conflicts with removed role/, JSON.stringify(again));
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), { code: 'INVALID_PARAMS', message: /conflicts with removed role/ });
    assert.deepEqual(t.snapshot(), before, 'nothing written, and the invite not consumed');
    assert.deepEqual(t.caps(first.personaId, CHAN_A), [], 'the revoked caps stay revoked');
  } finally {
    t.cleanup();
  }
});

test('the enrollment log names an unlabelled invite without its bearer code', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const r = makeRelay();
  try {
    const enrolled = await r.relay.enroll({ invite: 'mirror-mint', desiredName: 'logged' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    assert.ok(lines.some((l) => l.includes(`enrolled persona "${enrolled.personaId}"`)), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('mirror-mint')), lines.join('\n'));
  } finally {
    r.cleanup();
  }
});

test('the enrollment log shows at most half an unlabelled code, and 12 characters of a generated one', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const r = makeRelay();
  try {
    // A hand-supplied code can be short (mint-invite.mjs takes --code), and
    // one with a claim left is still a live credential. A generated code is
    // `inv_` and 24 characters, so its first four tell no two apart.
    const generated = 'inv_a1B2c3D4e5F6g7H8i9J0k1L2';
    for (const [code, shown] of [['p43x', 'p4…'], [generated, 'inv_a1B2c3D4…']] as const) {
      r.relay.invites.mint({ code, guildId: GUILD, maxUses: 2, grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } } });
      const enrolled = await r.relay.enroll({ invite: code, desiredName: `logged-${code.length}` });
      assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
      const line = lines.find((l) => l.includes(`enrolled persona "${enrolled.personaId}"`));
      assert.ok(line, lines.join('\n'));
      assert.ok(line.includes(`via invite (${shown})`), line);
      assert.ok(!lines.some((l) => l.includes(code)), lines.join('\n'));
    }
  } finally {
    r.cleanup();
  }
});

test('the removed-role refusal names, for the operator, the personas still naming the role', async (t) => {
  const lines: string[] = [];
  const r = makeRelay();
  try {
    const first = await r.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    const [name] = r.relay.permissions.getRoleNames(first.personaId);
    r.relay.permissions.removeRole(name);
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const again = await r.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
    assert.match(again.error ?? '', /conflicts with removed role/);
    assert.ok(!(again.error ?? '').includes(first.personaId), 'the claimant is not told who');
    assert.ok(
      lines.some((l) => l.includes(`removed role "${name}" is still named by "${first.personaId}" in permissions.json`)),
      lines.join('\n'),
    );
  } finally {
    r.cleanup();
  }
});
