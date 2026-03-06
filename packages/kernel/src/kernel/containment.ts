/**
 * G5: Containment
 * ================
 *
 * Every mutation traces to a predicate, or the human knows.
 *
 * Born from: "The Trojan Edit" — agent asked for CSS color change also
 * rewrote auth middleware. Both appeared as equal line items in the
 * approval card. G1 proves intended ⊆ actual. G5 proves actual ⊆ intended.
 * Together: actual == intended.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel owns:
 *   - Orchestration: iterate mutations, aggregate attributions, produce result
 *   - Summary generation: human-readable containment status
 *   - Enforcement: verdict based on containment mode
 *
 * The adapter owns:
 *   - Per-mutation attribution: "does this CSS edit match this CSS predicate?"
 *   - Identity binding: "does this SQL WHERE clause match observed evidence?"
 *
 * Extracted from: src/lib/services/agent/containment.ts:417-532
 */

import type {
  Mutation,
  Predicate,
  Evidence,
  ContainmentResult,
  MutationAttribution,
  Attribution,
  IdentityMismatch,
  ContainmentMode,
  GateVerdict,
  DomainAdapter,
} from '../types.js';

// =============================================================================
// TYPES — Re-export for consumers
// =============================================================================

/**
 * Re-export AttributedMutation as an alias for MutationAttribution.
 * The kernel's view of a classified mutation.
 */
export type AttributedMutation = MutationAttribution;

// =============================================================================
// PURE FUNCTIONS
// =============================================================================

/**
 * Attribute every mutation in the plan to a predicate (or flag as unexplained).
 *
 * The kernel iterates mutations and delegates classification to the adapter.
 * The adapter's `attributeMutation()` returns the domain-specific classification.
 * The kernel aggregates counts and produces the containment result.
 *
 * INDEX ORDERING INVARIANT: The attributions array is indexed by position in
 * the input `mutations` array. Consumers must maintain this ordering.
 *
 * Extracted from: attributePlan() in containment.ts:417-532
 */
export function attributePlan(
  mutations: Mutation[],
  predicates: Predicate[],
  evidence: Evidence[],
  adapter: DomainAdapter,
): ContainmentResult {
  const attributions: MutationAttribution[] = [];

  if (!predicates || predicates.length === 0) {
    // No predicates — everything is unexplained
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      attributions.push({
        index: i,
        verb: m.verb,
        target: m.target,
        attribution: 'unexplained' as Attribution,
        reason: 'No predicates defined — all mutations are unexplained',
      });
    }
  } else {
    // Delegate per-mutation attribution to the adapter
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      const result = adapter.attributeMutation(mutation, predicates, evidence);

      attributions.push({
        index: result.index,
        verb: result.verb,
        target: result.target,
        attribution: result.attribution,
        predicateId: result.predicateId,
        reason: result.reason,
      });
    }
  }

  // Identity binding check (G5.5) — delegate to adapter
  const identityMismatches = adapter.checkIdentityBinding(mutations, evidence);

  // Aggregate counts
  const directCount = attributions.filter(a => a.attribution === 'direct').length;
  const scaffoldingCount = attributions.filter(a => a.attribution === 'scaffolding').length;
  const unexplainedCount = attributions.filter(a => a.attribution === 'unexplained').length;
  const contained = unexplainedCount === 0 && identityMismatches.length === 0;

  // Build summary
  const parts: string[] = [];
  if (directCount > 0) parts.push(`${directCount} traced`);
  if (scaffoldingCount > 0) parts.push(`${scaffoldingCount} supporting`);
  if (unexplainedCount > 0) parts.push(`${unexplainedCount} untraced`);
  if (identityMismatches.length > 0) parts.push(`${identityMismatches.length} identity mismatch(es)`);
  const summary = parts.length > 0
    ? parts.join(', ')
    : 'No mutations to attribute';

  return {
    contained,
    attributions,
    identityMismatches,
    directCount,
    scaffoldingCount,
    unexplainedCount,
    summary,
  };
}

/**
 * Convert containment result to a gate verdict based on enforcement mode.
 *
 * Advisory:   Always proceed, log attribution for UI
 * Soft gate:  Escalate when unexplained > 0 (human must acknowledge)
 * Hard gate:  Block when unexplained > 0 (agent retries)
 */
export function containmentVerdict(
  result: ContainmentResult,
  mode: ContainmentMode,
): GateVerdict {
  if (result.contained) {
    return {
      action: 'proceed',
      gate: 'contain',
      reason: `Containment: ${result.summary}`,
    };
  }

  switch (mode) {
    case 'advisory':
      return {
        action: 'proceed',
        gate: 'contain',
        reason: `Containment (advisory): ${result.summary}`,
        escalationContext: { containment: result },
      };

    case 'soft_gate':
      return {
        action: 'escalate',
        gate: 'contain',
        reason: `Containment (soft gate): ${result.unexplainedCount} untraced mutation(s) require acknowledgment`,
        escalationContext: { containment: result },
      };

    case 'hard_gate':
      return {
        action: 'block',
        gate: 'contain',
        reason: `Containment (hard gate): ${result.unexplainedCount} untraced mutation(s) — agent must narrow plan`,
        escalationContext: { containment: result },
      };
  }
}
