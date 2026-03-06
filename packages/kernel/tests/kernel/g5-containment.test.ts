/**
 * Kernel G5: Containment Proof
 * ============================
 *
 * Every mutation traces to a predicate, or the human knows.
 *
 * Uses the mock adapter (key-value store) to prove containment physics
 * hold for a non-web domain — zero CSS, zero Docker, zero SSH.
 *
 * Run with: bun test tests/constitutional/kernel/g5-containment.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  attributePlan,
  containmentVerdict,
} from '../../src/kernel/containment.js';
import {
  createMockAdapter,
  createMockState,
} from '../../src/adapters/mock-adapter.js';
import type {
  Mutation,
  Predicate,
  Evidence,
  ContainmentMode,
} from '../../src/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

function makeMutation(verb: string, key: string, value?: string): Mutation {
  return {
    verb,
    target: key,
    capturedAt: Date.now(),
    args: { key, ...(value !== undefined ? { value } : {}) },
  };
}

function makePredicate(id: string, key: string, operator: string, value?: string): Predicate {
  return {
    id,
    type: 'kv',
    description: `Key "${key}" ${operator} "${value ?? ''}"`,
    fields: { key },
    operator,
    value,
  };
}

function makeEvidence(keys: string[]): Evidence[] {
  return [{ type: 'observation', data: { keys }, source: 'grounding', capturedAt: Date.now() }];
}

// =============================================================================
// 1. ATTRIBUTION — Direct, scaffolding, unexplained
// =============================================================================

describe('G5 Containment: Attribution', () => {
  const state = createMockState({ x: 'old' });
  const adapter = createMockAdapter(state);

  test('mutation matching predicate = direct', () => {
    const mutations = [makeMutation('set_value', 'x', 'new')];
    const predicates = [makePredicate('p0', 'x', '==', 'new')];
    const evidence = makeEvidence(['x']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.contained).toBe(true);
    expect(result.directCount).toBe(1);
    expect(result.attributions[0].attribution).toBe('direct');
    expect(result.attributions[0].predicateId).toBe('p0');
  });

  test('read mutation = scaffolding', () => {
    const mutations = [makeMutation('read_key', 'x')];
    const predicates = [makePredicate('p0', 'y', '==', 'val')];
    const evidence = makeEvidence(['x', 'y']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.contained).toBe(true);
    expect(result.scaffoldingCount).toBe(1);
    expect(result.attributions[0].attribution).toBe('scaffolding');
  });

  test('mutation with no matching predicate = unexplained', () => {
    const mutations = [makeMutation('set_value', 'z', 'sneaky')];
    const predicates = [makePredicate('p0', 'x', '==', 'val')];
    const evidence = makeEvidence(['x']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.contained).toBe(false);
    expect(result.unexplainedCount).toBe(1);
    expect(result.attributions[0].attribution).toBe('unexplained');
  });

  test('mixed: direct + scaffolding + unexplained', () => {
    // Mock adapter: read_key on key 'x' finds predicate with key 'x' → 'direct'
    // Use read_key on key 'q' (no predicate) to get scaffolding
    const mutations = [
      makeMutation('set_value', 'x', 'new'),   // direct (predicate key 'x' matches)
      makeMutation('read_key', 'q'),             // scaffolding (no predicate for 'q')
      makeMutation('delete_key', 'z'),           // unexplained (no predicate for 'z')
    ];
    const predicates = [makePredicate('p0', 'x', '==', 'new')];
    const evidence = makeEvidence(['x', 'q']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.contained).toBe(false);
    expect(result.directCount).toBe(1);
    expect(result.scaffoldingCount).toBe(1);
    expect(result.unexplainedCount).toBe(1);
  });

  test('no predicates = all unexplained', () => {
    const mutations = [
      makeMutation('set_value', 'a', '1'),
      makeMutation('set_value', 'b', '2'),
    ];

    const result = attributePlan(mutations, [], [], adapter);
    expect(result.contained).toBe(false);
    expect(result.unexplainedCount).toBe(2);
  });

  test('empty mutations = contained', () => {
    const result = attributePlan([], [makePredicate('p0', 'x', '==', 'v')], [], adapter);
    expect(result.contained).toBe(true);
    expect(result.summary).toBe('No mutations to attribute');
  });

  test('index ordering preserved', () => {
    const mutations = [
      makeMutation('set_value', 'a', '1'),
      makeMutation('set_value', 'b', '2'),
      makeMutation('set_value', 'c', '3'),
    ];
    const predicates = [
      makePredicate('p0', 'a', '==', '1'),
      makePredicate('p1', 'b', '==', '2'),
      makePredicate('p2', 'c', '==', '3'),
    ];
    const evidence = makeEvidence(['a', 'b', 'c']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.attributions).toHaveLength(3);
    expect(result.attributions[0].target).toBe('a');
    expect(result.attributions[1].target).toBe('b');
    expect(result.attributions[2].target).toBe('c');
  });
});

// =============================================================================
// 2. IDENTITY BINDING — Mutation targets vs observation evidence
// =============================================================================

describe('G5 Containment: Identity Binding', () => {
  test('mutating unobserved key = identity mismatch', () => {
    const state = createMockState({ x: 'v' });
    const adapter = createMockAdapter(state);

    const mutations = [makeMutation('set_value', 'unobserved', 'val')];
    const predicates = [makePredicate('p0', 'unobserved', '==', 'val')];
    // Evidence shows observation of key 'x' only
    const evidence: Evidence[] = [{
      type: 'observation',
      data: { key: 'x', keys: ['x'] },
      source: 'grounding',
      capturedAt: Date.now(),
    }];

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.identityMismatches).toHaveLength(1);
    expect(result.identityMismatches[0].mutationValue).toBe('unobserved');
    expect(result.contained).toBe(false); // identity mismatch breaks containment
  });

  test('mutating observed key = no mismatch', () => {
    const state = createMockState({ x: 'v' });
    const adapter = createMockAdapter(state);

    const mutations = [makeMutation('set_value', 'x', 'new')];
    const predicates = [makePredicate('p0', 'x', '==', 'new')];
    const evidence: Evidence[] = [{
      type: 'observation',
      data: { key: 'x', keys: ['x'] },
      source: 'grounding',
      capturedAt: Date.now(),
    }];

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.identityMismatches).toHaveLength(0);
    expect(result.contained).toBe(true);
  });

  test('no evidence = no mismatches (nothing to compare)', () => {
    const state = createMockState();
    const adapter = createMockAdapter(state);

    const mutations = [makeMutation('set_value', 'x', 'v')];
    const predicates = [makePredicate('p0', 'x', '==', 'v')];

    const result = attributePlan(mutations, predicates, [], adapter);
    expect(result.identityMismatches).toHaveLength(0);
  });
});

// =============================================================================
// 3. CONTAINMENT VERDICT — Enforcement gradient
// =============================================================================

describe('G5 Containment: Enforcement Gradient', () => {
  test('contained = proceed (all modes)', () => {
    const result = {
      contained: true,
      attributions: [],
      identityMismatches: [],
      directCount: 1,
      scaffoldingCount: 0,
      unexplainedCount: 0,
      summary: '1 traced',
    };

    for (const mode of ['advisory', 'soft_gate', 'hard_gate'] as ContainmentMode[]) {
      const verdict = containmentVerdict(result, mode);
      expect(verdict.action).toBe('proceed');
      expect(verdict.gate).toBe('contain');
    }
  });

  test('advisory: not contained = still proceed (with context)', () => {
    const result = {
      contained: false,
      attributions: [],
      identityMismatches: [],
      directCount: 1,
      scaffoldingCount: 0,
      unexplainedCount: 1,
      summary: '1 traced, 1 untraced',
    };

    const verdict = containmentVerdict(result, 'advisory');
    expect(verdict.action).toBe('proceed');
    expect(verdict.escalationContext?.containment).toBeDefined();
  });

  test('soft_gate: not contained = escalate', () => {
    const result = {
      contained: false,
      attributions: [],
      identityMismatches: [],
      directCount: 0,
      scaffoldingCount: 0,
      unexplainedCount: 2,
      summary: '2 untraced',
    };

    const verdict = containmentVerdict(result, 'soft_gate');
    expect(verdict.action).toBe('escalate');
    expect(verdict.reason).toContain('2 untraced');
  });

  test('hard_gate: not contained = block', () => {
    const result = {
      contained: false,
      attributions: [],
      identityMismatches: [],
      directCount: 1,
      scaffoldingCount: 0,
      unexplainedCount: 1,
      summary: '1 traced, 1 untraced',
    };

    const verdict = containmentVerdict(result, 'hard_gate');
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('1 untraced');
  });
});

// =============================================================================
// 4. SUMMARY GENERATION
// =============================================================================

describe('G5 Containment: Summary', () => {
  const state = createMockState({ x: 'v' });
  const adapter = createMockAdapter(state);

  test('summary contains counts', () => {
    // read_key on 'q' (no predicate) → scaffolding; delete_key on 'z' → unexplained
    const mutations = [
      makeMutation('set_value', 'x', 'new'),
      makeMutation('read_key', 'q'),
      makeMutation('delete_key', 'z'),
    ];
    const predicates = [makePredicate('p0', 'x', '==', 'new')];
    const evidence = makeEvidence(['x', 'q']);

    const result = attributePlan(mutations, predicates, evidence, adapter);
    expect(result.summary).toContain('1 traced');
    expect(result.summary).toContain('1 supporting');
    expect(result.summary).toContain('1 untraced');
  });
});
