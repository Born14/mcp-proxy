/**
 * G3: Entropy Resilience
 * ======================
 *
 * Verification survives partial deploys and system entropy.
 *
 * Born from: "The Partial Deploy" — npm install failed mid-deploy,
 * container started from cache, `/health` passed but `/api/stats` threw.
 * Zombie caught by log scanning.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel owns:
 *   - Snapshot integrity comparison (hash determinism)
 *   - State change detection (set difference for un-rollbackable changes)
 *   - Error pattern matching (zombie detection — domain-agnostic signatures)
 *   - Evidence chain completeness (monotonicity invariant)
 *
 * The adapter owns:
 *   - What files to snapshot (collectSnapshotFiles)
 *   - How to compute content hashes (file-level vs directory-level)
 *   - What log lines mean in context (severity classification)
 *
 * Extracted from: src/lib/snapshots.ts, src/lib/services/checkpoint.ts,
 * tests/constitutional/reality.test.ts
 */

import type { GateVerdict } from '../types.js';

// =============================================================================
// TYPES — Domain-agnostic entropy detection
// =============================================================================

/**
 * Snapshot metadata — the kernel's view of a captured state.
 *
 * The kernel doesn't know about files vs containers vs Terraform state.
 * It knows that a snapshot has a hash, a timestamp, and a list of artifacts.
 *
 * Maps to: Snapshot.metadata in snapshots.ts
 */
export interface SnapshotRecord {
  /** Unique snapshot identifier */
  id: string;

  /** When the snapshot was captured */
  timestamp: number;

  /** Cryptographic hash of the snapshot contents */
  contentHash: string;

  /** Adapter-provided list of artifact identifiers captured */
  artifacts: string[];
}

/**
 * Result of comparing two states for drift.
 */
export interface DriftResult {
  /** Whether any drift was detected */
  drifted: boolean;

  /** Hash at snapshot time */
  expectedHash: string;

  /** Hash at comparison time */
  actualHash: string;

  /** Artifacts present now but not in snapshot */
  added: string[];

  /** Artifacts in snapshot but not present now */
  removed: string[];

  /** Artifacts in both but with different content */
  modified: string[];
}

/**
 * Result of scanning for error patterns (zombie detection).
 */
export interface ErrorScanResult {
  /** Whether any errors were detected */
  hasErrors: boolean;

  /** Matched error lines with their pattern classification */
  matches: Array<{
    line: string;
    pattern: string;
    severity: 'error' | 'fatal' | 'warning';
  }>;

  /** Count by severity */
  errorCount: number;
  fatalCount: number;
  warningCount: number;
}

/**
 * Evidence chain — the complete evidence from a verification cycle.
 *
 * The monotonicity invariant: if any critical signal fails,
 * the chain MUST produce a failure category. Success evidence
 * cannot override failure evidence.
 */
export interface EvidenceChain {
  /** Ordered list of evidence items, each with a boolean verdict */
  items: Array<{
    name: string;
    passed: boolean;
    severity: 'critical' | 'warning' | 'info';
    detail?: string;
  }>;

  /** Whether goals/predicates were achieved */
  goalAchieved: boolean;

  /** Whether the operation timed out */
  timedOut: boolean;

  /** Whether the human rejected */
  rejected: boolean;
}

/**
 * Failure categories — exhaustive set of reasons a verification chain can fail.
 * Typed union prevents typo drift across kernel, adapter, and MCP surfaces.
 */
export type FailureCategory =
  | 'no_evidence'            // Goal claimed with zero proof (epistemic minimum)
  | 'rejected'               // Human rejected
  | 'timeout'                // Operation timed out
  | 'critical_probe_failed'  // Critical evidence item failed
  | 'warning_probe_failed'   // Warning evidence item failed
  | 'goal_not_achieved';     // Goal not achieved (functional failure)

/**
 * Result of verifying evidence chain completeness.
 */
export interface ChainCompletenessResult {
  /** Whether the chain is complete and consistent */
  complete: boolean;

  /** The highest-severity failure in the chain */
  failureCategory?: FailureCategory;

  /** Whether any critical item contradicts the goal verdict */
  hasContradiction: boolean;

  /** Description of the contradiction (if any) */
  contradictionDetail?: string;
}

// =============================================================================
// ZOMBIE DETECTION — Domain-agnostic error pattern matching
// =============================================================================

