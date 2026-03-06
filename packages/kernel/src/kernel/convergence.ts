/**
 * Convergence State Tracking + G8: Convergence Monotonicity
 * ==========================================================
 *
 * How the solution space narrows on retry (K5 physics).
 *
 * Born from: "The Poisoned Well" — agent tried same NOT NULL migration
 * 3 times. The convergence engine tracks: are we making progress, are we
 * stuck, or are we talking past each other?
 *
 * G8 invariant: On failure, the solution space MUST strictly narrow.
 * Iteration N+1 must have fewer valid actions than iteration N, or the
 * system escalates. Without monotonicity, retry loops burn tokens without
 * converging.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel owns:
 *   - ConvergenceState update logic
 *   - Exhaustion detection (budget exceeded, no progress)
 *   - Semantic disagreement detection (Jaccard similarity on evidence)
 *   - Empty plan stall detection (agent incapacity)
 *   - Monotonicity verification (G8: search space strictly narrows on failure)
 *
 * The adapter owns:
 *   - Action class classification (domain-specific strategy heuristics)
 *   - What constitutes a "meaningful" iteration
 *
 * Extracted from: src/lib/services/agent/agent-loop.ts (convergence detectors)
 */

import type {
  GovernanceConstraint,
  ConvergenceState,
  GateVerdict,
} from '../types.js';

// =============================================================================
// TYPES — Iteration tracking
// =============================================================================

/**
 * A single iteration record for convergence tracking.
 *
 * Maps to: IterationRecord in agent-loop.ts
 */
export interface IterationRecord {
  /** Iteration index (0-based) */
  index: number;

  /** Whether this iteration resulted in a rollback */
  rolledBack: boolean;

  /** The reason for failure (if rolled back) */
  reason: string;

  /** Number of mutations in this iteration's plan */
  mutationCount: number;

  /** Optional: action class classified by adapter */
  actionClass?: string;
}

/**
 * Convergence analysis result.
 */
export interface ConvergenceAnalysis {
  /** Overall assessment */
  status: 'progressing' | 'stalled' | 'exhausted' | 'disagreement';

  /** Whether the system should escalate to human */
  shouldEscalate: boolean;

  /** Human-readable explanation */
  reason: string;

  /** Similarity score (for disagreement detection) */
  similarity?: number;

  /** Evidence strings (for disagreement context) */
  evidence?: string[];
}

// =============================================================================
// CONVERGENCE STATE — Pure update functions
// =============================================================================

/**
 * Create initial convergence state for a new job.
 */
export function createConvergenceState(): ConvergenceState {
  return {
    activeConstraints: [],
    iterations: 0,
    emptyPlanCount: 0,
    priorEvidence: [],
    semanticDisagreement: false,
  };
}

/**
 * Record a completed iteration in convergence state.
 *
 * Returns a new ConvergenceState — never mutates the input.
 */
export function recordIteration(
  state: ConvergenceState,
  evidence: string | undefined,
  emptyPlan: boolean,
): ConvergenceState {
  return {
    ...state,
    iterations: state.iterations + 1,
    emptyPlanCount: emptyPlan ? state.emptyPlanCount + 1 : 0,
    priorEvidence: evidence
      ? [...state.priorEvidence, evidence]
      : state.priorEvidence,
  };
}

/**
 * Add a constraint to convergence state (from K5 seeding).
 *
 * Returns a new ConvergenceState — never mutates the input.
 */
export function addConstraint(
  state: ConvergenceState,
  constraint: GovernanceConstraint,
): ConvergenceState {
  return {
    ...state,
    activeConstraints: [...state.activeConstraints, constraint],
  };
}

// =============================================================================
// SEMANTIC DISAGREEMENT — Jaccard similarity on evidence words
// =============================================================================

/**
 * Stopwords for evidence comparison — filtered before similarity calc.
 *
 * Extracted from: STOPWORDS in agent-loop.ts
 */
const STOPWORDS = new Set([
  // English stopwords
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in',
  'for', 'of', 'with', 'by', 'from', 'as', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'shall', 'should', 'may', 'might', 'can', 'could', 'that', 'this',
  'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your',
  'he', 'she', 'his', 'her',
  // Verification boilerplate
  'error', 'failed', 'expected', 'actual', 'found', 'missing', 'check',
  'verification', 'predicate', 'evidence', 'result', 'value', 'status',
  'file', 'line', 'path', 'test', 'assert', 'match', 'matched',
  'not', 'but', 'got', 'instead', 'vs', 'versus',
]);

