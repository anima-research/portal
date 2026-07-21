/**
 * Node default WebSocket factory — the only module in the package that imports
 * `ws`. Reached exclusively through the Node entry (`index.ts`), so browser
 * bundles never resolve the `ws` package.
 */
import { WebSocket } from 'ws';
import type { WsFactory } from './ws-compat.js';

export const nodeWsFactory: WsFactory = (url) => new WebSocket(url);
