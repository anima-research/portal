/**
 * Map portal channels to MCPL ChannelDescriptors.
 *
 * Relay channel ids are Discord channel snowflakes (globally unique), so the
 * MCPL channel id is just `portal:<channelId>` — no guild prefix needed.
 * Threads carry their parent id in metadata.
 */
import type { ChannelDescriptor } from '@animalabs/mcpl-core';
import type { PortalChannel } from '@animalabs/portal-protocol';
import { formatChannelLabel } from './channel-names.js';

export type PortalChannelDescriptor = ChannelDescriptor & {
  initiallyOpen?: boolean;
  capabilities?: {
    history?: { maxMessages?: number; supportsBeforeMessage?: boolean };
    acknowledgment?: { kind?: string; supportsValue?: boolean };
    publish?: { target: PublishTarget };
  };
};

/**
 * Where a channels/publish lands (MCPL RFC-011 `capabilities.publish`).
 *
 * - `exact`: a guild text or forum channel holds threads; a publish naming
 *   one (`threadId`) lands exactly in that thread, and `null` in the channel
 *   itself, or it fails with nothing posted. The relay resolves the place
 *   exactly (a thread under this channel, or the channel) or refuses.
 * - `root`: a thread, a DM or a voice channel's chat has no threads inside
 *   it, so a publish lands in the channel itself.
 * - none: a category or an unknown channel kind promises nothing.
 */
export type PublishTarget = 'exact' | 'root';

export function publishTarget(channel: PortalChannel): PublishTarget | undefined {
  if (channel.type === 'thread' || channel.type === 'voice' || !channel.guildId) return 'root';
  if (channel.type === 'text' || channel.type === 'forum') return 'exact';
  return undefined;
}

export function portalChannelId(channelId: string): string {
  return `portal:${channelId}`;
}

export function parsePortalChannelId(id: string): string | null {
  const parts = id.split(':');
  return parts.length === 2 && parts[0] === 'portal' ? parts[1] : null;
}

/**
 * `guildName` makes the label `#name (Guild)` — the display form that every
 * channelId tool argument accepts back (see channel-names.ts: display form ==
 * address form). Without it the label is the unqualified `#name`, which still
 * parses but collides across guilds.
 */
export function toDescriptor(
  channel: PortalChannel,
  initiallyOpen = false,
  maxHistory = 500,
  guildName?: string,
): PortalChannelDescriptor {
  const label = channel.guildId
    ? formatChannelLabel(channel.name ?? channel.id, guildName)
    : `${formatChannelLabel(channel.name ?? channel.id)} (dm)`;
  const target = publishTarget(channel);
  return {
    id: portalChannelId(channel.id),
    type: 'portal',
    label,
    direction: 'bidirectional',
    address: { channelId: channel.id, guildId: channel.guildId },
    metadata: {
      channelType: channel.type,
      parentId: channel.parentId,
      guildId: channel.guildId,
      capabilities: channel.capabilities,
    },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
      ...(target ? { publish: { target } } : {}),
    },
  };
}
