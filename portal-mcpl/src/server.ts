/**
 * MCPL server binding: exposes a PortalAgent (over a PortalClient) to an MCPL
 * host (connectome-host / agent-framework's `mcpl` module).
 *
 * Mirrors discord-mcpl/server.ts but slim: initialize handshake, tools/list,
 * tools/call → PortalAgent, channel registration from the client cache, push
 * events for inbound messages, and channels/publish → send (the host's
 * locus-routing path for plain-text turns).
 */
import {
  McplConnection,
  textContent,
  method,
  type ChannelDescriptor,
  type ChannelsAcknowledgeParams,
  type ChannelsAcknowledgeResult,
  type ChannelsCloseParams,
  type ChannelsCloseResult,
  type ChannelsIncomingParams,
  type ChannelsListResult,
  type ChannelsOpenParams,
  type ChannelsOpenResult,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
  type ChannelsChangedParams,
  type ChannelsRegisterParams,
  type ContentBlock,
  type InitializeCapabilities,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McplCapabilities,
  type McplInitializeParams,
  type McplInitializeResult,
  type PushEventParams,
} from '@animalabs/mcpl-core';
import type { PortalClient } from '@animalabs/portal-client';
import { chunkText } from './chunk.js';
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';
import type { PortalAgent } from './agent.js';
import type { PendingPing } from './agent-state.js';
import { parsePortalChannelId, portalChannelId, toDescriptor } from './channels.js';
import { featureSets, TOOL_FEATURE_SETS } from './feature-sets.js';
import {
  McplPolicy,
  MalformedPolicyError,
  type CapabilityPath,
  type FeatureSetsUpdateParams,
} from './policy.js';

/** Appendix A error codes. */
const ERR_FEATURE_SET_NOT_ENABLED = -32001;
const ERR_CAPABILITY_DENIED = -32002;
const ERR_INVALID_PARAMS = -32602;

/** The feature set every server-initiated message on the message path is
 *  tagged with (§6.5). */
const MESSAGING = 'portal.messaging';

/**
 * SPEC §14.1's table, plus MCP's tool methods, expressed as the capability each
 * INBOUND method requires. Channel methods carry no `featureSet` field and are
 * authorized by the grant alone — §14.1 is explicit that feature sets "are not
 * the authorization" for them. Tool calls additionally check the feature set
 * that owns the tool, because a feature set is a named bundle of behavior (§6)
 * and a disabled bundle must stop answering.
 */
const INBOUND_CAPABILITY: Readonly<Record<string, CapabilityPath>> = {
  'tools/call': 'tools',
  [method.CHANNELS_LIST]: 'channels.register',
  [method.CHANNELS_OPEN]: 'channels.lifecycle',
  [method.CHANNELS_CLOSE]: 'channels.lifecycle',
  [method.CHANNELS_ACKNOWLEDGE]: 'channels.acknowledge',
  [method.CHANNELS_PUBLISH]: 'channels.publish',
};

/**
 * MCPL channel capabilities as §14.1 defines them — an object whose members are
 * the leaves of §6.2's vocabulary. The resolved @animalabs/mcpl-core 0.2.2 types
 * still declare `channels` as a bare boolean and `featureSets` as an array, so
 * the 0.5 shapes are declared locally and cast at the wire boundary.
 */
interface ChannelsCapability {
  register?: boolean;
  lifecycle?: boolean;
  publish?: boolean;
  incoming?: boolean;
  streaming?: boolean;
  acknowledge?: boolean;
  typing?: boolean;
}

/**
 * §14.5 — `channels/register` and `channels/changed` carry *arrays* of
 * descriptors and the host MUST authorize each independently, so the Request
 * form returns one entry per submitted descriptor. Not in the resolved core
 * types; declared here so the itemization can actually be read.
 */
interface ChannelRegistrationResults {
  results?: Array<{ id?: unknown; accepted?: unknown; reason?: unknown }>;
}

