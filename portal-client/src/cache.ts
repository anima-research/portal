/**
 * Client-side cache, hydrated from `ready` and kept fresh by dispatch events.
 * Provides synchronous getters so callers (and the MCPL layer) can resolve
 * names/ids and capabilities without a round-trip.
 */
import type {
  PortalChannel,
  PortalEvent,
  PortalGuild,
  Persona,
  ReadyData,
} from '@connectome/portal-protocol';

export class ClientCache {
  persona?: Persona;
  private guilds = new Map<string, PortalGuild>();
  private channels = new Map<string, PortalChannel>();

  hydrate(ready: ReadyData): void {
    this.persona = ready.persona;
    this.guilds.clear();
    this.channels.clear();
    for (const g of ready.guilds) this.guilds.set(g.id, g);
    for (const c of ready.channels) this.channels.set(c.id, c);
  }

  /** Apply structural events; returns true if the cache changed. */
  apply(event: PortalEvent): boolean {
    switch (event.type) {
      case 'channel_create':
      case 'channel_update':
      case 'thread_create':
      case 'thread_update':
        this.channels.set(event.channel.id, event.channel);
        return true;
      case 'channel_delete':
        return this.channels.delete(event.channelId);
      case 'thread_delete':
        return this.channels.delete(event.channelId);
      case 'guild_create':
        this.guilds.set(event.guild.id, event.guild);
        for (const c of event.channels) this.channels.set(c.id, c);
        return true;
      case 'guild_delete':
        return this.guilds.delete(event.guildId);
      case 'persona_update':
        this.persona = event.persona;
        return true;
      case 'capabilities_update': {
        const ch = this.channels.get(event.channelId);
        if (ch) {
          this.channels.set(event.channelId, { ...ch, capabilities: event.capabilities });
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  getGuild(id: string): PortalGuild | undefined {
    return this.guilds.get(id);
  }
  getChannel(id: string): PortalChannel | undefined {
    return this.channels.get(id);
  }
  allGuilds(): PortalGuild[] {
    return [...this.guilds.values()];
  }
  allChannels(): PortalChannel[] {
    return [...this.channels.values()];
  }
  /** Threads + channels under a parent. */
  childrenOf(parentId: string): PortalChannel[] {
    return [...this.channels.values()].filter((c) => c.parentId === parentId);
  }
  findChannelByName(name: string, guildId?: string): PortalChannel | undefined {
    return [...this.channels.values()].find(
      (c) => c.name === name && (!guildId || c.guildId === guildId),
    );
  }
}
