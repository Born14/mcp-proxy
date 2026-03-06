/**
 * G1: Honesty
 * ===========
 *
 * The system cannot declare success when reality disagrees.
 *
 * Born from: Container showed "running" but HTTP returned ECONNREFUSED
 * (wrong port). Naive system would declare success.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel doesn't know what containers or HTTP are. It knows:
 * - A set of boolean signals from the adapter's verification probes
 * - Whether the goal's predicates were satisfied
 * - Whether the execution timed out or was rejected
 *
 * Extracted from: src/lib/services/checkpoint.ts:388-440
 */

// =============================================================================
// TYPES — Domain-agnostic verification primitives
// =============================================================================

/**
 * A single verification signal from the adapter.
 *
 * The adapter decides what to probe (container state, HTTP health, DB schema).
 * The kernel sees: name, passed/failed, severity.
 *
 * Maps to individual fields in VerificationResult (web adapter).
 */
export interface VerificationSignal {
  /** What was probed (adapter-defined label) */
  name: string;

  /** Did the probe pass? */
  passed: boolean;

  /** How important is this signal? */
  severity: 'critical' | 'warning' | 'info';

  /** Optional detail about the probe result */
  detail?: string;
}

/**
 * Machine-classified failure category.
 *
 * Priority-ordered: the most severe matching category wins.
 * Domain-agnostic: categories describe failure MODE, not failure DOMAIN.
 *
 * Maps to: FailureCategory in checkpoint.ts
 */
export type FailureCategory =
  | 'critical_probe_failed'   // A critical-severity probe returned false
  | 'warning_probe_failed'    // A warning-severity probe returned false
  | 'predicates_unsatisfied'  // Deployed fine but predicates didn't pass
  | 'timeout'                 // Execution timed out
  | 'rejected';               // Human rejected the plan

/**
 * Honest verification result — the kernel's view of post-execution reality.
 */
export interface HonestyVerdict {
  /** Did all critical probes pass AND all predicates satisfy? */
  honest: boolean;

  /** The signals from the adapter's probes */
  signals: VerificationSignal[];

  /** How many predicates passed vs total */
  predicatesPassed: number;
  predicatesTotal: number;

  /** Machine-classified failure category (undefined = success) */
  failureCategory?: FailureCategory;
}

// =============================================================================
// PURE FUNCTIONS
// =============================================================================

/**
 * Build an honest verification verdict from adapter signals and predicate results.
 *
 * The kernel's job: aggregate signals truthfully. Never inflate success.
 * If any critical signal fails, honest = false regardless of predicates.
 *
 * Extracted from: buildVerificationResult() in checkpoint.ts:388
 */
export function buildHonestyVerdict(
  signals: VerificationSignal[],
  predicatesPassed: number,
  predicatesTotal: number,
): HonestyVerdict {
  const anyCriticalFailed = signals.some(s => s.severity === 'critical' && !s.passed);
  const allPredicatesPassed = predicatesTotal > 0 ? predicatesPassed === predicatesTotal : true;

  return {
    honest: !anyCriticalFailed && allPredicatesPassed,
    signals,
    predicatesPassed,
    predicatesTotal,
  };
}

/**
 * Derive failure category from verification state.
 *
 * Machine classification, not LLM interpretation.
 * Priority order: rejected > timeout > critical probe > warning probe > predicates
 *
 * Extracted from: deriveFailureCategory() in checkpoint.ts:410
 */
export function deriveFailureCategory(
  verdict: HonestyVerdict,
  timedOut: boolean = false,
  rejected: boolean = false,
): FailureCategory | undefined {
  // Success = no failure category
  if (verdict.honest && !timedOut && !rejected) {
    return undefined;
  }

  // Check in priority order (most severe first)
  if (rejected) {
    return 'rejected';
  }
  if (timedOut) {
    return 'timeout';
  }

  const criticalFailed = verdict.signals.some(s => s.severity === 'critical' && !s.passed);
  if (criticalFailed) {
    return 'critical_probe_failed';
  }

  const warningFailed = verdict.signals.some(s => s.severity === 'warning' && !s.passed);
  if (warningFailed) {
    return 'warning_probe_failed';
  }

  // Deployed fine but predicates weren't satisfied
  return 'predicates_unsatisfied';
}
