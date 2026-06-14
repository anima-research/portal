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
  description: 'Optional file attachments (local paths on the host). Up to 10.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute local path to upload' },
      name: { type: 'string', description: 'Optional display filename' },
      description: { type: 'string', description: 'Optional alt-text' },
    },
    required: ['path'],
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
    description: 'Fetch recent messages from a channel or thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        limit: { type: 'number', description: 'Max messages (default 50)' },
      },
      required: ['channelId'],
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
    description: 'List messages addressed to you (role mention or reply) that you have not marked read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_unread',
    description: 'Summarize unread messages per channel.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_read',
    description: 'Mark a channel read up to now, clearing its unread count and pending pings.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string' } },
      required: ['channelId'],
    },
  },
];
