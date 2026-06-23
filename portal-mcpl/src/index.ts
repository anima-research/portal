/**
 * @animalabs/portal-mcpl
 *
 * Agent-facing layer over portal-client: durable read-state (watermarks +
 * pending pings) and the MCPL tool surface. Transport-agnostic — bind
 * `PortalAgent` to an McplConnection to expose it over MCPL (see README).
 */
export { PortalAgent } from './agent.js';
export type { PortalAgentOptions } from './agent.js';
export { PortalMcplServer } from './server.js';
export { AgentState } from './agent-state.js';
export type { PendingPing, ChannelUnread } from './agent-state.js';
export { toolDefinitions } from './tools.js';
export type { ToolDefinition } from './tools.js';
