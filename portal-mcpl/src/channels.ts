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
    // MCPL RFC-011's declaration. mcpl-core 0.2.2 predates RFC-011, so this
    // stands in for mcpl-core-ts#9's type until that is released and the
    // dependency is bumped.
    publish?: { target: PublishTarget };
  };
};

/**
 * Where a channels/publish lands (MCPL RFC-011 `capabilities.publish`).
 *
 * - `exact`: a guild text or forum channel holds threads; a publish naming
 *   one (`threadId`) lands exactly in that thread, and `null` in the channel
 *   itself, or it is refused with nothing posted. The relay resolves the
 *   place exactly (a thread under this channel, or the channel) or refuses. A
 *   forum has no root (Discord takes messages there only inside its posts),
 *   so `null` on a forum is refused before anything is sent.
 * - `root`: a thread or a voice channel's chat has no threads inside it, so
 *   a publish lands in the channel itself.
 * - none: a DM (the relay posts through webhooks, and a DM has none), a
 *   category, or an unknown channel kind promises nothing, and a targeted
 *   publish there is refused.
 */
export type PublishTarget = 'exact' | 'root';

export function publishTarget(channel: PortalChannel): PublishTarget | undefined {
  if (!channel.guildId) return undefined;
  if (channel.type === 'thread' || channel.type === 'voice') return 'root';
  if (channel.type === 'text' || channel.type === 'forum') return 'exact';
  return undefined;
}

/** Whether a targeted publish with `null`, the channel itself, can land here:
 *  a `root` channel, or an `exact` one other than a forum. */
export function rootTakesPosts(channel: PortalChannel): boolean {
  const target = publishTarget(channel);
  return target === 'root' || (target === 'exact' && channel.type !== 'forum');
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
