/**
 * Convergence Exhaustion Detection — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import {
  detectExhaustion,
  detectSemanticDisagreement,
  convergenceVerdict,
  jaccardSimilarity,
} from '../src/convergence-detect.js';
import type { ConvergenceState, IterationRecord, ConstraintLike, ConvergenceConfig } from '../src/convergence-detect.js';

const DEFAULT_CONFIG: ConvergenceConfig = {
  maxEmptyPlans: 3,
  maxIterations: 10,
  maxConstraintDepth: 5,
};

function makeState(overrides: Partial<ConvergenceState> = {}): ConvergenceState {
  return {
    iterations: 0,
    emptyPlanCount: 0,
    activeConstraints: [],
    semanticDisagreement: false,
    ...overrides,
  };
}

describe('Jaccard Similarity', () => {

  test('identical sets have similarity 1', () => {
    const a = new Set(['hello', 'world']);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  test('disjoint sets have similarity 0', () => {
    const a = new Set(['hello', 'world']);
    const b = new Set(['foo', 'bar']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test('empty sets have similarity 1', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test('partial overlap returns correct value', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection: {b, c} = 2, union: {a, b, c, d} = 4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

describe('Detect Exhaustion', () => {

  test('progressing at iteration 0', () => {
    const result = detectExhaustion(makeState(), DEFAULT_CONFIG);
    expect(result.status).toBe('progressing');
    expect(result.shouldEscalate).toBe(false);
  });

  test('progressing with no constraints', () => {
    const result = detectExhaustion(makeState({ iterations: 3 }), DEFAULT_CONFIG);
    expect(result.status).toBe('progressing');
    expect(result.shouldEscalate).toBe(false);
  });

  test('stalled with active constraints', () => {
    const result = detectExhaustion(makeState({
      iterations: 3,
      activeConstraints: [{ type: 'forbidden_action' }],
    }), DEFAULT_CONFIG);
    expect(result.status).toBe('stalled');
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toContain('narrowing');
  });

  test('exhausted by empty plans', () => {
    const result = detectExhaustion(makeState({ emptyPlanCount: 3 }), DEFAULT_CONFIG);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('empty plans');
  });

  test('exhausted by iteration budget', () => {
    const result = detectExhaustion(makeState({ iterations: 10 }), DEFAULT_CONFIG);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('iteration budget');
  });

  test('exhausted by constraint depth', () => {
    const constraints: ConstraintLike[] = Array.from({ length: 5 }, () => ({ type: 'forbidden_action' }));
    const result = detectExhaustion(makeState({ activeConstraints: constraints }), DEFAULT_CONFIG);
    expect(result.status).toBe('exhausted');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('solution space');
  });

  test('disagreement when flag is set', () => {
    const result = detectExhaustion(makeState({ semanticDisagreement: true }), DEFAULT_CONFIG);
    expect(result.status).toBe('disagreement');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('disagreement');
  });

  test('empty plans checked before iteration budget', () => {
    const result = detectExhaustion(makeState({
      emptyPlanCount: 3,
      iterations: 10,
    }), DEFAULT_CONFIG);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toContain('empty plans');
  });
});

describe('Detect Semantic Disagreement', () => {

  test('not detected with fewer than 2 iterations', () => {
    const result = detectSemanticDisagreement(
      [{ index: 0, rolledBack: true, reason: 'color mismatch', mutationCount: 1 }],
      [{ type: 'radius_limit' }],
    );
    expect(result.detected).toBe(false);
  });

  test('not detected without radius_limit constraint', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'layout broken everywhere', mutationCount: 1 },
      { index: 1, rolledBack: true, reason: 'database schema wrong entirely', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [{ type: 'forbidden_action' }]);
    expect(result.detected).toBe(false);
  });

  test('not detected when last iterations are not rollbacks', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'something broken', mutationCount: 1 },
      { index: 1, rolledBack: false, reason: '', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [{ type: 'radius_limit' }]);
    expect(result.detected).toBe(false);
  });

  test('detected when content words diverge', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'The background gradient needs to be linear from top left corner to bottom', mutationCount: 1 },
      { index: 1, rolledBack: true, reason: 'Database migration requires foreign key constraint on user table with cascade', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [{ type: 'radius_limit' }]);
    expect(result.detected).toBe(true);
    expect(result.similarity).toBeLessThan(0.5);
    expect(result.evidence).toHaveLength(2);
  });

  test('not detected when content words are similar (same problem repeating)', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'The roster link color should be orange but got blue', mutationCount: 1 },
      { index: 1, rolledBack: true, reason: 'The roster link color should be orange but returns blue', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [{ type: 'radius_limit' }]);
    expect(result.detected).toBe(false);
    expect(result.similarity).toBeGreaterThanOrEqual(0.5);
  });

  test('not detected with too few content words', () => {
    const history: IterationRecord[] = [
      { index: 0, rolledBack: true, reason: 'bad', mutationCount: 1 },
      { index: 1, rolledBack: true, reason: 'wrong', mutationCount: 1 },
    ];
    const result = detectSemanticDisagreement(history, [{ type: 'radius_limit' }]);
    expect(result.detected).toBe(false);
  });
});

describe('Convergence Verdict', () => {

  test('proceed when not escalating', () => {
    const verdict = convergenceVerdict({
      status: 'progressing',
      shouldEscalate: false,
      reason: 'Iteration 0 — progressing',
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('plan');
  });

  test('escalate on disagreement', () => {
    const verdict = convergenceVerdict({
      status: 'disagreement',
      shouldEscalate: true,
      reason: 'Semantic disagreement detected',
      similarity: 0.3,
      evidence: ['reason A', 'reason B'],
    });
    expect(verdict.action).toBe('escalate');
    expect(verdict.escalationContext).toBeDefined();
    expect(verdict.escalationContext!.clarificationNeeded.similarity).toBe(0.3);
    expect(verdict.escalationContext!.clarificationNeeded.evidence).toHaveLength(2);
  });

  test('block on exhaustion', () => {
    const verdict = convergenceVerdict({
      status: 'exhausted',
      shouldEscalate: true,
      reason: '10 iterations without convergence',
    });
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('plan');
    expect(verdict.escalationContext).toBeUndefined();
  });

  test('block on stalled with escalation', () => {
    const verdict = convergenceVerdict({
      status: 'stalled',
      shouldEscalate: true,
      reason: '5 active constraints',
    });
    expect(verdict.action).toBe('block');
  });
});