export class PortalMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  /**
   * What the host currently knows about each channel: id → content key
   * (descriptor minus open-state). Presence ⇒ the channel was advertised;
   * a differing key ⇒ the descriptor changed (rename, live capability edit)
   * and the host needs a channels/changed `updated` entry (issue #5).
   */
  private advertised = new Map<string, string>();
  /** Descriptors the host itemized as *rejected* (§14.5): id → the descriptor
   *  key it refused. Kept so re-registration does not hot-loop on a channel the
   *  host will keep refusing. A rejection is diagnostics (§6.6) — it narrows
   *  what we believe is registered and never re-grants anything; a changed
   *  descriptor is offered once more, because it is a different question. */
  private rejected = new Map<string, string>();
  /** Raw relay channel ids whose removal was observed but not yet retracted
   *  (a removal can land while channels/register is in flight, before
   *  `advertised` is stamped — retracting inline would silently miss it). */
  private pendingRemovals = new Set<string>();
  private initialRegistrationComplete = false;
  private registrationInFlight: Promise<void> | null = null;
  /** Portal channel ids the host has opened — routed via channels/incoming so
   *  ambient traffic folds into the open conversation; closed channels use
   *  push/event (which the host's wake gate evaluates). Mirrors discord-mcpl. */
  private openChannels = new Set<string>();
  /** Ping message ids already surfaced as a wake (live or catch-up), so a
   *  reconnect doesn't re-wake for the same offline-accrued pings. */
  private wokenPings = new Set<string>();
  private eventSeq = 0;
  /**
   * The connection's effective capability grant and derived feature sets
   * (§5.4/§6.4). Nothing capability-dependent runs until the host's initial
   * `featureSets/update` Request lands (§5.3) — `McplPolicy` denies everything
   * until then, and this object is the ONLY thing consulted for authorization.
   */
  private policy = new McplPolicy(featureSets);

  constructor(
    private client: PortalClient,
    private agent: PortalAgent,
  ) {}

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.advertised.clear();
    this.rejected.clear();
    this.pendingRemovals.clear();
    this.openChannels.clear();
    this.initialRegistrationComplete = false;
    this.registrationInFlight = null;
    this.policy.reset();
    for (const diagnostic of this.policy.declarationDiagnostics()) {
      console.error('[portal-mcpl] declaration problem:', diagnostic);
    }
    this.wireClient();
    await this.handleInitialize();
    // §5.3: no channels/register, no push, no anything until policy arrives.
    // `onPolicyActivated()` starts registration once the host has spoken.

    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request);
        else this.handleNotification(msg.notification);
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') {
        console.error('[portal-mcpl] connection error:', (err as Error).message);
      }
    }
    this.conn = null;
  }

  // ── Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      conn.close();
      return;
    }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;

    // §5.1: the advertisement mirrors the capability paths, leaf by leaf. Only
    // what this server actually implements is claimed — no `channels.streaming`
    // (no channels/outgoing/* handler) and no `channels.typing`.
    const serverCaps: Omit<McplCapabilities, 'channels'> & { channels: ChannelsCapability } = {
      version: '0.5',
      pushEvents: true,
      channels: {
        register: true,
        lifecycle: true,
        publish: true,
        incoming: true,
        acknowledge: true,
      },
      rollback: false,
      // §6.1 / App. B.2: keyed by name, not an array with a `name` member.
      featureSets: featureSets as unknown as McplCapabilities['featureSets'],
    };
    const capabilities: InitializeCapabilities = {
      // listChanged: the tool surface follows the enabled feature sets, so it
      // changes when policy lands or is narrowed (§6.4).
      tools: { listChanged: true },
      ...(this.mcplEnabled && { experimental: { mcpl: serverCaps as unknown as McplCapabilities } }),
    };
    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'portal-mcpl', version: '0.1.0' },
    };
    conn.sendResponse(msg.request.id, result);

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      console.error('[portal-mcpl] initialized' + (this.mcplEnabled ? ' (MCPL)' : ' (MCP)'));
    }
  }

  // ── Requests ──

  /**
   * Refuse anything the host did not grant, before the handler runs.
   *
   * Returns false when it has already answered with an error. §6.6: a method
   * that will never be answered MUST return an error, and the rejection is
   * diagnostics — it never re-opens anything.
   */
  private authorizeInbound(req: JsonRpcRequest): boolean {
    const conn = this.conn!;
    if (!this.mcplEnabled) return true; // plain MCP host: §3.2, MCPL never applies
    const required = INBOUND_CAPABILITY[req.method];
    if (required === undefined) return true;
    if (!this.policy.isReady) {
      conn.sendError(
        req.id,
        ERR_CAPABILITY_DENIED,
        `capability denied: ${required} — no featureSets/update policy received yet (SPEC §5.3)`,
      );
      return false;
    }
    if (!this.policy.allows(required)) {
      conn.sendError(req.id, ERR_CAPABILITY_DENIED, `capability denied: ${required}`);
      return false;
    }
    return true;
  }

  /** The tools whose owning feature set is currently enabled. Empty before the
   *  initial policy exchange (§5.3) — the surface is honest about being off. */
  private availableTools(): typeof this.agent.tools {
    if (!this.mcplEnabled) return this.agent.tools;
    if (!this.policy.allows('tools')) return [];
    return this.agent.tools.filter((tool) =>
      this.policy.featureEnabled(TOOL_FEATURE_SETS[tool.name] ?? ''),
    );
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    // Policy itself is never gated by policy.
    if (req.method === method.FEATURE_SETS_UPDATE) {
      this.handlePolicyRequest(req);
      return;
    }
    if (!this.authorizeInbound(req)) return;
    try {
      switch (req.method) {
        case 'tools/list':
          conn.sendResponse(req.id, { tools: this.availableTools() });
          break;
        case 'tools/call': {
          const toolName = params.name as string;
          // A tool with no declared feature set is unauthorizable, so it is
          // refused rather than defaulted on (§6.4 fails closed).
          const owningSet = TOOL_FEATURE_SETS[toolName];
          if (this.mcplEnabled && (owningSet === undefined || !this.policy.featureEnabled(owningSet))) {
            conn.sendError(
              req.id,
              owningSet === undefined ? ERR_CAPABILITY_DENIED : ERR_FEATURE_SET_NOT_ENABLED,
              owningSet === undefined
                ? `tool ${toolName} has no declared feature set`
                : `feature set not enabled: ${owningSet}`,
            );
            break;
          }
          const out = await this.agent.handleToolCall(
            toolName,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, { content: [textContent(stringify(out))] });
          break;
        }
        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = { channels: this.allDescriptors() };
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_OPEN: {
          const result = await this.handleChannelOpen(params as unknown as ChannelsOpenParams);
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_CLOSE: {
          const result = await this.handleChannelClose(params as unknown as ChannelsCloseParams);
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_ACKNOWLEDGE: {
          const result = await this.handleChannelAcknowledge(
            params as unknown as ChannelsAcknowledgeParams,
          );
          conn.sendResponse(req.id, result);
          break;
        }
        case method.CHANNELS_PUBLISH: {
          const pub = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pub);
          conn.sendResponse(req.id, result);
          break;
        }
        default:
          conn.sendError(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      // Tool errors come back as a tool result with isError, not a JSON-RPC error.
      if (req.method === 'tools/call') {
        conn.sendResponse(req.id, { content: [textContent(`Error: ${e.message}`)], isError: true });
      } else {
        conn.sendError(req.id, -32000, e.message);
      }
    }
  }

  /**
   * `featureSets/update` as a **Request** (§5.3 / §6.7): the host's effective
   * grant arrives, and the response is a degradation receipt.
   *
   * The receipt is consequence testimony only (§6.7): it names which declared
   * feature sets stopped working and what each was missing. It never asserts an
   * entitlement, and this server never refuses — a portal connector degrades
   * usefully (its tools and publish path are independent of its push path), so
   * `accepted: false` would be a coercion-shaped message with no honest content.
   */
  private handlePolicyRequest(req: JsonRpcRequest): void {
    const conn = this.conn!;
    try {
      const receipt = this.policy.applyRequest(req.params as FeatureSetsUpdateParams | undefined);
      conn.sendResponse(req.id, receipt);
      for (const note of receipt.notes) console.error('[portal-mcpl] policy note:', note);
      for (const gone of receipt.unavailableFeatures) {
        console.error(
          `[portal-mcpl] feature set disabled: ${gone.featureSet} (${gone.reason}` +
            `${gone.missingCapabilities ? `: ${gone.missingCapabilities.join(', ')}` : ''})`,
        );
      }
      // The tool surface follows the enabled sets, so the host must re-list.
      conn.sendNotification('notifications/tools/list_changed', {});
      this.onPolicyActivated();
    } catch (err) {
      // §5.4: a malformed policy message fails closed. `applyRequest` has
      // already dropped us back to "nothing granted"; say so and stop.
      const message = (err as Error).message;
      console.error('[portal-mcpl] policy rejected, all capabilities denied:', message);
      conn.sendError(
        req.id,
        err instanceof MalformedPolicyError ? ERR_INVALID_PARAMS : -32000,
        `malformed featureSets/update: ${message}`,
      );
    }
  }

  /**
   * Work that was held back waiting for a grant (§5.3), or newly permitted by an
   * expansion. §6.7's expansion ordering is the host's: it sends the Request and
   * waits for the receipt before it begins accepting newly granted traffic — so
   * this runs *after* `sendResponse`, never before. Both are idempotent
   * (`advertised` / `wokenPings`), so re-running on an unchanged policy is a
   * no-op rather than duplicate traffic.
   */
  private onPolicyActivated(): void {
    if (this.canRegister()) {
      void this.registerChannels().catch((err) =>
        console.error('[portal-mcpl] channel registration failed:', (err as Error).message),
      );
    }
    if (this.canPush()) {
      void this.catchUp().catch((err) =>
        console.error('[portal-mcpl] catch-up failed:', (err as Error).message),
      );
    }
  }

  private handleNotification(n: JsonRpcNotification): void {
    if (n.method === method.FEATURE_SETS_UPDATE) {
      // §6.7: a Notification may not alter the grant and cannot establish a
      // ready state. Reductions are applied; everything else is logged and
      // dropped, because honouring an expansion here would let the host widen
      // us on a path neither side has acknowledged.
      const diagnostics = this.policy.applyNotification(
        n.params as FeatureSetsUpdateParams | undefined,
      );
      for (const diagnostic of diagnostics) console.error('[portal-mcpl] policy:', diagnostic);
      if (diagnostics.length) this.conn?.sendNotification('notifications/tools/list_changed', {});
    }
  }

  private async handlePublish(pub: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const channelId = parsePortalChannelId(pub.channelId);
    if (!channelId) return { delivered: false };
    const text = pub.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Discord caps content at 2000 chars — split long prose into sequential
    // messages instead of letting the whole publish 400 and vanish.
    let firstId: string | undefined;
    for (const chunk of chunkText(text)) {
      const { messageId } = await this.client.sendMessage({ channelId, content: chunk });
      firstId ??= messageId;
    }
    return { delivered: true, messageId: firstId };
  }

  private async handleChannelOpen(open: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const exact = open.channelId ? parsePortalChannelId(open.channelId) : null;
    const addr = open.address as { channelId?: string } | undefined;
    const channelId = exact ?? addr?.channelId;
    const channel = channelId ? this.client.cache.getChannel(channelId) : undefined;
    if (!channelId || !channel) throw new Error('unknown channel');

    const result: ChannelsOpenResult = {
      channel: toDescriptor(channel, false),
    };
    const requested = open.history?.limit ?? 0;
    if (requested > 0) {
      const limit = Math.min(500, Math.max(0, Math.floor(requested)));
      const fetched = await this.client.fetchHistory({
        channelId,
        limit,
        ...(open.history?.beforeMessageId ? { before: open.history.beforeMessageId } : {}),
      });
      const messages = [...fetched.messages].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
      result.history = await Promise.all(messages.map(async (message) => ({
        channelId: portalChannelId(message.channelId),
        messageId: message.id,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        author: authorOf(message),
        timestamp: message.createdAt,
        content: await buildContent(message),
        metadata: { ...wakeMetadata(message, false, []), backscroll: true },
        tags: deriveTags(message, false, []),
      })));
      result.historyTruncated = requested > limit;
    }

    // Commit actual lifecycle only after requested history succeeds.
    await this.client.subscribe(channelId);
    this.openChannels.add(channelId);
    return result;
  }

  private async handleChannelClose(close: ChannelsCloseParams): Promise<ChannelsCloseResult> {
    const channelId = parsePortalChannelId(close.channelId);
    if (!channelId) throw new Error(`invalid Portal channel id: ${close.channelId}`);
    await this.client.unsubscribe(channelId);
    this.openChannels.delete(channelId);
    return { closed: true };
  }

  private async handleChannelAcknowledge(
    request: ChannelsAcknowledgeParams,
  ): Promise<ChannelsAcknowledgeResult> {
    if (!parsePortalChannelId(request.channelId)) {
      return { acknowledged: false, reason: `invalid Portal channel id: ${request.channelId}` };
    }
    const representation = request.value?.trim() || '👀';
    try {
      // A visible persona reaction is attributable to this agent. A native
      // reaction would be owned by the relay's shared Discord bot instead.
      await this.client.react(request.messageId, representation, true, false);
      return { acknowledged: true, representation };
    } catch (error) {
      return { acknowledged: false, reason: (error as Error).message };
    }
  }

  // ── Outbound authorization (§5.4; absence of a capability is denial) ──

  /** `push/event` carries a `featureSet` (§6.5), so it needs both the
   *  `pushEvents` grant and that set to be enabled. */
  private canPush(): boolean {
    return this.mcplEnabled && this.policy.allows('pushEvents') && this.policy.featureEnabled(MESSAGING);
  }

  /** `channels/incoming` carries no `featureSet`; §14.1 authorizes it on the
   *  grant alone. It is server→host content injection plus wake authority. */
  private canSendIncoming(): boolean {
    return this.mcplEnabled && this.policy.allows('channels.incoming');
  }

  /** `channels/register` and `channels/changed` (§14.1). */
  private canRegister(): boolean {
    return this.mcplEnabled && this.policy.allows('channels.register');
  }

  /**
   * §6.6: rejection is diagnostics, not authorization. A refused push tells us
   * the host would not take that message. It does not re-grant, re-enable or
   * re-negotiate anything, so nothing here touches `this.policy` and nothing
   * retries — the only correct response is to say so out loud.
   */
  private notePushRejection(what: string, err: unknown): void {
    const e = err as { code?: number; message?: string } | undefined;
    const code = typeof e?.code === 'number' ? ` (code ${e.code})` : '';
    console.error(`[portal-mcpl] host rejected ${what}${code}:`, e?.message ?? String(err));
  }

  // ── Client → host event forwarding ──

  private wireClient(): void {
    this.client.on('ready', () => {
      // Both of these are server→host sends on granted paths; a relay `ready`
      // arriving before (or after a reduction removes) the grant must not put
      // them on the wire (§5.3, §5.4). `registerChannels`/`catchUp` re-check as
      // well — they run from other triggers too.
      if (this.canRegister()) {
        void this.registerChannels().catch((err) =>
          console.error('[portal-mcpl] channel registration failed:', (err as Error).message),
        );
      }
      if (this.canPush()) {
        void this.catchUp().catch((err) =>
          console.error('[portal-mcpl] catch-up failed:', (err as Error).message),
        );
      }
    });
    this.client.on('resumed', () => {
      // A Portal transport resume restores event delivery but the relay session
      // starts with no ambient subscriptions. Reassert actual host-open state;
      // a fresh identify already receives the client's mutable replay set.
      for (const channelId of this.openChannels) {
        void this.client.subscribe(channelId).catch((err) =>
          console.error(
            `[portal-mcpl] failed to restore open channel ${channelId}:`,
            (err as Error).message,
          ),
        );
      }
    });
    this.client.on('message', (e) => {
      // Self-echo filter: the relay dispatches the persona's OWN webhook posts
      // back to it like any other channel message. Re-ingesting them is pure
      // noise — the send tool already returned the messageId, and with
      // hear-while-acting (agent-framework ≥0.6.5) each echo would be
      // re-injected INTO the live turn as an incoming message, so a narrating
      // agent hears itself quoted back every round.
      if (authorOf(e.message).id === this.client.personaId) return;
      if (e.addressedToMe) this.wokenPings.add(e.message.id); // live wake covers it
      this.pushMessage(e.message, e.addressedToMe, e.reasons);
    });
    // Live reactions → context, NEVER a wake. Only *native* (human/bot)
    // reactions are surfaced: the relay dispatches a persona's own *pseudo*
    // reaction back only to that persona, so skipping pseudo avoids echoing the
    // agent's own reactions. An open channel receives reaction context; a
    // closed channel does not. This is the same lifecycle boundary as messages.
    this.client.on('reactionAdd', (e) => {
      if (e.reaction.kind === 'pseudo') return;
      this.pushReaction('add', e.channelId, e.messageId, e.reaction.emoji, e.reaction.by[0]?.name ?? 'someone', e.messageSnippet);
    });
    this.client.on('reactionRemove', (e) => {
      if (e.actor.kind === 'persona') return;
      this.pushReaction('remove', e.channelId, e.messageId, e.emoji, e.actor.name, e.messageSnippet);
    });
    this.client.on('messageDelete', (e) => {
      if (!this.conn || !this.canPush()) return;
      // Only surface deletions for channels the host actually has open — a delete
      // in a channel the agent isn't following is zero-signal context noise.
      // (The relay also gates deletes by subscription; this is belt-and-braces.)
      if (!this.openChannels.has(e.channelId)) return;
      this.conn
        .sendRequest(method.PUSH_EVENT, {
          featureSet: MESSAGING,
          eventId: `portal_del_${e.messageId}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'portal',
            channelId: portalChannelId(e.channelId),
            mcplChannelId: portalChannelId(e.channelId),
          },
          tags: ['chat:deleted'],
          payload: { content: [textContent(`[message deleted] ${e.messageId}`)] },
        } satisfies PushEventParams)
        .catch((err) => this.notePushRejection('message delete', err));
    });
    this.client.on('channelChange', (channel) => {
      if (!this.conn || !this.canRegister()) return;
      void this.registerChannels().catch((err) =>
        console.error('[portal-mcpl] channel registration failed:', (err as Error).message),
      );
    });
    this.client.on('channelRemove', ({ channelId }) => {
      if (!this.conn || !this.canRegister()) return;
      // Queue rather than retract inline: a removal landing while
      // channels/register is in flight finds `advertised` still unstamped, and
      // the ack would then stamp the dead channel in from its stale descriptor
      // snapshot — durably registering a channel that no longer exists.
      this.pendingRemovals.add(channelId);
      void this.flushRemovals().catch((err) =>
        console.error('[portal-mcpl] channel retraction failed:', (err as Error).message),
      );
    });
  }

  /**
   * Forward an inbound message to the host with discord-mcpl-parity addressing
   * metadata so the host's wake gate fires the same way: an *open* channel uses
   * channels/incoming (ambient folds into the conversation); a closed channel
   * uses push/event (the gate decides whether to wake). The wake flags
   * (isMention/isExplicitMention/isReplyToBot/isBot/isDM) are derived from the
   * relay's per-persona AddressInfo — no client-side guessing.
   */
  private pushMessage(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    if (!this.conn) return;
    // The two branches ride different capabilities (§14.1), so each is checked
    // against the one it actually uses — and re-checked after the async content
    // build, because a reduction MUST take effect immediately (§6.7) and the
    // grant that matters is the one current when the message goes out (§5.4).
    const open = this.openChannels.has(message.channelId);
    if (open ? !this.canSendIncoming() : !this.canPush()) return;
    const conn = this.conn;
    const meta = wakeMetadata(message, addressedToMe, reasons);
    const tags = deriveTags(message, addressedToMe, reasons);
    const channelMcplId = portalChannelId(message.channelId);
    void buildContent(message).then((content) => {
      if (this.conn !== conn) return;
      if (this.openChannels.has(message.channelId)) {
        if (!this.canSendIncoming()) return;
        conn
          .sendRequest(method.CHANNELS_INCOMING, {
            messages: [
              {
                channelId: channelMcplId,
                messageId: message.id,
                threadId: message.threadId,
                author: authorOf(message),
                timestamp: message.createdAt,
                content,
                metadata: meta,
                tags,
              },
            ],
          } satisfies ChannelsIncomingParams)
          .catch((err) => this.notePushRejection('inbound message', err));
      } else {
        if (!this.canPush()) return;
        conn
          .sendRequest(method.PUSH_EVENT, {
            featureSet: MESSAGING,
            eventId: `portal_msg_${message.id}_${this.eventSeq++}`,
            timestamp: message.createdAt,
            // Flat on origin (discord-mcpl parity) — the wake gate reads these.
            origin: {
              source: 'portal',
              messageId: message.id,
              channelId: channelMcplId,
              mcplChannelId: channelMcplId,
              channelName: this.channelLabel(message.channelId),
              guildId: message.guildId,
              threadId: message.threadId,
              authorId: authorOf(message).id,
              authorName: authorOf(message).name,
              ...meta,
            },
            tags, // MCPL RFC-001 — the host routes/gates on these
            payload: { content },
          } satisfies PushEventParams)
          .catch((err) => this.notePushRejection('message push', err));
      }
    });
  }

  /**
   * Surface a live reaction into the agent's context WITHOUT waking it. Gated by
   * whether the host has the channel open. The push
   * carries the `chat:reaction` tag and an origin with NO wake flags
   * (isMention/isExplicitMention/addressed absent) — the host's wake gate matches
   * nothing, so the event is addMessage()'d into context but triggers no
   * inference. Mirrors discord-mcpl's non-waking reaction path.
   */
  private pushReaction(
    action: 'add' | 'remove',
    channelId: string,
    messageId: string,
    emoji: string,
    reactorName: string,
    messageSnippet?: string,
  ): void {
    if (!this.conn || !this.canPush()) return;
    if (!this.openChannels.has(channelId)) return;
    const verb = action === 'add' ? 'reacted' : 'removed a reaction';
    const shown = renderReactionEmoji(emoji);
    // Carry a snippet of the reacted-to message when it has text — a bare
    // message id is meaningless to the agent (it can't look messages up).
    const quoted = messageSnippet ? ` — "${messageSnippet}"` : '';
    const line = `[reaction] @${reactorName} ${verb} ${shown} on message ${messageId} in ${this.channelLabel(channelId)}${quoted}`;
    this.conn
      .sendRequest(method.PUSH_EVENT, {
        featureSet: MESSAGING,
        eventId: `portal_reaction_${action}_${messageId}_${emoji}_${reactorName}_${this.eventSeq++}`,
        timestamp: new Date().toISOString(),
        // Deliberately NO wake flags on origin — reactions must never wake.
        origin: {
          source: 'portal',
          channelId: portalChannelId(channelId),
          mcplChannelId: portalChannelId(channelId),
          messageId,
          reactor: reactorName,
          emoji: shown,
          action,
        },
        // §16.2: `chat:reaction-remove` is a DISTINCT tag. Emitting
        // `chat:reaction` for a removal makes "wake on reactions to my
        // messages" fire on un-reactions. Either way this push carries no wake
        // flags, so it is shown, not woken.
        tags: [action === 'add' ? 'chat:reaction' : 'chat:reaction-remove'],
        payload: { content: [textContent(line)] },
      } satisfies PushEventParams)
      .catch((err) => this.notePushRejection(`reaction ${action}`, err));
  }

  /** On (re)connect, wake once for pings the relay accrued while we were away.
   *  Server-authoritative — an O(missed) read, no Discord history scan. */
  private async catchUp(): Promise<void> {
    if (!this.conn || !this.canPush()) return;
    const conn = this.conn;
    let pings: PendingPing[];
    try {
      pings = await this.agent.pendingPingsFromRelay();
    } catch {
      return; // relay not ready yet; a later ready will retry
    }
    // Re-check after the await: `pendingPingsFromRelay()` is a round trip, and a
    // reduction landing inside it MUST be respected immediately (§6.7). The
    // watermark below is consumed, so this has to happen before it moves.
    if (this.conn !== conn || !this.canPush()) return;
    const fresh = pings.filter((p) => !this.wokenPings.has(p.message.id));
    if (fresh.length === 0) return;
    for (const p of fresh) this.wokenPings.add(p.message.id);
    fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const lines = [`[catch-up] ${fresh.length} message(s) addressed to you while you were away:`];
    for (const p of fresh) {
      lines.push(`— ${this.channelLabel(p.message.channelId)}: ${render(p.message)}`);
    }
    lines.push('[use fetch_history / fetch_around for context, then mark_read]');
    const latest = fresh[fresh.length - 1].message;
    conn
      .sendRequest(method.PUSH_EVENT, {
        featureSet: MESSAGING,
        eventId: `portal_catchup_${latest.id}_${this.eventSeq++}`,
        timestamp: latest.createdAt,
        // isExplicitMention=true so the host's wake gate surfaces the catch-up.
        origin: {
          source: 'portal',
          channelId: portalChannelId(latest.channelId),
          mcplChannelId: portalChannelId(latest.channelId),
          messageId: latest.id,
          isMention: true,
          isExplicitMention: true,
          isReplyToBot: false,
          isBot: false,
          isDM: false,
          catchup: true,
        },
        tags: ['chat:addressed', 'chat:mention'],
        payload: { content: [textContent(lines.join('\n'))] },
      } satisfies PushEventParams)
      .catch((err) => this.notePushRejection('catch-up push', err));
  }

  private channelLabel(channelId: string): string {
    const name = this.client.cache.getChannel(channelId)?.name;
    return name ? `#${name}` : channelId;
  }

  // ── Channels ──

  private allDescriptors(): ChannelDescriptor[] {
    return this.client.cache
      .allChannels()
      .map((channel) => toDescriptor(channel, this.agent.state.isSubscribed(channel.id)));
  }

  /** Drop the legacy file-backed subscription for each channel that has now
   *  been advertised to the host (as an initiallyOpen bootstrap). Selective on
   *  purpose: only an advertised channel's bootstrap job is done. */
  private retireAdvertisedSubscriptions(descriptors: ChannelDescriptor[]): void {
    for (const descriptor of descriptors) {
      const relayId = parsePortalChannelId(descriptor.id);
      if (relayId) this.agent.state.unsubscribe(relayId);
    }
  }

  private registerChannels(): Promise<void> {
    if (this.registrationInFlight) return this.registrationInFlight;

    const run = async (): Promise<void> => {
      const conn = this.conn;
      // §14.1: `channels/register` and `channels/changed` both require
      // `channels.register`. Absence of the capability is denial (§5.4), so this
      // whole path stays off until the grant names it.
      if (!conn || !this.canRegister()) return;
      const descriptors = this.allDescriptors();

      // The first complete enumeration is a request so the host can durably
      // reconcile it before we retire the legacy file-backed subscriptions.
      if (!this.initialRegistrationComplete) {
        if (descriptors.length === 0) return;
        const params: ChannelsRegisterParams = { channels: descriptors };
        const result = await conn.sendRequest(method.CHANNELS_REGISTER, params);
        if (this.conn !== conn || !this.canRegister()) return;
        // §14.5: the Request form returns one entry per submitted descriptor,
        // because the host authorizes each independently. Believing a rejected
        // descriptor is registered is exactly the disagreement §14.5 forbids —
        // and it would retire that channel's local subscription for nothing.
        const { accepted } = this.applyRegistrationResults(descriptors, result);
        for (const descriptor of accepted) {
          this.advertised.set(descriptor.id, descriptorKey(descriptor));
        }
        this.initialRegistrationComplete = true;
        // Retire ONLY the subscriptions that were actually advertised in the
        // acked register (their initiallyOpen has been durably reconciled by
        // the host). A blanket clearSubscriptions() here permanently
        // destroyed any subscription whose channel missed the enumeration
        // (partial relay cache, stale build, transport hiccup) — the exact
        // "every bot loses its subscriptions on migration" failure mode.
        // Anything not yet advertised survives for a later register/changed
        // cycle, mirroring discord-mcpl's keep-the-bootstrap-hint approach.
        this.retireAdvertisedSubscriptions(accepted);
        return;
      }

      const added = descriptors.filter(
        (descriptor) =>
          !this.advertised.has(descriptor.id) &&
          // A descriptor the host already itemized as rejected is not re-offered
          // unchanged; re-asking every cycle is a hot loop, not enforcement.
          this.rejected.get(descriptor.id) !== descriptorKey(descriptor),
      );
      // A known channel whose descriptor content drifted (rename, live rights
      // change → new caps in metadata) refreshes the host registry in place.
      const updated = descriptors.filter((descriptor) => {
        const known = this.advertised.get(descriptor.id);
        return known !== undefined && known !== descriptorKey(descriptor);
      });
      if (added.length === 0 && updated.length === 0) return;
      for (const descriptor of [...added, ...updated]) {
        this.advertised.set(descriptor.id, descriptorKey(descriptor));
      }
      const changed: ChannelsChangedParams = {};
      if (added.length) changed.added = added;
      if (updated.length) changed.updated = updated;
      conn.sendNotification(method.CHANNELS_CHANGED, changed);
      // Late-arriving channels carried initiallyOpen too — retire their
      // subscriptions once announced (the host bootstraps their desired
      // state from the changed notification).
      this.retireAdvertisedSubscriptions(added);
    };

    this.registrationInFlight = run().finally(() => {
      this.registrationInFlight = null;
      if (this.initialRegistrationComplete && this.hasUnadvertisedWork()) {
        void this.registerChannels().catch((err) =>
          console.error('[portal-mcpl] channel registration failed:', (err as Error).message),
        );
      }
    });
    return this.registrationInFlight;
  }

  /** Any cached channel the host hasn't seen (or has seen with a stale
   *  descriptor)? Used to re-arm registration after an in-flight cycle. A
   *  descriptor the host itemized as rejected (§14.5) is not "work": re-arming
   *  on it would spin. */
  private hasUnadvertisedWork(): boolean {
    return this.allDescriptors().some((descriptor) => {
      const key = descriptorKey(descriptor);
      return this.advertised.get(descriptor.id) !== key && this.rejected.get(descriptor.id) !== key;
    });
  }

  /**
   * Split a `channels/register` (or `channels/changed`) Request result into the
   * descriptors the host accepted and those it refused, per §14.5's itemization.
   *
   * Fail-closed on a present-but-partial `results` array: a descriptor with no
   * entry is treated as NOT accepted, because §14.5 requires one entry per
   * submitted descriptor and a missing verdict is not a verdict. A result with
   * no `results` member at all is a host that predates the itemization; there is
   * nothing to read, so the submission stands as before. Either way this only
   * narrows what *we* believe — the host is the authorizer and a rejection here
   * grants nothing (§6.6).
   */
  private applyRegistrationResults(
    submitted: ChannelDescriptor[],
    result: unknown,
  ): { accepted: ChannelDescriptor[] } {
    const results = (result as ChannelRegistrationResults | undefined)?.results;
    if (!Array.isArray(results)) return { accepted: submitted };
    const verdict = new Map<string, { accepted?: unknown; reason?: unknown }>();
    for (const entry of results) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        verdict.set(entry.id, entry);
      }
    }
    const accepted: ChannelDescriptor[] = [];
    for (const descriptor of submitted) {
      const entry = verdict.get(descriptor.id);
      if (entry?.accepted === true) {
        accepted.push(descriptor);
        this.rejected.delete(descriptor.id);
        continue;
      }
      this.rejected.set(descriptor.id, descriptorKey(descriptor));
      this.advertised.delete(descriptor.id);
      console.error(
        `[portal-mcpl] host did not register channel ${descriptor.id}` +
          (typeof entry?.reason === 'string' ? `: ${entry.reason}` : entry ? '' : ' (no verdict returned)'),
      );
    }
    return { accepted };
  }

  /**
   * Retract queued removals once no registration is in flight. Only ids that
   * were BOTH observed via a channelRemove event AND actually advertised are
   * retracted — never anything derived by diffing an enumeration against
   * `advertised` (a partial enumeration must not be able to mass-retract
   * channels: the "every bot loses its subscriptions on migration" failure
   * mode). A queued id that was never advertised (created and deleted within
   * one registration window) drops silently — correct, the host never saw it.
   */
  private async flushRemovals(): Promise<void> {
    while (this.registrationInFlight) await this.registrationInFlight;
    const conn = this.conn;
    // `channels/changed` requires `channels.register` (§14.1).
    if (!conn || !this.canRegister() || this.pendingRemovals.size === 0) return;
    const removed: string[] = [];
    for (const channelId of this.pendingRemovals) {
      const id = portalChannelId(channelId);
      this.rejected.delete(id); // the channel is gone; nothing left to re-offer
      if (!this.advertised.delete(id)) continue;
      removed.push(id);
      this.openChannels.delete(channelId); // openChannels holds RAW relay ids
      this.agent.state.unsubscribe(channelId);
    }
    this.pendingRemovals.clear();
    if (removed.length) {
      conn.sendNotification(method.CHANNELS_CHANGED, { removed } satisfies ChannelsChangedParams);
    }
  }
}

/** Content identity of a descriptor for change detection. Open-state hints
 *  (initiallyOpen) are excluded: they're a one-shot bootstrap consumed by the
 *  host, not channel content — retiring a legacy subscription must not read
 *  as "channel changed". */
function descriptorKey(descriptor: ReturnType<typeof toDescriptor>): string {
  const { initiallyOpen: _open, ...content } = descriptor;
  return JSON.stringify(content);
}

/** discord-mcpl-parity wake flags, derived from the relay's AddressInfo. The
 *  host's gate matches `metadataTrue` (any-of) against these. */
function wakeMetadata(
  message: PortalMessage,
  addressedToMe: boolean,
  reasons: AddressReason[],
): Record<string, unknown> {
  const isExplicitMention = reasons.includes('role_mention') || reasons.includes('name_mention');
  const isReplyToBot = reasons.includes('reply');
  const isDM = message.guildId === null || reasons.includes('dm');
  const isMention = isExplicitMention || isReplyToBot;
  // A persona author is one of our agents (posted via webhook → bot-like); a
  // user author may be a real bot. Matches discord-mcpl's isBot semantics so the
  // host's bot-skip policy behaves identically.
  const isBot =
    message.author.kind === 'persona' || (message.author.kind === 'user' && message.author.bot);
  return {
    addressed: addressedToMe,
    // An array, not `reasons.join(',')`. The comma-joined form matched nothing
    // in the spec and forced any host that wanted a reason to re-split a string.
    reasons: [...reasons],
    isMention,
    isExplicitMention,
    isReplyToBot,
    isBot,
    isDM,
  };
}

/**
 * MCPL RFC-001 event tags for a portal message. Emits the reserved `chat:*` core
 * (including umbrellas like `chat:addressed`, so no host-side implication
 * expansion is required) plus the `portal:*` namespace. Derived from the relay's
 * per-persona AddressInfo — authoritative, no guessing.
 */
function deriveTags(
  message: PortalMessage,
  addressedToMe: boolean,
  reasons: AddressReason[],
): string[] {
  const t = new Set<string>();
  const mention = reasons.includes('role_mention') || reasons.includes('name_mention');
  const reply = reasons.includes('reply');
  const dm = message.guildId === null || reasons.includes('dm');
  if (mention) t.add('chat:mention');
  if (reply) t.add('chat:reply');
  if (dm) {
    t.add('chat:dm');
    t.add('chat:private'); // §16.3: chat:dm ⇒ chat:addressed, chat:private
  }
  // §16.3: `chat:mention`/`chat:reply`/`chat:dm` all imply `chat:addressed`, and
  // "producers SHOULD NOT emit chat:ambient alongside anything implying
  // chat:addressed". A relay that reports a mention but not `addressedToMe`
  // previously produced both, which is not interpretable by a first-match-wins
  // rule list — the outcome would depend on rule ordering, not on the event.
  if (addressedToMe || mention || reply || dm) t.add('chat:addressed');
  else t.add('chat:ambient');
  // sender
  if (message.author.kind === 'persona') {
    t.add('chat:from-agent');
    t.add('portal:persona');
  } else if (message.author.kind === 'user') {
    t.add(message.author.bot ? 'chat:from-bot' : 'chat:from-human');
  }
  // content modality
  for (const a of message.attachments ?? []) {
    const ct = (a.contentType ?? '').toLowerCase();
    if (ct.startsWith('image/')) t.add('chat:has-image');
    else if (ct.startsWith('audio/')) t.add('chat:has-audio');
    else t.add('chat:has-file');
  }
  if (message.threadId) t.add('chat:thread');
  // portal namespace specifics
  if (reasons.includes('role_mention')) t.add('portal:role-mention');
  if (reasons.includes('name_mention')) t.add('portal:name-mention');
  if (reasons.includes('subscription')) t.add('portal:subscription');
  return [...t];
}

/** Host-facing author {id, name} for channels/incoming. */
function authorOf(message: PortalMessage): { id: string; name: string } {
  const a = message.author;
  if (a.kind === 'persona') return { id: a.personaId, name: a.displayName };
  if (a.kind === 'user') return { id: a.userId, name: a.displayName || a.username };
  return { id: 'system', name: 'system' };
}

/** Max image bytes to fetch + inline as a vision block. */
const IMAGE_INLINE_CAP = 5 * 1024 * 1024;

/** Build MCPL content blocks for a message: the text line, plus inlined image
 *  attachments (so the agent can actually see them) and notes for the rest.
 *  Best-effort — a failed fetch degrades to a text note, never drops the msg. */
async function buildContent(m: PortalMessage): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [textContent(render(m))];
  for (const att of m.attachments) {
    const ct = (att.contentType ?? '').toLowerCase();
    if (ct.startsWith('image/') && att.size > 0 && att.size <= IMAGE_INLINE_CAP) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(att.url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer()).toString('base64');
        blocks.push({ type: 'image', data, mimeType: ct });
      } catch (err) {
        blocks.push(textContent(`[image "${att.name}" unavailable: ${(err as Error).message} — ${att.url}]`));
      }
    } else if (m.attachments.length) {
      blocks.push(textContent(`[attachment "${att.name}" (${att.contentType ?? 'unknown'}, ${att.size}B) — ${att.url}]`));
    }
  }
  return blocks;
}

function render(m: PortalMessage): string {
  const who =
    m.author.kind === 'persona'
      ? m.author.displayName
      : m.author.kind === 'user'
        ? m.author.displayName
        : 'system';
  const body = m.cleanContent || m.content || '';
  const atts = m.attachments.length ? ` [${m.attachments.length} attachment(s)]` : '';
  return `${who}: ${body}${atts}`;
}

/** Render a reaction emoji legibly: a custom `name:id` becomes `:name:`; unicode
 *  passes through. (The relay encodes customs as `name:id` on the wire.) */
function renderReactionEmoji(emoji: string): string {
  const m = /^(\w+):\d+$/.exec(emoji);
  return m ? `:${m[1]}:` : emoji;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