/**
 * Tokenize a string into content words (stripped of stopwords).
 * Pure function.
 */
function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

/**
 * Extract content words from a string (removing stopwords).
 * Pure function.
 */
function contentWords(s: string): Set<string> {
  return new Set(tokenize(s).filter(w => !STOPWORDS.has(w)));
}

/**
 * Compute Jaccard similarity between two sets.
 * Pure function — returns value in [0, 1].
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = Array.from(a).filter(w => b.has(w)).length;
  const union = new Set(Array.from(a).concat(Array.from(b))).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detect semantic disagreement between planner and verifier.
 *
 * Strategy: Extract CONTENT words from the last 2 rollback reasons.
 * High content similarity → same problem repeating (not disagreement).
 * Low content similarity → planner and verifier talking about different things.
 *
 * Guards (all must pass):
 * - radius_limit constraint exists (system is already narrowing)
 * - Last 2 iterations BOTH rolled back
 * - Neither reason matches a deterministic failure pattern
 * - Content words ≥3 per reason (enough signal)
 *
 * Extracted from: detectSemanticDisagreement() in agent-loop.ts
 */
export function detectSemanticDisagreement(
  history: IterationRecord[],
  constraints: GovernanceConstraint[],
): { detected: boolean; similarity: number; evidence: string[] } {
  const NO = { detected: false, similarity: 0, evidence: [] };

  // Guard: need at least 2 iterations
  if (history.length < 2) return NO;

  // Guard: radius_limit constraint must exist (proves prior narrowing)
  const hasRadiusLimit = constraints.some(c => c.type === 'radius_limit');
  if (!hasRadiusLimit) return NO;

  // Guard: last 2 iterations must both be rollbacks
  const recent = history.slice(-2);
  if (!recent.every(r => r.rolledBack && r.reason)) return NO;

  // Extract content words
  const content1 = contentWords(recent[0].reason);
  const content2 = contentWords(recent[1].reason);

  // Guard: enough content words for comparison
  if (content1.size < 3 || content2.size < 3) return NO;

  // Jaccard on content words
  const similarity = jaccardSimilarity(content1, content2);

  // Disagreement = content words diverge significantly (< 0.5)
  // High similarity means same problem repeating — not our domain
  return {
    detected: similarity < 0.5,
    similarity,
    evidence: [recent[0].reason, recent[1].reason],
  };
}

// =============================================================================
// EXHAUSTION DETECTION — When convergence fails
// =============================================================================

/**
 * Detect whether the convergence process is exhausted.
 *
 * Three exhaustion modes:
 * 1. Empty plan stall: agent keeps proposing zero mutations (incapacity)
 * 2. Iteration budget exceeded: too many attempts
 * 3. Constraint depth exceeded: too many constraints seeded
 *
 * Extracted from: agent-loop.ts exhaustion detectors
 */
export function detectExhaustion(
  state: ConvergenceState,
  config: {
    maxEmptyPlans: number;
    maxIterations: number;
    maxConstraintDepth: number;
  },
): ConvergenceAnalysis {
  // Empty plan stall: agent cannot generate mutations
  if (state.emptyPlanCount >= config.maxEmptyPlans) {
    return {
      status: 'exhausted',
      shouldEscalate: true,
      reason: `${state.emptyPlanCount} consecutive empty plans — agent cannot determine required changes`,
    };
  }

  // Iteration budget exceeded
  if (state.iterations >= config.maxIterations) {
    return {
      status: 'exhausted',
      shouldEscalate: true,
      reason: `${state.iterations} iterations without convergence — iteration budget exceeded`,
    };
  }

  // Constraint depth exceeded — solution space is too narrow
  if (state.activeConstraints.length >= config.maxConstraintDepth) {
    return {
      status: 'exhausted',
      shouldEscalate: true,
      reason: `${state.activeConstraints.length} active constraints — goal cannot be satisfied within consistent solution space`,
    };
  }

  // Semantic disagreement previously detected
  if (state.semanticDisagreement) {
    return {
      status: 'disagreement',
      shouldEscalate: true,
      reason: 'Semantic disagreement detected — planner and verifier interpreting goal differently',
    };
  }

  // Still converging
  return {
    status: state.iterations === 0 ? 'progressing' : (
      state.activeConstraints.length > 0 ? 'stalled' : 'progressing'
    ),
    shouldEscalate: false,
    reason: state.activeConstraints.length > 0
      ? `Iteration ${state.iterations}, ${state.activeConstraints.length} constraints active — narrowing`
      : `Iteration ${state.iterations} — progressing`,
  };
}

