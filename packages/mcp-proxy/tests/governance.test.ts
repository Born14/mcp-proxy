/**
 * Governance Gate Tests
 * =====================
 *
 * Proves:
 *   G2: Tool call that previously failed → blocked (strict) / annotated (advisory)
 *   G2: Same tool, different target → allowed
 *   G2: Constraint TTL expiry → allowed again
 *   G2: Duplicate failure doesn't create duplicate constraint
 *   E-H7: Controller identity persisted across restarts
 *   E-H8: bump_authority increments epoch
 *   E-H8: Session epoch captured at startup, frozen for session lifetime
 *   E-H8: Tool call after bump_authority → blocked (sessionEpoch < authorityEpoch)
 *   E-H8: Advisory mode logs violation but forwards anyway
 *   Receipt includes all governance check results + enforcement mode
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkConstraints, checkAuthority, runGates, processFailure, CONSTRAINT_TTL_MS } from '../src/governance.js';
import type { ConstraintEntry, AuthorityState } from '../src/types.js';
import type { Mutation } from '@sovereign-labs/kernel/types';
import { ensureStateDir } from '../src/state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-gov-'));
  ensureStateDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMutation(verb: string, target: string): Mutation {
  return { verb, target, capturedAt: Date.now(), args: {} };
}

// =============================================================================
// G2: CONSTRAINT CHECK
// =============================================================================

describe('G2: checkConstraints', () => {
  test('blocks tool+target with prior failure', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const result = checkConstraints(makeMutation('write_file', '/tmp/test.js'), constraints);
    expect(result.passed).toBe(false);
    expect(result.blockedBy).toBe('c_1');
  });

  test('allows same tool, different target', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/a.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const result = checkConstraints(makeMutation('write_file', '/tmp/b.js'), constraints);
    expect(result.passed).toBe(true);
  });

  test('allows different tool, same target', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const result = checkConstraints(makeMutation('read_file', '/tmp/test.js'), constraints);
    expect(result.passed).toBe(true);
  });

  test('allows after TTL expiry', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now() - CONSTRAINT_TTL_MS - 1000, // Expired
    }];

    const result = checkConstraints(makeMutation('write_file', '/tmp/test.js'), constraints);
    expect(result.passed).toBe(true);
  });

  test('blocks when within TTL', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now() - (CONSTRAINT_TTL_MS / 2), // Half TTL — still active
    }];

    const result = checkConstraints(makeMutation('write_file', '/tmp/test.js'), constraints);
    expect(result.passed).toBe(false);
  });

  test('empty constraints → always passes', () => {
    const result = checkConstraints(makeMutation('any_tool', '/any/target'), []);
    expect(result.passed).toBe(true);
  });
});

// =============================================================================
// E-H8: AUTHORITY CHECK
// =============================================================================

describe('E-H8: checkAuthority', () => {
  test('passes when session epoch matches authority epoch', () => {
    const state: AuthorityState = {
      controllerId: 'test',
      epoch: 3,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 3,
    };

    const verdict = checkAuthority(state);
    expect(verdict.action).toBe('proceed');
  });

  test('invalidates when authority epoch > session epoch (bumped during session)', () => {
    const state: AuthorityState = {
      controllerId: 'test',
      epoch: 5, // Bumped to 5
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 3, // Session started at 3
    };

    const verdict = checkAuthority(state);
    expect(verdict.action).toBe('invalidate');
    expect(verdict.reason).toContain('PLAN_INVALIDATED');
  });

  test('passes when no session epoch (pre-planning)', () => {
    const state: AuthorityState = {
      controllerId: 'test',
      epoch: 0,
      lastBumpedAt: Date.now(),
      // No activeSessionEpoch
    };

    const verdict = checkAuthority(state);
    expect(verdict.action).toBe('proceed');
  });
});

// =============================================================================
// GATE ORCHESTRATION
// =============================================================================

describe('runGates', () => {
  const baseAuthority: AuthorityState = {
    controllerId: 'test',
    epoch: 0,
    lastBumpedAt: Date.now(),
    activeSessionEpoch: 0,
  };

  test('strict mode: constraint violation blocks', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      constraints,
      baseAuthority,
      'strict',
    );

    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('G2 BLOCKED');
  });

  test('advisory mode: constraint violation forwards anyway', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      constraints,
      baseAuthority,
      'advisory',
    );

    expect(result.forward).toBe(true);
    expect(result.constraintCheck.passed).toBe(false);
  });

  test('strict mode: authority violation blocks', () => {
    const staleAuth: AuthorityState = {
      controllerId: 'test',
      epoch: 5,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 3,
    };

    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      staleAuth,
      'strict',
    );

    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('E-H8 BLOCKED');
  });

  test('advisory mode: authority violation forwards', () => {
    const staleAuth: AuthorityState = {
      controllerId: 'test',
      epoch: 5,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 3,
    };

    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      staleAuth,
      'advisory',
    );

    expect(result.forward).toBe(true);
    expect(result.authorityCheck.passed).toBe(false);
  });

  test('both checks pass → forwards', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
    );

    expect(result.forward).toBe(true);
    expect(result.constraintCheck.passed).toBe(true);
    expect(result.authorityCheck.passed).toBe(true);
  });

  test('receipt captures both check results', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const staleAuth: AuthorityState = {
      controllerId: 'test',
      epoch: 5,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 3,
    };

    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      constraints,
      staleAuth,
      'strict',
    );

    expect(result.constraintCheck.passed).toBe(false);
    expect(result.constraintCheck.blockedBy).toBe('c_1');
    expect(result.authorityCheck.passed).toBe(false);
    expect(result.authorityCheck.reason).toContain('PLAN_INVALIDATED');
  });

  // =========================================================================
  // Convergence signal integration with runGates
  // =========================================================================

  test('convergence exhausted blocks in strict mode', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'exhausted',
    );
    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('CONVERGENCE BLOCKED');
    expect(result.convergenceSignal).toBe('exhausted');
  });

  test('convergence loop blocks in strict mode', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'loop',
    );
    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('CONVERGENCE BLOCKED');
    expect(result.convergenceSignal).toBe('loop');
  });

  test('convergence warning never blocks in strict mode', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'warning',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBe('warning');
  });

  test('convergence in advisory mode always forwards (even exhausted)', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'advisory',
      'exhausted',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBe('exhausted');
  });

  test('convergence in advisory mode always forwards (even loop)', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'advisory',
      'loop',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBe('loop');
  });
});

// =============================================================================
// CONSTRAINT SEEDING
// =============================================================================

describe('processFailure', () => {
  test('seeds constraint on recognized error', () => {
    const constraints: ConstraintEntry[] = [];
    const result = processFailure(
      'write_file',
      '/tmp/test.js',
      'SyntaxError: Unexpected token }',
      constraints,
      tmpDir,
    );

    expect(result).not.toBeNull();
    expect(constraints).toHaveLength(1);
    expect(constraints[0].failureSignature).toBe('syntax_error');
  });

  test('seeds first-line constraint for unrecognized error', () => {
    const constraints: ConstraintEntry[] = [];
    const result = processFailure(
      'custom',
      '/tmp',
      'all good',
      constraints,
      tmpDir,
    );

    expect(result).not.toBeNull();
    expect(result!.failureSignature).toBe('all good');
    expect(constraints).toHaveLength(1);
  });

  test('returns null for empty error', () => {
    const constraints: ConstraintEntry[] = [];
    const result = processFailure('custom', '/tmp', '', constraints, tmpDir);
    expect(result).toBeNull();
    expect(constraints).toHaveLength(0);
  });

  test('deduplicates constraint seeding', () => {
    const constraints: ConstraintEntry[] = [];

    processFailure('write_file', '/tmp/test.js', 'SyntaxError: bad', constraints, tmpDir);
    processFailure('write_file', '/tmp/test.js', 'SyntaxError: also bad', constraints, tmpDir);

    // Same tool + target + signature → dedup
    expect(constraints).toHaveLength(1);
  });
});
