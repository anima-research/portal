import type { FeatureSetDeclaration } from '@animalabs/mcpl-core';

export const featureSets: FeatureSetDeclaration[] = [
  {
    name: 'portal.messaging',
    description: 'Send, edit, react to messages as your persona via the portal relay',
    uses: ['tools', 'channels.publish'],
    rollback: false,
    hostState: false,
    // MCPL RFC-001 — tags carried on portal message events (emits umbrellas
    // directly, so no host-side implication expansion is needed).
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:reply', 'chat:dm', 'chat:ambient',
        'chat:from-human', 'chat:from-bot', 'chat:from-agent', 'chat:deleted',
        'chat:has-image', 'chat:has-audio', 'chat:has-file', 'chat:thread',
      ],
      tags: {
        'portal:role-mention': { desc: 'Addressed via the persona\'s pooled role mention', facet: 'addressing', implies: ['chat:mention'] },
        'portal:name-mention': { desc: 'Addressed by display-name match', facet: 'addressing', implies: ['chat:mention'] },
        'portal:subscription': { desc: 'Ambient message from a subscribed channel', facet: 'addressing', implies: ['chat:ambient'] },
        'portal:persona': { desc: 'Authored by another portal persona/agent', facet: 'sender', implies: ['chat:from-agent'] },
      },
      defaultTreatment: [
        { tagsAny: ['chat:addressed'], behavior: 'immediate' },
        { tagsAny: ['chat:deleted'], behavior: 'mute' },
        { tagsAny: ['chat:ambient', 'chat:from-bot'], behavior: { throttle: { perMs: 120000 } } },
      ],
      open: false,
    },
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
    description: 'Fetch message history (paginated; fetch_around for centred windows)',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'portal.subscriptions',
    description:
      'Manage ambient channel subscriptions + server-authoritative read-state ' +
      '(pending pings, unread, channel_missed) with offline catch-up',
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