/**
 * Error patterns for zombie detection — log lines that indicate a "running
 * but broken" state. Domain-agnostic: these are runtime error signatures,
 * not domain-specific failure causes.
 *
 * Extracted from: LOG_ERROR_PATTERN in agent.ts:4820
 */
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  severity: 'error' | 'fatal' | 'warning';
}> = [
  // Fatal / crash patterns
  { pattern: /FATAL|panic|segfault|OOMKilled/i, name: 'fatal_crash', severity: 'fatal' },
  { pattern: /Traceback \(most recent call last\)/i, name: 'python_traceback', severity: 'fatal' },
  { pattern: /exit code [1-9]\d*/i, name: 'non_zero_exit', severity: 'fatal' },

  // Connection / service errors
  { pattern: /ECONNREFUSED/i, name: 'connection_refused', severity: 'error' },
  { pattern: /EADDRINUSE/i, name: 'port_in_use', severity: 'error' },

  // Runtime errors
  { pattern: /Error:|Exception:|TypeError:|ReferenceError:|SyntaxError:/i, name: 'runtime_error', severity: 'error' },
  { pattern: /Cannot find module|MODULE_NOT_FOUND/i, name: 'missing_module', severity: 'error' },
  { pattern: /ENOENT|no such file/i, name: 'file_not_found', severity: 'error' },

  // Warning patterns
  { pattern: /DeprecationWarning|ExperimentalWarning/i, name: 'deprecation', severity: 'warning' },
];

/**
 * Scan log lines for error patterns.
 *
 * Pure function — no state, no side effects.
 * Deterministic: same input always produces same output.
 *
 * Extracted from: zombie detection logic in reality.test.ts
 */
export function scanForErrors(logLines: string[]): ErrorScanResult {
  const matches: ErrorScanResult['matches'] = [];

  for (const line of logLines) {
    for (const { pattern, name, severity } of ERROR_PATTERNS) {
      if (pattern.test(line)) {
        matches.push({ line, pattern: name, severity });
        break; // First match wins per line
      }
    }
  }

  return {
    hasErrors: matches.length > 0,
    matches,
    errorCount: matches.filter(m => m.severity === 'error').length,
    fatalCount: matches.filter(m => m.severity === 'fatal').length,
    warningCount: matches.filter(m => m.severity === 'warning').length,
  };
}

// =============================================================================
// DRIFT DETECTION — Snapshot integrity comparison
// =============================================================================

/**
 * Compare two artifact lists and detect drift.
 *
 * This is the pure set-comparison function at the heart of G3.
 * The adapter provides the artifact lists and hashes;
 * the kernel computes the difference.
 *
 * Extracted from: restoreSnapshot migration set comparison in snapshots.ts
 */
export function detectDrift(
  snapshot: SnapshotRecord,
  currentHash: string,
  currentArtifacts: string[],
): DriftResult {
  const snapshotSet = new Set(snapshot.artifacts);
  const currentSet = new Set(currentArtifacts);

  const added = currentArtifacts.filter(a => !snapshotSet.has(a));
  const removed = snapshot.artifacts.filter(a => !currentSet.has(a));

  // We can only detect hash-level drift, not per-artifact modification
  // without the adapter providing per-artifact hashes. The contentHash
  // comparison covers the aggregate case.
  const drifted = snapshot.contentHash !== currentHash || added.length > 0 || removed.length > 0;

  return {
    drifted,
    expectedHash: snapshot.contentHash,
    actualHash: currentHash,
    added,
    removed,
    modified: [], // Adapter must provide per-artifact hashes for this
  };
}

/**
 * Detect un-rollbackable state changes.
 *
 * Given a snapshot's artifact list and the current artifact list,
 * returns the artifacts that were added AFTER the snapshot was taken.
 * These represent state changes the system cannot automatically undo
 * (e.g., database migrations applied after code snapshot).
 *
 * The adapter decides what "un-rollbackable" means in its domain:
 * - Web: migrations applied after snapshot → can't rollback DB
 * - IaC: resources created after snapshot → need destroy plan
 * - K8s: CRDs applied after snapshot → need manual cleanup
 *
 * Extracted from: migration warning logic in snapshots.ts:restoreSnapshot
 */
export function detectUnrollbackableChanges(
  snapshotArtifacts: string[],
  currentArtifacts: string[],
): string[] {
  const snapshotSet = new Set(snapshotArtifacts);
  return currentArtifacts.filter(a => !snapshotSet.has(a));
}

// =============================================================================
// EVIDENCE CHAIN — Monotonicity invariant
// =============================================================================

/**
 * Failure category priority order.
 *
 * Higher index = lower priority. First match wins.
 * This ensures monotonicity: critical failures always dominate.
 *
 * Extracted from: deriveFailureCategory priority order in checkpoint.ts
 */
const FAILURE_PRIORITY: Array<{
  check: (chain: EvidenceChain) => boolean;
  category: FailureCategory;
}> = [
  // 1. Human rejection (highest priority)
  {
    check: (c) => c.rejected,
    category: 'rejected',
  },
  // 2. Timeout
  {
    check: (c) => c.timedOut,
    category: 'timeout',
  },
  // 3. Critical item failed (structural failure)
  {
    check: (c) => c.items.some(i => i.severity === 'critical' && !i.passed),
    category: 'critical_probe_failed',
  },
  // 4. Warning item failed (symptom-level)
  {
    check: (c) => c.items.some(i => i.severity === 'warning' && !i.passed),
    category: 'warning_probe_failed',
  },
  // 5. Goal not achieved (functional failure)
  {
    check: (c) => !c.goalAchieved,
    category: 'goal_not_achieved',
  },
];

