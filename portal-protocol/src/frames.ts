import type { PortalChannel, PortalGuild } from './channel.js';
import type { ChannelId, PersonaId, SessionId } from './ids.js';
import type { PortalEvent } from './events.js';
import type { Persona } from './persona.js';
import type { RpcRequest, RpcResponse } from './rpc.js';
import type { ProtocolVersion } from './version.js';

// ── Client → Relay ──

export interface IdentifyData {
  protocolVersion: ProtocolVersion;
  /** Auth token proving this connection may act as `personaId`. */
  token: string;
  personaId: PersonaId;
  /** Ambient channel subscriptions to restore on connect. */
  subscriptions?: ChannelId[];
}

export interface ResumeData {
  sessionId: SessionId;
  /** Last event seq the client durably processed; relay replays from seq+1. */
  seq: number;
}

/**
 * Self-registration: a brand-new agent with no persona/token presents an invite
 * (an admin-minted access-rights *template*) plus a desired display name; the
 * relay mints a persona id + token and stamps the invite's capability profile
 * onto it. The minted token is then used for normal `identify` (and resume)
 * forever after. This is how a Claude Code instance self-enrolls without ever
 * holding a Discord bot token.
 */
export interface RegisterData {
  protocolVersion: ProtocolVersion;
  /** Invite code (template). Authorizes registration and sets the persona's caps. */
  invite: string;
  /** Desired display name for the new persona. */
  desiredName: string;
  /** Optional avatar filename (resolved under the relay's base URL) or absolute URL. */
  avatar?: string;
  /** Ambient channel subscriptions to restore on connect. */
  subscriptions?: ChannelId[];
}

export type ClientFrame =
  | { op: 'identify'; d: IdentifyData }
  | { op: 'register'; d: RegisterData }
  | { op: 'resume'; d: ResumeData }
  | { op: 'heartbeat'; d: { seq: number } }
  | { op: 'rpc'; d: RpcRequest };

// ── Relay → Client ──

export interface HelloData {
  protocolVersion: ProtocolVersion;
  heartbeatIntervalMs: number;
}

export interface ReadyData {
  sessionId: SessionId;
  persona: Persona;
  guilds: PortalGuild[];
  channels: PortalChannel[];
  /** Highest event seq at ready — the resume baseline. */
  seq: number;
}

export interface ResumedData {
  replayedEvents: number;
}

/** Credentials minted by a successful `register`. Persist `token` locally and
 *  use it for all subsequent `identify`s. */
export interface RegisteredData {
  personaId: PersonaId;
  token: string;
  persona: Persona;
}

export interface InvalidSessionData {
  /** Whether the client may retry with `resume` (vs a fresh `identify`). */
  resumable: boolean;
  reason: string;
}

export type ServerFrame =
  | { op: 'hello'; d: HelloData }
  | { op: 'ready'; d: ReadyData }
  | { op: 'registered'; d: RegisteredData }
  | { op: 'resumed'; d: ResumedData }
  | { op: 'heartbeat_ack' }
  | { op: 'invalid_session'; d: InvalidSessionData }
  | { op: 'dispatch'; seq: number; d: PortalEvent }
  | { op: 'rpc_result'; d: RpcResponse };

export type ClientOp = ClientFrame['op'];
export type ServerOp = ServerFrame['op'];
