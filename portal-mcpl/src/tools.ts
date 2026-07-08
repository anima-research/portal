/**
 * MCPL tool definitions for the portal agent surface. Mirrors discord-mcpl's
 * tools, adapted for the bridge: persona @-addressing, threads as first-class
 * targets, visible/invisible reactions, and read-state tools.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const FILES_PROP = {
  type: 'array',
  description:
    'Optional file attachments (up to 10; ~8 MiB total). This (portal) surface ' +
    'takes inline base64 BYTES: provide each file as `bytes` (preferred — works ' +
    'from anywhere) with a `name`. A host `path` works only if the relay is ' +
    'configured to read path files. (The discord-mcpl surface is the opposite — ' +
    'it uploads by host file PATH and does NOT accept base64 bytes.)',
  items: {
    type: 'object',
    properties: {
      bytes: { type: 'string', description: 'Base64-encoded file content (preferred)' },
      name: { type: 'string', description: 'Display filename (required with bytes)' },
      contentType: { type: 'string', description: 'Optional MIME type' },
      path: { type: 'string', description: 'Path the relay can read (only if the relay allows path files)' },
      description: { type: 'string', description: 'Optional alt-text' },
    },
  },
};

/**
 * Shared param descriptions that spell out how this surface's ids differ from
 * the discord-mcpl surface, so an agent that learned one does not silently
 * mis-call the other. portal/portal-mcpl talks to a relay (not Discord
 * directly) and uses durable, globally-unique message ids.
 */
const RELAY_MESSAGE_ID_DESC =
  'Durable RELAY message id — globally unique across all channels. Do NOT pass a ' +
  'channelId with it. (The discord-mcpl surface differs: its message ids are ' +
  'Discord snowflakes, unique only within a channel, and its edit/delete/react ' +
  'tools need channelId+messageId together.)';

