/**
 * G6: Scope Boundedness
 * =====================
 *
 * Every mutation's blast radius must be estimable before execution.
 *
 * Born from: Effect-Verified Governance (Feb 27-28, 2026). The system
 * estimated a CSS change would affect 1 element, but it affected 47.
 * Without scope awareness, the system auto-approved a mass rewrite.
 *
 * The kernel sees numbers, not domains. ScopeEstimate is
 * { cardinality: number, trust: number } — not CSS selectors, not
 * DOM nodes, not SQL tables. The adapter computes cardinality from
 * its domain; the kernel evaluates f(estimated, observed, threshold) → verdict.
 *
 * If scope.ts ever imports anything web-specific, it's a broken invariant.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 */

import type { GateVerdict } from '../types.js';

// =============================================================================
// TYPES — Domain-agnostic scope measurement
// =============================================================================

/**
 * How much confidence to place in a scope estimate.
 *
 * The adapter labels trust level based on its measurement method.
 * The kernel uses trust to weight alignment results.
 */
export type ScopeTrust = 'authoritative' | 'heuristic' | 'guess' | 'none';

/**
 * Where a scope measurement came from.
 *
 * The adapter labels the source. The kernel treats this as an opaque
 * category for weighting and auditing.
 */
export type ScopeSource = 'browser' | 'file_diff' | 'db_schema' | 'template_regex' | 'static_analysis' | 'unknown';

/**
 * Pre-execution scope estimate for a single predicate/mutation.
 *
 * The adapter computes this from domain-specific analysis.
 * The kernel stores it for comparison with post-execution observation.
 */
export interface ScopeEstimate {
  /** Adapter-defined target identifier (opaque to kernel) */
  target: string;

  /** How many entities this target selects (null = unknown/unsupported) */
  cardinality: number | null;

  /** How the measurement was taken */
  source: ScopeSource;

  /** Confidence in the measurement */
  trust: ScopeTrust;

  /** Adapter-supplied context (opaque to kernel) */
  reason?: string;
}

/**
 * Post-execution observed impact for a single predicate/mutation.
 *
 * The adapter populates this after execution (e.g., from browser gate,
 * file diff count, DB query result).
 */
export interface ObservedImpact {
  /** How many entities actually changed */
  cardinality: number;

  /** How the measurement was taken */
  source: ScopeSource;

  /** Confidence in the measurement */
  trust: ScopeTrust;
}

/**
 * Alignment status between estimated and observed scope.
 */
export type AlignmentStatus = 'match' | 'over' | 'under' | 'unknown';

/**
 * Alignment result for a single predicate.
 */
export interface ScopeAlignment {
  status: AlignmentStatus;
  delta?: number;
  note?: string;
}

/**
 * Full impact evidence for a single predicate/mutation.
 */
export interface ImpactEvidence {
  /** Adapter-defined target identifier */
  target: string;

  /** Pre-execution estimate */
  estimated: ScopeEstimate;

  /** Post-execution observation (populated after execution) */
  observed?: ObservedImpact;

  /** Structured comparison result */
  alignment?: ScopeAlignment;

  /** Human-readable summary for attestation */
  summary: string;
}

/**
 * Per-axis weighted contributions to the composite score.
 */
export interface AxisContributions {
  /** verificationDepth * 0.50 (0.0–0.50) */
  verificationDepth: number;
  /** (1 - unknownPenalty) * 0.25 (0.0–0.25) */
  unknownPenalty: number;
  /** (1 - underestimateRate) * 0.25 (0.0–0.25) */
  underestimateRate: number;
  /** @deprecated always 0 — axis removed, kept for backward compat */
  matchRate?: number;
  /** @deprecated always 0 — axis removed, kept for backward compat */
  fileDiffAmbiguity?: number;
}

/**
 * Composite alignment score from a single job's evidence.
 *
 * The score measures how well pre-execution scope estimates predicted
 * post-execution reality. Higher = better estimation = safer execution.
 */
