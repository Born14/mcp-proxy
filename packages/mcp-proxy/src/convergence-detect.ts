/**
 * Convergence Exhaustion Detection
 * ==================================
 *
 * Detects when the agent is stuck in a convergence loop — empty plans,
 * iteration budget exceeded, constraint depth exceeded, or semantic
 * disagreement between planner and verifier.
 *
 * Zero dependencies. Pure functions.
 *
 * Ported from: packages/kernel/src/kernel/convergence.ts
 */

// =============================================================================
// TYPES
// =============================================================================

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

export interface ConvergenceConfig {
  /** Max consecutive empty plans before escalating */
  maxEmptyPlans: number;

  /** Max total iterations before escalating */
  maxIterations: number;

  /** Max active constraints before escalating */
  maxConstraintDepth: number;
}

/** Minimal constraint shape — only needs type field for exhaustion check */
export interface ConstraintLike {
  type: string;
}

/** Minimal convergence state for exhaustion detection */
export interface ConvergenceState {
  iterations: number;
  emptyPlanCount: number;
  activeConstraints: ConstraintLike[];
  semanticDisagreement: boolean;
}

export interface ConvergenceVerdict {
  action: 'proceed' | 'escalate' | 'block';
  gate: string;
  reason: string;
  escalationContext?: {
    clarificationNeeded: {
      evidence: string[];
      similarity: number;
    };
  };
}

// =============================================================================
// STOPWORDS — for semantic disagreement detection
// =============================================================================

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

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Tokenize a string into words (stripped of numbers and punctuation).
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
 */
function contentWords(s: string): Set<string> {
  return new Set(tokenize(s).filter(w => !STOPWORDS.has(w)));
}

/**
 * Compute Jaccard similarity between two sets.
 * Returns value in [0, 1].
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = Array.from(a).filter(w => b.has(w)).length;
  const union = new Set(Array.from(a).concat(Array.from(b))).size;
  return union > 0 ? intersection / union : 0;
}

// =============================================================================
// DETECTION FUNCTIONS
// =============================================================================

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
 * - Content words ≥3 per reason (enough signal)
 */
export function detectSemanticDisagreement(
  history: IterationRecord[],
  constraints: ConstraintLike[],
): { detected: boolean; similarity: number; evidence: string[] } {
  const NO = { detected: false, similarity: 0, evidence: [] as string[] };

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

/**
 * Detect whether the convergence process is exhausted.
 *
 * Three exhaustion modes:
 * 1. Empty plan stall: agent keeps proposing zero mutations (incapacity)
 * 2. Iteration budget exceeded: too many attempts
 * 3. Constraint depth exceeded: too many constraints seeded
 */
export function detectExhaustion(
  state: ConvergenceState,
  config: ConvergenceConfig,
): ConvergenceAnalysis {
  // Empty plan stall
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

  // Constraint depth exceeded
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
export function convergenceVerdict(analysis: ConvergenceAnalysis): ConvergenceVerdict {
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

  // Exhausted — block
  return {
    action: 'block',
    gate: 'plan',
    reason: analysis.reason,
  };
}
