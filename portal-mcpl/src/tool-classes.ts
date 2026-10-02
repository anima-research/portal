/**
 * Tool classes for the portal MCPL surface — MCPL RFC-008
 * (https://github.com/anima-research/mcpl/blob/main/RFC-008-tool-classes.md).
 *
 * Each tool definition served by tools/list carries `_meta: {"mcpl/class": [...]}`
 * naming what the tool does, from RFC-008's fixed vocabulary. The class is a
 * hint, not a grant: it changes nothing the agent may call or the server may do.
 * Hosts use it as a policy key — e.g. what an RFC-007 tool-lifecycle observer
 * may see of a call.
 *
 * THE COMMS RULE. Any tool that sends to, or reads, other people's messages —
 * posting, editing, reacting, fetching history, pings, unread previews, voice
 * to or from a person — MUST include `comms`. Hosts never share `comms`
 * arguments with observers; tagging such a tool as anything else (`control`,
 * `body`, …) alone would let a host expose one side of a private conversation.
 * When in doubt, add `comms`: a host applies the union of restrictions across
 * every class named, so extra classes only make handling stricter.
 *
 * UNCLASSED. A tool with no `mcpl/class` key is treated by hosts as the most
 * restrictive class for every question, so leaving a tool out is always safe.
 * Every tool must appear in exactly one of `TOOL_CLASSES` or `UNCLASSED`
 * (enforced by test), so an unclassed tool is a decision, not an oversight.
 */

/** RFC-008 §4 / SPEC Appendix B.4. New classes come by amendment, never here. */
export const TOOL_CLASS_VOCABULARY = [
  'comms',
  'memory',
  'notes',
  'files',
  'shell',
  'web',
  'computer',
  'media',
  'body',
  'control',
] as const;

export type ToolClass = (typeof TOOL_CLASS_VOCABULARY)[number];

/** RFC-008 §3: the `_meta` key. The `mcpl/` prefix is reserved for MCPL. */
export const TOOL_CLASS_META_KEY = 'mcpl/class';

export const TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  // Messages to and from people, and the directory used to address them.
  send_message: ['comms'],
  edit_message: ['comms'],
  delete_message: ['comms'],
  react: ['comms'],
  unreact: ['comms'],
  create_thread: ['comms'],
  fetch_history: ['comms'],
  fetch_around: ['comms'],
  list_pins: ['comms'],
  get_pending_pings: ['comms'],
  list_unread: ['comms'],
  list_members: ['comms'],
  resolve_mentions: ['comms'],
  list_roles: ['comms'],
  list_guilds: ['comms'],
  list_channels: ['comms'],
  list_emojis: ['comms'],
  voice_join: ['comms'],
  voice_speak: ['comms'],

  // Lifecycle/read-state changes that also touch a conversation.
  voice_leave: ['comms', 'control'],
  channel_missed: ['comms', 'control'],

  // Read-state and delivery settings; no message content in or out.
  mark_read: ['control'],
  subscribe_channel: ['control'],
  unsubscribe_channel: ['control'],
  list_subscriptions: ['control'],
  set_reaction_visibility: ['control'],
};

/** Tools deliberately served without a class (hosts treat them most strictly). */
export const UNCLASSED: ReadonlySet<string> = new Set<string>();

/**
 * Merge the tool's RFC-008 class into its `_meta`, keeping every existing key
 * (e.g. `featureSet`). Unclassed tools are returned unchanged — no key at all.
 * Never mutates the input.
 */
export function withToolClass<T extends { name: string; _meta?: Record<string, unknown> }>(tool: T): T {
  const classes = TOOL_CLASSES[tool.name];
  if (!classes || classes.length === 0) return tool;
  return { ...tool, _meta: { ...tool._meta, [TOOL_CLASS_META_KEY]: [...classes] } };
}
