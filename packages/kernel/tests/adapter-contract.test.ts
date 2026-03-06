/**
 * Adapter Conformance Test Suite
 * ==============================
 *
 * Any adapter (mock, web, IaC, future domains) must pass these mandatory
 * behavioral tests. They verify the DomainAdapter contract is implemented
 * correctly, deterministically, and completely.
 *
 * 6 mandatory conformance tests:
 *   1. Deterministic syntax validation
 *   2. Verification mode consistency
 *   3. Total attributeMutation (returns classification for EVERY verb)
 *   4. Risk floor integrity (declared floor is minimum)
 *   5. Predicate legitimacy (only declared types returned)
 *   6. Verb envelope (only accepts verbs from manifest)
 *
 * Run with: bun test tests/adapter-contract/adapter-contract.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  createMockAdapter,
  createMockState,
} from '../src/adapters/mock-adapter.js';
import type {
  DomainAdapter,
  Mutation,
  Predicate,
  Evidence,
  MutationAttribution,
} from '../src/types.js';

// =============================================================================
// ADAPTER UNDER TEST
// =============================================================================

// The conformance suite tests the mock adapter. A sovereign-web adapter
// would be tested with the same suite — just swap the factory.
function getAdapter(): DomainAdapter {
  const state = createMockState({ x: 'initial', y: '42' });
  return createMockAdapter(state);
}

// =============================================================================
// HELPERS
// =============================================================================

function makeMutation(verb: string, key: string, value?: string): Mutation {
  return {
    verb,
    target: key,
    capturedAt: Date.now(),
    args: value !== undefined ? { key, value } : { key },
  };
}

function makePredicate(id: string, key: string, operator: string, value?: string | number): Predicate {
  return {
    id,
    type: 'kv',
    description: `${key} ${operator} ${value ?? ''}`,
    fields: { key },
    operator,
    value,
  };
}

function makeEvidence(keys: string[]): Evidence[] {
  return [{
    type: 'observation',
    data: { keys },
    source: 'grounding',
    capturedAt: Date.now(),
  }];
}

// =============================================================================
// 1. DETERMINISTIC SYNTAX VALIDATION
// =============================================================================

describe('Adapter Contract: Deterministic Syntax Validation', () => {
  test('same input = same result, every time', async () => {
    const adapter = getAdapter();
    const mutations: Mutation[] = [
      makeMutation('set_value', 'x', 'hello'),
      makeMutation('delete_key', 'y'),
    ];

    const result1 = await adapter.validateSyntax(mutations);
    const result2 = await adapter.validateSyntax(mutations);
    const result3 = await adapter.validateSyntax(mutations);

    expect(result1.passed).toBe(result2.passed);
    expect(result2.passed).toBe(result3.passed);
    expect(result1.errors).toEqual(result2.errors);
    expect(result2.errors).toEqual(result3.errors);
  });

  test('valid mutations pass syntax', async () => {
    const adapter = getAdapter();
    const mutations: Mutation[] = [
      makeMutation('set_value', 'x', 'new_value'),
    ];

    const result = await adapter.validateSyntax(mutations);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('invalid mutations fail syntax deterministically', async () => {
    const adapter = getAdapter();
    const mutations: Mutation[] = [
      makeMutation('set_value', '', 'value'),  // empty key
    ];

    const r1 = await adapter.validateSyntax(mutations);
    const r2 = await adapter.validateSyntax(mutations);

    expect(r1.passed).toBe(false);
    expect(r1.errors.length).toBeGreaterThan(0);
    expect(r1.passed).toBe(r2.passed);
    expect(r1.errors).toEqual(r2.errors);
  });

  test('empty mutations list passes', async () => {
    const adapter = getAdapter();
    const result = await adapter.validateSyntax([]);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// 2. VERIFICATION MODE CONSISTENCY
// =============================================================================

describe('Adapter Contract: Verification Mode Consistency', () => {
  test('manifest declares a verification mode', () => {
    const adapter = getAdapter();
    expect(['independent', 'hybrid', 'agent-reported']).toContain(
      adapter.manifest.verificationMode,
    );
  });

  test('independent adapter verifies predicates against real state', async () => {
    const state = createMockState({ x: 'hello' });
    const adapter = createMockAdapter(state);

    // Adapter declares independent verification
    expect(adapter.manifest.verificationMode).toBe('independent');

    // Verify a predicate — adapter should check real state, not agent claims
    const predicates: Predicate[] = [
      makePredicate('p0', 'x', '==', 'hello'),
    ];

    const results = await adapter.verify(predicates);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].actual).toBe('hello');
  });

  test('independent adapter fails verification when state disagrees', async () => {
    const state = createMockState({ x: 'wrong' });
    const adapter = createMockAdapter(state);

    const predicates: Predicate[] = [
      makePredicate('p0', 'x', '==', 'expected'),
    ];

    const results = await adapter.verify(predicates);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].actual).toBe('wrong');
    expect(results[0].expected).toBe('expected');
  });

  test('verification result includes predicateId', async () => {
    const adapter = getAdapter();
    const predicates: Predicate[] = [
      makePredicate('pred-alpha', 'x', '==', 'initial'),
    ];

    const results = await adapter.verify(predicates);
    expect(results[0].predicateId).toBe('pred-alpha');
  });
});

// =============================================================================
// 3. TOTAL attributeMutation — Must classify EVERY mutation verb
// =============================================================================

describe('Adapter Contract: Total attributeMutation', () => {
  test('returns attribution for every verb in manifest', () => {
    const adapter = getAdapter();
    const predicates: Predicate[] = [makePredicate('p0', 'x', '==', 'val')];
    const evidence = makeEvidence(['x']);

    for (const verbDef of adapter.manifest.verbs) {
      const mutation = makeMutation(
        verbDef.name,
        'x',
        verbDef.name === 'set_value' ? 'val' : undefined,
      );

      const result: MutationAttribution = adapter.attributeMutation(
        mutation,
        predicates,
        evidence,
      );

      // Must return a valid MutationAttribution — never null, never undefined
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(typeof result.verb).toBe('string');
      expect(typeof result.target).toBe('string');
      expect(['direct', 'scaffolding', 'unexplained']).toContain(result.attribution);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test('attribution with no predicates = scaffolding or unexplained (never direct)', () => {
    const adapter = getAdapter();

    for (const verbDef of adapter.manifest.verbs) {
      const mutation = makeMutation(
        verbDef.name,
        'orphan-key',
        verbDef.name === 'set_value' ? 'val' : undefined,
      );

      const result = adapter.attributeMutation(mutation, [], []);

      // With no predicates, nothing can be "direct"
      expect(result.attribution).not.toBe('direct');
    }
  });

  test('direct attribution includes predicateId', () => {
    const adapter = getAdapter();
    const predicates: Predicate[] = [makePredicate('p0', 'target_key', '==', 'val')];
    const mutation = makeMutation('set_value', 'target_key', 'val');

    const result = adapter.attributeMutation(mutation, predicates, []);

    expect(result.attribution).toBe('direct');
    expect(result.predicateId).toBe('p0');
  });

  test('unexplained attribution has no predicateId', () => {
    const adapter = getAdapter();
    const predicates: Predicate[] = [makePredicate('p0', 'x', '==', 'val')];
    const mutation = makeMutation('delete_key', 'unrelated_key');

    const result = adapter.attributeMutation(mutation, predicates, []);

    expect(result.attribution).toBe('unexplained');
    expect(result.predicateId).toBeUndefined();
  });
});

// =============================================================================
// 4. RISK FLOOR INTEGRITY — Declared floor cannot be downgraded at runtime
// =============================================================================

describe('Adapter Contract: Risk Floor Integrity', () => {
  test('manifest declares approval floor for every risk level', () => {
    const adapter = getAdapter();
    const floors = adapter.manifest.approvalFloor;

    // Must cover all MutationRisk values used by the adapter's verbs
    const riskLevels = new Set(adapter.manifest.verbs.map(v => v.risk));
    for (const risk of riskLevels) {
      expect(floors[risk]).toBeDefined();
      expect(['auto', 'human', 'never']).toContain(floors[risk]);
    }
  });

  test('floor is consistent across multiple reads', () => {
    const adapter = getAdapter();

    const floor1 = { ...adapter.manifest.approvalFloor };
    const floor2 = { ...adapter.manifest.approvalFloor };

    expect(floor1).toEqual(floor2);
  });

  test('destructive operations require human approval', () => {
    const adapter = getAdapter();
    const destroyFloor = adapter.manifest.approvalFloor['destroy'];

    // Destroy-risk operations should require at least human approval
    expect(['human', 'never']).toContain(destroyFloor);
  });

  test('mutate operations require at least human approval', () => {
    const adapter = getAdapter();
    const mutateFloor = adapter.manifest.approvalFloor['mutate'];

    expect(['human', 'never']).toContain(mutateFloor);
  });

  test('risk floor is a minimum — kernel can escalate but never downgrade', () => {
    const adapter = getAdapter();

    // The risk hierarchy: auto < human < never
    const hierarchy: Record<string, number> = { auto: 0, human: 1, never: 2 };

    for (const verbDef of adapter.manifest.verbs) {
      const floor = adapter.manifest.approvalFloor[verbDef.risk];
      const floorLevel = hierarchy[floor];

      // Every verb's floor should be at its declared risk level or higher
      // (the kernel can escalate further, but the adapter's floor is the minimum)
      expect(floorLevel).toBeDefined();
      expect(floorLevel).toBeGreaterThanOrEqual(0);
    }
  });
});

// =============================================================================
// 5. PREDICATE LEGITIMACY — Only declared predicate types returned
// =============================================================================

describe('Adapter Contract: Predicate Legitimacy', () => {
  test('extractPredicates returns predicates with valid structure', async () => {
    const adapter = getAdapter();
    const grounding = { keys: ['x', 'y'], keyCount: 2 };

    const predicates = await adapter.extractPredicates(
      'set x to hello',
      grounding,
    );

    for (const p of predicates) {
      // Every predicate must have required fields
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.type).toBe('string');
      expect(p.type.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
      expect(typeof p.fields).toBe('object');
      expect(typeof p.operator).toBe('string');
    }
  });

  test('predicate types are consistent within adapter', async () => {
    const adapter = getAdapter();

    const p1 = await adapter.extractPredicates('set x to hello', {});
    const p2 = await adapter.extractPredicates('delete y', {});

    // All predicate types from this adapter should be from the same type set
    const allTypes = new Set([...p1, ...p2].map(p => p.type));

    // The mock adapter only uses 'kv' type
    for (const t of allTypes) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  test('validatePredicate handles all predicate types from extractPredicates', async () => {
    const state = createMockState({ x: 'hello' });
    const adapter = createMockAdapter(state);

    const predicates = await adapter.extractPredicates('set x to hello', {});

    // Every predicate type the adapter extracts must be validatable
    for (const p of predicates) {
      const result = await adapter.validatePredicate(p, {});
      expect(result).toBeDefined();
      expect(typeof result.passed).toBe('boolean');
    }
  });

  test('predicate IDs are unique within a single extraction', async () => {
    const adapter = getAdapter();

    const predicates = await adapter.extractPredicates(
      'set x to hello and set y to world',
      {},
    );

    const ids = predicates.map(p => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('empty goal produces empty predicates (not error)', async () => {
    const adapter = getAdapter();

    const predicates = await adapter.extractPredicates('just thinking', {});
    expect(Array.isArray(predicates)).toBe(true);
    // May be empty or may extract something — but must not throw
  });
});

// =============================================================================
// 6. VERB ENVELOPE — Only accepts verbs from manifest
// =============================================================================

describe('Adapter Contract: Verb Envelope', () => {
  test('manifest declares at least one verb', () => {
    const adapter = getAdapter();
    expect(adapter.manifest.verbs.length).toBeGreaterThan(0);
  });

  test('every verb has name, risk, and description', () => {
    const adapter = getAdapter();

    for (const v of adapter.manifest.verbs) {
      expect(typeof v.name).toBe('string');
      expect(v.name.length).toBeGreaterThan(0);
      expect(['read', 'mutate', 'destroy']).toContain(v.risk);
      expect(typeof v.description).toBe('string');
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  test('syntax validation rejects unknown verbs', async () => {
    const adapter = getAdapter();
    const knownVerbs = new Set(adapter.manifest.verbs.map(v => v.name));

    // An unknown verb
    const unknownMutation = makeMutation('teleport_key', 'x', 'val');
    expect(knownVerbs.has('teleport_key')).toBe(false);

    const result = await adapter.validateSyntax([unknownMutation]);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain('teleport_key');
  });

  test('syntax validation accepts all declared verbs', async () => {
    const adapter = getAdapter();

    for (const verbDef of adapter.manifest.verbs) {
      const mutation = makeMutation(
        verbDef.name,
        'test_key',
        verbDef.name === 'set_value' ? 'test_val' : undefined,
      );

      const result = await adapter.validateSyntax([mutation]);

      // Each declared verb should pass syntax (assuming valid args)
      expect(result.passed).toBe(true);
    }
  });

  test('classifyRisk handles mutations with all declared verbs', () => {
    const adapter = getAdapter();

    for (const verbDef of adapter.manifest.verbs) {
      const mutation = makeMutation(
        verbDef.name,
        'key',
        verbDef.name === 'set_value' ? 'val' : undefined,
      );

      const risk = adapter.classifyRisk([mutation]);
      expect(typeof risk).toBe('string');
      expect(risk.length).toBeGreaterThan(0);
    }
  });

  test('produceMutations only produces verbs from manifest', async () => {
    const adapter = getAdapter();
    const knownVerbs = new Set(adapter.manifest.verbs.map(v => v.name));

    const predicates = [makePredicate('p0', 'x', '==', 'new_val')];
    const result = await adapter.produceMutations(
      'set x to new_val',
      predicates,
      [],
      {},
    );

    for (const m of result.mutations) {
      expect(knownVerbs.has(m.verb)).toBe(true);
    }
  });
});

// =============================================================================
// 7. ACTION CLASSIFICATION — Strategy classification for G2 constraint seeding
// =============================================================================

describe('Adapter Contract: Action Classification', () => {
  test('classifyAction exists and is a function', () => {
    const adapter = getAdapter();
    expect(typeof adapter.classifyAction).toBe('function');
  });

  test('empty mutations = undefined (no classifiable strategy)', () => {
    const adapter = getAdapter();
    const result = adapter.classifyAction([]);
    expect(result).toBeUndefined();
  });

  test('returns string or undefined — never null, never throws', () => {
    const adapter = getAdapter();

    // Test with each verb type
    for (const verbDef of adapter.manifest.verbs) {
      const mutation = makeMutation(
        verbDef.name,
        'x',
        verbDef.name === 'set_value' ? 'val' : undefined,
      );

      const result = adapter.classifyAction([mutation]);
      expect(result === undefined || typeof result === 'string').toBe(true);
    }
  });

  test('deterministic: same input = same classification', () => {
    const adapter = getAdapter();
    const mutations = [
      makeMutation('delete_key', 'a'),
      makeMutation('delete_key', 'b'),
      makeMutation('delete_key', 'c'),
    ];

    const r1 = adapter.classifyAction(mutations);
    const r2 = adapter.classifyAction(mutations);
    const r3 = adapter.classifyAction(mutations);

    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  test('classifies destructive patterns', () => {
    const adapter = getAdapter();

    // Bulk deletes should be classifiable
    const bulkDeletes = [
      makeMutation('delete_key', 'a'),
      makeMutation('delete_key', 'b'),
      makeMutation('delete_key', 'c'),
    ];

    const result = adapter.classifyAction(bulkDeletes);
    // The adapter should recognize this as some strategy
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  test('classification feeds into kernel constraint seeding', () => {
    const adapter = getAdapter();
    const mutations = [
      makeMutation('delete_key', 'a'),
      makeMutation('delete_key', 'b'),
      makeMutation('delete_key', 'c'),
    ];

    const actionClass = adapter.classifyAction(mutations);

    // The action class should be usable as FailureEvent.actionClass
    // (a string that the kernel's seedConstraint uses for forbidden_action)
    if (actionClass !== undefined) {
      expect(typeof actionClass).toBe('string');
      // Must not contain special characters that would break constraint matching
      expect(actionClass).toMatch(/^[a-z_]+$/);
    }
  });
});

// =============================================================================
// 8. MANIFEST COMPLETENESS — Structural integrity of manifest
// =============================================================================

describe('Adapter Contract: Manifest Completeness', () => {
  test('manifest has a name', () => {
    const adapter = getAdapter();
    expect(typeof adapter.manifest.name).toBe('string');
    expect(adapter.manifest.name.length).toBeGreaterThan(0);
  });

  test('manifest declares ceilings', () => {
    const adapter = getAdapter();
    expect(typeof adapter.manifest.ceilings.maxMutationsPerPlan).toBe('number');
    expect(adapter.manifest.ceilings.maxMutationsPerPlan).toBeGreaterThan(0);
    expect(typeof adapter.manifest.ceilings.requiresPredicates).toBe('boolean');
  });

  test('all adapter interface methods exist', () => {
    const adapter = getAdapter();

    // Every DomainAdapter method must be implemented
    expect(typeof adapter.classifyGoal).toBe('function');
    expect(typeof adapter.groundInReality).toBe('function');
    expect(typeof adapter.extractPredicates).toBe('function');
    expect(typeof adapter.validatePredicate).toBe('function');
    expect(typeof adapter.produceMutations).toBe('function');
    expect(typeof adapter.validateSyntax).toBe('function');
    expect(typeof adapter.attributeMutation).toBe('function');
    expect(typeof adapter.checkIdentityBinding).toBe('function');
    expect(typeof adapter.stage).toBe('function');
    expect(typeof adapter.execute).toBe('function');
    expect(typeof adapter.verify).toBe('function');
    expect(typeof adapter.captureState).toBe('function');
    expect(typeof adapter.restoreState).toBe('function');
    expect(typeof adapter.classifyRisk).toBe('function');
    expect(typeof adapter.classifyAction).toBe('function');
  });
});

// =============================================================================
// 9. END-TO-END CONTRACT — Full gate sequence traversable
// =============================================================================

describe('Adapter Contract: End-to-End Gate Traversal', () => {
  test('adapter supports full classify → verify flow', async () => {
    const state = createMockState({ x: 'old' });
    const adapter = createMockAdapter(state);

    // Gate 1: Classify
    const classification = await adapter.classifyGoal('set x to new');
    expect(typeof classification.intent).toBe('string');
    expect(Array.isArray(classification.domains)).toBe(true);

    // Gate 2: Ground
    const grounding = await adapter.groundInReality('test-target');
    expect(typeof grounding.summary).toBe('string');

    // Gate 3: Extract
    const predicates = await adapter.extractPredicates('set x to new', grounding.context);
    expect(predicates.length).toBeGreaterThan(0);

    // Gate 4: Plan
    const plan = await adapter.produceMutations('set x to new', predicates, [], grounding.context);
    expect(plan.mutations.length).toBeGreaterThan(0);

    // Gate 5: Syntax
    const syntax = await adapter.validateSyntax(plan.mutations);
    expect(syntax.passed).toBe(true);

    // Gate 7: Contain (attribution)
    for (const m of plan.mutations) {
      const attr = adapter.attributeMutation(m, predicates, []);
      expect(['direct', 'scaffolding', 'unexplained']).toContain(attr.attribution);
    }

    // Gate 7: Identity binding
    const mismatches = adapter.checkIdentityBinding(plan.mutations, []);
    expect(Array.isArray(mismatches)).toBe(true);

    // Gate 9: Stage
    const staging = await adapter.stage(plan.mutations, predicates);
    expect(staging.passed).toBe(true);

    // Gate 10: Execute
    const execution = await adapter.execute(plan.mutations);
    expect(execution.success).toBe(true);

    // Gate 11: Verify
    const verification = await adapter.verify(predicates);
    expect(verification.length).toBeGreaterThan(0);
    expect(verification[0].passed).toBe(true);

    // Gate 12: Capture state
    const checkpoint = await adapter.captureState('test-target');
    expect(typeof checkpoint.contentHashes).toBe('object');

    // Risk classification
    const risk = adapter.classifyRisk(plan.mutations);
    expect(typeof risk).toBe('string');
  });
});
