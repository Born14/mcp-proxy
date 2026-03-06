/**
 * Kernel E-H8: Temporal Sovereignty Proof
 * ========================================
 *
 * Latest human authority invalidates stale plans.
 *
 * Run with: bun test tests/constitutional/kernel/eh8-temporal.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  validateAuthority,
  capturePlanEpoch,
  incrementAuthority,
} from '../../src/kernel/temporal.js';
import type { AuthorityContext } from '../../src/types.js';

// =============================================================================
// 1. AUTHORITY VALIDATION — Epoch comparison
// =============================================================================

describe('E-H8 Temporal: Authority Validation', () => {
  test('no plan epoch = proceed (pre-planning)', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 3,
      isForeign: false,
      // planEpoch is undefined
    };
    const verdict = validateAuthority(authority);
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toContain('pre-planning');
  });

  test('matching epochs = proceed (plan is current)', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      planEpoch: 5,
      isForeign: false,
    };
    const verdict = validateAuthority(authority);
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toContain('current');
  });

  test('epoch mismatch = PLAN_INVALIDATED', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 7,
      planEpoch: 5,
      isForeign: false,
    };
    const verdict = validateAuthority(authority);
    expect(verdict.action).toBe('invalidate');
    expect(verdict.reason).toContain('PLAN_INVALIDATED');
    expect(verdict.reason).toContain('7');
    expect(verdict.reason).toContain('5');
  });

  test('single increment causes invalidation', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 2,
      planEpoch: 1,
      isForeign: false,
    };
    const verdict = validateAuthority(authority);
    expect(verdict.action).toBe('invalidate');
  });
});

// =============================================================================
// 2. PLAN EPOCH CAPTURE — Snapshot authority
// =============================================================================

describe('E-H8 Temporal: Plan Epoch Capture', () => {
  test('captures current authority as plan epoch', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 3,
      isForeign: false,
    };
    const captured = capturePlanEpoch(authority);
    expect(captured.planEpoch).toBe(3);
    expect(captured.authorityEpoch).toBe(3);
    expect(captured.controllerId).toBe('ctrl-A');
  });

  test('does not mutate input', () => {
    const original: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      isForeign: false,
    };
    const captured = capturePlanEpoch(original);
    expect(original.planEpoch).toBeUndefined();
    expect(captured.planEpoch).toBe(5);
  });

  test('overwrites existing plan epoch', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 10,
      planEpoch: 7,
      isForeign: false,
    };
    const captured = capturePlanEpoch(authority);
    expect(captured.planEpoch).toBe(10);
  });
});

// =============================================================================
// 3. AUTHORITY INCREMENT — Human message injection
// =============================================================================

describe('E-H8 Temporal: Authority Increment', () => {
  test('increments epoch by 1', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      isForeign: false,
    };
    const incremented = incrementAuthority(authority);
    expect(incremented.authorityEpoch).toBe(6);
  });

  test('does not mutate input', () => {
    const original: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      isForeign: false,
    };
    incrementAuthority(original);
    expect(original.authorityEpoch).toBe(5);
  });

  test('preserves all other fields', () => {
    const authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 5,
      planEpoch: 3,
      isForeign: false,
    };
    const incremented = incrementAuthority(authority);
    expect(incremented.controllerId).toBe('ctrl-A');
    expect(incremented.planEpoch).toBe(3);
    expect(incremented.isForeign).toBe(false);
  });

  test('rapid-fire increments (last writer wins)', () => {
    let authority: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 0,
      isForeign: false,
    };

    // Simulate rapid-fire human messages
    for (let i = 0; i < 10; i++) {
      authority = incrementAuthority(authority);
    }
    expect(authority.authorityEpoch).toBe(10);
  });
});

// =============================================================================
// 4. FULL LIFECYCLE — Capture, increment, validate
// =============================================================================

describe('E-H8 Temporal: Full Lifecycle', () => {
  test('normal flow: capture → validate = proceed', () => {
    let auth: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      isForeign: false,
    };

    // Plan starts — capture epoch
    auth = capturePlanEpoch(auth);
    expect(auth.planEpoch).toBe(1);

    // Validate at commit — no human message arrived
    const verdict = validateAuthority(auth);
    expect(verdict.action).toBe('proceed');
  });

  test('mid-plan override: capture → increment → validate = invalidate', () => {
    let auth: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      isForeign: false,
    };

    // Plan starts
    auth = capturePlanEpoch(auth);
    expect(auth.planEpoch).toBe(1);

    // Human sends message mid-planning
    auth = incrementAuthority(auth);
    expect(auth.authorityEpoch).toBe(2);
    expect(auth.planEpoch).toBe(1); // Still old

    // Validate at commit — stale!
    const verdict = validateAuthority(auth);
    expect(verdict.action).toBe('invalidate');
  });

  test('re-capture after invalidation = proceed', () => {
    let auth: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 3,
      planEpoch: 1, // Stale from prior plan
      isForeign: false,
    };

    // Invalidated — re-drain messages, re-capture
    auth = capturePlanEpoch(auth);
    expect(auth.planEpoch).toBe(3);

    // New plan is current
    const verdict = validateAuthority(auth);
    expect(verdict.action).toBe('proceed');
  });

  test('multi-plan convergence: A → B → C, only C at gate', () => {
    let auth: AuthorityContext = {
      controllerId: 'ctrl-A',
      authorityEpoch: 1,
      isForeign: false,
    };

    // Plan A
    auth = capturePlanEpoch(auth);
    auth = incrementAuthority(auth); // Human override → epoch 2
    expect(validateAuthority(auth).action).toBe('invalidate');

    // Plan B
    auth = capturePlanEpoch(auth); // Captures epoch 2
    auth = incrementAuthority(auth); // Human override → epoch 3
    expect(validateAuthority(auth).action).toBe('invalidate');

    // Plan C
    auth = capturePlanEpoch(auth); // Captures epoch 3
    // No more human messages
    expect(validateAuthority(auth).action).toBe('proceed');
  });
});
