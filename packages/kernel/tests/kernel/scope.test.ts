/**
 * G6: Scope Boundedness — Constitutional Tests
 * ==============================================
 *
 * Every mutation's blast radius must be estimable before execution.
 *
 * Pure functions. Tests verify:
 *   - Alignment computation between estimates and observations
 *   - Effect alignment score from adapter telemetry
 *   - Scope contract evaluation (aligned/deviated/unknown)
 *   - Gate verdict production
 *
 * Run with: bun test packages/kernel/tests/kernel/scope.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  computeAlignment,
  computeEffectAlignmentScore,
  evaluateScopeContract,
  gateScope,
} from '../../src/kernel/scope.js';
import type {
  ScopeEstimate,
  ObservedImpact,
  ScopeTelemetry,
  ScopeContractResult,
} from '../../src/kernel/scope.js';

// =============================================================================
// 1. ALIGNMENT COMPUTATION
// =============================================================================

describe('G6: computeAlignment', () => {
  test('exact match → status "match", delta 0', () => {
    const est: ScopeEstimate = { target: '.btn', cardinality: 3, source: 'browser', trust: 'authoritative' };
    const obs: ObservedImpact = { cardinality: 3, source: 'browser', trust: 'authoritative' };
    const result = computeAlignment(est, obs);
    expect(result.status).toBe('match');
    expect(result.delta).toBe(0);
  });

  test('observed > estimated → status "under", positive delta', () => {
    const est: ScopeEstimate = { target: '.btn', cardinality: 1, source: 'template_regex', trust: 'heuristic' };
    const obs: ObservedImpact = { cardinality: 47, source: 'browser', trust: 'authoritative' };
    const result = computeAlignment(est, obs);
    expect(result.status).toBe('under');
    expect(result.delta).toBe(46);
    expect(result.note).toContain('1');
    expect(result.note).toContain('47');
  });

  test('observed < estimated → status "over", negative delta', () => {
    const est: ScopeEstimate = { target: 'h1', cardinality: 5, source: 'file_diff', trust: 'heuristic' };
    const obs: ObservedImpact = { cardinality: 2, source: 'browser', trust: 'authoritative' };
    const result = computeAlignment(est, obs);
    expect(result.status).toBe('over');
    expect(result.delta).toBe(-3);
  });

  test('null estimate → status "unknown"', () => {
    const est: ScopeEstimate = { target: '.dynamic', cardinality: null, source: 'unknown', trust: 'none' };
    const obs: ObservedImpact = { cardinality: 10, source: 'browser', trust: 'authoritative' };
    const result = computeAlignment(est, obs);
    expect(result.status).toBe('unknown');
    expect(result.note).toContain('No pre-execution estimate');
  });

  test('zero cardinality match → status "match"', () => {
    const est: ScopeEstimate = { target: '.ghost', cardinality: 0, source: 'browser', trust: 'authoritative' };
    const obs: ObservedImpact = { cardinality: 0, source: 'browser', trust: 'authoritative' };
    const result = computeAlignment(est, obs);
    expect(result.status).toBe('match');
    expect(result.delta).toBe(0);
  });
});

// =============================================================================
// 2. EFFECT ALIGNMENT SCORE
// =============================================================================

describe('G6: computeEffectAlignmentScore', () => {
  test('empty telemetry → zeroed score', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 0,
      alignmentMatchCount: 0,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 0,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 0,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.overall).toBe(0);
    expect(score.confidence).toBe(0);
  });

  test('perfect alignment → score 1.0', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 3,
      alignmentMatchCount: 3,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 0,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 3,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.overall).toBe(1.0);
    expect(score.verificationDepth).toBe(1.0);
    expect(score.unknownPenalty).toBe(0);
    expect(score.underestimateRate).toBe(0);
    expect(score.confidence).toBe(1.0);
  });

  test('all unknown → score reflects unknown penalty', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 5,
      alignmentMatchCount: 0,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 5,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 0,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.unknownPenalty).toBe(1.0);
    // unknownPenalty axis: (1 - 1.0) * 0.25 = 0
    expect(score.axisContributions.unknownPenalty).toBe(0);
  });

  test('all underestimated → underestimateRate = 1.0', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 3,
      alignmentMatchCount: 0,
      alignmentOverCount: 0,
      alignmentUnderCount: 3,
      unknownCardinalityCount: 0,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 3,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.underestimateRate).toBe(1.0);
    expect(score.verificationDepth).toBe(0);
    // underestimateRate axis: (1 - 1.0) * 0.25 = 0
    expect(score.axisContributions.underestimateRate).toBe(0);
  });

  test('o5b verified predicates subtract from unknown count', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 5,
      alignmentMatchCount: 2,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 3,
      o5bVerifiedNoEvidenceCount: 2, // 2 of the 3 "unknown" are actually verified
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 2,
    };
    const score = computeEffectAlignmentScore(telemetry);
    // Effective unknown = max(0, 3 - 2) = 1
    expect(score.unknownPenalty).toBe(1 / 5); // 0.2
  });

  test('staging proximity score used as verificationDepth fallback', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 3,
      alignmentMatchCount: 0,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 0,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 0,
      stagingProximityScore: 0.85,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.verificationDepth).toBe(0.85);
    expect(score.axisContributions.verificationDepth).toBeCloseTo(0.85 * 0.50);
  });

  test('score clamped to [0, 1]', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 1,
      alignmentMatchCount: 1,
      alignmentOverCount: 0,
      alignmentUnderCount: 0,
      unknownCardinalityCount: 0,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 0,
      editAmbiguityCount: 0,
      impactEvidenceCount: 1,
    };
    const score = computeEffectAlignmentScore(telemetry);
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(1);
  });

  test('per-axis contributions sum to overall', () => {
    const telemetry: ScopeTelemetry = {
      predicateCount: 10,
      alignmentMatchCount: 6,
      alignmentOverCount: 2,
      alignmentUnderCount: 2,
      unknownCardinalityCount: 1,
      o5bVerifiedNoEvidenceCount: 0,
      fileDiffAmbiguityCount: 1,
      editAmbiguityCount: 5,
      impactEvidenceCount: 10,
    };
    const score = computeEffectAlignmentScore(telemetry);
    const axisSum =
      score.axisContributions.verificationDepth +
      score.axisContributions.unknownPenalty +
      score.axisContributions.underestimateRate;
    expect(score.overall).toBeCloseTo(axisSum, 10);
  });
});

// =============================================================================
// 3. SCOPE CONTRACT EVALUATION
// =============================================================================

describe('G6: evaluateScopeContract', () => {
  test('score >= threshold at postdeploy → aligned', () => {
    const result = evaluateScopeContract(0.95, 'postdeploy', 0.80);
    expect(result.verdict).toBe('aligned');
    expect(result.reason).toContain('0.95');
  });

  test('score < threshold at postdeploy → deviated', () => {
    const result = evaluateScopeContract(0.45, 'postdeploy', 0.80);
    expect(result.verdict).toBe('deviated');
    expect(result.reason).toContain('0.45');
    expect(result.reason).toContain('0.8');
  });

  test('score at exact threshold → aligned', () => {
    const result = evaluateScopeContract(0.80, 'postdeploy', 0.80);
    expect(result.verdict).toBe('aligned');
  });

  test('undefined score → unknown', () => {
    const result = evaluateScopeContract(undefined, 'postdeploy');
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('No alignment score');
  });

  test('non-postdeploy stage → unknown', () => {
    const result = evaluateScopeContract(0.95, 'staging');
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('not authoritative');
  });

  test('undefined stage → unknown', () => {
    const result = evaluateScopeContract(0.90, undefined);
    expect(result.verdict).toBe('unknown');
  });

  test('default threshold is 0.80', () => {
    const aligned = evaluateScopeContract(0.80, 'postdeploy');
    expect(aligned.verdict).toBe('aligned');
    expect(aligned.threshold).toBe(0.80);

    const deviated = evaluateScopeContract(0.79, 'postdeploy');
    expect(deviated.verdict).toBe('deviated');
  });
});

// =============================================================================
// 4. GATE VERDICT (G6)
// =============================================================================

describe('G6: gateScope', () => {
  test('aligned → proceed', () => {
    const contract: ScopeContractResult = {
      verdict: 'aligned',
      score: 0.95,
      stage: 'postdeploy',
      threshold: 0.80,
      reason: 'Scope aligned (0.95 >= 0.8)',
    };
    const verdict = gateScope(contract);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('scope');
  });

  test('deviated → narrow', () => {
    const contract: ScopeContractResult = {
      verdict: 'deviated',
      score: 0.45,
      stage: 'postdeploy',
      threshold: 0.80,
      reason: 'Structural deviation detected (0.45 < 0.8)',
    };
    const verdict = gateScope(contract);
    expect(verdict.action).toBe('narrow');
    expect(verdict.gate).toBe('scope');
  });

  test('unknown → proceed with annotation', () => {
    const contract: ScopeContractResult = {
      verdict: 'unknown',
      score: undefined,
      stage: undefined,
      threshold: 0.80,
      reason: 'No alignment score available',
    };
    const verdict = gateScope(contract);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('scope');
    expect(verdict.reason).toContain('No alignment score');
  });
});
