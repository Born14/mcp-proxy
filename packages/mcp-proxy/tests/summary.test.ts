/**
 * Exit Summary — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import { createSessionStats, recordOutcome, formatExitSummary } from '../src/summary.js';
import { createBudgetState } from '../src/budget.js';
import { createLoopDetector } from '../src/loop-detect.js';

function makeStats(opts?: { maxCalls?: number; schemaMode?: 'off' | 'warn' | 'strict' }) {
  const budget = createBudgetState(opts?.maxCalls);
  const loopDetector = createLoopDetector();
  return createSessionStats(budget, loopDetector, opts?.schemaMode ?? 'off');
}

describe('Exit Summary', () => {

  test('empty session produces valid summary', () => {
    const stats = makeStats();
    const output = formatExitSummary(stats);
    expect(output).toContain('SESSION SUMMARY');
    expect(output).toContain('tool calls:');
    expect(output).toContain('0');
  });

  test('records tool outcomes correctly', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordOutcome(stats, 'write_file', 'success', 'mutating');
    recordOutcome(stats, 'write_file', 'error', 'mutating');
    recordOutcome(stats, 'read_file', 'blocked', 'readonly', 'G2 constraint');

    expect(stats.totalCalls).toBe(4);
    expect(stats.succeeded).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.blocked).toBe(1);
    expect(stats.mutations).toBe(2);
    expect(stats.readonly).toBe(2);
  });

  test('tool counts tracked', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    recordOutcome(stats, 'write_file', 'success', 'mutating');

    expect(stats.toolCounts.get('read_file')).toBe(2);
    expect(stats.toolCounts.get('write_file')).toBe(1);
  });

  test('block reasons classified', () => {
    const stats = makeStats();
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'BUDGET EXCEEDED');
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'LOOP DETECTED');
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'G2 constraint');

    expect(stats.blockReasons.get('budget')).toBe(1);
    expect(stats.blockReasons.get('loop')).toBe(1);
    expect(stats.blockReasons.get('constraint (G2)')).toBe(1);
  });

  test('summary includes budget info when set', () => {
    const stats = makeStats({ maxCalls: 10 });
    // recordOutcome tracks stats; budget.callCount is tracked separately in proxy.ts
    stats.budget.callCount = 1;
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    const output = formatExitSummary(stats);
    expect(output).toContain('budget:');
    expect(output).toContain('1/10');
  });

  test('summary excludes budget when unlimited', () => {
    const stats = makeStats();
    recordOutcome(stats, 'read_file', 'success', 'readonly');
    const output = formatExitSummary(stats);
    expect(output).not.toContain('budget:');
  });

  test('summary includes schema info when mode is not off', () => {
    const stats = makeStats({ schemaMode: 'warn' });
    stats.schemaWarnings = 3;
    const output = formatExitSummary(stats);
    expect(output).toContain('schema:');
    expect(output).toContain('3 warnings');
  });

  test('summary excludes schema when mode is off', () => {
    const stats = makeStats({ schemaMode: 'off' });
    const output = formatExitSummary(stats);
    expect(output).not.toContain('schema:');
  });

  test('summary shows top tools', () => {
    const stats = makeStats();
    for (let i = 0; i < 10; i++) recordOutcome(stats, 'read_file', 'success', 'readonly');
    for (let i = 0; i < 5; i++) recordOutcome(stats, 'write_file', 'success', 'mutating');
    for (let i = 0; i < 3; i++) recordOutcome(stats, 'list_dir', 'success', 'readonly');

    const output = formatExitSummary(stats);
    expect(output).toContain('top tools:');
    expect(output).toContain('read_file');
  });

  test('summary shows block breakdown', () => {
    const stats = makeStats();
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'BUDGET EXCEEDED');
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'BUDGET EXCEEDED');

    const output = formatExitSummary(stats);
    expect(output).toContain('blocks by reason:');
    expect(output).toContain('budget');
  });

  test('schema strict mode shows blocks not warnings', () => {
    const stats = makeStats({ schemaMode: 'strict' });
    stats.schemaBlocks = 2;
    const output = formatExitSummary(stats);
    expect(output).toContain('2 blocked');
  });

  test('classifies E-H8 authority blocks', () => {
    const stats = makeStats();
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'E-H8 stale authority');
    expect(stats.blockReasons.get('authority (E-H8)')).toBe(1);
  });

  test('classifies convergence blocks', () => {
    const stats = makeStats();
    recordOutcome(stats, 'tool', 'blocked', 'readonly', 'CONVERGENCE exhausted');
    expect(stats.blockReasons.get('convergence')).toBe(1);
  });
});
