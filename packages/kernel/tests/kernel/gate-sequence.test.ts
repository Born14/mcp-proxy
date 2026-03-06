/**
 * Kernel Gate Sequence Proof
 * ==========================
 *
 * The 12-gate sequence is immutable. Gates 6-8 are pure governance.
 * Tests the gate sequence constants and gate-level pure functions.
 *
 * Run with: bun test tests/constitutional/kernel/gate-sequence.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  GATE_ORDER,
  gateConstrain,
  gateContain,
  gateApprove,
  seedConstraint,
  extractPlanSurface,
} from '../../src/kernel/gate-sequence.js';
import {
  createMockAdapter,
  createMockState,
} from '../../src/adapters/mock-adapter.js';
import type {
  Mutation,
  Predicate,
  Evidence,
  GovernanceConstraint,
  AuthorityContext,
  ApprovalPolicy,
  ContainmentResult,
  FailureEvent,
} from '../../src/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

function makePolicy(overrides?: Partial<ApprovalPolicy>): ApprovalPolicy {
  return {
    trustLevels: { ui: 'auto', logic: 'gate', config: 'gate', schema: 'gate', infra: 'gate' },
    containmentMode: 'advisory',
    requireContainmentForAutoApprove: false,
    ...overrides,
  };
}

function makeContainment(contained = true): ContainmentResult {
  return {
    contained,
    attributions: [],
    identityMismatches: [],
    directCount: contained ? 1 : 0,
    scaffoldingCount: 0,
    unexplainedCount: contained ? 0 : 1,
    summary: contained ? '1 traced' : '1 untraced',
  };
}

// =============================================================================
// 1. GATE ORDER — Immutable sequence
// =============================================================================

describe('Gate Sequence: Order', () => {
  test('16 gates in correct order', () => {
    expect(GATE_ORDER).toEqual([
      'classify', 'grounding', 'ground', 'extract', 'plan', 'syntax',
      'constrain', 'scope', 'contain', 'approve', 'stage', 'execute',
      'verify', 'evidence', 'converge', 'attest',
    ]);
  });

  test('gate order is readonly (TypeScript const assertion)', () => {
    // GATE_ORDER is `as const` — TypeScript prevents mutation at compile time.
    // At runtime, verify it has 16 elements and correct structure.
    expect(GATE_ORDER).toHaveLength(16);
    expect(typeof GATE_ORDER[0]).toBe('string');
  });

  test('governance gates at correct positions', () => {
    // Pure governance gates (kernel-owned, no adapter needed):
    // constrain(6), scope(7), contain(8), approve(9), evidence(13), converge(14)
    expect(GATE_ORDER[6]).toBe('constrain');
    expect(GATE_ORDER[7]).toBe('scope');
    expect(GATE_ORDER[8]).toBe('contain');
    expect(GATE_ORDER[9]).toBe('approve');
    expect(GATE_ORDER[13]).toBe('evidence');
    expect(GATE_ORDER[14]).toBe('converge');
  });

  test('new invariant gates at correct positions relative to original gates', () => {
    // G7 grounding is before ground (adapter populates reality)
    expect(GATE_ORDER.indexOf('grounding')).toBeLessThan(GATE_ORDER.indexOf('ground'));
    // G6 scope is between constrain and contain
    expect(GATE_ORDER.indexOf('scope')).toBeGreaterThan(GATE_ORDER.indexOf('constrain'));
    expect(GATE_ORDER.indexOf('scope')).toBeLessThan(GATE_ORDER.indexOf('contain'));
    // G9 evidence is after verify
    expect(GATE_ORDER.indexOf('evidence')).toBeGreaterThan(GATE_ORDER.indexOf('verify'));
    // G8 converge is after evidence, before attest
    expect(GATE_ORDER.indexOf('converge')).toBeGreaterThan(GATE_ORDER.indexOf('evidence'));
    expect(GATE_ORDER.indexOf('converge')).toBeLessThan(GATE_ORDER.indexOf('attest'));
  });
});

// =============================================================================
// 2. GATE 6: CONSTRAIN — Constraint enforcement
// =============================================================================

describe('Gate Sequence: Gate 6 (Constrain)', () => {
  test('no constraints = proceed', () => {
    const surface = { files: ['server.js'], intents: ['routes'], properties: {} };
    const verdict = gateConstrain(surface, [], 'logic');
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('constrain');
  });

  test('violated constraint = block', () => {
    const constraint: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'health_check_failure',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/health'] },
      reason: 'Must include health check',
      introducedAt: Date.now(),
    };

    const surface = { files: ['server.js'], intents: [], properties: {} };
    const verdict = gateConstrain(surface, [constraint], 'logic');
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('CONSTRAINT VIOLATION');
  });

  test('overridden constraint = proceed', () => {
    const constraint: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'sig1',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/never'] },
      reason: 'test',
      introducedAt: Date.now(),
    };

    const surface = { files: ['server.js'], intents: [], properties: {} };
    const verdict = gateConstrain(surface, [constraint], 'logic', ['sig1']);
    expect(verdict.action).toBe('proceed');
  });
});

// =============================================================================
// 3. GATE 7: CONTAIN — Mutation attribution
// =============================================================================

describe('Gate Sequence: Gate 7 (Contain)', () => {
  const state = createMockState({ x: 'old' });
  const adapter = createMockAdapter(state);

  test('all mutations attributed = proceed', () => {
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'x', capturedAt: Date.now(), args: { key: 'x', value: 'new' } },
    ];
    const predicates: Predicate[] = [
      { id: 'p0', type: 'kv', description: 'x == new', fields: { key: 'x' }, operator: '==', value: 'new' },
    ];
    const evidence: Evidence[] = [{
      type: 'observation',
      data: { keys: ['x'] },
      source: 'grounding',
      capturedAt: Date.now(),
    }];

    const { result, verdict } = gateContain(mutations, predicates, evidence, adapter, 'advisory');
    expect(verdict.action).toBe('proceed');
    expect(result.contained).toBe(true);
  });

  test('unexplained mutation in hard_gate = block', () => {
    const mutations: Mutation[] = [
      { verb: 'delete_key', target: 'z', capturedAt: Date.now(), args: { key: 'z' } },
    ];
    const predicates: Predicate[] = [
      { id: 'p0', type: 'kv', description: 'x == val', fields: { key: 'x' }, operator: '==', value: 'val' },
    ];

    const { result, verdict } = gateContain(mutations, predicates, [], adapter, 'hard_gate');
    expect(verdict.action).toBe('block');
    expect(result.unexplainedCount).toBe(1);
  });

  test('advisory mode: not contained = still proceed', () => {
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'unmatched', capturedAt: Date.now(), args: { key: 'unmatched', value: 'x' } },
    ];
    const predicates: Predicate[] = [
      { id: 'p0', type: 'kv', description: 'y == val', fields: { key: 'y' }, operator: '==', value: 'val' },
    ];

    const { verdict } = gateContain(mutations, predicates, [], adapter, 'advisory');
    expect(verdict.action).toBe('proceed');
  });
});

// =============================================================================
// 4. GATE 8: APPROVE — Authority checks
// =============================================================================

describe('Gate Sequence: Gate 8 (Approve)', () => {
  const policy = makePolicy();
  const containment = makeContainment();

  test('own job, current authority, auto trust = proceed', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      planEpoch: 1,
      isForeign: false,
    };

    // 'ui' is auto-trust in makePolicy()
    const verdict = gateApprove(authority, 'ui', containment, policy);
    expect(verdict.action).toBe('proceed');
  });

  test('own job, gate trust = escalate', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      planEpoch: 1,
      isForeign: false,
    };

    // 'logic' is gate trust in makePolicy()
    const verdict = gateApprove(authority, 'logic', containment, policy);
    expect(verdict.action).toBe('escalate');
    expect(verdict.reason).toContain('Human approval required');
  });

  test('foreign job = block', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-B',
      authorityEpoch: 1,
      planEpoch: 1,
      isForeign: true,
    };

    const verdict = gateApprove(authority, 'logic', containment, policy);
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('ctrl-B');
  });

  test('stale plan = invalidate', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      planEpoch: 3,
      isForeign: false,
    };

    const verdict = gateApprove(authority, 'logic', containment, policy);
    expect(verdict.action).toBe('invalidate');
    expect(verdict.reason).toContain('PLAN_INVALIDATED');
  });

  test('risk class exceeds ceiling = block', () => {
    const ceilingPolicy = makePolicy({ ceiling: 'ui' });
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      planEpoch: 1,
      isForeign: false,
    };

    const verdict = gateApprove(authority, 'schema', containment, ceilingPolicy);
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('ceiling');
  });

  test('auto-approve blocked when containment required but not contained', () => {
    const strictPolicy = makePolicy({
      trustLevels: { ui: 'auto' },
      requireContainmentForAutoApprove: true,
    });
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      planEpoch: 1,
      isForeign: false,
    };
    const notContained = makeContainment(false);

    const verdict = gateApprove(authority, 'ui', notContained, strictPolicy);
    expect(verdict.action).toBe('escalate');
    expect(verdict.reason).toContain('containment');
  });
});

// =============================================================================
// 5. CONSTRAINT SEEDING — Failure to constraint
// =============================================================================

describe('Gate Sequence: Constraint Seeding', () => {
  test('seeds forbidden_action from staging failure with actionClass (attempt >= 2)', () => {
    const failure: FailureEvent = {
      jobId: 'job-1',
      source: 'staging',
      error: 'Deploy without health check',
      filesTouched: ['server.js'],
      attempt: 2,
      riskClass: 'logic',
      actionClass: 'rewrite_page',
    };

    const constraint = seedConstraint(failure, []);
    expect(constraint).toBeDefined();
    expect(constraint!.type).toBe('forbidden_action');
    expect(constraint!.signature).toBe('rewrite_page');
    expect(constraint!.reason).toContain('rewrite_page');
    expect(constraint!.reason).toContain('Deploy without health check');
  });

  test('seeds radius_limit from post_deploy failure without actionClass', () => {
    const failure: FailureEvent = {
      jobId: 'job-1',
      source: 'post_deploy',
      error: 'Build broke',
      filesTouched: ['a.js', 'b.js', 'c.js'],
      attempt: 2,
      riskClass: 'logic',
    };

    const constraint = seedConstraint(failure, []);
    expect(constraint).toBeDefined();
    expect(constraint!.type).toBe('radius_limit');
    expect(constraint!.requires.maxMutations).toBeDefined();
  });

  test('constraint has job scope and TTL', () => {
    const failure: FailureEvent = {
      jobId: 'job-1',
      source: 'post_deploy',
      error: 'test failure',
      filesTouched: [],
      attempt: 1,
    };

    const constraint = seedConstraint(failure, []);
    expect(constraint).not.toBeNull();
    expect(constraint!.jobId).toBe('job-1');
    expect(constraint!.jobScoped).toBe(true);
    expect(constraint!.expiresAt).toBeDefined();
    expect(constraint!.expiresAt!).toBeGreaterThan(Date.now());
  });

  test('max depth prevents new constraints', () => {
    const existing: GovernanceConstraint[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      type: 'radius_limit' as const,
      signature: 'sig',
      appliesTo: ['logic'],
      surface: { files: [], intents: [] },
      requires: {},
      reason: 'test',
      introducedAt: Date.now(),
      jobId: 'job-1',
    }));

    const failure: FailureEvent = {
      jobId: 'job-1',
      source: 'staging',
      error: 'another failure',
      filesTouched: ['a.js'],
      attempt: 3,
    };

    const constraint = seedConstraint(failure, existing, 5);
    expect(constraint).toBeNull();
  });

  test('syntax failure at attempt 1 returns null (needs corroboration)', () => {
    const failure: FailureEvent = {
      jobId: 'job-1',
      source: 'syntax',
      error: 'Syntax error in line 42',
      filesTouched: ['server.js'],
      attempt: 1,
    };

    const constraint = seedConstraint(failure, []);
    expect(constraint).toBeNull();
  });

  test('progressive radius narrowing', () => {
    const failure1: FailureEvent = {
      jobId: 'job-1',
      source: 'post_deploy',
      error: 'failed attempt 1',
      filesTouched: ['a.js'],
      attempt: 1,
    };

    // First seed: radius → 5
    const c1 = seedConstraint(failure1, []);
    expect(c1).not.toBeNull();
    expect(c1!.type).toBe('radius_limit');
    expect(c1!.requires.maxMutations).toBe(5);

    // Second seed: radius → 4
    const c2 = seedConstraint(
      { ...failure1, attempt: 2 },
      [c1!],
    );
    expect(c2).not.toBeNull();
    expect(c2!.type).toBe('radius_limit');
    expect(c2!.requires.maxMutations).toBe(4);
  });
});

// =============================================================================
// 6. PLAN SURFACE EXTRACTION — Domain-agnostic
// =============================================================================

describe('Gate Sequence: Plan Surface Extraction', () => {
  test('extracts files from mutations', () => {
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'x', capturedAt: Date.now(), args: { key: 'x', value: '1' } },
      { verb: 'delete_key', target: 'y', capturedAt: Date.now(), args: { key: 'y' } },
    ];

    const surface = extractPlanSurface(mutations);
    expect(surface.files).toContain('x');
    expect(surface.files).toContain('y');
  });

  test('empty mutations = empty surface', () => {
    const surface = extractPlanSurface([]);
    expect(surface.files).toHaveLength(0);
    expect(surface.intents).toHaveLength(0);
  });

  test('deduplicates files', () => {
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'x', capturedAt: Date.now(), args: { key: 'x', value: '1' } },
      { verb: 'set_value', target: 'x', capturedAt: Date.now(), args: { key: 'x', value: '2' } },
    ];

    const surface = extractPlanSurface(mutations);
    expect(surface.files).toHaveLength(1);
  });

  test('adapter intents passed through', () => {
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'x', capturedAt: Date.now(), args: { key: 'x', value: '1' } },
    ];

    const surface = extractPlanSurface(mutations, ['routes', 'db']);
    expect(surface.intents).toEqual(['routes', 'db']);
  });

  test('adapter properties passed through', () => {
    const surface = extractPlanSurface([], undefined, { hasCSS: true, hasSQL: false });
    expect(surface.properties).toEqual({ hasCSS: true, hasSQL: false });
  });
});
