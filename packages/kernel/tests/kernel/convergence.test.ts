/**
 * Kernel Convergence Proof
 * ========================
 *
 * How the solution space narrows on retry.
 * Pure convergence state tracking, exhaustion detection, semantic disagreement.
 *
 * Run with: bun test tests/constitutional/kernel/convergence.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  createConvergenceState,
  recordIteration,
  addConstraint,
  jaccardSimilarity,
  detectSemanticDisagreement,
  detectExhaustion,
  convergenceVerdict,
  type IterationRecord,
} from '../../src/kernel/convergence.js';
import type { GovernanceConstraint } from '../../src/types.js';

// =============================================================================
// 1. CONVERGENCE STATE — Pure update functions
// =============================================================================

describe('Convergence: State Management', () => {
  test('initial state is zeroed', () => {
    const state = createConvergenceState();
    expect(state.iterations).toBe(0);
    expect(state.emptyPlanCount).toBe(0);
    expect(state.priorEvidence).toHaveLength(0);
    expect(state.activeConstraints).toHaveLength(0);
    expect(state.semanticDisagreement).toBe(false);
  });

  test('recordIteration increments count', () => {
    const s0 = createConvergenceState();
    const s1 = recordIteration(s0, 'some evidence', false);
    expect(s1.iterations).toBe(1);
    expect(s1.priorEvidence).toEqual(['some evidence']);
  });

  test('recordIteration tracks empty plans', () => {
    let state = createConvergenceState();
    state = recordIteration(state, undefined, true);
    expect(state.emptyPlanCount).toBe(1);

    state = recordIteration(state, undefined, true);
    expect(state.emptyPlanCount).toBe(2);

    // Non-empty plan resets counter
    state = recordIteration(state, 'evidence', false);
    expect(state.emptyPlanCount).toBe(0);
  });

  test('recordIteration preserves evidence', () => {
    let state = createConvergenceState();
    state = recordIteration(state, 'ev1', false);
    state = recordIteration(state, 'ev2', false);
    state = recordIteration(state, undefined, true); // no evidence
    expect(state.priorEvidence).toEqual(['ev1', 'ev2']);
  });

  test('addConstraint appends to list', () => {
    let state = createConvergenceState();
    const constraint: GovernanceConstraint = {
      id: 'c1',
      type: 'radius_limit',
      signature: 'test',
      scope: 'planning',
      appliesTo: [],
      surface: { files: [], intents: [] },
      requires: { maxMutations: 3 },
      reason: 'test',
      introducedAt: Date.now(),
    };
    state = addConstraint(state, constraint);
    expect(state.activeConstraints).toHaveLength(1);
    expect(state.activeConstraints[0].id).toBe('c1');
  });

  test('state updates are immutable', () => {
    const s0 = createConvergenceState();
    const s1 = recordIteration(s0, 'ev', false);
    expect(s0.iterations).toBe(0); // Original unchanged
    expect(s1.iterations).toBe(1);
  });
});

// =============================================================================
// 2. JACCARD SIMILARITY — Set comparison
// =============================================================================

describe('Convergence: Jaccard Similarity', () => {
  test('identical sets = 1.0', () => {
    const a = new Set(['foo', 'bar', 'baz']);
    const b = new Set(['foo', 'bar', 'baz']);
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  test('disjoint sets = 0.0', () => {
    const a = new Set(['foo', 'bar']);
    const b = new Set(['baz', 'qux']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test('partial overlap', () => {
    const a = new Set(['foo', 'bar', 'baz']);
    const b = new Set(['bar', 'baz', 'qux']);
    // intersection: {bar, baz} = 2, union: {foo, bar, baz, qux} = 4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  test('both empty = 1.0', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test('one empty, one not = 0.0', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });

  test('single shared element', () => {
    const a = new Set(['shared', 'only_a']);
    const b = new Set(['shared', 'only_b']);
    // intersection: 1, union: 3
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3);
  });
});

// =============================================================================
// 3. SEMANTIC DISAGREEMENT DETECTION
// =============================================================================

describe('Convergence: Semantic Disagreement', () => {
  const radiusConstraint: GovernanceConstraint = {
    id: 'c1',
    type: 'radius_limit',
    signature: 'test',
    scope: 'planning',
    appliesTo: [],
    surface: { files: [], intents: [] },
    requires: { maxMutations: 3 },
    reason: 'Shrinking radius',
    introducedAt: Date.now(),
  };

  test('not detected with < 2 iterations', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'some failure', mutationCount: 3 },
    ];
    const result = detectSemanticDisagreement(history, [radiusConstraint]);
    expect(result.detected).toBe(false);
  });

  test('not detected without radius_limit constraint', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'failure alpha bravo charlie', mutationCount: 3 },
      { index: 1, rolledBack: true, reason: 'failure delta echo foxtrot', mutationCount: 3 },
    ];
    const result = detectSemanticDisagreement(history, []);
    expect(result.detected).toBe(false);
  });

  test('not detected when iterations did not roll back', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: false, reason: '', mutationCount: 3 },
      { index: 1, rolledBack: true, reason: 'failure message bravo delta', mutationCount: 3 },
    ];
    const result = detectSemanticDisagreement(history, [radiusConstraint]);
    expect(result.detected).toBe(false);
  });

  test('detected when divergent evidence and constraints shrinking', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'The planner proposed database migration schema changes completely wrong approach', mutationCount: 3 },
      { index: 1, rolledBack: true, reason: 'The verifier found background color style property incorrect mismatch rendering', mutationCount: 2 },
    ];
    const result = detectSemanticDisagreement(history, [radiusConstraint]);
    // Content words should diverge enough → detected
    expect(result.similarity).toBeLessThan(0.5);
    expect(result.detected).toBe(true);
    expect(result.evidence).toHaveLength(2);
  });

  test('NOT detected when evidence is similar (same problem repeating)', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'Health probe background color style property mismatch rendering failure', mutationCount: 3 },
      { index: 1, rolledBack: true, reason: 'The background color style property rendering mismatch probe failure', mutationCount: 2 },
    ];
    const result = detectSemanticDisagreement(history, [radiusConstraint]);
    // Same problem repeated → high similarity → NOT disagreement
    expect(result.similarity).toBeGreaterThanOrEqual(0.5);
    expect(result.detected).toBe(false);
  });

  test('not detected when content words < 3', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'ab', mutationCount: 1 },
      { index: 1, rolledBack: true, reason: 'cd', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [radiusConstraint]);
    expect(result.detected).toBe(false);
  });
});

// =============================================================================
// 4. EXHAUSTION DETECTION
// =============================================================================

describe('Convergence: Exhaustion Detection', () => {
  const config = {
    maxEmptyPlans: 3,
    maxIterations: 10,
    maxConstraintDepth: 5,
  };

  test('fresh state = progressing', () => {
    const state = createConvergenceState();
    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('progressing');
    expect(analysis.shouldEscalate).toBe(false);
  });

  test('empty plan stall = exhausted', () => {
    let state = createConvergenceState();
    state = recordIteration(state, undefined, true);
    state = recordIteration(state, undefined, true);
    state = recordIteration(state, undefined, true);

    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('exhausted');
    expect(analysis.shouldEscalate).toBe(true);
    expect(analysis.reason).toContain('empty plans');
  });

  test('iteration budget exceeded = exhausted', () => {
    let state = createConvergenceState();
    for (let i = 0; i < 10; i++) {
      state = recordIteration(state, `evidence-${i}`, false);
    }

    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('exhausted');
    expect(analysis.shouldEscalate).toBe(true);
    expect(analysis.reason).toContain('iteration budget');
  });

  test('constraint depth exceeded = exhausted', () => {
    let state = createConvergenceState();
    for (let i = 0; i < 5; i++) {
      state = addConstraint(state, {
        id: `c${i}`,
        type: 'radius_limit',
        signature: `sig${i}`,
        scope: 'planning',
        appliesTo: [],
        surface: { files: [], intents: [] },
        requires: {},
        reason: 'test',
        introducedAt: Date.now(),
      });
    }

    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('exhausted');
    expect(analysis.reason).toContain('active constraints');
  });

  test('semantic disagreement flag = disagreement', () => {
    const state = {
      ...createConvergenceState(),
      semanticDisagreement: true,
      iterations: 3,
    };

    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('disagreement');
    expect(analysis.shouldEscalate).toBe(true);
  });

  test('active constraints = stalled (but not exhausted)', () => {
    let state = createConvergenceState();
    state = recordIteration(state, 'ev', false);
    state = addConstraint(state, {
      id: 'c1',
      type: 'radius_limit',
      signature: 'test',
      scope: 'planning',
      appliesTo: [],
      surface: { files: [], intents: [] },
      requires: {},
      reason: 'narrowing',
      introducedAt: Date.now(),
    });

    const analysis = detectExhaustion(state, config);
    expect(analysis.status).toBe('stalled');
    expect(analysis.shouldEscalate).toBe(false);
  });
});

// =============================================================================
// 5. CONVERGENCE VERDICT
// =============================================================================

describe('Convergence: Verdict', () => {
  test('progressing = proceed', () => {
    const verdict = convergenceVerdict({
      status: 'progressing',
      shouldEscalate: false,
      reason: 'Iteration 0 — progressing',
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('plan');
  });

  test('disagreement = escalate with evidence', () => {
    const verdict = convergenceVerdict({
      status: 'disagreement',
      shouldEscalate: true,
      reason: 'Semantic disagreement detected',
      similarity: 0.3,
      evidence: ['reason1', 'reason2'],
    });
    expect(verdict.action).toBe('escalate');
    expect(verdict.escalationContext?.clarificationNeeded?.similarity).toBe(0.3);
    expect(verdict.escalationContext?.clarificationNeeded?.evidence).toEqual(['reason1', 'reason2']);
  });

  test('exhausted = block', () => {
    const verdict = convergenceVerdict({
      status: 'exhausted',
      shouldEscalate: true,
      reason: '10 iterations without convergence',
    });
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('plan');
  });
});
