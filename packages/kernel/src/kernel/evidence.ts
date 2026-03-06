/**
 * G9: Deterministic Evidence
 * ==========================
 *
 * Verification results must be reproducible from observable state.
 * If the harness reruns verification, the verdict must match.
 *
 * Born from: Browser gate instability (Feb 2026). CSS animations caused
 * `getComputedStyle()` to return different values on each check.
 * The system rolled back a working deploy because a non-deterministic
 * evidence source reported a transient mismatch.
 *
 * The kernel classifies reliability from stability labels provided by
 * the adapter. It never knows whether "non-deterministic" means
 * "CSS animation" or "Kubernetes pod startup race." The adapter labels;
 * the kernel decides what weight to give each label.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 */

import type { GateVerdict } from '../types.js';

// =============================================================================
// TYPES — Evidence stability classification
// =============================================================================

/**
 * How stable is this piece of verification evidence?
 *
 * The adapter classifies each evidence record based on its domain knowledge:
 * - deterministic: computed style, element exists, file content → always same result
 * - eventual: async-loaded content, hydration-dependent DOM → same after settle
 * - non_deterministic: animations, transitions, race conditions → may vary each check
 */
export type EvidenceStability = 'deterministic' | 'eventual' | 'non_deterministic';

/**
 * A single evidence record from verification.
 *
 * The adapter populates these from its domain-specific verification.
 * The kernel evaluates the collection for reliability.
 */
export interface EvidenceRecord {
  /** Which predicate this evidence covers */
  predicateId: string;

  /** Stability classification (adapter-provided) */
  stability: EvidenceStability;

  /** Whether the evidence was reproduced on recheck (adapter-reported) */
  reproducible: boolean;

  /** How many times the check was attempted (for eventual evidence) */
  attempts?: number;

  /** Whether this evidence passed verification */
  passed: boolean;
}

/**
 * Evidence reliability evaluation result.
 */
export interface EvidenceReliability {
  /** Overall assessment */
  status: 'reliable' | 'mixed' | 'unreliable' | 'insufficient';

  /** Whether any non-deterministic evidence is the sole basis for a critical decision */
  nonDeterministicDecision: boolean;

  /** Count of evidence records by stability */
  deterministicCount: number;
  eventualCount: number;
  nonDeterministicCount: number;

  /** Count of failed evidence by stability */
  deterministicFailures: number;
  eventualFailures: number;
  nonDeterministicFailures: number;

  /** Human-readable summary */
  reason: string;
}

// =============================================================================
// CORE FUNCTIONS — Pure evidence reliability physics
// =============================================================================

/**
 * Classify the reliability of a verification evidence set.
 *
 * Core invariant: Only deterministic evidence can cause a rollback.
 * Non-deterministic evidence is advisory — it annotates but never blocks.
 *
 * Pure function — deterministic, no side effects.
 */
export function classifyEvidenceReliability(
  records: EvidenceRecord[],
): EvidenceReliability {
  if (records.length === 0) {
    return {
      status: 'insufficient',
      nonDeterministicDecision: false,
      deterministicCount: 0,
      eventualCount: 0,
      nonDeterministicCount: 0,
      deterministicFailures: 0,
      eventualFailures: 0,
      nonDeterministicFailures: 0,
      reason: 'No evidence records — cannot determine verification outcome',
    };
  }

  const deterministic = records.filter(r => r.stability === 'deterministic');
  const eventual = records.filter(r => r.stability === 'eventual');
  const nonDeterministic = records.filter(r => r.stability === 'non_deterministic');

  const deterministicFailures = deterministic.filter(r => !r.passed).length;
  const eventualFailures = eventual.filter(r => !r.passed).length;
  const nonDeterministicFailures = nonDeterministic.filter(r => !r.passed).length;

  const totalFailures = deterministicFailures + eventualFailures + nonDeterministicFailures;

  // Check if non-deterministic evidence is the sole failure source
  const nonDeterministicDecision =
    nonDeterministicFailures > 0 &&
    deterministicFailures === 0 &&
    eventualFailures === 0;

  // Classify overall reliability
  let status: EvidenceReliability['status'];
  let reason: string;

  if (deterministic.length === 0 && eventual.length === 0) {
    // All evidence is non-deterministic — unreliable
    status = 'unreliable';
    reason = `All ${records.length} evidence record(s) are non-deterministic — cannot determine truth`;
  } else if (nonDeterministicFailures > 0 && deterministicFailures === 0 && eventualFailures === 0) {
    // Only non-deterministic failures — reliable (ignore non-deterministic)
    status = totalFailures === 0 ? 'reliable' : 'mixed';
    reason = `${nonDeterministicFailures} non-deterministic failure(s) — advisory only, deterministic evidence passes`;
  } else if (deterministicFailures > 0) {
    // Deterministic failures — this is a real problem
    status = 'reliable';
    reason = `${deterministicFailures} deterministic failure(s) — verification reliably detects issues`;
  } else if (totalFailures === 0) {
    status = 'reliable';
    reason = `All ${records.length} evidence record(s) pass — ${deterministic.length} deterministic, ${eventual.length} eventual`;
  } else {
    status = 'mixed';
    reason = `Mixed reliability: ${deterministicFailures} deterministic, ${eventualFailures} eventual, ${nonDeterministicFailures} non-deterministic failure(s)`;
  }

  return {
    status,
    nonDeterministicDecision,
    deterministicCount: deterministic.length,
    eventualCount: eventual.length,
    nonDeterministicCount: nonDeterministic.length,
    deterministicFailures,
    eventualFailures,
    nonDeterministicFailures,
    reason,
  };
}

