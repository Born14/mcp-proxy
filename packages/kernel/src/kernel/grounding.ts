/**
 * G7: Epistemic Grounding
 * =======================
 *
 * Claims must reference observable reality, not hallucinated state.
 *
 * Born from: Predicate grounding misses (Feb 2026). LLMs fabricated CSS
 * selectors (`.nonexistent-class`) and the system tried to verify against
 * elements that never existed. O.5b passed vacuously — 0 predicates to check.
 *
 * The kernel sees abstract evidence, not domain facts. Grounding evidence is:
 *   { domain: string, timestamp: number, coverageScore: number,
 *     hardMissCount: number, softMissCount: number, stalenessMs?: number }
 *
 * The adapter reads CSS files, parses Terraform state, queries Kubernetes —
 * whatever its domain requires. It computes coverageScore and hardMissCount.
 * The kernel evaluates f(evidence[], threshold, maxStaleness) → verdict.
 *
 * If the kernel ever parses CSS, HTML, HCL, or YAML, you've crossed the streams.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 */

import type { GateVerdict } from '../types.js';

// =============================================================================
// TYPES — Domain-agnostic grounding evidence
// =============================================================================

/**
 * Abstract grounding evidence from a domain adapter.
 *
 * The adapter grounds predicates against reality (CSS files, Terraform state,
 * Kubernetes manifests, database schema) and summarizes into this structure.
 * The kernel evaluates coverage and staleness without knowing the domain.
 */
export interface GroundingEvidence {
  /** Opaque domain identifier (e.g., 'css', 'terraform', 'k8s', 'sql') */
  domain: string;

  /** When was reality observed? */
  timestamp: number;

  /** How much of the claimed surface is grounded? (0.0–1.0) */
  coverageScore: number;

  /** Claims referencing targets that definitely don't exist */
  hardMissCount: number;

  /** Claims referencing targets that are ambiguous or might not exist */
  softMissCount: number;

  /** Total claims evaluated against this evidence */
  totalClaims: number;

  /** How old is this evidence? (computed from timestamp) */
  stalenessMs?: number;
}

/**
 * Coverage evaluation result.
 */
export interface CoverageResult {
  /** Overall assessment */
  status: 'grounded' | 'partially_grounded' | 'ungrounded' | 'stale' | 'missing';

  /** Composite coverage score across all evidence (0.0–1.0) */
  overallCoverage: number;

  /** Number of hard misses across all evidence */
  totalHardMisses: number;

  /** Number of soft misses across all evidence */
  totalSoftMisses: number;

  /** Number of evidence sources that are stale */
  staleCount: number;

  /** Human-readable summary */
  reason: string;
}

/**
 * Grounding configuration thresholds.
 */
export interface GroundingConfig {
  /** Minimum coverage score to proceed without annotation (default: 0.7) */
  minCoverageScore: number;

  /** Maximum staleness before evidence is treated as missing (default: 300000ms = 5min) */
  maxStalenessMs: number;

  /** Maximum hard misses before blocking (default: 0 = zero tolerance) */
  maxHardMisses: number;
}

const DEFAULT_GROUNDING_CONFIG: GroundingConfig = {
  minCoverageScore: 0.7,
  maxStalenessMs: 300000, // 5 minutes
  maxHardMisses: 0,
};

// =============================================================================
// CORE FUNCTIONS — Pure grounding evaluation
// =============================================================================

/**
 * Evaluate grounding coverage across all evidence sources.
 *
 * Pure function — deterministic, no side effects, no domain knowledge.
 */
