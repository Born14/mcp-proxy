/**
 * G8: Convergence Monotonicity — Constitutional Tests
 * =====================================================
 *
 * On failure, the search space must strictly narrow.
 *
 * Pure functions. Tests verify:
 *   - Monotonicity verification between snapshot pairs
 *   - Chain-level monotonicity verification
 *   - Narrowing type and magnitude classification
 *   - Gate verdict production
 *   - Integration with exhaustion detection
 *
 * Run with: bun test packages/kernel/tests/kernel/convergence-g8.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  verifyMonotonicity,
  verifyMonotonicityChain,
  gateConvergence,
  createConvergenceState,
  detectExhaustion,
  detectSemanticDisagreement,
  jaccardSimilarity,
} from '../../src/kernel/convergence.js';
import type {
  SolutionSpaceSnapshot,
  MonotonicityResult,
  IterationRecord,
} from '../../src/kernel/convergence.js';
import type { GovernanceConstraint } from '../../src/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeSnapshot(overrides: Partial<SolutionSpaceSnapshot> & { iteration: number }): SolutionSpaceSnapshot {
  return {
    constraintCount: 0,
    bannedActionClasses: 0,
    bannedFingerprints: 0,
    wasRollback: false,
    ...overrides,
  };
}

function makeConstraint(overrides?: Partial<GovernanceConstraint>): GovernanceConstraint {
  return {
    id: 'c1',
    type: 'radius_limit',
    signature: 'sig',
    appliesTo: ['logic'],
    surface: { files: [], intents: [] },
    requires: {},
    reason: 'test',
    introducedAt: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// 1. MONOTONICITY VERIFICATION (pair-level)
// =============================================================================

describe('G8: verifyMonotonicity', () => {
  test('non-rollback → trivially monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: false });
    const next = makeSnapshot({ iteration: 1 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('none');
    expect(result.narrowingMagnitude).toBe(0);
  });

  test('rollback + constraint added → monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 1 });
    const next = makeSnapshot({ iteration: 1, constraintCount: 2 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('constraint_added');
    expect(result.narrowingMagnitude).toBe(1);
    expect(result.reason).toContain('constraint');
  });

  test('rollback + radius reduced → monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, maxMutations: 5 });
    const next = makeSnapshot({ iteration: 1, maxMutations: 3 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('radius_reduced');
    expect(result.narrowingMagnitude).toBe(2);
    expect(result.reason).toContain('radius');
  });

  test('rollback + action banned → monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, bannedActionClasses: 0 });
    const next = makeSnapshot({ iteration: 1, bannedActionClasses: 1 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('action_banned');
    expect(result.narrowingMagnitude).toBe(1);
  });

  test('rollback + fingerprint banned → monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, bannedFingerprints: 1 });
    const next = makeSnapshot({ iteration: 1, bannedFingerprints: 3 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('fingerprint_banned');
    expect(result.narrowingMagnitude).toBe(2);
  });

  test('rollback + multiple axes → "multiple"', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 1, bannedActionClasses: 0 });
    const next = makeSnapshot({ iteration: 1, constraintCount: 2, bannedActionClasses: 1 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(true);
    expect(result.narrowingType).toBe('multiple');
    expect(result.narrowingMagnitude).toBe(2);
  });

  test('rollback + no narrowing → NOT monotonic', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 2 });
    const next = makeSnapshot({ iteration: 1, constraintCount: 2 });
    const result = verifyMonotonicity(prev, next);
    expect(result.monotonic).toBe(false);
    expect(result.narrowingType).toBe('none');
    expect(result.narrowingMagnitude).toBe(0);
    expect(result.reason).toContain('did not narrow');
  });

  test('rollback + radius undefined on one side → no radius narrowing', () => {
    const prev = makeSnapshot({ iteration: 0, wasRollback: true, maxMutations: 5 });
    const next = makeSnapshot({ iteration: 1 }); // maxMutations undefined
    const result = verifyMonotonicity(prev, next);
    // Only radius_reduced checks both defined — should not count
    expect(result.monotonic).toBe(false);
  });
});

// =============================================================================
// 2. MONOTONICITY CHAIN VERIFICATION
// =============================================================================

describe('G8: verifyMonotonicityChain', () => {
  test('empty snapshots → monotonic (trivial)', () => {
    const result = verifyMonotonicityChain([]);
    expect(result.monotonic).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.passCount).toBe(0);
  });

  test('single snapshot → monotonic (trivial)', () => {
    const result = verifyMonotonicityChain([makeSnapshot({ iteration: 0 })]);
    expect(result.monotonic).toBe(true);
  });

  test('two snapshots, no rollback → monotonic', () => {
    const result = verifyMonotonicityChain([
      makeSnapshot({ iteration: 0, wasRollback: false }),
      makeSnapshot({ iteration: 1 }),
    ]);
    expect(result.monotonic).toBe(true);
    expect(result.passCount).toBe(0); // non-rollback pairs don't count as "pass"
  });

  test('proper narrowing chain → monotonic with pass count', () => {
    const result = verifyMonotonicityChain([
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 0 }),
      makeSnapshot({ iteration: 1, wasRollback: true, constraintCount: 1 }),
      makeSnapshot({ iteration: 2, constraintCount: 2 }),
    ]);
    expect(result.monotonic).toBe(true);
    expect(result.passCount).toBe(2);
    expect(result.violations).toHaveLength(0);
  });

  test('one violation in chain → not monotonic', () => {
    const result = verifyMonotonicityChain([
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 1 }),
      makeSnapshot({ iteration: 1, wasRollback: true, constraintCount: 1 }), // no narrowing!
      makeSnapshot({ iteration: 2, constraintCount: 2 }),
    ]);
    expect(result.monotonic).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.passCount).toBe(1); // second pair passes
  });

  test('multiple violations reported', () => {
    const result = verifyMonotonicityChain([
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 2 }),
      makeSnapshot({ iteration: 1, wasRollback: true, constraintCount: 2 }), // no narrowing
      makeSnapshot({ iteration: 2, constraintCount: 2 }), // no narrowing
    ]);
    expect(result.monotonic).toBe(false);
    expect(result.violations).toHaveLength(2);
  });
});

// =============================================================================
// 3. JACCARD SIMILARITY (helper for semantic disagreement)
// =============================================================================

describe('G8: jaccardSimilarity', () => {
  test('identical sets → 1.0', () => {
    const a = new Set(['hello', 'world']);
    const b = new Set(['hello', 'world']);
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  test('disjoint sets → 0.0', () => {
    const a = new Set(['hello', 'world']);
    const b = new Set(['foo', 'bar']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test('both empty → 1.0', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test('partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection: 2, union: 4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

// =============================================================================
// 4. SEMANTIC DISAGREEMENT DETECTION
// =============================================================================

describe('G8: detectSemanticDisagreement', () => {
  test('no history → not detected', () => {
    const result = detectSemanticDisagreement([], []);
    expect(result.detected).toBe(false);
  });

  test('no radius_limit constraint → not detected', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'CSS color wrong on homepage', mutationCount: 2 },
      { index: 1, rolledBack: true, reason: 'HTML element missing from profile', mutationCount: 3 },
    ];
    const result = detectSemanticDisagreement(history, []);
    expect(result.detected).toBe(false);
  });

  test('last 2 not rollbacks → not detected', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'some failure', mutationCount: 2 },
      { index: 1, rolledBack: false, reason: '', mutationCount: 3 },
    ];
    const constraints = [makeConstraint({ type: 'radius_limit' })];
    const result = detectSemanticDisagreement(history, constraints);
    expect(result.detected).toBe(false);
  });

  test('divergent reasons + radius_limit → detected', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'Database migration schema columns altered incorrectly', mutationCount: 2 },
      { index: 1, rolledBack: true, reason: 'Frontend styling background gradient rendering wrong', mutationCount: 2 },
    ];
    const constraints = [makeConstraint({ type: 'radius_limit' })];
    const result = detectSemanticDisagreement(history, constraints);
    expect(result.detected).toBe(true);
    expect(result.similarity).toBeLessThan(0.5);
    expect(result.evidence).toHaveLength(2);
  });

  test('similar reasons → not detected (same problem repeating)', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'CSS color orange roster link wrong display', mutationCount: 2 },
      { index: 1, rolledBack: true, reason: 'CSS color orange roster link different display', mutationCount: 2 },
    ];
    const constraints = [makeConstraint({ type: 'radius_limit' })];
    const result = detectSemanticDisagreement(history, constraints);
    // High similarity → same problem → NOT disagreement
    expect(result.similarity).toBeGreaterThanOrEqual(0.5);
    expect(result.detected).toBe(false);
  });

  test('too few content words → not detected', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'ab', mutationCount: 2 },
      { index: 1, rolledBack: true, reason: 'cd', mutationCount: 2 },
    ];
    const constraints = [makeConstraint({ type: 'radius_limit' })];
    const result = detectSemanticDisagreement(history, constraints);
    expect(result.detected).toBe(false);
  });
});

// =============================================================================
// 5. EXHAUSTION DETECTION
// =============================================================================

describe('G8: detectExhaustion', () => {
  const config = { maxEmptyPlans: 3, maxIterations: 10, maxConstraintDepth: 5 };

  test('fresh state → progressing', () => {
    const state = createConvergenceState();
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('progressing');
    expect(result.shouldEscalate).toBe(false);
  });

  test('empty plan stall → exhausted', () => {
    const state = { ...createConvergenceState(), emptyPlanCount: 3 };
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('empty plans');
  });

  test('iteration budget → exhausted', () => {
    const state = { ...createConvergenceState(), iterations: 10 };
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('iteration budget');
  });

  test('constraint depth → exhausted', () => {
    const state = {
      ...createConvergenceState(),
      activeConstraints: Array.from({ length: 5 }, () => makeConstraint()),
    };
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('constraints');
  });

  test('semantic disagreement flag → disagreement', () => {
    const state = { ...createConvergenceState(), semanticDisagreement: true };
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('disagreement');
    expect(result.shouldEscalate).toBe(true);
  });

  test('active constraints but under limit → stalled', () => {
    const state = {
      ...createConvergenceState(),
      iterations: 3,
      activeConstraints: [makeConstraint()],
    };
    const result = detectExhaustion(state, config);
    expect(result.status).toBe('stalled');
    expect(result.shouldEscalate).toBe(false);
  });
});

// =============================================================================
// 6. GATE VERDICT (G8)
// =============================================================================

describe('G8: gateConvergence', () => {
  const config = { maxEmptyPlans: 3, maxIterations: 10, maxConstraintDepth: 5 };

  test('no snapshots, fresh state → proceed', () => {
    const verdict = gateConvergence([], createConvergenceState(), config);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('converge');
  });

  test('proper narrowing chain → proceed', () => {
    const snapshots: SolutionSpaceSnapshot[] = [
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 0 }),
      makeSnapshot({ iteration: 1, constraintCount: 1 }),
    ];
    const verdict = gateConvergence(snapshots, createConvergenceState(), config);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('converge');
    expect(verdict.reason).toContain('Monotonicity verified');
  });

  test('no rollbacks → proceed with trivial message', () => {
    const snapshots: SolutionSpaceSnapshot[] = [
      makeSnapshot({ iteration: 0, wasRollback: false }),
      makeSnapshot({ iteration: 1, wasRollback: false }),
    ];
    const verdict = gateConvergence(snapshots, createConvergenceState(), config);
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toContain('trivially');
  });

  test('monotonicity violation → escalate', () => {
    const snapshots: SolutionSpaceSnapshot[] = [
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 2 }),
      makeSnapshot({ iteration: 1, constraintCount: 2 }), // no narrowing!
    ];
    const verdict = gateConvergence(snapshots, createConvergenceState(), config);
    expect(verdict.action).toBe('escalate');
    expect(verdict.gate).toBe('converge');
    expect(verdict.reason).toContain('monotonicity violated');
  });

  test('exhaustion takes priority over monotonicity', () => {
    const snapshots: SolutionSpaceSnapshot[] = [
      makeSnapshot({ iteration: 0, wasRollback: true, constraintCount: 2 }),
      makeSnapshot({ iteration: 1, constraintCount: 2 }),
    ];
    const exhaustedState = { ...createConvergenceState(), iterations: 10 };
    const verdict = gateConvergence(snapshots, exhaustedState, config);
    // Exhaustion checked first → block (not escalate from monotonicity)
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('iteration budget');
  });

  test('semantic disagreement → escalate', () => {
    const snapshots: SolutionSpaceSnapshot[] = [];
    const state = { ...createConvergenceState(), semanticDisagreement: true };
    const verdict = gateConvergence(snapshots, state, config);
    expect(verdict.action).toBe('escalate');
    expect(verdict.escalationContext).toBeDefined();
  });
});