/**
 * Convert convergence analysis to a gate verdict.
 */
export function convergenceVerdict(analysis: ConvergenceAnalysis): GateVerdict {
  if (!analysis.shouldEscalate) {
    return {
      action: 'proceed',
      gate: 'plan',
      reason: analysis.reason,
    };
  }

  if (analysis.status === 'disagreement') {
    return {
      action: 'escalate',
      gate: 'plan',
      reason: analysis.reason,
      escalationContext: {
        clarificationNeeded: {
          evidence: analysis.evidence || [],
          similarity: analysis.similarity || 0,
        },
      },
    };
  }

  // Exhausted — block with explanation
  return {
    action: 'block',
    gate: 'plan',
    reason: analysis.reason,
  };
}

// =============================================================================
// G8: CONVERGENCE MONOTONICITY — Search space must strictly narrow on failure
// =============================================================================

/**
 * A snapshot of the solution space at a given iteration.
 *
 * The adapter populates this from domain-specific measurements.
 * The kernel compares snapshots to verify monotonic narrowing.
 */
export interface SolutionSpaceSnapshot {
  /** Iteration index (0-based) */
  iteration: number;

  /** Number of active constraints at this point */
  constraintCount: number;

  /** Total number of mutation targets still allowed (if known) */
  allowedTargets?: number;

  /** Maximum mutation count allowed by radius limits (if constrained) */
  maxMutations?: number;

  /** Number of banned action classes */
  bannedActionClasses: number;

  /** Number of banned predicate fingerprints */
  bannedFingerprints: number;

  /** Whether this iteration resulted in a rollback */
  wasRollback: boolean;
}

/**
 * Result of monotonicity verification between two solution space snapshots.
 */
export interface MonotonicityResult {
  /** Whether the solution space strictly narrowed */
  monotonic: boolean;

  /** What kind of narrowing occurred (if any) */
  narrowingType: 'constraint_added' | 'radius_reduced' | 'action_banned' | 'fingerprint_banned' | 'none' | 'multiple';

  /** How much the space narrowed (larger = more narrowing) */
  narrowingMagnitude: number;

  /** Human-readable explanation */
  reason: string;
}

/**
 * Verify that the solution space strictly narrowed between two iterations.
 *
 * G8 invariant: After a failure (rollback), the next iteration MUST have
 * a strictly smaller solution space. This prevents retry loops that burn
 * tokens without converging.
 *
 * The comparison checks multiple axes:
 *   1. Constraint count increased (K5 seeded a new constraint)
 *   2. Max mutations decreased (radius limit tightened)
 *   3. Banned action classes increased (strategy eliminated)
 *   4. Banned fingerprints increased (predicate variant eliminated)
 *
 * If the previous iteration was NOT a rollback, monotonicity is trivially
 * satisfied (no failure → no narrowing requirement).
 *
 * Pure function — deterministic, no side effects.
 */