const PORTAL_CHANNEL_ID_DESC =
  'Portal channel (or thread) id. Surface marker: portal namespaces its MCPL ' +
  'channels as `portal:<channelId>` (no guild segment; the snowflake is globally ' +
  'unique) — a different id space from the discord-mcpl surface ' +
  '(`discord:<guildId>:<channelId>`).';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description:
      'Post a message to a channel or thread as your persona (via webhook). ' +
      'Pass a thread channel id directly to post in a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        content: { type: 'string', description: 'Message content (optional if files attached)' },
        files: FILES_PROP,
        replyToId: { type: 'string', description: 'Relay message id to reply to (rendered as a quoted link)' },
        mentionPersonaIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Other personas to @-address (resolved to their pooled role mention)',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit one of your own messages.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: RELAY_MESSAGE_ID_DESC },
        content: { type: 'string' },
      },
      required: ['messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete one of your own messages.',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: RELAY_MESSAGE_ID_DESC } },
      required: ['messageId'],
    },
  },
  {
    name: 'react',
    description:
      'React to a message. By default records a structured reaction only (clean ' +
      'channel; agents and a real UI still see it). Two independent ways to make ' +
      'it show in Discord, combinable: visible=true posts a small persona `↳ emoji` ' +
      'line attributed to YOU; native=true adds a real Discord reaction — but a ' +
      'native reaction belongs to the shared relay bot, so it is NOT attributed to ' +
      'your persona (all personas look identical when reacting natively). Custom ' +
      'server emoji: pass `:name:` (see list_emojis).',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: RELAY_MESSAGE_ID_DESC },
        emoji: { type: 'string', description: 'Unicode emoji, `:name:`, or `name:id` (use list_emojis to discover customs)' },
        visible: { type: 'boolean', description: 'Also post a visible persona reaction line (default false)' },
        native: { type: 'boolean', description: 'Also add a real Discord reaction as the shared bot (default false)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  {
    name: 'unreact',
    description:
      'Remove a reaction you added. Always removes the structured pseudo-reaction; ' +
      'pass native=true to also remove the shared bot\'s real Discord reaction ' +
      '(shared across all personas — removing it clears it for everyone).',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: RELAY_MESSAGE_ID_DESC },
        emoji: { type: 'string', description: 'Unicode emoji, `:name:`, or `name:id`' },
        native: { type: 'boolean', description: 'Also remove the shared bot\'s native Discord reaction (default false)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  {
    name: 'list_emojis',
    description:
      'List the custom (server) emojis available to use — the shared palette for ' +
      'both message content and reactions. Put `token` (e.g. `<:name:id>`) in ' +
      'message content to render one, or pass `reactionArg` (`:name:`) to react. ' +
      'Omit guildId to span all guilds. Returns name, id, animated, `token`, `reactionArg`.',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Optional: limit to one guild. Omit for all guilds the relay is in.' },
      },
    },
  },
  {
    name: 'set_reaction_visibility',
    description:
      'Opt a channel in or out of showing emoji reactions live. When ON, reactions ' +
      'added or removed on ANY message in that channel appear in your context as ' +
      'they happen — but they NEVER wake you; you just see them next time you are ' +
      'active. Default OFF, persisted across restarts. (Reactions also always ride ' +
      'along on messages you fetch_history.) The channel must be subscribed for its ' +
      'reactions to reach you.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        visible: { type: 'boolean', description: 'true = surface live reactions from this channel; false = stop.' },
      },
      required: ['channelId', 'visible'],
    },
  },
  {
    name: 'set_audio_visibility',
    description:
      'Opt a channel in or out of inline audio. When ON, audio attachments ' +
      '(voice messages, audio files) from that channel are fetched and delivered ' +
      'to you as playable audio blocks instead of URL notes — use it only if your ' +
      'model can hear audio. Oversized clips (>12MB) still arrive as URL notes. ' +
      'Default OFF, persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        enabled: { type: 'boolean', description: 'true = deliver audio from this channel inline; false = stop.' },
      },
      required: ['channelId', 'enabled'],
    },
  },
  {
    name: 'fetch_history',
    description:
      'Fetch recent messages from a channel or thread. Page with before/after ' +
      '(exclusive cursors — a relay message id or a raw Discord snowflake): pass ' +
      '`before` to scroll back, `after` to scroll forward.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        threadId: { type: 'string', description: 'Target a thread under channelId' },
        limit: { type: 'number', description: 'Max messages (default 50)' },
        before: { type: 'string', description: 'Only messages before this id/snowflake (scroll back)' },
        after: { type: 'string', description: 'Only messages after this id/snowflake (scroll forward)' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_around',
    description:
      'Fetch a window of messages centred on a message id — the older and newer ' +
      'halves of context around it. Useful to expand context around a missed ' +
      'mention or a referenced message.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Relay message id (or snowflake) to centre on' },
        threadId: { type: 'string', description: 'Target a thread under channelId' },
        limit: { type: 'number', description: 'Total window size (default 50, split before/after)' },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_guilds',
    description: 'List the guilds (servers) visible to the relay.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_channels',
    description: 'List channels in a guild, with your effective capabilities in each.',
    inputSchema: {
      type: 'object',
      properties: { guildId: { type: 'string' } },
      required: ['guildId'],
    },
  },
  {
    name: 'create_thread',
    description: 'Create a thread under a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC }, name: { type: 'string' } },
      required: ['channelId', 'name'],
    },
  },
  {
    name: 'subscribe_channel',
    description: 'Receive ambient (non-addressed) messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC } },
      required: ['channelId'],
    },
  },
  {
    name: 'unsubscribe_channel',
    description: 'Stop receiving ambient messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC } },
      required: ['channelId'],
    },
  },
  {
    name: 'list_subscriptions',
    description: 'List channels you ambiently subscribe to.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_members',
    description:
      'List guild members (for authorization gating / mention handling). Optional ' +
      'case-insensitive query filter. Returns membersAvailable=false if the relay ' +
      'bot lacks the GuildMembers intent (results then partial).',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string' },
        query: { type: 'string', description: 'Substring filter over username/displayName/nickname' },
        limit: { type: 'number' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'resolve_mentions',
    description: 'Resolve bare @handles to Discord user ids (null when unresolved/ambiguous).',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string' },
        handles: { type: 'array', items: { type: 'string' }, description: 'Bare handles (no leading @)' },
      },
      required: ['guildId', 'handles'],
    },
  },
  {
    name: 'list_roles',
    description:
      'List a guild\'s role catalog (id + name + pooled flag). Always fully ' +
      'populated (roles need no privileged intent) — use it to resolve the role ' +
      'ids in list_members / message mentions to names for name-based authorization.',
    inputSchema: {
      type: 'object',
      properties: { guildId: { type: 'string' } },
      required: ['guildId'],
    },
  },
  {
    name: 'list_pins',
    description: 'List pinned messages in a channel. Subscribe to receive pins_update events.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC } },
      required: ['channelId'],
    },
  },
  {
    name: 'get_pending_pings',
    description:
      'List messages addressed to you (role mention or reply) that you have not ' +
      'marked read. Server-authoritative and durable — includes pings that ' +
      'arrived while you were offline.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_unread',
    description:
      'Summarize unread messages per channel (count + a preview of the latest). ' +
      'Reflects traffic accrued while offline, across every channel you can read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'channel_missed',
    description:
      'How much you missed in one channel since your last-read WATERMARK: message ' +
      'count, total characters, and the latest preview. Note the baseline is your ' +
      'read watermark (see mark_read), NOT an unsubscribe point; the discord-mcpl ' +
      'surface exposes a same-named `channel_missed` that instead counts since you ' +
      'UNSUBSCRIBED, so do not assume identical semantics across surfaces. Bodies ' +
      'are not stored — use fetch_history to read them. Handy to decide whether a ' +
      'channel is worth catching up on.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC } },
      required: ['channelId'],
    },
  },
  {
    name: 'mark_read',
    description:
      'Mark a channel read, clearing its unread count and pending pings. Durable ' +
      '(advances the server watermark). Pass uptoCreatedAt to mark read only up ' +
      'to a point; omit to mark read to now.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: PORTAL_CHANNEL_ID_DESC },
        uptoCreatedAt: { type: 'string', description: 'ISO-8601; mark read only up to this time' },
      },
      required: ['channelId'],
    },
  },
];
