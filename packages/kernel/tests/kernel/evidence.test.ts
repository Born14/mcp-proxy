/**
 * G9: Deterministic Evidence — Constitutional Tests
 * ==================================================
 *
 * Only deterministic evidence can cause a rollback.
 * Non-deterministic evidence is advisory — it annotates but never blocks.
 *
 * Pure functions. Tests verify:
 *   - Evidence reliability classification
 *   - Non-deterministic suppression
 *   - Evidence filtering for rollback vs proceed decisions
 *   - Gate verdict production
 *
 * Run with: bun test packages/kernel/tests/kernel/evidence.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyEvidenceReliability,
  filterReliableEvidence,
  gateEvidence,
} from '../../src/kernel/evidence.js';
import type {
  EvidenceRecord,
  EvidenceReliability,
} from '../../src/kernel/evidence.js';

// =============================================================================
// 1. EVIDENCE RELIABILITY CLASSIFICATION
// =============================================================================

describe('G9: classifyEvidenceReliability', () => {
  test('empty records → status "insufficient"', () => {
    const result = classifyEvidenceReliability([]);
    expect(result.status).toBe('insufficient');
    expect(result.deterministicCount).toBe(0);
    expect(result.eventualCount).toBe(0);
    expect(result.nonDeterministicCount).toBe(0);
    expect(result.nonDeterministicDecision).toBe(false);
  });

  test('all deterministic passing → "reliable"', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'deterministic', reproducible: true, passed: true },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.status).toBe('reliable');
    expect(result.deterministicCount).toBe(2);
    expect(result.deterministicFailures).toBe(0);
    expect(result.nonDeterministicDecision).toBe(false);
  });

  test('deterministic failure → "reliable" (reliably detects issues)', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: false },
      { predicateId: 'p2', stability: 'deterministic', reproducible: true, passed: true },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.status).toBe('reliable');
    expect(result.deterministicFailures).toBe(1);
    expect(result.reason).toContain('deterministic failure');
  });

  test('only non-deterministic evidence → "unreliable"', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'non_deterministic', reproducible: false, passed: true },
      { predicateId: 'p2', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.status).toBe('unreliable');
    expect(result.nonDeterministicCount).toBe(2);
    expect(result.reason).toContain('non-deterministic');
  });

  test('non-deterministic sole failure → nonDeterministicDecision = true', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.nonDeterministicDecision).toBe(true);
    expect(result.nonDeterministicFailures).toBe(1);
    expect(result.deterministicFailures).toBe(0);
    expect(result.reason).toContain('advisory');
  });

  test('mixed failures → nonDeterministicDecision = false', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: false },
      { predicateId: 'p2', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.nonDeterministicDecision).toBe(false);
    expect(result.deterministicFailures).toBe(1);
    expect(result.nonDeterministicFailures).toBe(1);
  });

  test('eventual evidence counted correctly', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'eventual', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'eventual', reproducible: false, passed: false },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.eventualCount).toBe(2);
    expect(result.eventualFailures).toBe(1);
    expect(result.status).toBe('mixed');
  });

  test('all passing mixed stability → "reliable"', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'eventual', reproducible: true, passed: true },
      { predicateId: 'p3', stability: 'non_deterministic', reproducible: true, passed: true },
    ];
    const result = classifyEvidenceReliability(records);
    expect(result.status).toBe('reliable');
    expect(result.deterministicCount).toBe(1);
    expect(result.eventualCount).toBe(1);
    expect(result.nonDeterministicCount).toBe(1);
  });
});

// =============================================================================
// 2. EVIDENCE FILTERING
// =============================================================================

describe('G9: filterReliableEvidence', () => {
  const records: EvidenceRecord[] = [
    { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
    { predicateId: 'p2', stability: 'eventual', reproducible: true, passed: true },
    { predicateId: 'p3', stability: 'eventual', reproducible: false, passed: false },
    { predicateId: 'p4', stability: 'non_deterministic', reproducible: false, passed: false },
  ];

  test('proceed → returns all evidence', () => {
    const filtered = filterReliableEvidence(records, 'proceed');
    expect(filtered).toHaveLength(4);
  });

  test('rollback → excludes non-deterministic', () => {
    const filtered = filterReliableEvidence(records, 'rollback');
    expect(filtered).toHaveLength(2);
    // Only deterministic and reproduced eventual
    expect(filtered.map(r => r.predicateId)).toEqual(['p1', 'p2']);
  });

  test('rollback → excludes non-reproduced eventual', () => {
    const filtered = filterReliableEvidence(records, 'rollback');
    const eventual = filtered.filter(r => r.stability === 'eventual');
    expect(eventual).toHaveLength(1);
    expect(eventual[0].reproducible).toBe(true);
  });

  test('rollback with only non-deterministic → empty', () => {
    const ndRecords: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const filtered = filterReliableEvidence(ndRecords, 'rollback');
    expect(filtered).toHaveLength(0);
  });

  test('empty records → empty for both types', () => {
    expect(filterReliableEvidence([], 'rollback')).toHaveLength(0);
    expect(filterReliableEvidence([], 'proceed')).toHaveLength(0);
  });
});

// =============================================================================
// 3. GATE VERDICT
// =============================================================================

describe('G9: gateEvidence', () => {
  test('all deterministic passing → proceed', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'deterministic', reproducible: true, passed: true },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('evidence');
  });

  test('deterministic failure → block', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: false },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('evidence');
    expect(verdict.reason).toContain('deterministic');
  });

  test('non-deterministic sole failure → proceed (suppressed)', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toContain('suppressed');
  });

  test('all non-deterministic → escalate', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'non_deterministic', reproducible: false, passed: false },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('escalate');
    expect(verdict.gate).toBe('evidence');
  });

  test('no evidence → escalate', () => {
    const verdict = gateEvidence([]);
    expect(verdict.action).toBe('escalate');
    expect(verdict.gate).toBe('evidence');
  });

  test('eventual failure → block', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'eventual', reproducible: false, passed: false },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('block');
    expect(verdict.gate).toBe('evidence');
    expect(verdict.reason).toContain('eventual');
  });

  test('mixed all passing → proceed', () => {
    const records: EvidenceRecord[] = [
      { predicateId: 'p1', stability: 'deterministic', reproducible: true, passed: true },
      { predicateId: 'p2', stability: 'eventual', reproducible: true, passed: true },
      { predicateId: 'p3', stability: 'non_deterministic', reproducible: true, passed: true },
    ];
    const verdict = gateEvidence(records);
    expect(verdict.action).toBe('proceed');
    expect(verdict.gate).toBe('evidence');
  });
});
