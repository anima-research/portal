import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_PROTOCOL_VERSION,
  dispatch,
  isClientFrame,
  isServerFrame,
  parseClientFrame,
  rpcErr,
  rpcOk,
} from '../src/index.js';
import type { ClientFrame, PortalEvent } from '../src/index.js';

test('identify is a valid client frame', () => {
  const f: ClientFrame = {
    op: 'identify',
    d: { protocolVersion: PORTAL_PROTOCOL_VERSION, token: 't', personaId: 'p1' },
  };
  assert.ok(isClientFrame(f));
});

test('rpc client frame requires a well-formed request', () => {
  assert.ok(
    isClientFrame({ op: 'rpc', d: { id: '1', method: 'send_message', params: { channelId: 'c' } } }),
  );
  assert.equal(isClientFrame({ op: 'rpc', d: { id: '1' } }), false);
});

test('garbage is rejected', () => {
  assert.equal(isClientFrame({ op: 'nope' }), false);
  assert.equal(isClientFrame(null), false);
  assert.equal(parseClientFrame('{not json'), null);
});

test('dispatch frame round-trips through JSON and validates', () => {
  const ev: PortalEvent = {
    type: 'message_delete',
    channelId: 'c1',
    messageId: 'm1',
  };
  const frame = dispatch(7, ev);
  const json = JSON.stringify(frame);
  const back: unknown = JSON.parse(json);
  assert.ok(isServerFrame(back));
  assert.equal((back as { op: 'dispatch'; seq: number }).seq, 7);
});

test('rpc result constructors', () => {
  const ok = rpcOk('1', { messageId: 'm9' });
  assert.ok(isServerFrame(ok));
  const err = rpcErr('2', 'FORBIDDEN', 'nope');
  assert.ok(isServerFrame(err));
  assert.equal(err.op, 'rpc_result');
});
