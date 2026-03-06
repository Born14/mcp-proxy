/**
 * Kernel G1: Honesty Proof
 * ========================
 *
 * The system cannot declare success when reality disagrees.
 *
 * Same invariants as tests/constitutional/honesty.test.ts but importing
 * from the governance kernel only — zero web domain imports.
 *
 * Run with: bun test tests/constitutional/kernel/g1-honesty.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  buildHonestyVerdict,
  deriveFailureCategory,
  type VerificationSignal,
} from '../../src/kernel/honesty.js';

// =============================================================================
// 1. THE INVISIBLE WALL — Critical probe failure
// =============================================================================

describe('G1 Honesty: The Invisible Wall', () => {
  test('critical probe failed = not honest', () => {
    const signals: VerificationSignal[] = [
      { name: 'container_running', passed: true, severity: 'critical' },
      { name: 'http_reachable', passed: false, severity: 'critical' },
    ];

    const verdict = buildHonestyVerdict(signals, 0, 0);
    expect(verdict.honest).toBe(false);
  });

  test('all probes pass + all predicates pass = honest', () => {
    const signals: VerificationSignal[] = [
      { name: 'container_running', passed: true, severity: 'critical' },
      { name: 'http_reachable', passed: true, severity: 'critical' },
    ];

    const verdict = buildHonestyVerdict(signals, 3, 3);
    expect(verdict.honest).toBe(true);
  });

  test('all probes pass + predicates unsatisfied = not honest', () => {
    const signals: VerificationSignal[] = [
      { name: 'container_running', passed: true, severity: 'critical' },
      { name: 'http_reachable', passed: true, severity: 'critical' },
    ];

    const verdict = buildHonestyVerdict(signals, 1, 3);
    expect(verdict.honest).toBe(false);
  });

  test('no predicates defined = honest if probes pass', () => {
    const signals: VerificationSignal[] = [
      { name: 'container_running', passed: true, severity: 'critical' },
    ];

    const verdict = buildHonestyVerdict(signals, 0, 0);
    expect(verdict.honest).toBe(true);
  });

  test('warning probe failure does not affect honesty', () => {
    const signals: VerificationSignal[] = [
      { name: 'container_running', passed: true, severity: 'critical' },
      { name: 'http_reachable', passed: true, severity: 'critical' },
      { name: 'deprecation_warning', passed: false, severity: 'warning' },
    ];

    const verdict = buildHonestyVerdict(signals, 2, 2);
    expect(verdict.honest).toBe(true);
  });
});

// =============================================================================
// 2. FAILURE CATEGORY DERIVATION — Priority ordering
// =============================================================================

describe('G1 Honesty: Failure Category Derivation', () => {
  test('success = no failure category', () => {
    const verdict = buildHonestyVerdict(
      [{ name: 'probe', passed: true, severity: 'critical' }],
      1, 1,
    );
    expect(deriveFailureCategory(verdict)).toBeUndefined();
  });

  test('rejected > timeout > critical > warning > predicates (priority order)', () => {
    const badVerdict = buildHonestyVerdict(
      [
        { name: 'critical_probe', passed: false, severity: 'critical' },
        { name: 'warning_probe', passed: false, severity: 'warning' },
      ],
      0, 1,
    );

    // Rejected wins over everything
    expect(deriveFailureCategory(badVerdict, true, true)).toBe('rejected');

    // Timeout wins over probe failures
    expect(deriveFailureCategory(badVerdict, true, false)).toBe('timeout');

    // Critical probe wins over warning + predicates
    expect(deriveFailureCategory(badVerdict, false, false)).toBe('critical_probe_failed');
  });

  test('warning probe failed (no critical failure)', () => {
    const verdict = buildHonestyVerdict(
      [
        { name: 'critical_probe', passed: true, severity: 'critical' },
        { name: 'warning_probe', passed: false, severity: 'warning' },
      ],
      1, 1,
    );
    // honest is true (critical passed, predicates passed) so no failure category
    expect(deriveFailureCategory(verdict)).toBeUndefined();

    // With predicates unsatisfied
    const verdict2 = buildHonestyVerdict(
      [
        { name: 'critical_probe', passed: true, severity: 'critical' },
        { name: 'warning_probe', passed: false, severity: 'warning' },
      ],
      0, 1,
    );
    expect(deriveFailureCategory(verdict2)).toBe('warning_probe_failed');
  });

  test('predicates unsatisfied (all probes pass)', () => {
    const verdict = buildHonestyVerdict(
      [{ name: 'probe', passed: true, severity: 'critical' }],
      0, 3,
    );
    expect(deriveFailureCategory(verdict)).toBe('predicates_unsatisfied');
  });
});

// =============================================================================
// 3. SIGNAL COUNTING & DETAIL
// =============================================================================

describe('G1 Honesty: Signal Accounting', () => {
  test('verdict carries all signals', () => {
    const signals: VerificationSignal[] = [
      { name: 'a', passed: true, severity: 'critical' },
      { name: 'b', passed: false, severity: 'warning', detail: 'deprecation found' },
      { name: 'c', passed: true, severity: 'info' },
    ];

    const verdict = buildHonestyVerdict(signals, 2, 2);
    expect(verdict.signals).toHaveLength(3);
    expect(verdict.signals[1].detail).toBe('deprecation found');
  });

  test('predicate counts are carried through', () => {
    const verdict = buildHonestyVerdict([], 7, 10);
    expect(verdict.predicatesPassed).toBe(7);
    expect(verdict.predicatesTotal).toBe(10);
    expect(verdict.honest).toBe(false); // 7 !== 10
  });

  test('zero signals with zero predicates = honest', () => {
    const verdict = buildHonestyVerdict([], 0, 0);
    expect(verdict.honest).toBe(true);
  });
});

// =============================================================================
// 4. EDGE CASES
// =============================================================================

describe('G1 Honesty: Edge Cases', () => {
  test('info-only signals never affect honesty', () => {
    const verdict = buildHonestyVerdict(
      [
        { name: 'info1', passed: false, severity: 'info' },
        { name: 'info2', passed: false, severity: 'info' },
      ],
      1, 1,
    );
    expect(verdict.honest).toBe(true);
  });

  test('multiple critical failures all detected', () => {
    const signals: VerificationSignal[] = [
      { name: 'probe_a', passed: false, severity: 'critical' },
      { name: 'probe_b', passed: false, severity: 'critical' },
      { name: 'probe_c', passed: false, severity: 'critical' },
    ];

    const verdict = buildHonestyVerdict(signals, 0, 0);
    expect(verdict.honest).toBe(false);
    expect(deriveFailureCategory(verdict)).toBe('critical_probe_failed');
  });

  test('timed out but honest = timeout category', () => {
    const verdict = buildHonestyVerdict(
      [{ name: 'probe', passed: true, severity: 'critical' }],
      1, 1,
    );
    expect(verdict.honest).toBe(true);
    expect(deriveFailureCategory(verdict, true)).toBe('timeout');
  });
});
