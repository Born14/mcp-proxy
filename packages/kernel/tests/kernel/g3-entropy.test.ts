/**
 * Kernel G3: Entropy Resilience Proof
 * ====================================
 *
 * Verification survives partial deploys and system entropy.
 *
 * Same invariants as tests/constitutional/reality.test.ts but importing
 * from the governance kernel only — zero web domain imports.
 *
 * Run with: bun test tests/constitutional/kernel/g3-entropy.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  scanForErrors,
  detectDrift,
  detectUnrollbackableChanges,
  verifyEvidenceChain,
  entropyVerdict,
  type SnapshotRecord,
  type EvidenceChain,
} from '../../src/kernel/entropy.js';

// =============================================================================
// 1. ZOMBIE DETECTION — Log line pattern matching
// =============================================================================

describe('G3 Entropy: Zombie Detection', () => {
  test('fatal patterns detected', () => {
    const result = scanForErrors([
      'Server starting...',
      'FATAL: unable to bind port',
      'Listening on :3000',
    ]);
    expect(result.hasErrors).toBe(true);
    expect(result.fatalCount).toBe(1);
    expect(result.matches[0].pattern).toBe('fatal_crash');
  });

  test('OOMKilled detected', () => {
    const result = scanForErrors(['Process OOMKilled by kernel']);
    expect(result.fatalCount).toBe(1);
    expect(result.matches[0].pattern).toBe('fatal_crash');
  });

  test('python traceback detected', () => {
    const result = scanForErrors(['Traceback (most recent call last):']);
    expect(result.fatalCount).toBe(1);
    expect(result.matches[0].pattern).toBe('python_traceback');
  });

  test('non-zero exit code detected', () => {
    const result = scanForErrors(['Process exited with exit code 1']);
    expect(result.fatalCount).toBe(1);
    expect(result.matches[0].pattern).toBe('non_zero_exit');
  });

  test('connection refused detected', () => {
    const result = scanForErrors(['Error: connect ECONNREFUSED 127.0.0.1:5432']);
    expect(result.errorCount).toBe(1);
    expect(result.matches[0].pattern).toBe('connection_refused');
  });

  test('port in use detected', () => {
    const result = scanForErrors(['Error: listen EADDRINUSE: address already in use :::3000']);
    expect(result.errorCount).toBe(1);
    expect(result.matches[0].pattern).toBe('port_in_use');
  });

  test('runtime errors detected', () => {
    const result = scanForErrors([
      'TypeError: Cannot read properties of undefined',
      'ReferenceError: foo is not defined',
    ]);
    expect(result.errorCount).toBe(2);
  });

  test('missing module detected (standalone — no "Error:" prefix)', () => {
    // "Cannot find module" without "Error:" prefix matches missing_module directly
    const result = scanForErrors(['Cannot find module "express"']);
    expect(result.errorCount).toBe(1);
    expect(result.matches[0].pattern).toBe('missing_module');
  });

  test('Error: prefix causes runtime_error to match first', () => {
    // "Error: Cannot find module" — first-match priority gives runtime_error
    const result = scanForErrors(['Error: Cannot find module "express"']);
    expect(result.errorCount).toBe(1);
    expect(result.matches[0].pattern).toBe('runtime_error');
  });

  test('file not found detected', () => {
    const result = scanForErrors(['ENOENT: no such file or directory']);
    expect(result.errorCount).toBe(1);
    expect(result.matches[0].pattern).toBe('file_not_found');
  });

  test('deprecation warnings detected', () => {
    const result = scanForErrors(['DeprecationWarning: util.isBuffer is deprecated']);
    expect(result.warningCount).toBe(1);
    expect(result.matches[0].severity).toBe('warning');
  });

  test('clean logs = no errors', () => {
    const result = scanForErrors([
      'Server starting...',
      'Listening on :3000',
      'Request: GET /',
      'Response: 200 OK',
    ]);
    expect(result.hasErrors).toBe(false);
    expect(result.errorCount).toBe(0);
    expect(result.fatalCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test('first match wins per line', () => {
    // A line matching multiple patterns should only be counted once
    const result = scanForErrors(['FATAL Error: Cannot find module']);
    expect(result.matches).toHaveLength(1);
    // FATAL matches first (fatal_crash pattern)
    expect(result.matches[0].pattern).toBe('fatal_crash');
  });

  test('empty log lines = no errors', () => {
    const result = scanForErrors([]);
    expect(result.hasErrors).toBe(false);
  });

  test('mixed severity counting', () => {
    const result = scanForErrors([
      'FATAL: crash',
      'Error: something broke',
      'DeprecationWarning: old API',
      'Normal log line',
    ]);
    expect(result.fatalCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.matches).toHaveLength(3);
  });
});

// =============================================================================
// 2. DRIFT DETECTION — Snapshot integrity comparison
// =============================================================================

describe('G3 Entropy: Drift Detection', () => {
  const snapshot: SnapshotRecord = {
    id: 'snap-1',
    timestamp: Date.now() - 60000,
    contentHash: 'abc123',
    artifacts: ['server.js', 'package.json', 'Dockerfile'],
  };

  test('no drift when hashes and artifacts match', () => {
    const result = detectDrift(snapshot, 'abc123', ['server.js', 'package.json', 'Dockerfile']);
    expect(result.drifted).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  test('hash mismatch = drift', () => {
    const result = detectDrift(snapshot, 'xyz789', ['server.js', 'package.json', 'Dockerfile']);
    expect(result.drifted).toBe(true);
    expect(result.expectedHash).toBe('abc123');
    expect(result.actualHash).toBe('xyz789');
  });

  test('added artifacts detected', () => {
    const result = detectDrift(snapshot, 'abc123', [
      'server.js', 'package.json', 'Dockerfile', 'migrations/001.sql',
    ]);
    expect(result.drifted).toBe(true);
    expect(result.added).toEqual(['migrations/001.sql']);
  });

  test('removed artifacts detected', () => {
    const result = detectDrift(snapshot, 'abc123', ['server.js', 'package.json']);
    expect(result.drifted).toBe(true);
    expect(result.removed).toEqual(['Dockerfile']);
  });

  test('added + removed both detected', () => {
    const result = detectDrift(snapshot, 'abc123', ['server.js', 'new-file.ts']);
    expect(result.drifted).toBe(true);
    expect(result.added).toEqual(['new-file.ts']);
    expect(result.removed).toContain('package.json');
    expect(result.removed).toContain('Dockerfile');
  });
});

// =============================================================================
// 3. UN-ROLLBACKABLE CHANGES
// =============================================================================

describe('G3 Entropy: Un-rollbackable Changes', () => {
  test('no new artifacts = nothing un-rollbackable', () => {
    const result = detectUnrollbackableChanges(
      ['a.sql', 'b.sql'],
      ['a.sql', 'b.sql'],
    );
    expect(result).toHaveLength(0);
  });

  test('new artifacts after snapshot detected', () => {
    const result = detectUnrollbackableChanges(
      ['001_create_users.sql'],
      ['001_create_users.sql', '002_add_email.sql'],
    );
    expect(result).toEqual(['002_add_email.sql']);
  });

  test('removed artifacts not flagged (only additions)', () => {
    const result = detectUnrollbackableChanges(
      ['a.sql', 'b.sql'],
      ['a.sql'],
    );
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// 4. EVIDENCE CHAIN — Monotonicity invariant
// =============================================================================

describe('G3 Entropy: Evidence Chain Monotonicity', () => {
  test('success chain = complete, no failure', () => {
    const chain: EvidenceChain = {
      items: [
        { name: 'container', passed: true, severity: 'critical' },
        { name: 'http', passed: true, severity: 'critical' },
      ],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const result = verifyEvidenceChain(chain);
    expect(result.complete).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.hasContradiction).toBe(false);
  });

  test('critical failure + goal achieved = CONTRADICTION', () => {
    const chain: EvidenceChain = {
      items: [
        { name: 'container', passed: true, severity: 'critical' },
        { name: 'http', passed: false, severity: 'critical' },
      ],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const result = verifyEvidenceChain(chain);
    expect(result.hasContradiction).toBe(true);
    expect(result.contradictionDetail).toContain('http');
  });

  test('rejection is highest priority', () => {
    const chain: EvidenceChain = {
      items: [
        { name: 'probe', passed: false, severity: 'critical' },
      ],
      goalAchieved: false,
      timedOut: true,
      rejected: true,
    };
    const result = verifyEvidenceChain(chain);
    expect(result.failureCategory).toBe('rejected');
  });

  test('timeout > critical probe > warning > goal', () => {
    // timeout
    const timedOut: EvidenceChain = {
      items: [{ name: 'p', passed: false, severity: 'critical' }],
      goalAchieved: false,
      timedOut: true,
      rejected: false,
    };
    expect(verifyEvidenceChain(timedOut).failureCategory).toBe('timeout');

    // critical probe failed (no timeout)
    const critFail: EvidenceChain = {
      items: [{ name: 'p', passed: false, severity: 'critical' }],
      goalAchieved: false,
      timedOut: false,
      rejected: false,
    };
    expect(verifyEvidenceChain(critFail).failureCategory).toBe('critical_probe_failed');

    // warning probe failed (no critical)
    const warnFail: EvidenceChain = {
      items: [
        { name: 'crit', passed: true, severity: 'critical' },
        { name: 'warn', passed: false, severity: 'warning' },
      ],
      goalAchieved: false,
      timedOut: false,
      rejected: false,
    };
    expect(verifyEvidenceChain(warnFail).failureCategory).toBe('warning_probe_failed');

    // goal not achieved (all probes pass)
    const goalFail: EvidenceChain = {
      items: [{ name: 'p', passed: true, severity: 'critical' }],
      goalAchieved: false,
      timedOut: false,
      rejected: false,
    };
    expect(verifyEvidenceChain(goalFail).failureCategory).toBe('goal_not_achieved');
  });

  test('empty evidence items with goal achieved = epistemic violation', () => {
    const chain: EvidenceChain = {
      items: [],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const result = verifyEvidenceChain(chain);
    // Cannot claim success with zero proof
    expect(result.complete).toBe(false);
    expect(result.hasContradiction).toBe(true);
    expect(result.failureCategory).toBe('no_evidence');
    expect(result.contradictionDetail).toContain('no evidence');
  });

  test('empty evidence blocks even when logs contain only warnings', () => {
    // Ensures the block comes from no_evidence, not from log scanning
    const chain: EvidenceChain = {
      items: [],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const errorScan = scanForErrors(['DeprecationWarning: Buffer()']);
    expect(errorScan.warningCount).toBe(1);
    expect(errorScan.fatalCount).toBe(0);

    const result = verifyEvidenceChain(chain);
    expect(result.failureCategory).toBe('no_evidence');
    // Not 'warning_probe_failed' — the block is epistemic, not log-driven

    const verdict = entropyVerdict(chain, errorScan);
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('EVIDENCE CONTRADICTION');
    expect(verdict.reason).toContain('no evidence');
  });
});

// =============================================================================
// 5. ENTROPY VERDICT — Gate decision
// =============================================================================

describe('G3 Entropy: Verdict', () => {
  test('clean chain = proceed', () => {
    const chain: EvidenceChain = {
      items: [{ name: 'probe', passed: true, severity: 'critical' }],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const verdict = entropyVerdict(chain);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('verify');
  });

  test('contradiction = block with evidence', () => {
    const chain: EvidenceChain = {
      items: [{ name: 'http', passed: false, severity: 'critical' }],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const verdict = entropyVerdict(chain);
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('EVIDENCE CONTRADICTION');
    expect(verdict.escalationContext?.clarificationNeeded?.evidence).toBeDefined();
    expect(verdict.escalationContext!.clarificationNeeded!.evidence!.length).toBeGreaterThan(0);
  });

  test('zombie detection = escalate', () => {
    const chain: EvidenceChain = {
      items: [{ name: 'probe', passed: true, severity: 'critical' }],
      goalAchieved: true,
      timedOut: false,
      rejected: false,
    };
    const errorScan = scanForErrors(['FATAL: process died']);
    const verdict = entropyVerdict(chain, errorScan);
    expect(verdict.action).toBe('escalate');
    expect(verdict.reason).toContain('ZOMBIE DETECTED');
    expect(verdict.escalationContext?.clarificationNeeded?.evidence).toBeDefined();
  });

  test('failure detected = block', () => {
    const chain: EvidenceChain = {
      items: [{ name: 'probe', passed: false, severity: 'critical' }],
      goalAchieved: false,
      timedOut: false,
      rejected: false,
    };
    const verdict = entropyVerdict(chain);
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toContain('critical_probe_failed');
  });

  test('evidence lines encode full chain state', () => {
    const chain: EvidenceChain = {
      items: [
        { name: 'container', passed: true, severity: 'critical' },
        { name: 'http', passed: false, severity: 'critical', detail: 'ECONNREFUSED' },
      ],
      goalAchieved: false,
      timedOut: false,
      rejected: false,
    };
    const errorScan = scanForErrors(['Error: something broke', 'DeprecationWarning: old API']);
    const verdict = entropyVerdict(chain, errorScan);
    const evidence = verdict.escalationContext?.clarificationNeeded?.evidence;
    expect(evidence).toBeDefined();
    expect(evidence!.some(l => l.includes('goalAchieved=false'))).toBe(true);
    expect(evidence!.some(l => l.includes('container=pass'))).toBe(true);
    expect(evidence!.some(l => l.includes('http=fail'))).toBe(true);
    expect(evidence!.some(l => l.includes('ECONNREFUSED'))).toBe(true);
    expect(evidence!.some(l => l.includes('logScan'))).toBe(true);
  });
});
