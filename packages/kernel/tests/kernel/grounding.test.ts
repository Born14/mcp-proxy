/**
 * G7: Epistemic Grounding — Constitutional Tests
 * ================================================
 *
 * Claims must reference observable reality, not hallucinated state.
 *
 * Pure functions. Tests verify:
 *   - Coverage evaluation from abstract evidence
 *   - Staleness handling
 *   - Hard miss / soft miss counting
 *   - Weighted coverage across domains
 *   - Gate verdict production
 *
 * Run with: bun test packages/kernel/tests/kernel/grounding.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  evaluateGroundingCoverage,
  gateGrounding,
} from '../../src/kernel/grounding.js';
import type {
  GroundingEvidence,
  CoverageResult,
  GroundingConfig,
} from '../../src/kernel/grounding.js';

// =============================================================================
// 1. COVERAGE EVALUATION
// =============================================================================

describe('G7: evaluateGroundingCoverage', () => {
  test('no evidence → status "missing"', () => {
    const result = evaluateGroundingCoverage([]);
    expect(result.status).toBe('missing');
    expect(result.overallCoverage).toBe(0);
    expect(result.reason).toContain('No grounding evidence');
  });

  test('perfect single-domain evidence → "grounded"', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 1.0,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('grounded');
    expect(result.overallCoverage).toBe(1.0);
    expect(result.totalHardMisses).toBe(0);
    expect(result.totalSoftMisses).toBe(0);
  });

  test('hard miss → status "ungrounded"', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.8,
      hardMissCount: 1,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('ungrounded');
    expect(result.totalHardMisses).toBe(1);
    expect(result.reason).toContain('hard grounding miss');
  });

  test('hard miss within custom threshold → "grounded"', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.9,
      hardMissCount: 1,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence, { maxHardMisses: 2 });
    expect(result.status).toBe('grounded');
  });

  test('low coverage → status "partially_grounded"', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.5,
      hardMissCount: 0,
      softMissCount: 2,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('partially_grounded');
    expect(result.overallCoverage).toBe(0.5);
    expect(result.reason).toContain('50%');
    expect(result.reason).toContain('70%');
  });

  test('custom coverage threshold changes verdict', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.5,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence, { minCoverageScore: 0.3 });
    expect(result.status).toBe('grounded');
  });

  test('stale evidence → status "stale"', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now() - 600000, // 10 minutes ago
      coverageScore: 1.0,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('stale');
    expect(result.staleCount).toBe(1);
    expect(result.overallCoverage).toBe(0);
  });

  test('explicit stalenessMs overrides timestamp calculation', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(), // fresh timestamp...
      coverageScore: 1.0,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
      stalenessMs: 999999, // ...but explicitly stale
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('stale');
  });

  test('mixed fresh and stale evidence → weighted by fresh only', () => {
    const evidence: GroundingEvidence[] = [
      {
        domain: 'css',
        timestamp: Date.now(),
        coverageScore: 1.0,
        hardMissCount: 0,
        softMissCount: 0,
        totalClaims: 3,
      },
      {
        domain: 'sql',
        timestamp: Date.now() - 600000, // stale
        coverageScore: 0.2,
        hardMissCount: 0,
        softMissCount: 0,
        totalClaims: 5,
      },
    ];
    const result = evaluateGroundingCoverage(evidence);
    // Only fresh CSS evidence counts — overallCoverage should be 1.0
    expect(result.status).toBe('grounded');
    expect(result.overallCoverage).toBe(1.0);
    expect(result.staleCount).toBe(1);
  });

  test('multi-domain weighted coverage', () => {
    const evidence: GroundingEvidence[] = [
      {
        domain: 'css',
        timestamp: Date.now(),
        coverageScore: 1.0,
        hardMissCount: 0,
        softMissCount: 0,
        totalClaims: 2,
      },
      {
        domain: 'sql',
        timestamp: Date.now(),
        coverageScore: 0.5,
        hardMissCount: 0,
        softMissCount: 1,
        totalClaims: 8,
      },
    ];
    const result = evaluateGroundingCoverage(evidence);
    // Weighted: (1.0*2 + 0.5*8) / (2+8) = (2+4)/10 = 0.6
    expect(result.overallCoverage).toBe(0.6);
    expect(result.status).toBe('partially_grounded');
    expect(result.totalSoftMisses).toBe(1);
  });

  test('soft misses accumulate across domains', () => {
    const evidence: GroundingEvidence[] = [
      {
        domain: 'css',
        timestamp: Date.now(),
        coverageScore: 0.9,
        hardMissCount: 0,
        softMissCount: 2,
        totalClaims: 5,
      },
      {
        domain: 'html',
        timestamp: Date.now(),
        coverageScore: 0.8,
        hardMissCount: 0,
        softMissCount: 3,
        totalClaims: 5,
      },
    ];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.totalSoftMisses).toBe(5);
  });

  test('hard misses accumulate across domains', () => {
    const evidence: GroundingEvidence[] = [
      {
        domain: 'css',
        timestamp: Date.now(),
        coverageScore: 0.9,
        hardMissCount: 1,
        softMissCount: 0,
        totalClaims: 5,
      },
      {
        domain: 'html',
        timestamp: Date.now(),
        coverageScore: 0.8,
        hardMissCount: 2,
        softMissCount: 0,
        totalClaims: 5,
      },
    ];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.totalHardMisses).toBe(3);
    expect(result.status).toBe('ungrounded');
  });

  test('zero totalClaims gets minimum weight of 1', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.8,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 0,
    }];
    const result = evaluateGroundingCoverage(evidence);
    expect(result.status).toBe('grounded');
    expect(result.overallCoverage).toBe(0.8);
  });
});

// =============================================================================
// 2. GATE VERDICT
// =============================================================================

describe('G7: gateGrounding', () => {
  test('grounded → proceed', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 1.0,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const verdict = gateGrounding(evidence);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('grounding');
  });

  test('partially grounded → escalate', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.5,
      hardMissCount: 0,
      softMissCount: 2,
      totalClaims: 5,
    }];
    const verdict = gateGrounding(evidence);
    expect(verdict.action).toBe('escalate');
    expect(verdict.gate).toBe('grounding');
    expect(verdict.escalationContext).toBeDefined();
  });

  test('ungrounded (hard miss) → block', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.9,
      hardMissCount: 1,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const verdict = gateGrounding(evidence);
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('grounding');
  });

  test('stale → block', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now() - 600000,
      coverageScore: 1.0,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    const verdict = gateGrounding(evidence);
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('grounding');
  });

  test('missing (no evidence) → block', () => {
    const verdict = gateGrounding([]);
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('grounding');
  });

  test('custom config passed through', () => {
    const evidence: GroundingEvidence[] = [{
      domain: 'css',
      timestamp: Date.now(),
      coverageScore: 0.5,
      hardMissCount: 0,
      softMissCount: 0,
      totalClaims: 5,
    }];
    // With low threshold, 0.5 should be enough
    const verdict = gateGrounding(evidence, { minCoverageScore: 0.3 });
    expect(verdict.action).toBe('proceed');
  });
});
