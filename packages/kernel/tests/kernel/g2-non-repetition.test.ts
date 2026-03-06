/**
 * Kernel G2: Non-Repetition Proof
 * ================================
 *
 * The system cannot repeat a strategy that already failed.
 *
 * Same invariants as tests/constitutional/memory.test.ts but importing
 * from the governance kernel only — zero web domain imports.
 *
 * Run with: bun test tests/constitutional/kernel/g2-non-repetition.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  extractSignature,
  checkConstraint,
  checkAllConstraints,
  constraintVerdict,
  buildEvidenceBlock,
  type PlanSurface,
  type FileOutcomeEvidence,
  type PatternEvidence,
} from '../../src/kernel/non-repetition.js';
import type { GovernanceConstraint } from '../../src/types.js';

// =============================================================================
// 1. SIGNATURE EXTRACTION — Deterministic failure classification
// =============================================================================

describe('G2 Non-Repetition: Signature Extraction', () => {
  test('timeout patterns', () => {
    expect(extractSignature('Connection timed out after 30s')).toBe('timeout');
    expect(extractSignature('Operation exceeded time limit')).toBe('timeout');
    expect(extractSignature('Request timeout')).toBe('timeout');
  });

  test('port conflict', () => {
    expect(extractSignature('Error: EADDRINUSE: address already in use :3000')).toBe('port_conflict');
    expect(extractSignature('Port 3000 is in use')).toBe('port_conflict');
  });

  test('syntax errors', () => {
    expect(extractSignature('SyntaxError: Unexpected token }')).toBe('syntax_error');
    expect(extractSignature('Parse error in line 42')).toBe('syntax_error');
  });

  test('missing dependencies', () => {
    expect(extractSignature('Error: Cannot find module "express"')).toBe('missing_dependency');
    expect(extractSignature('MODULE_NOT_FOUND: lodash')).toBe('missing_dependency');
  });

  test('build failures', () => {
    expect(extractSignature('Build failed with exit code 1')).toBe('build_failure');
    expect(extractSignature('Compilation failure in server.ts')).toBe('build_failure');
  });

  test('health check failures', () => {
    expect(extractSignature('Health check failed after 3 retries')).toBe('health_check_failure');
    expect(extractSignature('Container marked unhealthy')).toBe('health_check_failure');
    expect(extractSignature('502 spike detected')).toBe('health_check_failure');
  });

  test('connection refused', () => {
    expect(extractSignature('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connection_refused');
  });

  test('out of memory', () => {
    expect(extractSignature('Process killed: out of memory')).toBe('oom_killed');
    expect(extractSignature('OOMKilled by system')).toBe('oom_killed');
  });

  test('constraint violations (domain-agnostic)', () => {
    expect(extractSignature('duplicate key value violates unique constraint')).toBe('constraint_violation');
    expect(extractSignature('violates not-null constraint on column "name"')).toBe('constraint_violation');
    expect(extractSignature('foreign key constraint violation')).toBe('constraint_violation');
  });

  test('verification failures', () => {
    expect(extractSignature('.roster-link (not found in DOM)')).toBe('element_not_found');
    expect(extractSignature('actual: red expected: blue')).toBe('value_mismatch');
    expect(extractSignature('predicate p1 failed: color mismatch')).toBe('predicate_failure');
  });

  test('unknown pattern returns undefined', () => {
    expect(extractSignature('Everything is fine')).toBeUndefined();
    expect(extractSignature('')).toBeUndefined();
  });

  test('first match wins (priority order)', () => {
    // "timed out" matches timeout, but also matches other patterns
    expect(extractSignature('Connection timed out')).toBe('timeout');
  });

  test('empty/null input safety', () => {
    expect(extractSignature('')).toBeUndefined();
  });
});

// =============================================================================
// 2. CONSTRAINT EVALUATION — Single constraint check
// =============================================================================

describe('G2 Non-Repetition: Constraint Evaluation', () => {
  const makeConstraint = (overrides: Partial<GovernanceConstraint> = {}): GovernanceConstraint => ({
    id: 'c1',
    type: 'forbidden_action',
    signature: 'health_check_failure',
    scope: 'planning',
    appliesTo: ['logic', 'mixed'],
    surface: {
      files: ['server.js', 'routes/'],
      intents: ['routes', 'api'],
    },
    requires: {
      patterns: ['/health'],
    },
    reason: 'Repeated 502 failures after deploy without health check',
    introducedAt: Date.now(),
    ...overrides,
  });

  test('constraint satisfied when plan includes required patterns', () => {
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: ['routes'],
      properties: { '/health': true },
    };
    expect(checkConstraint(surface, makeConstraint(), 'logic')).toBe(true);
  });

  test('constraint violated when required pattern missing', () => {
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: ['routes'],
      properties: {},
    };
    expect(checkConstraint(surface, makeConstraint(), 'logic')).toBe(false);
  });

  test('constraint does not apply to non-matching risk class', () => {
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: ['routes'],
      properties: {},
    };
    // Constraint appliesTo ['logic', 'mixed'] — 'ui' is not in scope
    expect(checkConstraint(surface, makeConstraint(), 'ui')).toBe(true);
  });

  test('constraint does not fire for unrelated files', () => {
    const surface: PlanSurface = {
      files: ['styles.css'],
      intents: ['ui'],
      properties: {},
    };
    expect(checkConstraint(surface, makeConstraint(), 'logic')).toBe(true);
  });

  test('goal_drift_ban blocks mismatched risk class', () => {
    const constraint = makeConstraint({
      type: 'goal_drift_ban',
      appliesTo: ['schema', 'config', 'infra'],
    });
    const surface: PlanSurface = {
      files: ['migration.sql'],
      intents: ['schema'],
      properties: {},
    };
    expect(checkConstraint(surface, constraint, 'schema')).toBe(false);
    expect(checkConstraint(surface, constraint, 'ui')).toBe(true);
  });

  test('radius_limit enforces file count', () => {
    const constraint = makeConstraint({
      type: 'radius_limit',
      requires: { maxMutations: 3 },
    });
    const smallSurface: PlanSurface = {
      files: ['a.js', 'b.js'],
      intents: [],
      properties: {},
    };
    const largeSurface: PlanSurface = {
      files: ['a.js', 'b.js', 'c.js', 'd.js'],
      intents: [],
      properties: {},
    };
    expect(checkConstraint(smallSurface, constraint, 'logic')).toBe(true);
    expect(checkConstraint(largeSurface, constraint, 'logic')).toBe(false);
  });
});

// =============================================================================
// 3. BATCH CONSTRAINT CHECK — All constraints + overrides
// =============================================================================

describe('G2 Non-Repetition: Batch Constraint Check', () => {
  test('no constraints = no violation', () => {
    const surface: PlanSurface = { files: ['anything.js'], intents: [], properties: {} };
    const result = checkAllConstraints(surface, [], 'logic');
    expect(result.violation).toBeNull();
    expect(result.overridden).toHaveLength(0);
  });

  test('violated constraint returned', () => {
    const constraint: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'health_check_failure',
      scope: 'planning',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/health'] },
      reason: 'Must include health check',
      introducedAt: Date.now(),
    };
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: [],
      properties: {},
    };
    const result = checkAllConstraints(surface, [constraint], 'logic');
    expect(result.violation).not.toBeNull();
    expect(result.violation!.signature).toBe('health_check_failure');
  });

  test('override allows violation to pass', () => {
    const constraint: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'health_check_failure',
      scope: 'planning',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/health'] },
      reason: 'Must include health check',
      introducedAt: Date.now(),
    };
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: [],
      properties: {},
    };
    const result = checkAllConstraints(surface, [constraint], 'logic', ['health_check_failure']);
    expect(result.violation).toBeNull();
    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0].signature).toBe('health_check_failure');
  });

  test('expired constraints filtered out', () => {
    const expired: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'old_failure',
      scope: 'planning',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/check'] },
      reason: 'Old failure pattern',
      introducedAt: Date.now() - 100000,
      expiresAt: Date.now() - 1000, // Already expired
    };
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: [],
      properties: {},
    };
    const result = checkAllConstraints(surface, [expired], 'logic');
    expect(result.violation).toBeNull();
  });

  test('first violation wins (stops checking)', () => {
    const c1: GovernanceConstraint = {
      id: 'c1',
      type: 'forbidden_action',
      signature: 'first_failure',
      scope: 'planning',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/never'] },
      reason: 'First failure',
      introducedAt: Date.now(),
    };
    const c2: GovernanceConstraint = {
      id: 'c2',
      type: 'forbidden_action',
      signature: 'second_failure',
      scope: 'planning',
      appliesTo: ['logic'],
      surface: { files: ['server.js'], intents: [] },
      requires: { patterns: ['/also_never'] },
      reason: 'Second failure',
      introducedAt: Date.now(),
    };
    const surface: PlanSurface = {
      files: ['server.js'],
      intents: [],
      properties: {},
    };
    const result = checkAllConstraints(surface, [c1, c2], 'logic');
    expect(result.violation!.signature).toBe('first_failure');
  });
});

// =============================================================================
// 4. CONSTRAINT VERDICT — Gate decision
// =============================================================================

describe('G2 Non-Repetition: Constraint Verdict', () => {
  test('no violation = proceed', () => {
    const verdict = constraintVerdict({ violation: null, overridden: [] });
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('constrain');
  });

  test('violation = block with escalation context', () => {
    const verdict = constraintVerdict({
      violation: {
        constraintId: 'c1',
        signature: 'health_check_failure',
        reason: 'Must include health check',
        surface: { files: ['server.js'], intents: [], properties: {} },
        constraint: {} as GovernanceConstraint,
      },
      overridden: [],
    });
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('constrain');
    expect(verdict.reason).toContain('CONSTRAINT VIOLATION');
    expect(verdict.escalationContext?.constraintViolation?.signature).toBe('health_check_failure');
  });

  test('overrides noted in proceed reason', () => {
    const verdict = constraintVerdict({
      violation: null,
      overridden: [{ signature: 'health_check_failure', reason: 'acknowledged' }],
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toContain('1 overridden');
  });
});

// =============================================================================
// 5. EVIDENCE BLOCK FORMATTING — Pure text construction
// =============================================================================

describe('G2 Non-Repetition: Evidence Block', () => {
  test('empty evidence returns undefined', () => {
    expect(buildEvidenceBlock('myapp', [], [])).toBeUndefined();
  });

  test('file evidence formatted correctly', () => {
    const fileEvidence: FileOutcomeEvidence[] = [{
      file: 'server.js',
      totalOutcomes: 5,
      successes: 3,
      failures: 1,
      rollbacks: 1,
      lastFailure: { checkpoint: 'CP-10', date: 'Feb 3', reason: '502 spike' },
      lastSuccess: { checkpoint: 'CP-12', date: 'Feb 5' },
      trendStreak: 2,
    }];

    const block = buildEvidenceBlock('myapp', fileEvidence, []);
    expect(block).toBeDefined();
    expect(block).toContain('[OPERATIONAL MEMORY — myapp]');
    expect(block).toContain('server.js');
    expect(block).toContain('5 total');
    expect(block).toContain('3 successes');
    expect(block).toContain('1 failure');
    expect(block).toContain('1 rollback');
    expect(block).toContain('CP-10');
    expect(block).toContain('502 spike');
    expect(block).toContain('CP-12');
    expect(block).toContain('2 consecutive successes');
  });

  test('negative trend shows failures', () => {
    const fileEvidence: FileOutcomeEvidence[] = [{
      file: 'broken.js',
      totalOutcomes: 3,
      successes: 0,
      failures: 3,
      rollbacks: 0,
      trendStreak: -3,
    }];

    const block = buildEvidenceBlock('app', fileEvidence, []);
    expect(block).toContain('3 consecutive failures');
  });

  test('pattern evidence formatted correctly', () => {
    const patterns: PatternEvidence[] = [{
      signature: 'migration_timeout',
      occurrences: 3,
      winningFixes: ['split migration into two steps', 'add index first'],
    }];

    const block = buildEvidenceBlock('myapp', [], patterns);
    expect(block).toContain('migration_timeout');
    expect(block).toContain('seen 3x');
    expect(block).toContain('split migration into two steps');
  });

  test('pattern with no winning fixes', () => {
    const patterns: PatternEvidence[] = [{
      signature: 'oom_killed',
      occurrences: 1,
      winningFixes: [],
    }];

    const block = buildEvidenceBlock('app', [], patterns);
    expect(block).toContain('no recorded fixes yet');
  });

  test('singular/plural grammar', () => {
    const evidence: FileOutcomeEvidence[] = [{
      file: 'f.js',
      totalOutcomes: 1,
      successes: 1,
      failures: 0,
      rollbacks: 0,
      trendStreak: 1,
    }];

    const block = buildEvidenceBlock('app', evidence, []);
    expect(block).toContain('1 success,');
    expect(block).toContain('0 failures');
    expect(block).toContain('1 consecutive success');
  });
});