export interface EffectAlignmentScore {
  /** Composite health score (0.0–1.0) */
  overall: number;
  /** Fraction of predicates verified (browser match + O.5b) */
  verificationDepth: number;
  /** Fraction of predicates with no estimate (0 = all known) */
  unknownPenalty: number;
  /** Fraction underestimated (observed > estimated) */
  underestimateRate: number;
  /** Fraction of predicates with both estimate + observation */
  confidence: number;
  /** Per-axis weighted contributions */
  axisContributions: AxisContributions;
  /** @deprecated use verificationDepth */
  matchRate?: number;
  /** @deprecated always 0 — axis removed */
  fileDiffAmbiguity?: number;
}

/**
 * Scope contract verdict — binary gate decision.
 */
export type ScopeContractVerdict = 'aligned' | 'deviated' | 'unknown';

/**
 * Full scope contract evaluation result.
 */
export interface ScopeContractResult {
  verdict: ScopeContractVerdict;
  score: number | undefined;
  stage: string | undefined;
  threshold: number;
  reason: string;
}

// =============================================================================
// INPUT — What the adapter provides to the kernel
// =============================================================================

/**
 * Telemetry fields the adapter must provide for score computation.
 *
 * These are domain-agnostic counts that the adapter populates from
 * its specific measurement methods.
 */
export interface ScopeTelemetry {
  /** Total predicates in the plan */
  predicateCount: number;
  /** Aligned predicates where estimate == observed */
  alignmentMatchCount: number;
  /** Aligned predicates where observed > estimated */
  alignmentOverCount: number;
  /** Aligned predicates where observed < estimated */
  alignmentUnderCount: number;
  /** Predicates with cardinality === null */
  unknownCardinalityCount: number;
  /** Predicates authoritatively verified without impact evidence (e.g., HTTP, DB) */
  o5bVerifiedNoEvidenceCount: number;
  /** Edit mutations matching >1 location in target */
  fileDiffAmbiguityCount: number;
  /** Total edit mutations */
  editAmbiguityCount: number;
  /** Predicates with any impact evidence attached */
  impactEvidenceCount: number;
  /** Optional: staging proximity score (substitute when no browser observation) */
  stagingProximityScore?: number;
}

// =============================================================================
// CORE FUNCTIONS — Pure scope physics
// =============================================================================

/**
 * Compute alignment between a pre-execution estimate and post-execution observation.
 *
 * Pure function — deterministic, no side effects.
 */
export function computeAlignment(
  estimated: ScopeEstimate,
  observed: ObservedImpact,
): ScopeAlignment {
  if (estimated.cardinality === null) {
    return { status: 'unknown', note: 'No pre-execution estimate available' };
  }
  if (estimated.cardinality === observed.cardinality) {
    return { status: 'match', delta: 0 };
  }
  const delta = observed.cardinality - estimated.cardinality;
  if (delta > 0) {
    return { status: 'under', delta, note: `Estimated ${estimated.cardinality}, observed ${observed.cardinality}` };
  }
  return { status: 'over', delta, note: `Estimated ${estimated.cardinality}, observed ${observed.cardinality}` };
}

/**
 * Compute EffectAlignmentScore from adapter-provided telemetry.
 *
 * Returns zeroed score when telemetry is missing or empty.
 * Pure function — all inputs from adapter, no domain knowledge.
 */
