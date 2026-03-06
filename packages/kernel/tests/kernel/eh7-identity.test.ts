/**
 * Kernel E-H7: Identity Sovereignty Proof
 * ========================================
 *
 * Foreign controller jobs are immutable.
 *
 * Run with: bun test tests/constitutional/kernel/eh7-identity.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  assertMutable,
  isForeignJob,
  checkIdentity,
} from '../../src/kernel/identity.js';
import type { AuthorityContext } from '../../src/types.js';

// =============================================================================
// 1. ASSERT MUTABLE — Boolean guard
// =============================================================================

describe('E-H7 Identity: assertMutable', () => {
  test('own job is mutable', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      isForeign: false,
    };
    expect(assertMutable(authority)).toBe(true);
  });

  test('foreign job is NOT mutable', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-B',
      authorityEpoch: 1,
      isForeign: true,
    };
    expect(assertMutable(authority)).toBe(false);
  });
});

// =============================================================================
// 2. FOREIGN JOB DETECTION — Controller ID comparison
// =============================================================================

describe('E-H7 Identity: Foreign Detection', () => {
  test('same controller = not foreign', () => {
    expect(isForeignJob('ctrl-A', 'ctrl-A')).toBe(false);
  });

  test('different controller = foreign', () => {
    expect(isForeignJob('ctrl-A', 'ctrl-B')).toBe(true);
  });

  test('pre-E-H8 job (no controllerId) = adopted, not foreign', () => {
    expect(isForeignJob(undefined, 'ctrl-A')).toBe(false);
  });

  test('empty string controllerId = adopted (falsy, treated like undefined)', () => {
    // Empty string is falsy in JS — `!''` is true — so treated as "no controllerId"
    expect(isForeignJob('', 'ctrl-A')).toBe(false);
  });
});

// =============================================================================
// 3. IDENTITY GATE — Verdict
// =============================================================================

describe('E-H7 Identity: Gate Verdict', () => {
  test('own job = proceed', () => {
    const verdict = checkIdentity({
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      isForeign: false,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('approve');
  });

  test('foreign job = block', () => {
    const verdict = checkIdentity({
      controllerId: 'ctrl-B',
      authorityEpoch: 1,
      isForeign: true,
    });
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('approve');
    expect(verdict.reason).toContain('ctrl-B');
  });
});
