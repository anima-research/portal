/**
 * MCPL 0.5 capability grant + feature-set enforcement.
 *
 * The capability grant is the security boundary (SPEC §5.4). Feature sets are
 * derived from it (§6.4) and carry no authority of their own. This module holds
 * the whole of that derivation so the server binding has exactly one place to
 * ask "may I do this?".
 *
 * Three invariants shape everything here:
 *
 *  - **Absence is denial** (§5.4). `effectiveCapabilities` is the sole normative
 *    allowlist; every path not present is denied and there is no unspecified
 *    state. Before the initial policy exchange completes, NOTHING is granted
 *    (§5.3) — `allows()` returns false until `applyRequest()` has run.
 *  - **`deniedCapabilities` is diagnostics** (§5.4). It never participates in an
 *    authorization decision. It is read only to detect the malformed case where
 *    a path appears in both lists, which fails closed.
 *  - **The server never supplies the key its own request is authorised against.**
 *    Nothing in this module derives a grant from a feature-set declaration, a
 *    receipt, or a host rejection. Declarations narrow; they never widen.
 */

/**
 * SPEC §6.2 / Appendix B.2 — the complete, closed vocabulary of capability
 * paths. These are the ONLY valid `uses` values. Anything else in a declaration
 * makes that declaration invalid (§6.4 rule 1), and anything else in a grant is
 * a path this server cannot exercise and therefore ignores.
 *
 * Declared here rather than imported: the resolved `@animalabs/mcpl-core` 0.2.2
 * types predate 0.5 and export no capability-path vocabulary.
 */
export const CAPABILITY_PATHS = [
  'pushEvents',
  'tools',
  'modelInfo',
  'inferenceRequest',
  'inferenceRequest.streaming',
  'inferenceLifecycle',

  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.system',
  'contextHooks.beforeInference.inject.beforeUser',
  'contextHooks.beforeInference.inject.afterUser',

  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
  'channels.acknowledge',
  'channels.typing',
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

const KNOWN_PATHS: ReadonlySet<string> = new Set(CAPABILITY_PATHS);

export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && KNOWN_PATHS.has(value);
}

/**
 * The shape this module needs from a feature-set declaration: §6.1 keys them by
 * name, so the name is the map key and `uses` is the only member derivation
 * reads. `uses` is `unknown` on purpose — validating it is the point (§6.4).
 */
export interface DeclaredFeatureSet {
  uses?: unknown;
}

/**
 * Segment-wise pattern match over dot-separated paths (§5.4: "matching is over
 * full paths with `*` wildcards ... implementations MUST perform a generic
 * recursive walk"). Deliberately generic: no hardcoded set of nestable keys, so
 * a deeper vocabulary needs no change here.
 *
 * `*` as an interior segment matches exactly one segment; as the final segment
 * it matches the remaining subtree (one or more segments), which is what §6.3's
 * `memory.*` bulk form means.
 *
 * A bare prefix does NOT match its subtree: `channels` does not grant
 * `channels.publish`. §5.1's "boolean true is shorthand for every leaf beneath
 * this node" is stated for the *advertisement*, not for grant paths, and §5.4
 * says absence is denial with no unspecified state. A host that means the
 * subtree can say `channels.*`.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') {
      if (i === p.length - 1) return q.length > i; // trailing: rest of subtree
      if (i >= q.length) return false;
      continue;
    }
    if (p[i] !== q[i]) return false;
  }
  return p.length === q.length;
}

/** Why a declared feature set is not running. Reported in the receipt (§6.7). */
export type DisableReason =
  /** §6.4 rule 1 — `uses` absent, empty, or containing an unrecognized value. */
  | 'invalid_uses'
  /** §6.4 — a capability the set's `uses` requires is not in the grant. */
  | 'capability_denied'
  /** The host named it in `disabled`. */
  | 'host_disabled'
  /** The host sent an `enabled` allowlist and this set is not on it. */
  | 'not_selected';

export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities?: string[];
  reason: DisableReason;
  effect: 'disabled';
}

/** SPEC §6.7 — the response to a `featureSets/update` Request. */
export interface DegradationReceipt {
  accepted: true;
  mode: 'full' | 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes: string[];
}

