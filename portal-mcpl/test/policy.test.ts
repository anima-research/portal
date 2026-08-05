/**
 * MCPL 0.5 capability-grant enforcement (SPEC §5.3, §5.4, §6.2, §6.4, §6.6, §6.7).
 *
 * The property under test throughout is that **absence of a capability is
 * denial**, never a default-allow, and that nothing the server says or is told
 * can widen what it may do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { featureSets, TOOL_FEATURE_SETS, toolFeatureSetCoverage } from '../src/feature-sets.js';
import {
  CAPABILITY_PATHS,
  MalformedPolicyError,
  McplPolicy,
  invalidUses,
  isCapabilityPath,
  pathMatches,
  type DeclaredFeatureSet,
} from '../src/policy.js';

const ALL_USES = [...new Set(Object.values(featureSets).flatMap((set) => set.uses as string[]))];

function policy(
  declarations: Readonly<Record<string, DeclaredFeatureSet>> = featureSets,
): McplPolicy {
  return new McplPolicy(declarations);
}

// ── §6.2 vocabulary ──

test('the capability vocabulary is exactly SPEC §6.2 / Appendix B.2', () => {
  assert.deepEqual(
    [...CAPABILITY_PATHS],
    [
      'pushEvents',
      'tools',
      'modelInfo',
      'inferenceRequest',
      'inferenceRequest.streaming',
      'inferenceLifecycle',
      'contextHooks.beforeInference.observe',
      'contextHooks.beforeInference.inject.system',
      'contextHooks.beforeInference.inject.beforeUser',
      'contextHooks.beforeInference.inject.afterUser',
      'channels.register',
      'channels.lifecycle',
      'channels.publish',
      'channels.incoming',
      'channels.streaming',
      'channels.acknowledge',
      'channels.typing',
    ],
  );
  // Plausible-looking non-members stay non-members.
  for (const bogus of ['channels', 'contextHooks', 'contextHooks.beforeInference', 'push', 'tools.call']) {
    assert.equal(isCapabilityPath(bogus), false, `${bogus} must not be a capability path`);
  }
});

test('every declared feature set declares a valid, non-empty uses (§6.4 rule 1)', () => {
  for (const [name, declaration] of Object.entries(featureSets)) {
    assert.equal(invalidUses(declaration), null, `${name} has invalid uses`);
  }
  assert.equal(invalidUses({ uses: undefined }), 'absent');
  assert.equal(invalidUses({ uses: [] }), 'empty');
  assert.equal(invalidUses({ uses: ['channels'] }), 'unrecognized: channels');
});

test('feature sets are keyed by name, not an array with a name member (§6.1)', () => {
  assert.equal(Array.isArray(featureSets), false);
  assert.deepEqual(Object.keys(featureSets).sort(), [
    'portal.channels',
    'portal.history',
    'portal.messaging',
    'portal.subscriptions',
    'portal.voice',
  ]);
  for (const declaration of Object.values(featureSets)) {
    assert.equal('name' in declaration, false);
    assert.equal(typeof declaration.description, 'string');
  }
});

test('every tool belongs to a declared feature set', () => {
  assert.deepEqual(toolFeatureSetCoverage(), { unmapped: [], unknownSets: [] });
});

// ── §5.4 matching ──

test('grant matching is a generic recursive walk; a bare prefix is not a subtree', () => {
  assert.equal(pathMatches('channels.publish', 'channels.publish'), true);
  assert.equal(pathMatches('channels.*', 'channels.publish'), true);
  assert.equal(pathMatches('channels', 'channels.publish'), false);
  assert.equal(pathMatches('contextHooks.*', 'contextHooks.beforeInference.inject.system'), true);
  assert.equal(pathMatches('contextHooks.beforeInference.inject.*', 'contextHooks.beforeInference.observe'), false);
  assert.equal(pathMatches('*', 'anything.at.all'), true);
});

// ── §5.3 initial policy ──

test('nothing is granted before the initial featureSets/update (§5.3)', () => {
  const p = policy();
  assert.equal(p.isReady, false);
  for (const path of CAPABILITY_PATHS) assert.equal(p.allows(path), false, path);
  for (const name of Object.keys(featureSets)) assert.equal(p.featureEnabled(name), false, name);
});

test('an empty grant enables nothing — "policy arrived" is not "allowed"', () => {
  const p = policy();
  const receipt = p.applyRequest({ effectiveCapabilities: [] });
  assert.equal(p.isReady, true);
  assert.equal(receipt.mode, 'degraded');
  assert.equal(receipt.unavailableFeatures.length, Object.keys(featureSets).length);
  for (const path of CAPABILITY_PATHS) assert.equal(p.allows(path), false, path);
});

// ── §6.4 derivation ──

test('a denied capability disables every set whose uses requires it (§6.4)', () => {
  const p = policy();
  const receipt = p.applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(p.featureEnabled('portal.messaging'), false);
  assert.equal(p.featureEnabled('portal.history'), true);
  const messaging = receipt.unavailableFeatures.find((f) => f.featureSet === 'portal.messaging');
  assert.equal(messaging?.reason, 'capability_denied');
  assert.deepEqual(messaging?.missingCapabilities, [
    'pushEvents',
    'channels.register',
    'channels.lifecycle',
    'channels.publish',
    'channels.incoming',
    'channels.acknowledge',
  ]);
});

test('an invalid uses disables that set with invalid_uses and nothing else (§6.4 rule 1)', () => {
  const p = policy({
    good: { uses: ['tools'] },
    bogus: { uses: ['channels.everything'] },
    empty: { uses: [] },
    absent: {},
  });
  const receipt = p.applyRequest({ effectiveCapabilities: ['tools', 'channels.everything'] });
  assert.equal(p.featureEnabled('good'), true);
  for (const name of ['bogus', 'empty', 'absent']) {
    assert.equal(p.featureEnabled(name), false, name);
    assert.equal(
      receipt.unavailableFeatures.find((f) => f.featureSet === name)?.reason,
      'invalid_uses',
    );
  }
  // The unrecognized path is not silently promoted into the grant either.
  assert.ok(receipt.notes.some((n) => n.includes('channels.everything')));
});

test('host selection narrows and never widens (§6.4 rule 3)', () => {
  const enabledOnly = policy().applyRequest({
    effectiveCapabilities: ALL_USES,
    enabled: ['portal.history'],
  });
  assert.deepEqual(
    enabledOnly.unavailableFeatures.filter((f) => f.reason === 'not_selected').map((f) => f.featureSet).sort(),
    ['portal.channels', 'portal.messaging', 'portal.subscriptions', 'portal.voice'],
  );

  const p = policy();
  p.applyRequest({ effectiveCapabilities: ['tools'], enabled: ['portal.messaging'] });
  assert.equal(
    p.featureEnabled('portal.messaging'),
    false,
    'naming a set in `enabled` must not supply the capabilities it lacks',
  );

  const wildcard = policy();
  wildcard.applyRequest({ effectiveCapabilities: ALL_USES, disabled: ['portal.*'] });
  for (const name of Object.keys(featureSets)) assert.equal(wildcard.featureEnabled(name), false, name);
});

// ── §5.4 deniedCapabilities is diagnostics ──

test('deniedCapabilities never authorizes, and a path in both lists fails closed (§5.4)', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ['tools'], deniedCapabilities: ['pushEvents'] });
  assert.equal(p.allows('tools'), true);
  assert.equal(p.allows('pushEvents'), false);

  assert.throws(
    () => p.applyRequest({ effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] }),
    MalformedPolicyError,
  );
  assert.equal(p.isReady, false, 'a malformed policy drops back to fully denied');
  assert.equal(p.allows('tools'), false);
});

test('an unparseable member drops the whole message rather than half-applying it', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ALL_USES });
  assert.equal(p.allows('channels.publish'), true);
  assert.throws(
    () => p.applyRequest({ effectiveCapabilities: ['tools'], disabled: [{ nope: true }] }),
    MalformedPolicyError,
  );
  assert.equal(
    p.allows('channels.publish'),
    false,
    'the previous, wider grant must not survive a rejected policy message',
  );
});

// ── §6.7 Request vs Notification ──

test('a Notification cannot establish a ready state or widen anything (§6.7)', () => {
  const p = policy();
  const diagnostics = p.applyNotification({
    effectiveCapabilities: ALL_USES,
    enabled: ['portal.messaging'],
  });
  assert.equal(p.isReady, false);
  assert.equal(p.allows('tools'), false);
  assert.equal(diagnostics.length, 2, 'both the grant and the expansion are refused and reported');
});

test('a reduction is respected immediately, even as a Notification (§6.7)', () => {
  const p = policy();
  p.applyRequest({ effectiveCapabilities: ALL_USES });
  assert.equal(p.featureEnabled('portal.messaging'), true);
  p.applyNotification({ disabled: ['portal.messaging'] });
  assert.equal(p.featureEnabled('portal.messaging'), false);
  assert.equal(p.featureEnabled('portal.history'), true);
});

test('the receipt is consequence testimony, never a claim of entitlement (§6.7)', () => {
  const receipt = policy().applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(Object.keys(receipt).sort(), ['accepted', 'mode', 'notes', 'unavailableFeatures']);
  for (const feature of receipt.unavailableFeatures) {
    assert.equal(feature.effect, 'disabled');
    // Nothing in the receipt names what the server should be given.
    assert.equal('requires' in feature, false);
    assert.equal('requested' in feature, false);
  }
});

// ── Server binding ──

function serverHarness() {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const server = new PortalMcplServer(client, new PortalAgent(client, { hostOwnsChannelLifecycle: true }));
  const responses: unknown[] = [];
  const errors: Array<{ code: number; message: string }> = [];
  const internal = server as unknown as {
    conn: unknown;
    mcplEnabled: boolean;
    policy: McplPolicy;
    handleRequest(req: { id: number; method: string; params?: unknown }): Promise<void>;
  };
  internal.conn = {
    sendResponse(_id: number, result: unknown) {
      responses.push(result);
    },
    sendError(_id: number, code: number, message: string) {
      errors.push({ code, message });
    },
    sendNotification() {},
    async sendRequest() {
      return {};
    },
  };
  internal.mcplEnabled = true;
  return { server, internal, responses, errors };
}

test('before policy, the tool surface is empty and privileged methods are refused (§5.3, §6.6)', async () => {
  const h = serverHarness();
  await h.internal.handleRequest({ id: 1, method: 'tools/list' });
  assert.deepEqual(h.responses[0], { tools: [] });

  await h.internal.handleRequest({ id: 2, method: 'channels/publish', params: { channelId: 'portal:1', content: [] } });
  // §6.6: a method that will never be answered MUST return an error, not silence.
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, -32002);
});

test('a denied capability refuses the inbound method that needs it (§5.4, §14.1)', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  await h.internal.handleRequest({ id: 1, method: 'channels/open', params: { channelId: 'portal:1' } });
  assert.equal(h.errors[0].code, -32002, 'channels/open requires channels.lifecycle');
  assert.ok(h.errors[0].message.includes('channels.lifecycle'));
});

test('a tool whose feature set is disabled stops answering (§6.4, §6.6)', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ['tools'] });
  assert.equal(TOOL_FEATURE_SETS.send_message, 'portal.messaging');

  await h.internal.handleRequest({ id: 1, method: 'tools/list' });
  const listed = (h.responses[0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.equal(listed.includes('send_message'), false, 'portal.messaging is disabled');
  assert.equal(listed.includes('fetch_history'), true, 'portal.history only needs `tools`');

  await h.internal.handleRequest({ id: 2, method: 'tools/call', params: { name: 'send_message', arguments: {} } });
  assert.equal(h.errors[0].code, -32001, 'feature set not enabled');
});

test('a featureSets/update Request is answered even when it grants nothing (§5.3, §6.7)', async () => {
  const h = serverHarness();
  await h.internal.handleRequest({ id: 1, method: 'featureSets/update', params: { effectiveCapabilities: [] } });
  const receipt = h.responses[0] as { accepted: boolean; mode: string };
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, 'degraded');
  assert.equal(h.errors.length, 0);
});

test('a malformed featureSets/update is answered with an error and denies everything', async () => {
  const h = serverHarness();
  h.internal.policy.applyRequest({ effectiveCapabilities: ALL_USES });
  await h.internal.handleRequest({
    id: 1,
    method: 'featureSets/update',
    params: { effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] },
  });
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].code, -32602);
  assert.equal(h.internal.policy.allows('tools'), false);
});
