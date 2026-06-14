/**
 * Map portal channels to MCPL ChannelDescriptors.
 *
 * Relay channel ids are Discord channel snowflakes (globally unique), so the
 * MCPL channel id is just `portal:<channelId>` — no guild prefix needed.
 * Threads carry their parent id in metadata.
 */
import type { ChannelDescriptor } from '@connectome/mcpl-core';
import type { PortalChannel } from '@connectome/portal-protocol';

export function portalChannelId(channelId: string): string {
  return `portal:${channelId}`;
}

export function parsePortalChannelId(id: string): string | null {
  const parts = id.split(':');
  return parts.length === 2 && parts[0] === 'portal' ? parts[1] : null;
}

export function toDescriptor(channel: PortalChannel): ChannelDescriptor {
  const guildLabel = channel.guildId ? '' : ' (dm)';
  return {
    id: portalChannelId(channel.id),
    type: 'portal',
    label: `#${channel.name ?? channel.id}${guildLabel}`,
    direction: 'bidirectional',
    address: { channelId: channel.id, guildId: channel.guildId },
    metadata: {
      channelType: channel.type,
      parentId: channel.parentId,
      guildId: channel.guildId,
      capabilities: channel.capabilities,
    },
  };
}
