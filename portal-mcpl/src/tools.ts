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
    'Optional file attachments (up to 10; ~8 MiB total). Provide each file as ' +
    'inline base64 `bytes` (preferred — works from anywhere) with a `name`.',
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

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description:
      'Post a message to a channel or thread as your persona (via webhook). ' +
      'Pass a thread channel id directly to post in a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel or thread id' },
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
        messageId: { type: 'string', description: 'Relay message id' },
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
      properties: { messageId: { type: 'string', description: 'Relay message id' } },
      required: ['messageId'],
    },
  },
  {
    name: 'react',
    description:
      'React to a message. visible=false records a structured reaction (clean channel); ' +
      'visible=true also posts a small persona line so humans see it in Discord.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        emoji: { type: 'string', description: 'Unicode emoji or name:id' },
        visible: { type: 'boolean', description: 'Also post a visible reaction line (default false)' },
      },
      required: ['messageId', 'emoji'],
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
        channelId: { type: 'string' },
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
        channelId: { type: 'string' },
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
      properties: { channelId: { type: 'string' }, name: { type: 'string' } },
      required: ['channelId', 'name'],
    },
  },
  {
    name: 'subscribe_channel',
    description: 'Receive ambient (non-addressed) messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' } },
      required: ['channelId'],
    },
  },
  {
    name: 'unsubscribe_channel',
    description: 'Stop receiving ambient messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' } },
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
      properties: { channelId: { type: 'string' } },
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
      'How much you missed in one channel since your last read: message count, ' +
      'total characters, and the latest preview. Bodies are not stored — use ' +
      'fetch_history to read them. Handy to decide whether a channel is worth ' +
      'catching up on.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' } },
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
        channelId: { type: 'string' },
        uptoCreatedAt: { type: 'string', description: 'ISO-8601; mark read only up to this time' },
      },
      required: ['channelId'],
    },
  },
];