/**
 * Filter evidence records to only those reliable enough for a given decision.
 *
 * For rollback decisions: only deterministic + eventual (reproduced) evidence.
 * For proceed decisions: all evidence (non-deterministic passing is fine).
 *
 * Pure function.
 */
export function filterReliableEvidence(
  records: EvidenceRecord[],
  decisionType: 'rollback' | 'proceed',
): EvidenceRecord[] {
  if (decisionType === 'proceed') {
    // All evidence can support a proceed decision
    return records;
  }

  // For rollback: only deterministic evidence, plus eventual that reproduced
  return records.filter(r => {
    if (r.stability === 'deterministic') return true;
    if (r.stability === 'eventual' && r.reproducible) return true;
    return false;
  });
}

// =============================================================================
// GATE — G9 verdict production
// =============================================================================

/**
 * G9 Gate: Deterministic Evidence.
 *
 * Only deterministic evidence can cause a rollback.
 * Non-deterministic evidence annotates but never blocks.
 * Called after 'verify' gate, before 'converge' gate.
 *
 * Verdicts:
 * - 'proceed': evidence is reliable (deterministic or all passing)
 * - 'proceed' + reason: non-deterministic failures exist but deterministic passes
 * - 'escalate': all evidence is non-deterministic and failing (cannot determine truth)
 * - 'block': deterministic evidence shows failure (reliable signal to act on)
 */
export function gateEvidence(
  records: EvidenceRecord[],
): GateVerdict {
  const reliability = classifyEvidenceReliability(records);

  // No evidence at all
  if (reliability.status === 'insufficient') {
    return {
      action: 'escalate',
      gate: 'evidence',
      reason: reliability.reason,
    };
  }

  // All evidence is non-deterministic — cannot determine truth
  if (reliability.status === 'unreliable') {
    return {
      action: 'escalate',
      gate: 'evidence',
      reason: reliability.reason,
    };
  }

  // Non-deterministic is the sole failure source — suppress rollback
  if (reliability.nonDeterministicDecision) {
    return {
      action: 'proceed',
      gate: 'evidence',
      reason: `${reliability.nonDeterministicFailures} non-deterministic failure(s) suppressed — only deterministic evidence can trigger rollback`,
    };
  }

  // Deterministic failures exist — real problem
  if (reliability.deterministicFailures > 0) {
    return {
      action: 'block',
      gate: 'evidence',
      reason: `${reliability.deterministicFailures} deterministic verification failure(s) — reliable signal`,
    };
  }

  // Eventual failures (not reproduced on recheck) — real problem but softer
  if (reliability.eventualFailures > 0) {
    return {
      action: 'block',
      gate: 'evidence',
      reason: `${reliability.eventualFailures} eventual verification failure(s) — check after settlement`,
    };
  }

  // All passing
  return {
    action: 'proceed',
    gate: 'evidence',
    reason: reliability.reason,
  };
}
