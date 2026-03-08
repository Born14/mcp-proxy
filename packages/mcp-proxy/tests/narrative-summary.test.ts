/**
 * Narrative exit summary tests.
 */
import { describe, test, expect } from 'bun:test';
import {
  createSessionStats,
  recordOutcome,
  formatNarrativeSummary,
} from '../src/summary.js';
import { createBudgetState, recordCall } from '../src/budget.js';
import { createLoopDetector } from '../src/loop-detect.js';

function makeStats(overrides?: { schemaMode?: 'off' | 'warn' | 'strict'; maxCalls?: number }) {
  const budget = createBudgetState(overrides?.maxCalls);
  const loopDetector = createLoopDetector();
  return createSessionStats(budget, loopDetector, overrides?.schemaMode ?? 'warn');
}

describe('formatNarrativeSummary', () => {
  test('reports zero calls gracefully', () => {
    const stats = makeStats();
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('0 tool calls');
  });

  test('reports read and mutation counts', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordOutcome(stats, 'write_file', 'success', 'mutating');
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('3 tool calls');
    expect(summary).toContain('read 2');
    expect(summary).toContain('modified 1');
  });

  test('reports blocked calls with reasons', () => {
    const stats = makeStats();
    recordOutcome(stats, 'write_file', 'blocked', 'mutating', 'G2 constraint violation');
    recordOutcome(stats, 'deploy', 'blocked', 'mutating', 'BUDGET exceeded');
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('2 calls were blocked');
    expect(summary).toContain('constraint (G2)');
    expect(summary).toContain('budget');
  });

  test('reports errors', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'error', 'readonly');
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('1 call returned upstream errors');
  });

  test('reports schema warnings', () => {
    const stats = makeStats({ schemaMode: 'warn' });
    stats.schemaWarnings = 4;
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('Schema validation caught 4 invalid parameters');
  });

  test('reports budget usage', () => {
    const stats = makeStats({ maxCalls: 100 });
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordCall(stats.budget);
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordCall(stats.budget);
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('2/100 calls used');
  });

  test('reports no loops when none detected', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('No loops detected');
  });

  test('singular grammar for 1 call', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    const summary = formatNarrativeSummary(stats);
    expect(summary).toContain('1 tool call ');
    expect(summary).not.toContain('1 tool calls');
  });
});
