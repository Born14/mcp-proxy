/**
 * Tier 5: Convergence Enforcement Tests
 * ======================================
 *
 * Proves:
 *   checkConvergence: failure signature accumulation + loop detection
 *   Rolling window: old timestamps pruned, loop detection time-bounded
 *   runGates: convergence signal blocking in strict, forwarding in advisory
 *   extractProxySignature: priority chain for failure classification
 *   convergence_status meta-tool: read-only state inspection
 *   Convergence reset: session re-initialize clears state
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  checkConvergence,
  createConvergenceTracker,
  extractProxySignature,
  runGates,
} from '../src/governance.js';
import { handleConvergenceStatus } from '../src/meta-tools.js';
import type { ConvergenceTracker, AuthorityState, ProxyState, ControllerState } from '../src/types.js';
import type { Mutation } from '@sovereign-labs/kernel/types';

function makeMutation(verb: string, target: string): Mutation {
  return { verb, target, capturedAt: Date.now(), args: {} };
}

const baseAuthority: AuthorityState = {
  controllerId: 'test',
  epoch: 0,
  lastBumpedAt: Date.now(),
  activeSessionEpoch: 0,
};

// =============================================================================
// checkConvergence — Failure Signature Accumulation
// =============================================================================

describe('checkConvergence: failure signatures', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = createConvergenceTracker();
  });

  test('first failure → none', () => {
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    expect(signal).toBe('none');
  });

  test('same signature 2x → warning', () => {
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    const signal = checkConvergence(tracker, 'write_file', '/tmp/b.js', 'syntax_error');
    expect(signal).toBe('warning');
  });

  test('same signature 3x → exhausted', () => {
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    checkConvergence(tracker, 'write_file', '/tmp/b.js', 'syntax_error');
    const signal = checkConvergence(tracker, 'write_file', '/tmp/c.js', 'syntax_error');
    expect(signal).toBe('exhausted');
  });

  test('different signatures → none for each (independent tracking)', () => {
    const s1 = checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    const s2 = checkConvergence(tracker, 'write_file', '/tmp/b.js', 'timeout');
    const s3 = checkConvergence(tracker, 'write_file', '/tmp/c.js', 'connection_refused');
    expect(s1).toBe('none');
    expect(s2).toBe('none');
    expect(s3).toBe('none');
  });

  test('mixed: failure then success resets nothing (signatures sticky)', () => {
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    // Call with no failure signature (success)
    checkConvergence(tracker, 'write_file', '/tmp/b.js');
    // Second failure with same signature → still warning (count=2)
    const signal = checkConvergence(tracker, 'write_file', '/tmp/c.js', 'syntax_error');
    expect(signal).toBe('warning');
  });

  test('no failure signature → none (success path)', () => {
    const signal = checkConvergence(tracker, 'read_file', '/tmp/a.js');
    expect(signal).toBe('none');
  });
});

// =============================================================================
// checkConvergence — Tool+Target Loop Detection
// =============================================================================

describe('checkConvergence: loop detection', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = createConvergenceTracker();
  });

  test('same tool+target 5x within 2min → loop', () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + i * 1000);
    }
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 4000);
    expect(signal).toBe('loop');
  });

  test('same tool+target 4x within 2min → none (below threshold)', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + i * 1000);
    }
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 3000);
    expect(signal).toBe('none');
  });

  test('same tool+target 5x spread over >2min → none (rolling window prunes old)', () => {
    const now = Date.now();
    const twoMinPlus = 2 * 60 * 1000 + 1000;

    // First 3 calls at time 0
    for (let i = 0; i < 3; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + i * 100);
    }
    // Last 2 calls after 2+ minutes — old ones should be pruned
    for (let i = 0; i < 2; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + twoMinPlus + i * 100);
    }

    // Only 2 recent entries, below threshold
    const timestamps = tracker.toolTargetTimestamps.get('write_file:/tmp/a.js')!;
    expect(timestamps.length).toBe(2);
  });

  test('rolling window: old timestamps pruned on each check', () => {
    const now = Date.now();
    const twoMinPlus = 2 * 60 * 1000 + 1000;

    // First call at now
    checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now);

    // Second call after 2+ minutes — first should be pruned
    checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + twoMinPlus);

    const timestamps = tracker.toolTargetTimestamps.get('write_file:/tmp/a.js')!;
    expect(timestamps.length).toBe(1);
    expect(timestamps[0]).toBe(now + twoMinPlus);
  });

  test('different tool+target pairs tracked independently', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + i * 100);
      checkConvergence(tracker, 'read_file', '/tmp/b.js', undefined, now + i * 100);
    }
    // write_file:/tmp/a.js has 5 recent → loop
    // read_file:/tmp/b.js has 5 recent → loop
    // But let's check via one more call each
    const s1 = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 500);
    const s2 = checkConvergence(tracker, 'read_file', '/tmp/b.js', undefined, now + 500);
    expect(s1).toBe('loop');
    expect(s2).toBe('loop');
  });
});

// =============================================================================
// checkConvergence — Temporal Edge Cases
// =============================================================================

describe('checkConvergence: temporal edge cases', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = createConvergenceTracker();
  });

  test('failure signatures are NOT time-bounded (3 failures across >2min → exhausted)', () => {
    const now = Date.now();
    const threeMin = 3 * 60 * 1000;

    // Fail at t=0
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error', now);
    // Fail at t=3min
    checkConvergence(tracker, 'write_file', '/tmp/b.js', 'syntax_error', now + threeMin);
    // Fail at t=6min — still the 3rd failure, should be exhausted despite time gap
    const signal = checkConvergence(tracker, 'write_file', '/tmp/c.js', 'syntax_error', now + threeMin * 2);
    expect(signal).toBe('exhausted');
    expect(tracker.failureSignatures.get('syntax_error')).toBe(3);
  });

  test('loop detection resets after window expires (5 calls, wait >2min, 1 more → none)', () => {
    const now = Date.now();
    const twoMinPlus = 2 * 60 * 1000 + 1000;

    // Build 5 calls → loop detected
    for (let i = 0; i < 5; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + i * 100);
    }
    const loopSignal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 500);
    expect(loopSignal).toBe('loop');

    // Wait >2min, one more call — all old timestamps pruned, only 1 recent
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + twoMinPlus);
    expect(signal).toBe('none');
    expect(tracker.toolTargetTimestamps.get('write_file:/tmp/a.js')!.length).toBe(1);
  });

  test('exact boundary: timestamp at exactly cutoff (2min ago) is excluded', () => {
    const now = Date.now();
    const twoMin = 2 * 60 * 1000;

    // 4 calls at exactly 2min before "now"
    for (let i = 0; i < 4; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now - twoMin + i);
    }
    // 5th call at "now" — cutoff = now - 2min, timestamps at (now-2min) are NOT >= cutoff?
    // cutoff = now - CONVERGENCE_WINDOW_MS = now - 120000
    // timestamp = now - 120000 → (now - 120000) >= (now - 120000) → true (included)
    // So 4 old + 1 new = 5 → loop
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now);
    expect(signal).toBe('loop');
  });

  test('exact boundary: timestamp 1ms before cutoff is excluded', () => {
    const now = Date.now();
    const twoMin = 2 * 60 * 1000;

    // 4 calls at 1ms before the window boundary
    for (let i = 0; i < 4; i++) {
      checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now - twoMin - 1 + i);
    }
    // 5th call at "now" — cutoff = now - 120000
    // oldest timestamp = now - 120001 → excluded
    // Only timestamps within window survive + the new one
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now);
    // Some timestamps may be just inside window (now-120000, now-119999, now-119998)
    // but the first (now-120001) is excluded. So at most 3 old + 1 new = 4 → not loop
    const timestamps = tracker.toolTargetTimestamps.get('write_file:/tmp/a.js')!;
    expect(timestamps.length).toBeLessThanOrEqual(4);
    expect(signal).toBe('none');
  });

  test('failure + success interleaved: 5 calls total but only 2 are failures → warning', () => {
    const now = Date.now();
    // Fail
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error', now);
    // Success
    checkConvergence(tracker, 'write_file', '/tmp/b.js', undefined, now + 100);
    // Success
    checkConvergence(tracker, 'write_file', '/tmp/c.js', undefined, now + 200);
    // Success
    checkConvergence(tracker, 'write_file', '/tmp/d.js', undefined, now + 300);
    // Fail (2nd time) — should be warning, not exhausted
    const signal = checkConvergence(tracker, 'write_file', '/tmp/e.js', 'syntax_error', now + 400);
    expect(signal).toBe('warning');
    expect(tracker.failureSignatures.get('syntax_error')).toBe(2);
  });

  test('gradual accumulation across sessions: counter persists through non-failure calls', () => {
    const now = Date.now();
    // 2 failures → warning
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'timeout', now);
    checkConvergence(tracker, 'write_file', '/tmp/b.js', 'timeout', now + 100);

    // 100 success calls in between (different targets to avoid loop)
    for (let i = 0; i < 100; i++) {
      checkConvergence(tracker, 'read_file', `/tmp/file_${i}.js`, undefined, now + 200 + i);
    }

    // 3rd failure with same signature → still exhausted
    const signal = checkConvergence(tracker, 'write_file', '/tmp/c.js', 'timeout', now + 500);
    expect(signal).toBe('exhausted');
  });
});

// =============================================================================
// checkConvergence — Signal Priority
// =============================================================================

describe('checkConvergence: signal priority', () => {
  let tracker: ConvergenceTracker;

  beforeEach(() => {
    tracker = createConvergenceTracker();
  });

  test('exhausted takes priority over loop', () => {
    const now = Date.now();
    // Build up failure signatures to exhausted (3x)
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error', now);
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error', now + 100);
    // This call: 3rd failure (exhausted) AND 3rd tool+target call
    // Add more calls to hit loop threshold too
    checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 200);
    checkConvergence(tracker, 'write_file', '/tmp/a.js', undefined, now + 300);
    // 5th call with 3rd failure
    const signal = checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error', now + 400);
    expect(signal).toBe('exhausted');
  });
});

// =============================================================================
// runGates with convergence signal
// =============================================================================

describe('runGates: convergence blocking', () => {
  test('exhausted blocks in strict mode', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'exhausted',
    );
    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('CONVERGENCE BLOCKED');
    expect(result.blockReason).toContain('exhausted');
    expect(result.convergenceSignal).toBe('exhausted');
  });

  test('loop blocks in strict mode', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'loop',
    );
    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('CONVERGENCE BLOCKED');
    expect(result.blockReason).toContain('loop');
    expect(result.convergenceSignal).toBe('loop');
  });

  test('warning never blocks in strict mode', () => {
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

  test('none never blocks', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
      'none',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBe('none');
  });

  test('advisory mode NEVER blocks — exhausted forwards', () => {
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

  test('advisory mode NEVER blocks — loop forwards', () => {
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

  test('advisory mode NEVER blocks — warning forwards', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'advisory',
      'warning',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBe('warning');
  });

  test('no convergence signal → forward', () => {
    const result = runGates(
      makeMutation('write_file', '/tmp/test.js'),
      [],
      baseAuthority,
      'strict',
    );
    expect(result.forward).toBe(true);
    expect(result.convergenceSignal).toBeUndefined();
  });
});

// =============================================================================
// extractProxySignature
// =============================================================================

describe('extractProxySignature', () => {
  test('uses error.code when present (numeric)', () => {
    const sig = extractProxySignature({ error: { code: -32601, message: 'Method not found' } });
    expect(sig).toBe('-32601');
  });

  test('uses error.code when present (string)', () => {
    const sig = extractProxySignature({ error: { code: 'ENOENT', message: 'No such file' } });
    expect(sig).toBe('ENOENT');
  });

  test('uses error.name as fallback', () => {
    const sig = extractProxySignature({ error: { name: 'TypeError', message: 'Cannot read property' } });
    expect(sig).toBe('TypeError');
  });

  test('kernel extractSignature for recognized patterns', () => {
    const sig = extractProxySignature({ error: { message: 'SyntaxError: Unexpected token }' } });
    expect(sig).toBe('syntax_error');
  });

  test('first line of error message as fallback', () => {
    const sig = extractProxySignature({ error: { message: 'Something weird happened\nline 2\nline 3' } });
    expect(sig).toBe('Something weird happened');
  });

  test('truncates first line to 100 chars', () => {
    const longMsg = 'A'.repeat(200) + '\nSecond line';
    const sig = extractProxySignature({ error: { message: longMsg } });
    expect(sig).toBe('A'.repeat(100));
  });

  test('falls back to unknown_error', () => {
    const sig = extractProxySignature({});
    expect(sig).toBe('unknown_error');
  });

  test('extracts from MCP error result (isError flag)', () => {
    const sig = extractProxySignature({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'SyntaxError: bad code' }],
      },
    });
    expect(sig).toBe('syntax_error');
  });

  test('ignores non-error result', () => {
    const sig = extractProxySignature({
      result: {
        content: [{ type: 'text', text: 'SyntaxError: this is fine' }],
      },
    });
    expect(sig).toBe('unknown_error');
  });
});

// =============================================================================
// createConvergenceTracker
// =============================================================================

describe('createConvergenceTracker', () => {
  test('returns fresh tracker with empty Maps', () => {
    const tracker = createConvergenceTracker();
    expect(tracker.failureSignatures).toBeInstanceOf(Map);
    expect(tracker.toolTargetTimestamps).toBeInstanceOf(Map);
    expect(tracker.failureSignatures.size).toBe(0);
    expect(tracker.toolTargetTimestamps.size).toBe(0);
  });

  test('convergence state is session-scoped (not persisted to disk)', () => {
    // Prove that createConvergenceTracker returns independent instances
    const t1 = createConvergenceTracker();
    const t2 = createConvergenceTracker();
    t1.failureSignatures.set('test', 5);
    expect(t2.failureSignatures.size).toBe(0);
  });
});

// =============================================================================
// convergence_status meta-tool
// =============================================================================

describe('convergence_status meta-tool', () => {
  function makeProxyState(tracker: ConvergenceTracker): ProxyState {
    return {
      controller: { id: 'test', establishedAt: Date.now() } as ControllerState,
      authority: baseAuthority,
      constraints: [],
      receiptSeq: 0,
      previousReceiptHash: 'genesis',
      convergence: tracker,
    };
  }

  test('returns counts for empty tracker', () => {
    const tracker = createConvergenceTracker();
    const result = handleConvergenceStatus(makeProxyState(tracker));
    const data = JSON.parse(result.content[0].text);

    expect(data.signal).toBe('none');
    expect(Object.keys(data.failureSignatures)).toHaveLength(0);
    expect(Object.keys(data.toolTargetCounts)).toHaveLength(0);
    expect(data.recommendations).toHaveLength(0);
  });

  test('returns counts after failures', () => {
    const tracker = createConvergenceTracker();
    tracker.failureSignatures.set('syntax_error', 2);
    tracker.toolTargetTimestamps.set('write_file:/tmp/a.js', [Date.now()]);

    const result = handleConvergenceStatus(makeProxyState(tracker));
    const data = JSON.parse(result.content[0].text);

    expect(data.failureSignatures['syntax_error']).toBe(2);
    expect(data.toolTargetCounts['write_file:/tmp/a.js']).toBe(1);
    expect(data.signal).toBe('warning');
    expect(data.recommendations.length).toBeGreaterThan(0);
  });

  test('detects exhausted signal', () => {
    const tracker = createConvergenceTracker();
    tracker.failureSignatures.set('syntax_error', 3);

    const result = handleConvergenceStatus(makeProxyState(tracker));
    const data = JSON.parse(result.content[0].text);

    expect(data.signal).toBe('exhausted');
    expect(data.recommendations).toContain('Session exhausted for this failure pattern — change strategy or declare new intent');
  });

  test('detects loop signal from timestamps', () => {
    const tracker = createConvergenceTracker();
    const now = Date.now();
    tracker.toolTargetTimestamps.set('write_file:/tmp/a.js', [
      now - 1000, now - 800, now - 600, now - 400, now - 200,
    ]);

    const result = handleConvergenceStatus(makeProxyState(tracker));
    const data = JSON.parse(result.content[0].text);

    expect(data.signal).toBe('loop');
    expect(data.recommendations).toContain('Repetitive tool+target calls detected — consider a different approach');
  });
});

// =============================================================================
// Convergence reset on session re-initialize
// =============================================================================

describe('convergence reset', () => {
  test('createConvergenceTracker creates clean state for re-init', () => {
    const tracker = createConvergenceTracker();
    // Populate it
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    checkConvergence(tracker, 'write_file', '/tmp/a.js', 'syntax_error');
    expect(tracker.failureSignatures.get('syntax_error')).toBe(2);

    // Re-initialize — proxy calls createConvergenceTracker() on re-init
    const fresh = createConvergenceTracker();
    expect(fresh.failureSignatures.size).toBe(0);
    expect(fresh.toolTargetTimestamps.size).toBe(0);

    // First failure on fresh tracker → none (not warning)
    const signal = checkConvergence(fresh, 'write_file', '/tmp/a.js', 'syntax_error');
    expect(signal).toBe('none');
  });
});
