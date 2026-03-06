/**
 * G2: Non-Repetition
 * ===================
 *
 * The system cannot repeat a strategy that already failed.
 *
 * Born from: "The Poisoned Well" — agent tried same NOT NULL migration
 * 3 times, each time crashing the app identically. K5 constraint seeding born.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel owns:
 *   - Signature extraction (regex-based failure classification)
 *   - Constraint evaluation (does a plan violate known failure patterns?)
 *   - Plan surface extraction (what files/intents does a mutation set touch?)
 *
 * The adapter owns:
 *   - Action class classification (domain-specific strategy heuristics)
 *   - What file extensions mean what intents
 *
 * Extracted from: src/lib/services/memory.ts + src/lib/services/planner.ts
 */

import type {
  GovernanceConstraint,
  Mutation,
  FailureEvent,
  GateVerdict,
} from '../types.js';

// =============================================================================
// TYPES — Domain-agnostic plan surface
// =============================================================================

/**
 * Structural representation of a plan's mutation footprint.
 *
 * The adapter extracts this from domain-specific mutations.
 * The kernel evaluates constraints against it.
 *
 * Maps to: PlanSurface in planner.ts
 */
export interface PlanSurface {
  /** Files the plan will touch */
  files: string[];

  /** Inferred intent tags (adapter-provided, e.g., 'routes', 'schema', 'ui') */
  intents: string[];

  /** Adapter-provided properties for pattern matching */
  properties: Record<string, boolean>;
}

/**
 * Result of checking all constraints against a plan.
 */
export interface ConstraintCheckResult {
  /** The first violated constraint (null if all pass) */
  violation: ConstraintViolation | null;

  /** Constraints that were explicitly overridden by human */
  overridden: Array<{ signature: string; reason: string }>;
}

/**
 * A single constraint violation.
 */
export interface ConstraintViolation {
  constraintId: string;
  signature: string;
  reason: string;
  surface: PlanSurface;
  constraint: GovernanceConstraint;
}

// =============================================================================
// SIGNATURE EXTRACTION — Deterministic failure pattern matching
// =============================================================================

/**
 * Signature extraction rules — simple regex matching on error strings.
 * Priority order: first match wins.
 *
 * These patterns are domain-agnostic failure *modes*, not domain-specific
 * failure *causes*. A timeout is a timeout whether it's SQL or Terraform.
 *
 * Extracted from: SIGNATURE_PATTERNS in memory.ts:148-179
 */
const SIGNATURE_PATTERNS: Array<{ pattern: RegExp; signature: string }> = [
  // Timeout patterns
  { pattern: /timeout|exceeded.*time|timed?\s*out/i, signature: 'timeout' },
  // Port conflicts
  { pattern: /EADDRINUSE|port.*in use|address.*in use/i, signature: 'port_conflict' },
  // Syntax errors
  { pattern: /SyntaxError|Unexpected token|Parse error/i, signature: 'syntax_error' },
  // Missing modules/dependencies
  { pattern: /Cannot find module|MODULE_NOT_FOUND|no such file or directory/i, signature: 'missing_dependency' },
  // Build failures
  { pattern: /build.*fail|compilation.*fail|exit code [1-9]/i, signature: 'build_failure' },
  // Health check failures
  { pattern: /health.*check.*fail|unhealthy|502.*spike|503|504/i, signature: 'health_check_failure' },
  // Connection refused
  { pattern: /ECONNREFUSED|connection refused|connect ECONNREFUSED/i, signature: 'connection_refused' },
  // Out of memory
  { pattern: /out of memory|OOM|ENOMEM|killed.*memory/i, signature: 'oom_killed' },
  // Constraint violations (domain-agnostic: any uniqueness/FK/null constraint)
  { pattern: /duplicate key|unique constraint|foreign key constraint|not-null constraint|not null/i, signature: 'constraint_violation' },
  // Missing resources
  { pattern: /relation.*does not exist|table.*not found|resource.*not found/i, signature: 'missing_resource' },
  // Deadlocks
  { pattern: /deadlock|lock wait timeout/i, signature: 'deadlock' },
  // Container/process errors
  { pattern: /no such container|container.*not found/i, signature: 'container_not_found' },
  { pattern: /image.*not found|pull.*fail/i, signature: 'image_not_found' },
  // Crash patterns
  { pattern: /crash.*loop|CrashLoopBackOff/i, signature: 'crash_loop' },
  { pattern: /segmentation fault|SIGSEGV/i, signature: 'segfault' },
  // Verification failures
  { pattern: /not found in DOM|not found\)|Element not found/i, signature: 'element_not_found' },
  { pattern: /actual:.*expected:|[Vv]alue mismatch|wrong value/i, signature: 'value_mismatch' },
  { pattern: /predicate.*failed|evidence.*FAILED/i, signature: 'predicate_failure' },
];