export function verifyMonotonicity(
  prev: SolutionSpaceSnapshot,
  next: SolutionSpaceSnapshot,
): MonotonicityResult {
  // If the previous iteration was not a rollback, no narrowing required
  if (!prev.wasRollback) {
    return {
      monotonic: true,
      narrowingType: 'none',
      narrowingMagnitude: 0,
      reason: `Iteration ${prev.iteration} did not fail — no narrowing required`,
    };
  }

  // Check all narrowing axes
  const constraintAdded = next.constraintCount > prev.constraintCount;
  const radiusReduced = (
    next.maxMutations !== undefined &&
    prev.maxMutations !== undefined &&
    next.maxMutations < prev.maxMutations
  );
  const actionBanned = next.bannedActionClasses > prev.bannedActionClasses;
  const fingerprintBanned = next.bannedFingerprints > prev.bannedFingerprints;

  const narrowingAxes = [
    constraintAdded && 'constraint_added',
    radiusReduced && 'radius_reduced',
    actionBanned && 'action_banned',
    fingerprintBanned && 'fingerprint_banned',
  ].filter(Boolean) as MonotonicityResult['narrowingType'][];

  if (narrowingAxes.length === 0) {
    return {
      monotonic: false,
      narrowingType: 'none',
      narrowingMagnitude: 0,
      reason: `Iteration ${prev.iteration} failed but solution space did not narrow — ` +
        `constraints: ${prev.constraintCount}→${next.constraintCount}, ` +
        `banned actions: ${prev.bannedActionClasses}→${next.bannedActionClasses}, ` +
        `banned fingerprints: ${prev.bannedFingerprints}→${next.bannedFingerprints}`,
    };
  }

  // Compute narrowing magnitude (sum of all narrowing deltas)
  let magnitude = 0;
  if (constraintAdded) magnitude += (next.constraintCount - prev.constraintCount);
  if (radiusReduced) magnitude += (prev.maxMutations! - next.maxMutations!);
  if (actionBanned) magnitude += (next.bannedActionClasses - prev.bannedActionClasses);
  if (fingerprintBanned) magnitude += (next.bannedFingerprints - prev.bannedFingerprints);

  const narrowingType = narrowingAxes.length === 1 ? narrowingAxes[0] : 'multiple';

  const details: string[] = [];
  if (constraintAdded) details.push(`+${next.constraintCount - prev.constraintCount} constraint(s)`);
  if (radiusReduced) details.push(`radius ${prev.maxMutations}→${next.maxMutations}`);
  if (actionBanned) details.push(`+${next.bannedActionClasses - prev.bannedActionClasses} banned action(s)`);
  if (fingerprintBanned) details.push(`+${next.bannedFingerprints - prev.bannedFingerprints} banned fingerprint(s)`);

  return {
    monotonic: true,
    narrowingType,
    narrowingMagnitude: magnitude,
    reason: `Solution space narrowed: ${details.join(', ')}`,
  };
}

/**
 * Verify monotonicity across a full iteration history.
 *
 * Checks every consecutive pair of snapshots where the first was a rollback.
 * Returns the first violation found, or a passing result.
 *
 * Pure function.
 */
export function verifyMonotonicityChain(
  snapshots: SolutionSpaceSnapshot[],
): { monotonic: boolean; violations: MonotonicityResult[]; passCount: number } {
  if (snapshots.length < 2) {
    return { monotonic: true, violations: [], passCount: 0 };
  }

  const violations: MonotonicityResult[] = [];
  let passCount = 0;

  for (let i = 0; i < snapshots.length - 1; i++) {
    const result = verifyMonotonicity(snapshots[i], snapshots[i + 1]);
    if (result.monotonic) {
      if (snapshots[i].wasRollback) passCount++;
    } else {
      violations.push(result);
    }
  }

  return {
    monotonic: violations.length === 0,
    violations,
    passCount,
  };
}

// =============================================================================
// GATE — G8 verdict production
// =============================================================================

/**
 * G8 Gate: Convergence Monotonicity.
 *
 * Verifies that the search space is strictly narrowing on failure.
 * Called after 'verify' gate, used as convergence health check.
 *
 * Verdicts:
 * - 'proceed': monotonicity holds (or no rollbacks occurred)
 * - 'proceed' + reason: first iteration (nothing to compare)
 * - 'escalate': monotonicity violated (retry without narrowing)
 *   System should escalate to human rather than continue burning tokens
 * - 'block': exhaustion detected (delegates to detectExhaustion)
 */
export function gateConvergence(
  snapshots: SolutionSpaceSnapshot[],
  state: ConvergenceState,
  config: {
    maxEmptyPlans: number;
    maxIterations: number;
    maxConstraintDepth: number;
  },
): GateVerdict {
  // First check exhaustion (from existing convergence tracking)
  const exhaustion = detectExhaustion(state, config);
  if (exhaustion.shouldEscalate) {
    return convergenceVerdict(exhaustion);
  }

  // Check monotonicity across the snapshot chain
  const chain = verifyMonotonicityChain(snapshots);

  if (!chain.monotonic) {
    const firstViolation = chain.violations[0];
    return {
      action: 'escalate',
      gate: 'converge',
      reason: `Convergence monotonicity violated: ${firstViolation.reason}`,
      escalationContext: {
        clarificationNeeded: {
          evidence: chain.violations.map(v => v.reason),
          similarity: 0,
        },
      },
    };
  }

  // All good
  return {
    action: 'proceed',
    gate: 'converge',
    reason: chain.passCount > 0
      ? `Monotonicity verified across ${chain.passCount} rollback-recovery pair(s)`
      : 'No rollbacks — monotonicity trivially satisfied',
  };
}
