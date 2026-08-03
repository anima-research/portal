/**
 * Feature-set declarations for the portal MCPL surface (SPEC §6.1).
 *
 * §6.1 and Appendix B.2 key `featureSets` **by name**: the name is the object
 * key, and the declaration itself carries only `description` and `uses`. The
 * previous array-with-`name` shape is a 0.4 artefact — under 0.5 a host walking
 * `Object.entries(featureSets)` over an array derives feature sets called
 * `"0"`, `"1"`, … and every `uses` check is then made against the wrong name.
 *
 * `uses` is typed as `CapabilityPath[]`, which is Appendix B.2's enum expressed
 * in the type system: a path outside §6.2's vocabulary is a compile error rather
 * than an `invalid_uses` disable at negotiation time (§6.4 rule 1).
 *
 * Declarations here are testimony about what this server *does*, never a claim
 * about what it may do. Authorization is the host's grant (§5.4).
 */
import type { TagOntology, TreatmentRule } from '@animalabs/mcpl-core';
import type { CapabilityPath } from './policy.js';
import { toolDefinitions } from './tools.js';

/**
 * RFC-001 rev 2 §5.1 renamed the ontology's rule list `defaultTreatment` →
 * `suggestedTreatment` ("the old name implied the rules were a default the host
 * would apply; they are not"). The resolved @animalabs/mcpl-core 0.2.2 types
 * predate the rename, so the corrected shape is declared locally.
 */
export type PortalTagOntology = Omit<TagOntology, 'defaultTreatment'> & {
  suggestedTreatment?: TreatmentRule[];
};

/** SPEC App. B.2: `description` and `uses` required; no `name`, no `hostState`. */
export interface PortalFeatureSet {
  description: string;
  uses: CapabilityPath[];
  /** §8.1, out of scope for 0.5.0. Not a capability path, confers nothing. */
  rollback?: boolean;
  tagOntology?: PortalTagOntology;
}

export const featureSets: Readonly<Record<string, PortalFeatureSet>> = {
  'portal.messaging': {
    description: 'Send, edit, react to messages as your persona via the portal relay',
    // SPEC §6.4: `uses` must name every capability this bundle actually
    // exercises, or the host's degradation derivation is wrong about us —
    //   tools                → send_message / edit_message / react / …
    //   channels.publish     → handlePublish (the host's locus-routing send)
    //   channels.register    → channels/register + channels/changed + channels/list
    //   channels.lifecycle   → channels/open + channels/close
    //   channels.incoming    → inbound messages on an OPEN channel
    //   pushEvents           → inbound messages, reactions, deletes, catch-up
    //   channels.acknowledge → channels/acknowledge (a visible persona reaction)
    // Consequence, stated plainly because §6.4 makes it real: denying any one of
    // these disables this whole set, and with it the messaging tool surface. The
    // other three sets use only `tools`, so a tools-only grant keeps them.
    uses: [
      'tools',
      'pushEvents',
      'channels.register',
      'channels.lifecycle',
      'channels.publish',
      'channels.incoming',
      'channels.acknowledge',
    ],
    rollback: false,
    // MCPL RFC-001 / SPEC §16 — tags carried on portal message events (emits
    // the umbrellas directly, which §16.3 says is the more robust form).
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:reply', 'chat:dm', 'chat:private', 'chat:ambient',
        'chat:from-human', 'chat:from-bot', 'chat:from-agent', 'chat:deleted',
        'chat:reaction', 'chat:reaction-remove',
        'chat:has-image', 'chat:has-audio', 'chat:has-file', 'chat:thread',
      ],
      // No `implies` edges into the reserved `chat:*` namespace. SPEC §16.3:
      // a producer edge targeting a reserved tag MUST NOT be applied unless the
      // host explicitly accepted this ontology, because it would let a producer
      // promote its own traffic into the band the consumer reserved for being
      // spoken to. Every core tag these would have implied is emitted directly
      // by deriveTags(), so the edges bought nothing and are gone.
      tags: {
        'portal:role-mention': { desc: 'Addressed via the persona\'s pooled role mention', facet: 'addressing' },
        'portal:name-mention': { desc: 'Addressed by display-name match', facet: 'addressing' },
        'portal:subscription': { desc: 'Ambient message from a subscribed channel', facet: 'addressing' },
        'portal:persona': { desc: 'Authored by another portal persona/agent', facet: 'sender' },
      },
      // §16.5: a hint. The host applies it only on explicit acceptance; absent
      // acceptance there is no producer tier at all.
      suggestedTreatment: [
        { tagsAny: ['chat:addressed'], behavior: 'immediate' },
        { tagsAny: ['chat:deleted'], behavior: 'mute' },
        { tagsAny: ['chat:ambient', 'chat:from-bot'], behavior: { throttle: { perMs: 120000 } } },
      ],
      open: false,
    },
  },
  'portal.channels': {
    description: 'Create threads/channels and list guilds via the relay',
    uses: ['tools'],
    rollback: false,
  },
  'portal.history': {
    description: 'Fetch message history (paginated; fetch_around for centred windows)',
    uses: ['tools'],
    rollback: false,
  },
  'portal.subscriptions': {
    description:
      'Server-authoritative read-state (pending pings, unread, channel_missed) ' +
      'with offline catch-up; the MCPL host owns channel open/close lifecycle',
    uses: ['tools'],
    rollback: false,
  },
};

/**
 * Which feature set each tool belongs to (§6.5's tagging, applied to the tool
 * surface so a disabled set actually stops answering).
 *
 * Fail-closed: a tool missing from this table has no feature set and is
 * therefore refused under MCPL. `toolFeatureSetCoverage()` makes that a test
 * failure rather than a silent outage.
 */
export const TOOL_FEATURE_SETS: Readonly<Record<string, string>> = {
  send_message: 'portal.messaging',
  edit_message: 'portal.messaging',
  delete_message: 'portal.messaging',
  react: 'portal.messaging',
  unreact: 'portal.messaging',
  list_emojis: 'portal.messaging',
  set_reaction_visibility: 'portal.messaging',
  resolve_mentions: 'portal.messaging',

  list_guilds: 'portal.channels',
  list_channels: 'portal.channels',
  create_thread: 'portal.channels',
  list_members: 'portal.channels',
  list_roles: 'portal.channels',

  fetch_history: 'portal.history',
  fetch_around: 'portal.history',
  list_pins: 'portal.history',

  subscribe_channel: 'portal.subscriptions',
  unsubscribe_channel: 'portal.subscriptions',
  list_subscriptions: 'portal.subscriptions',
  get_pending_pings: 'portal.subscriptions',
  list_unread: 'portal.subscriptions',
  channel_missed: 'portal.subscriptions',
  mark_read: 'portal.subscriptions',
};

/** Tools with no feature set, and mappings naming a set that does not exist. */
export function toolFeatureSetCoverage(): { unmapped: string[]; unknownSets: string[] } {
  const declared = new Set(Object.keys(featureSets));
  return {
    unmapped: toolDefinitions.map((t) => t.name).filter((name) => !(name in TOOL_FEATURE_SETS)),
    unknownSets: Object.values(TOOL_FEATURE_SETS).filter((name) => !declared.has(name)),
  };
}