/**
 * `featureSets/update` params (§5.3 / §6.7). Every member is typed `unknown`
 * because it arrives off the wire and is validated before use.
 */
export interface FeatureSetsUpdateParams {
  effectiveCapabilities?: unknown;
  deniedCapabilities?: unknown;
  enabled?: unknown;
  disabled?: unknown;
}

/** A policy message that cannot be trusted at all. The caller answers with a
 *  JSON-RPC error and the policy has already fallen back to fully denied. */
export class MalformedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPolicyError';
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new MalformedPolicyError(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * The connection's effective policy. One instance per connection; `reset()`
 * returns it to the pre-policy state where nothing is granted.
 */
export class McplPolicy {
  /** §5.3 — false until the initial `featureSets/update` Request is answered. */
  private ready = false;
  /** Accepted grant patterns. Absence is denial (§5.4). */
  private grant: string[] = [];
  private enabledSets = new Set<string>();
  private unavailable: UnavailableFeature[] = [];

  constructor(private readonly declarations: Readonly<Record<string, DeclaredFeatureSet>>) {}

  /** §5.3 — has the initial policy exchange completed? */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * The one authorization question. False before policy arrives and false for
   * every path the host did not name.
   */
  allows(capability: CapabilityPath): boolean {
    if (!this.ready) return false;
    return this.grant.some((pattern) => pathMatches(pattern, capability));
  }

  /** Feature sets are ergonomics, not authority — check `allows()` too (§5.4). */
  featureEnabled(name: string): boolean {
    return this.ready && this.enabledSets.has(name);
  }

  get degradation(): readonly UnavailableFeature[] {
    return this.unavailable;
  }

  /** Return to the pre-policy state: nothing granted, nothing enabled. */
  reset(): void {
    this.ready = false;
    this.grant = [];
    this.enabledSets.clear();
    this.unavailable = [];
  }

  /**
   * Apply a `featureSets/update` **Request** and produce the degradation receipt
   * (§6.7). Throws `MalformedPolicyError` after resetting to fully denied — any
   * unparseable member drops the whole message, because a partially-read policy
   * would leave the previous (possibly wider) grant standing through what may
   * have been a reduction.
   *
   * The receipt is testimony about consequences, never a claim of entitlement
   * (§6.7): it reports which of this server's declared sets stopped working and
   * which capability each was missing. It asks for nothing.
   */
  applyRequest(params: FeatureSetsUpdateParams | undefined): DegradationReceipt {
    const p = params ?? {};
    let effective: string[];
    let denied: string[];
    let enabledList: string[] | undefined;
    let disabledList: string[];
    try {
      effective = stringArray(p.effectiveCapabilities, 'effectiveCapabilities');
      denied = stringArray(p.deniedCapabilities, 'deniedCapabilities');
      enabledList = p.enabled === undefined ? undefined : stringArray(p.enabled, 'enabled');
      disabledList = stringArray(p.disabled, 'disabled');

      // §5.4: a path in both lists is malformed and the receiving side MUST fail
      // closed. We drop the whole message rather than invent a precedence rule.
      const deniedSet = new Set(denied);
      const conflicts = effective.filter((path) => deniedSet.has(path));
      if (conflicts.length > 0) {
        throw new MalformedPolicyError(
          `capability path in both effectiveCapabilities and deniedCapabilities: ${conflicts.join(', ')}`,
        );
      }
    } catch (err) {
      this.reset();
      throw err;
    }

    const notes: string[] = [];
    const patterns: string[] = [];
    for (const entry of effective) {
      if (entry.includes('*') || isCapabilityPath(entry)) patterns.push(entry);
      else notes.push(`ignored unrecognized capability path in effectiveCapabilities: ${entry}`);
    }

    this.grant = patterns;
    this.ready = true;
    this.deriveFeatureSets(enabledList, disabledList, notes);

    return {
      accepted: true,
      mode: this.unavailable.length === 0 ? 'full' : 'degraded',
      unavailableFeatures: [...this.unavailable],
      notes,
    };
  }

  /**
   * Apply a `featureSets/update` **Notification**.
   *
   * §6.7: a Notification is valid only for descriptive metadata that does not
   * alter the grant, and it **cannot establish a ready state**. So this applies
   * reductions (`disabled`) — "servers MUST immediately respect a reduction" —
   * and nothing else: never a grant, never an expansion, never readiness.
   * Returns diagnostics for the caller to log.
   */
  applyNotification(params: FeatureSetsUpdateParams | undefined): string[] {
    const p = params ?? {};
    const diagnostics: string[] = [];
    if (p.effectiveCapabilities !== undefined || p.deniedCapabilities !== undefined) {
      diagnostics.push(
        'featureSets/update carrying a capability grant arrived as a Notification; ' +
          'ignored (SPEC §6.7 requires the Request form for any grant change)',
      );
    }
    if (p.enabled !== undefined) {
      diagnostics.push(
        'featureSets/update Notification carried `enabled`; ignored (an expansion ' +
          'must be acknowledged, SPEC §6.7)',
      );
    }
    let disabledList: string[];
    try {
      disabledList = stringArray(p.disabled, 'disabled');
    } catch (err) {
      return [...diagnostics, (err as Error).message];
    }
    if (!this.ready) {
      if (disabledList.length) {
        diagnostics.push('featureSets/update Notification before initial policy; nothing to reduce');
      }
      return diagnostics;
    }
    for (const name of [...this.enabledSets]) {
      if (disabledList.some((pattern) => pathMatches(pattern, name))) {
        this.enabledSets.delete(name);
        this.unavailable.push({ featureSet: name, reason: 'host_disabled', effect: 'disabled' });
        diagnostics.push(`feature set disabled by notification: ${name}`);
      }
    }
    return diagnostics;
  }

  /**
   * §6.4 — derive feature sets from the grant, fail-closed:
   *  1. absent/empty/unrecognized `uses` ⇒ `invalid_uses`;
   *  2. any required capability outside the grant ⇒ disabled;
   *  3. host selection narrows further, never widens.
   */
  private deriveFeatureSets(
    enabledList: string[] | undefined,
    disabledList: string[],
    notes: string[],
  ): void {
    this.enabledSets.clear();
    this.unavailable = [];

    for (const [name, declaration] of Object.entries(this.declarations)) {
      const invalid = invalidUses(declaration);
      if (invalid !== null) {
        this.unavailable.push({ featureSet: name, reason: 'invalid_uses', effect: 'disabled' });
        notes.push(`feature set ${name} has invalid uses: ${invalid}`);
        continue;
      }
      const missing = (declaration.uses as string[]).filter(
        (use) => !this.allows(use as CapabilityPath),
      );
      if (missing.length > 0) {
        this.unavailable.push({
          featureSet: name,
          missingCapabilities: missing,
          reason: 'capability_denied',
          effect: 'disabled',
        });
        continue;
      }
      if (disabledList.some((pattern) => pathMatches(pattern, name))) {
        this.unavailable.push({ featureSet: name, reason: 'host_disabled', effect: 'disabled' });
        continue;
      }
      // An `enabled` list, when present, is an allowlist: a set it does not name
      // stays off. Absent, derivation from the grant alone decides (§6.4).
      if (enabledList !== undefined && !enabledList.some((pattern) => pathMatches(pattern, name))) {
        this.unavailable.push({ featureSet: name, reason: 'not_selected', effect: 'disabled' });
        continue;
      }
      this.enabledSets.add(name);
    }
  }

  /** Startup self-check: report our own malformed declarations (§6.4 rule 1)
   *  before a host has to tell us. Pure diagnostics — grants nothing. */
  declarationDiagnostics(): string[] {
    const out: string[] = [];
    for (const [name, declaration] of Object.entries(this.declarations)) {
      const invalid = invalidUses(declaration);
      if (invalid !== null) out.push(`feature set ${name}: invalid uses (${invalid})`);
    }
    return out;
  }
}

/** §6.4 rule 1 / §6.2. Returns null when `uses` is valid, else why it is not. */
export function invalidUses(declaration: DeclaredFeatureSet): string | null {
  const uses = declaration?.uses;
  if (!Array.isArray(uses)) return 'absent';
  if (uses.length === 0) return 'empty';
  const unknown = uses.filter((use) => !isCapabilityPath(use));
  if (unknown.length > 0) return `unrecognized: ${unknown.map((u) => String(u)).join(', ')}`;
  return null;
}