export function computeEffectAlignmentScore(
  telemetry: ScopeTelemetry,
): EffectAlignmentScore {
  const matchCount = telemetry.alignmentMatchCount ?? 0;
  const overCount = telemetry.alignmentOverCount ?? 0;
  const underCount = telemetry.alignmentUnderCount ?? 0;
  const predCount = telemetry.predicateCount ?? 0;
  const rawUnknownCardinality = telemetry.unknownCardinalityCount ?? 0;
  const o5bCredit = telemetry.o5bVerifiedNoEvidenceCount ?? 0;
  // Subtract authoritatively verified predicates from unknown count —
  // they are verified, not "unknown."
  const unknownCardinality = Math.max(0, rawUnknownCardinality - o5bCredit);

  const totalAligned = matchCount + overCount + underCount;

  const zeroContributions: AxisContributions = {
    verificationDepth: 0,
    unknownPenalty: 0,
    underestimateRate: 0,
  };

  // No data — return zeroed score
  if (predCount === 0 && totalAligned === 0) {
    return {
      overall: 0,
      verificationDepth: 0,
      unknownPenalty: 0,
      underestimateRate: 0,
      confidence: 0,
      axisContributions: zeroContributions,
    };
  }

  // verificationDepth: predicates verified by browser alignment match OR by O.5b without evidence.
  // Both are authoritative — the predicate type doesn't matter.
  // Staging fallback: when no verification data exists, use stagingProximityScore.
  const verifiedCount = matchCount + o5bCredit;
  const rawVerificationDepth = predCount > 0 ? Math.min(1, verifiedCount / predCount) : 0;
  const verificationDepth = (rawVerificationDepth === 0 && telemetry.stagingProximityScore != null)
    ? telemetry.stagingProximityScore
    : rawVerificationDepth;

  const unknownPenalty = predCount > 0 ? Math.min(1, unknownCardinality / predCount) : 0;
  const underestimateRate = totalAligned > 0 ? Math.min(1, underCount / totalAligned) : 0;
  const confidence = predCount > 0 ? Math.min(1, totalAligned / predCount) : 0;

  // Per-axis weighted contributions
  const axisContributions: AxisContributions = {
    verificationDepth: verificationDepth * 0.50,
    unknownPenalty: (1 - unknownPenalty) * 0.25,
    underestimateRate: (1 - underestimateRate) * 0.25,
  };

  const overall = Math.min(1, Math.max(0,
    axisContributions.verificationDepth
    + axisContributions.unknownPenalty
    + axisContributions.underestimateRate,
  ));

  return {
    overall,
    verificationDepth,
    unknownPenalty,
    underestimateRate,
    confidence,
    axisContributions,
  };
}

/**
 * Evaluate the scope contract gate.
 *
 * Returns 'aligned' when score >= threshold, 'deviated' when below,
 * 'unknown' when score/stage unavailable or non-authoritative.
 *
 * Pure function — no side effects, no domain knowledge.
 */
export function evaluateScopeContract(
  score: number | undefined,
  stage: string | undefined,
  threshold: number = 0.80,
): ScopeContractResult {
  if (score === undefined || score === null) {
    return {
      verdict: 'unknown',
      score,
      stage,
      threshold,
      reason: 'No alignment score available',
    };
  }
  if (stage !== 'postdeploy') {
    return {
      verdict: 'unknown',
      score,
      stage,
      threshold,
      reason: `Score not authoritative (stage: ${stage ?? 'none'})`,
    };
  }
  if (score >= threshold) {
    return {
      verdict: 'aligned',
      score,
      stage,
      threshold,
      reason: `Scope aligned (${score.toFixed(2)} >= ${threshold})`,
    };
  }
  return {
    verdict: 'deviated',
    score,
    stage,
    threshold,
    reason: `Structural deviation detected (${score.toFixed(2)} < ${threshold})`,
  };
}

// =============================================================================
// GATE — G6 verdict production
// =============================================================================

/**
 * G6 Gate: Scope Boundedness.
 *
 * Evaluates whether mutations have bounded, predictable blast radius.
 * Called after 'constrain' gate, before 'contain' gate.
 *
 * Verdicts:
 * - 'proceed' + annotation: unknown scope (cannot estimate, but safe to continue)
 * - 'proceed': aligned scope (estimates match observations)
 * - 'narrow': deviated scope (suppress auto-approve, human must review)
 */
export function gateScope(
  scopeContract: ScopeContractResult,
): GateVerdict {
  if (scopeContract.verdict === 'aligned') {
    return {
      action: 'proceed',
      gate: 'scope',
      reason: scopeContract.reason,
    };
  }

  if (scopeContract.verdict === 'deviated') {
    return {
      action: 'narrow',
      gate: 'scope',
      reason: scopeContract.reason,
    };
  }

  // Unknown — proceed with annotation
  return {
    action: 'proceed',
    gate: 'scope',
    reason: scopeContract.reason,
  };
}