export function evaluateGroundingCoverage(
  evidence: GroundingEvidence[],
  config: Partial<GroundingConfig> = {},
): CoverageResult {
  const cfg = { ...DEFAULT_GROUNDING_CONFIG, ...config };

  // No evidence at all — completely ungrounded
  if (evidence.length === 0) {
    return {
      status: 'missing',
      overallCoverage: 0,
      totalHardMisses: 0,
      totalSoftMisses: 0,
      staleCount: 0,
      reason: 'No grounding evidence provided — claims are unverified',
    };
  }

  const now = Date.now();
  let totalHardMisses = 0;
  let totalSoftMisses = 0;
  let staleCount = 0;
  let weightedCoverage = 0;
  let totalWeight = 0;

  for (const ev of evidence) {
    totalHardMisses += ev.hardMissCount;
    totalSoftMisses += ev.softMissCount;

    // Staleness check
    const staleness = ev.stalenessMs ?? (now - ev.timestamp);
    if (staleness > cfg.maxStalenessMs) {
      staleCount++;
      // Stale evidence gets 0 coverage weight
      continue;
    }

    // Weight by total claims (more claims = more important evidence)
    const weight = Math.max(1, ev.totalClaims);
    weightedCoverage += ev.coverageScore * weight;
    totalWeight += weight;
  }

  const overallCoverage = totalWeight > 0 ? weightedCoverage / totalWeight : 0;

  // All evidence is stale
  if (staleCount === evidence.length) {
    return {
      status: 'stale',
      overallCoverage: 0,
      totalHardMisses,
      totalSoftMisses,
      staleCount,
      reason: `All ${evidence.length} evidence source(s) are stale (>${cfg.maxStalenessMs}ms) — effectively ungrounded`,
    };
  }

  // Hard misses exceed threshold
  if (totalHardMisses > cfg.maxHardMisses) {
    return {
      status: 'ungrounded',
      overallCoverage,
      totalHardMisses,
      totalSoftMisses,
      staleCount,
      reason: `${totalHardMisses} hard grounding miss(es) — claims reference non-existent targets`,
    };
  }

  // Coverage below threshold
  if (overallCoverage < cfg.minCoverageScore) {
    return {
      status: 'partially_grounded',
      overallCoverage,
      totalHardMisses,
      totalSoftMisses,
      staleCount,
      reason: `Coverage ${(overallCoverage * 100).toFixed(0)}% is below threshold ${(cfg.minCoverageScore * 100).toFixed(0)}%`,
    };
  }

  // All clear
  return {
    status: 'grounded',
    overallCoverage,
    totalHardMisses,
    totalSoftMisses,
    staleCount,
    reason: `Grounded: ${(overallCoverage * 100).toFixed(0)}% coverage across ${evidence.length - staleCount} source(s)`,
  };
}

// =============================================================================
// GATE — G7 verdict production
// =============================================================================

/**
 * G7 Gate: Epistemic Grounding.
 *
 * No plan executes without grounding evidence attached.
 * Called after 'classify' gate, before 'extract' gate.
 *
 * Verdicts:
 * - 'proceed': grounded (all claims reference observable reality)
 * - 'proceed' + reason: partially grounded (soft misses, but acceptable)
 * - 'block': hard misses (claims reference non-existent targets)
 * - 'block': stale/missing evidence (effectively ungrounded)
 * - 'escalate': coverage below threshold (needs human clarification)
 */
export function gateGrounding(
  evidence: GroundingEvidence[],
  config?: Partial<GroundingConfig>,
): GateVerdict {
  const result = evaluateGroundingCoverage(evidence, config);

  switch (result.status) {
    case 'grounded':
      return {
        action: 'proceed',
        gate: 'grounding',
        reason: result.reason,
      };

    case 'partially_grounded':
      return {
        action: 'escalate',
        gate: 'grounding',
        reason: result.reason,
        escalationContext: {
          clarificationNeeded: {
            evidence: [`Coverage: ${(result.overallCoverage * 100).toFixed(0)}%`, `Soft misses: ${result.totalSoftMisses}`],
            similarity: result.overallCoverage,
          },
        },
      };

    case 'ungrounded':
      return {
        action: 'block',
        gate: 'grounding',
        reason: result.reason,
      };

    case 'stale':
      return {
        action: 'block',
        gate: 'grounding',
        reason: result.reason,
      };

    case 'missing':
      return {
        action: 'block',
        gate: 'grounding',
        reason: result.reason,
      };
  }
}