/**
 * Verify evidence chain completeness and classify failure.
 *
 * The monotonicity invariant:
 * - If any critical evidence item fails → failure category MUST be set
 * - If goalAchieved is true AND no critical failures → no failure category
 * - Success evidence cannot override failure evidence
 * - The chain cannot contradict itself (critical fail + goalAchieved = contradiction)
 *
 * Extracted from: deriveFailureCategory + evidence chain tests in reality.test.ts
 */
export function verifyEvidenceChain(chain: EvidenceChain): ChainCompletenessResult {
  // Check for contradiction: goal achieved but critical probe failed
  const criticalFailed = chain.items.some(i => i.severity === 'critical' && !i.passed);
  const hasContradiction = chain.goalAchieved && criticalFailed;

  // Empty evidence with claimed success = epistemic violation
  // You cannot claim achievement with zero proof.
  if (chain.goalAchieved && chain.items.length === 0) {
    return {
      complete: false,
      failureCategory: 'no_evidence',
      hasContradiction: true,
      contradictionDetail: 'Goal reported as achieved but no evidence items provided',
    };
  }

  // If goal achieved and no structural failures, chain is complete with no failure
  if (chain.goalAchieved && !criticalFailed && !chain.timedOut && !chain.rejected) {
    return {
      complete: true,
      hasContradiction: false,
    };
  }

  // Find failure category by priority order
  let failureCategory: FailureCategory | undefined;
  for (const { check, category } of FAILURE_PRIORITY) {
    if (check(chain)) {
      failureCategory = category;
      break;
    }
  }

  return {
    complete: failureCategory !== undefined,
    failureCategory,
    hasContradiction,
    contradictionDetail: hasContradiction
      ? `Goal reported as achieved but critical probe "${chain.items.find(i => i.severity === 'critical' && !i.passed)?.name}" failed`
      : undefined,
  };
}

/**
 * Convert entropy check results to a gate verdict.
 *
 * Called after the adapter probes reality. If evidence is contradictory
 * or incomplete, the gate blocks.
 */
export function entropyVerdict(
  chain: EvidenceChain,
  errorScan?: ErrorScanResult,
): GateVerdict {
  const completeness = verifyEvidenceChain(chain);

  // Build evidence lines for consumers — encode full chain state into
  // clarificationNeeded.evidence so the receipt carries diagnostic context.
  const evidenceLines: string[] = [
    `goalAchieved=${chain.goalAchieved}`,
    `timedOut=${chain.timedOut}`,
    `rejected=${chain.rejected}`,
    ...chain.items.map(i =>
      `${i.severity}:${i.name}=${i.passed ? 'pass' : 'fail'}${i.detail ? ` (${i.detail})` : ''}`
    ),
  ];

  if (errorScan) {
    evidenceLines.push(
      `logScan hasErrors=${errorScan.hasErrors} fatal=${errorScan.fatalCount} error=${errorScan.errorCount} warning=${errorScan.warningCount}`,
      ...errorScan.matches.slice(0, 10).map(m => `log:${m.severity}:${m.pattern}: ${m.line}`),
    );
  }

  // Contradiction = always block (system integrity issue)
  if (completeness.hasContradiction) {
    return {
      action: 'block',
      gate: 'verify',
      reason: `EVIDENCE CONTRADICTION: ${completeness.contradictionDetail}`,
      escalationContext: {
        clarificationNeeded: { evidence: evidenceLines, similarity: 0 },
      },
    };
  }

  // Zombie detection: service appears up but logs show fatal errors
  if (errorScan && errorScan.fatalCount > 0 && chain.goalAchieved) {
    return {
      action: 'escalate',
      gate: 'verify',
      reason: `ZOMBIE DETECTED: ${errorScan.fatalCount} fatal error(s) in logs despite goal appearing achieved`,
      escalationContext: {
        clarificationNeeded: { evidence: evidenceLines, similarity: 0 },
      },
    };
  }

  // Failure detected → block
  if (completeness.failureCategory) {
    return {
      action: 'block',
      gate: 'verify',
      reason: `Verification failed: ${completeness.failureCategory}`,
      escalationContext: {
        clarificationNeeded: { evidence: evidenceLines, similarity: 0 },
      },
    };
  }

  // Evidence chain complete, no failures
  return {
    action: 'proceed',
    gate: 'verify',
    reason: 'Verification passed: evidence chain complete, no contradictions',
  };
}
