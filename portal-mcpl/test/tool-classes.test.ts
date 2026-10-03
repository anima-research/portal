/**
 * MCPL RFC-008 tool classes: every served tool is classed (or deliberately
 * unclassed), every class is from the vocabulary, and both tools/list paths
 * emit `_meta["mcpl/class"]` without dropping other `_meta` keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import { PortalAgent } from '../src/agent.js';
import { PortalMcplServer } from '../src/server.js';
import { PortalCcChannelServer } from '../src/server-cc.js';
import { featureSets, TOOL_FEATURE_SETS } from '../src/feature-sets.js';
import {
  TOOL_CLASSES,
  TOOL_CLASS_META_KEY,
  TOOL_CLASS_VOCABULARY,
  UNCLASSED,
  withToolClass,
} from '../src/tool-classes.js';
import { toolDefinitions, type ToolDefinition } from '../src/tools.js';

const ALL_USES = [...new Set(Object.values(featureSets).flatMap((set) => set.uses as string[]))];

test('the class vocabulary is exactly RFC-008 §4', () => {
  assert.equal(TOOL_CLASS_META_KEY, 'mcpl/class');
  assert.deepEqual(
    [...TOOL_CLASS_VOCABULARY],
    ['comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control'],
  );
});

test('every tool (all feature sets) is in TOOL_CLASSES or UNCLASSED, never both, never stale', () => {
  const names = toolDefinitions.map((t) => t.name);
  const unlisted = names.filter((name) => !(name in TOOL_CLASSES) && !UNCLASSED.has(name));
  assert.deepEqual(unlisted, [], 'class or explicitly unclass every tool');
  const both = names.filter((name) => name in TOOL_CLASSES && UNCLASSED.has(name));
  assert.deepEqual(both, []);
  const known = new Set(names);
  const stale = [...Object.keys(TOOL_CLASSES), ...UNCLASSED].filter((name) => !known.has(name));
  assert.deepEqual(stale, [], 'entries naming tools that no longer exist');
  // The feature-set table covers the same surface, so no set's tools escape classing.
  for (const name of Object.keys(TOOL_FEATURE_SETS)) assert.ok(known.has(name), name);
});

test('every declared class is from the vocabulary, non-empty, without duplicates', () => {
  const vocabulary = new Set<string>(TOOL_CLASS_VOCABULARY);
  for (const [name, classes] of Object.entries(TOOL_CLASSES)) {
    assert.ok(classes.length > 0, `${name}: an empty list is unclassed — use UNCLASSED`);
    assert.equal(new Set(classes).size, classes.length, `${name}: duplicate class`);
    for (const cls of classes) assert.ok(vocabulary.has(cls), `${name}: unknown class ${cls}`);
  }
});

test('the comms rule: a tool that takes message text or attachments is comms', () => {
  for (const tool of toolDefinitions) {
    const props = Object.keys(tool.inputSchema.properties);
    if (!props.some((p) => p === 'content' || p === 'text' || p === 'files')) continue;
    assert.ok(TOOL_CLASSES[tool.name]?.includes('comms'), `${tool.name} carries message text`);
  }
});

test('toolDefinitions carry their class in _meta; unclassed tools carry no key', () => {
  for (const tool of toolDefinitions) {
    const declared = tool._meta?.[TOOL_CLASS_META_KEY];
    if (UNCLASSED.has(tool.name)) {
      assert.equal(declared, undefined, tool.name);
    } else {
      assert.deepEqual(declared, [...TOOL_CLASSES[tool.name]], tool.name);
    }
  }
});

test('withToolClass merges into existing _meta and never mutates its input', () => {
  const tool: ToolDefinition = {
    name: 'send_message',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    _meta: { featureSet: 'portal.messaging', 'vendor/x': 1 },
  };
  const out = withToolClass(tool);
  assert.deepEqual(out._meta, {
    featureSet: 'portal.messaging',
    'vendor/x': 1,
    'mcpl/class': ['comms'],
  });
  assert.deepEqual(tool._meta, { featureSet: 'portal.messaging', 'vendor/x': 1 });
  // The served array is a copy: mutating it cannot corrupt the shared table.
  (out._meta![TOOL_CLASS_META_KEY] as string[]).push('control');
  assert.deepEqual(TOOL_CLASSES.send_message, ['comms']);

  const unknown = { name: 'not_a_tool', _meta: { featureSet: 'x' } };
  assert.equal(withToolClass(unknown), unknown, 'unclassed: returned as-is, no key added');
});

// ── Both tools/list paths ──

/** An agent whose tools carry an upstream `_meta` key, as a host-facing
 *  attribution would, so the list paths are checked for merging, not replacing. */
class AttributedAgent extends PortalAgent {
  override get tools(): ToolDefinition[] {
    return super.tools.map((tool) => ({
      ...tool,
      _meta: { ...tool._meta, featureSet: TOOL_FEATURE_SETS[tool.name] },
    }));
  }
}

function connStub() {
  const responses: unknown[] = [];
  const errors: Array<{ code: number; message: string }> = [];
  return {
    responses,
    errors,
    conn: {
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
    },
  };
}

type Internal = {
  conn: unknown;
  handleRequest(req: { id: number; method: string; params?: unknown }): Promise<void>;
};

function assertClassedListing(tools: ToolDefinition[], expectedNames: string[]): void {
  assert.deepEqual(tools.map((t) => t.name).sort(), [...expectedNames].sort());
  for (const tool of tools) {
    assert.deepEqual(tool._meta?.[TOOL_CLASS_META_KEY], [...TOOL_CLASSES[tool.name]], tool.name);
    assert.equal(tool._meta?.featureSet, TOOL_FEATURE_SETS[tool.name], `${tool.name}: featureSet kept`);
  }
}

test('MCPL server tools/list emits mcpl/class and keeps existing _meta (host-owned lifecycle)', async () => {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const agent = new AttributedAgent(client, { hostOwnsChannelLifecycle: true });
  const server = new PortalMcplServer(client, agent);
  const internal = server as unknown as Internal & {
    mcplEnabled: boolean;
    policy: { applyRequest(params: unknown): unknown };
  };
  const stub = connStub();
  internal.conn = stub.conn;
  internal.mcplEnabled = true;
  internal.policy.applyRequest({ effectiveCapabilities: ALL_USES });

  await internal.handleRequest({ id: 1, method: 'tools/list' });
  assert.equal(stub.errors.length, 0);
  const { tools } = stub.responses[0] as { tools: ToolDefinition[] };
  assertClassedListing(tools, agent.tools.map((t) => t.name));
  assert.ok(tools.length > 0);
});

test('Claude Code channel tools/list emits mcpl/class and keeps existing _meta (full surface)', async () => {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const server = new PortalCcChannelServer(client, new AttributedAgent(client));
  const internal = server as unknown as Internal;
  const stub = connStub();
  internal.conn = stub.conn;

  await internal.handleRequest({ id: 1, method: 'tools/list' });
  assert.equal(stub.errors.length, 0);
  const { tools } = stub.responses[0] as { tools: ToolDefinition[] };
  assertClassedListing(tools, toolDefinitions.map((t) => t.name));
});