/**
 * Extract a failure signature from an error string.
 * Deterministic regex matching — not LLM inference.
 *
 * Extracted from: extractSignature() in memory.ts:185-196
 */
export function extractSignature(errorString: string): string | undefined {
  if (!errorString) return undefined;

  for (const { pattern, signature } of SIGNATURE_PATTERNS) {
    if (pattern.test(errorString)) {
      return signature;
    }
  }

  return undefined;
}

// =============================================================================
// CONSTRAINT EVALUATION — Does a plan violate known failure patterns?
// =============================================================================

/**
 * Check a single constraint against a plan surface.
 *
 * Returns true if constraint is satisfied, false if violated.
 *
 * Extracted from: checkConstraint() in planner.ts:623-682
 */
export function checkConstraint(
  surface: PlanSurface,
  constraint: GovernanceConstraint,
  riskClass: string,
): boolean {
  // goal_drift_ban: simple risk class check
  if (constraint.type === 'goal_drift_ban') {
    return !constraint.appliesTo.includes(riskClass);
  }

  // radius_limit: check mutation count
  if (constraint.type === 'radius_limit') {
    const maxMutations = constraint.requires.maxMutations;
    if (maxMutations !== undefined && surface.files.length > maxMutations) {
      return false;
    }
    return true;
  }

  // forbidden_action: only check constraints that apply to this risk class
  if (!constraint.appliesTo.includes(riskClass)) {
    return true;
  }

  // Does this plan touch the constraint's surface?
  const touchesSurface =
    (constraint.surface.files.length === 0 && constraint.surface.intents.length === 0) ||
    surface.files.some(f =>
      constraint.surface.files.some(cf =>
        f.includes(cf) || f.endsWith(cf)
      )
    ) ||
    surface.intents.some(i => constraint.surface.intents.includes(i));

  if (!touchesSurface) {
    return true;
  }

  // Plan touches the constraint's surface — check requirements
  if (constraint.requires.patterns) {
    for (const pattern of constraint.requires.patterns) {
      if (!surface.properties[pattern]) {
        return false;
      }
    }
  }

  if (constraint.requires.files) {
    for (const requiredFile of constraint.requires.files) {
      if (!surface.files.some(f => f.includes(requiredFile))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Check all constraints against a plan.
 *
 * This is gate 6 (constrain) in the gate sequence.
 * If a constraint is violated and not overridden, the plan is rejected.
 *
 * Extracted from: checkPlanConstraints() in planner.ts:706-757
 */
export function checkAllConstraints(
  surface: PlanSurface,
  constraints: GovernanceConstraint[],
  riskClass: string,
  overrides?: string[],
): ConstraintCheckResult {
  const overridden: Array<{ signature: string; reason: string }> = [];

  if (constraints.length === 0) {
    return { violation: null, overridden: [] };
  }

  // Filter expired constraints (lazy cleanup)
  const now = Date.now();
  const active = constraints.filter(c => !c.expiresAt || c.expiresAt > now);

  const overrideSet = new Set(overrides || []);

  for (const constraint of active) {
    const satisfied = checkConstraint(surface, constraint, riskClass);

    if (!satisfied) {
      if (overrideSet.has(constraint.signature)) {
        overridden.push({ signature: constraint.signature, reason: constraint.reason });
        continue;
      }

      return {
        violation: {
          constraintId: constraint.id,
          signature: constraint.signature,
          reason: constraint.reason,
          surface,
          constraint,
        },
        overridden,
      };
    }
  }

  return { violation: null, overridden };
}

/**
 * Convert constraint check result to a gate verdict.
 */
export function constraintVerdict(result: ConstraintCheckResult): GateVerdict {
  if (result.violation) {
    return {
      action: 'block',
      gate: 'constrain',
      reason: `CONSTRAINT VIOLATION: ${result.violation.signature} — ${result.violation.reason}`,
      escalationContext: {
        constraintViolation: {
          constraintId: result.violation.constraintId,
          signature: result.violation.signature,
          reason: result.violation.reason,
        },
      },
    };
  }

  return {
    action: 'proceed',
    gate: 'constrain',
    reason: result.overridden.length > 0
      ? `Constraints passed (${result.overridden.length} overridden)`
      : 'All constraints satisfied',
  };
}

// =============================================================================
// EVIDENCE FORMATTING — Pure text construction for context injection
// =============================================================================

/**
 * File outcome evidence — structured facts about a file's history.
 */
export interface FileOutcomeEvidence {
  file: string;
  totalOutcomes: number;
  successes: number;
  failures: number;
  rollbacks: number;
  lastFailure?: { checkpoint: string; date: string; reason: string };
  lastSuccess?: { checkpoint: string; date: string };
  trendStreak: number;  // positive = consecutive successes, negative = consecutive failures
}

/**
 * Pattern evidence — known failure patterns with winning fixes.
 */
export interface PatternEvidence {
  signature: string;
  occurrences: number;
  winningFixes: string[];
}

/**
 * Build the evidence injection block for planning context.
 * Facts only — no risk labels, no scores, no editorial.
 *
 * Extracted from: buildEvidenceBlock() in memory.ts:667-714
 */
export function buildEvidenceBlock(
  contextLabel: string,
  fileEvidence: FileOutcomeEvidence[],
  patterns: PatternEvidence[],
): string | undefined {
  if (fileEvidence.length === 0 && patterns.length === 0) {
    return undefined;
  }

  const lines: string[] = [`[OPERATIONAL MEMORY — ${contextLabel}]`, ''];

  if (fileEvidence.length > 0) {
    lines.push('Recent outcomes for files likely to be touched:', '');

    for (const fe of fileEvidence) {
      lines.push(`  ${fe.file}`);
      lines.push(`    outcomes: ${fe.totalOutcomes} total (${fe.successes} success${fe.successes !== 1 ? 'es' : ''}, ${fe.failures} failure${fe.failures !== 1 ? 's' : ''}, ${fe.rollbacks} rollback${fe.rollbacks !== 1 ? 's' : ''})`);

      if (fe.lastFailure) {
        lines.push(`    last failure: ${fe.lastFailure.checkpoint} (${fe.lastFailure.date}) — ${fe.lastFailure.reason}`);
      }
      if (fe.lastSuccess) {
        lines.push(`    last success: ${fe.lastSuccess.checkpoint} (${fe.lastSuccess.date}) — verified OK`);
      }
      if (fe.trendStreak !== 0) {
        const trendDesc = fe.trendStreak > 0
          ? `${fe.trendStreak} consecutive success${fe.trendStreak !== 1 ? 'es' : ''}`
          : `${Math.abs(fe.trendStreak)} consecutive failure${fe.trendStreak !== -1 ? 's' : ''}`;
        lines.push(`    trend: ${trendDesc}`);
      }
      lines.push('');
    }
  }

  if (patterns.length > 0) {
    lines.push('Known patterns on this context:');
    for (const p of patterns) {
      const fixes = p.winningFixes.length > 0
        ? `winning fixes: ${p.winningFixes.join('; ')}`
        : 'no recorded fixes yet';
      lines.push(`  ${p.signature} (seen ${p.occurrences}x) — ${fixes}`);
    }
  }

  return lines.join('\n');
}
