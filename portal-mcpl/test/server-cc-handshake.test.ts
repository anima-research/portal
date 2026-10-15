import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
import { PortalClient } from '@animalabs/portal-client';
import { PortalAgent } from '../src/agent.js';
import { PortalCcChannelServer } from '../src/server-cc.js';

// Claude Code >= 2.1.282 speaks the 2026-07-28 MCP revision first: it opens with
// a `server/discover` probe and falls back to `initialize` only once the probe
// is answered. A silent drop here hung every interactive session for its full
// connect timeout, so the probe must get a JSON-RPC error and the legacy
// handshake must still complete on the same connection.
test('handshake answers a pre-initialize server/discover probe, then still initializes', async () => {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'p' });
  const server = new PortalCcChannelServer(client, new PortalAgent(client, {}));
  const serving = server.serve(McplConnection.fromStreams(toServer, fromServer));

  type Reply = {
    id: number;
    result?: { capabilities?: { experimental: Record<string, unknown> }; tools?: Array<{ name: string }> };
    error?: { code: number };
  };
  const replies: Reply[] = [];
  let buf = '';
  fromServer.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      replies.push(JSON.parse(buf.slice(0, nl)) as Reply);
      buf = buf.slice(nl + 1);
    }
  });
  const reply = async (n: number): Promise<Reply> => {
    for (let i = 0; i < 400 && replies.length < n; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(replies.length >= n, `expected reply #${n}, got ${replies.length}`);
    return replies[n - 1];
  };
  const send = (o: unknown) => toServer.write(JSON.stringify(o) + '\n');

  send({ jsonrpc: '2.0', id: 0, method: 'server/discover', params: {} });
  const probe = await reply(1);
  assert.equal(probe.id, 0);
  assert.equal(probe.error?.code, -32601);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const init = await reply(2);
  assert.equal(init.id, 1);
  assert.ok(init.result?.capabilities && 'claude/channel' in init.result.capabilities.experimental);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await reply(3);
  assert.equal(tools.id, 2);
  assert.equal(tools.error, undefined, 'tools/list answers with a result, not an error');
  assert.ok(tools.result?.tools?.some((t) => t.name === 'send_message'), 'the tool surface is listed');

  toServer.end();
  await serving;
});
