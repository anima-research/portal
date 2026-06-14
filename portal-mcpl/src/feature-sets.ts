import type { FeatureSetDeclaration } from '@connectome/mcpl-core';

export const featureSets: FeatureSetDeclaration[] = [
  {
    name: 'portal.messaging',
    description: 'Send, edit, react to messages as your persona via the portal relay',
    uses: ['tools', 'channels.publish'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'portal.channels',
    description: 'Create threads/channels and list guilds via the relay',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'portal.history',
    description: 'Fetch message history',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'portal.subscriptions',
    description: 'Manage ambient channel subscriptions + read-state (pings, unread)',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
];

export function isEnabled(name: string, enabled: Set<string>): boolean {
  if (enabled.has(name)) return true;
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    if (enabled.has(parts.slice(0, i).join('.') + '.*')) return true;
  }
  return false;
}
