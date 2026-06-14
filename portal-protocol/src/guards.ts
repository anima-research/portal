import type { ClientFrame, ServerFrame } from './frames.js';
import type { PortalEvent } from './events.js';
import type { RpcId } from './ids.js';
import type { RpcError, RpcErrorCode, RpcRequest, RpcResponse } from './rpc.js';

/**
 * Lightweight structural validation. This package intentionally has no schema
 * dependency (zod etc.); these guards check the discriminant + shape enough to
 * route a frame safely. Full field validation lives in the handlers, which
 * have the typed context to produce good errors.
 */

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

const CLIENT_OPS = new Set(['identify', 'register', 'resume', 'heartbeat', 'rpc']);
const SERVER_OPS = new Set([
  'hello',
  'ready',
  'registered',
  'resumed',
  'heartbeat_ack',
  'invalid_session',
  'dispatch',
  'rpc_result',
]);

export function isClientFrame(x: unknown): x is ClientFrame {
  if (!isObj(x) || typeof x.op !== 'string' || !CLIENT_OPS.has(x.op)) return false;
  if (x.op === 'heartbeat_ack') return true;
  if (x.op === 'rpc') return isRpcRequest(x.d);
  return 'd' in x && isObj(x.d);
}

export function isServerFrame(x: unknown): x is ServerFrame {
  if (!isObj(x) || typeof x.op !== 'string' || !SERVER_OPS.has(x.op)) return false;
  if (x.op === 'heartbeat_ack') return true;
  if (x.op === 'dispatch') return typeof x.seq === 'number' && isObj(x.d) && typeof x.d.type === 'string';
  return 'd' in x && isObj(x.d);
}

export function isRpcRequest(x: unknown): x is RpcRequest {
  return isObj(x) && typeof x.id === 'string' && typeof x.method === 'string' && isObj(x.params);
}

/** Parse a JSON wire string into a frame, returning null on any failure. */
export function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isClientFrame(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseServerFrame(raw: string): ServerFrame | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isServerFrame(v) ? v : null;
  } catch {
    return null;
  }
}

// ── Constructors (shared by relay + client for consistent framing) ──

export function dispatch(seq: number, event: PortalEvent): ServerFrame {
  return { op: 'dispatch', seq, d: event };
}

export function rpcOk(id: RpcId, result: unknown): ServerFrame {
  return { op: 'rpc_result', d: { id, ok: true, result } as RpcResponse };
}

export function rpcErr(id: RpcId, code: RpcErrorCode, message: string): ServerFrame {
  const error: RpcError = { code, message };
  return { op: 'rpc_result', d: { id, ok: false, error } };
}
