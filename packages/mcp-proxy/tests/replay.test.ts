/**
 * Replay Timeline — Unit Tests
 *
 * Tests the phase grouping, turning point detection, and formatting logic.
 * Since printReplay() writes to stderr, we test the internal helpers by
 * importing from the module and checking the output indirectly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { printReplay } from '../src/replay.js';
import type { ToolCallRecord } from '../src/types.js';

const TEST_DIR = join(process.cwd(), '.test-replay-state');

function makeReceipt(overrides: Partial<ToolCallRecord> & { seq: number; toolName: string }): ToolCallRecord {
  return {
    id: `r_${overrides.seq}`,
    seq: overrides.seq,
    timestamp: overrides.timestamp ?? Date.now() + overrides.seq * 1000,
    controllerId: 'test-ctrl',
    authorityEpoch: 1,
    enforcement: 'strict',
    toolName: overrides.toolName,
    arguments: overrides.arguments ?? {},
    target: overrides.target ?? overrides.toolName,
    constraintCheck: overrides.constraintCheck ?? { passed: true },
    authorityCheck: overrides.authorityCheck ?? { passed: true },
    outcome: overrides.outcome ?? 'success',
    durationMs: overrides.durationMs ?? 100,
    previousHash: overrides.previousHash ?? 'genesis',
    hash: overrides.hash ?? `hash_${overrides.seq}`,
    mutation: overrides.mutation ?? { verb: overrides.toolName, target: overrides.toolName, capturedAt: Date.now(), args: {} },
    mutationType: overrides.mutationType ?? 'readonly',
    ...overrides,
  };
}

function setupStateDir(receipts: ToolCallRecord[]): void {
  mkdirSync(TEST_DIR, { recursive: true });
  const lines = receipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(TEST_DIR, 'receipts.jsonl'), lines);
  writeFileSync(join(TEST_DIR, 'controller.json'), JSON.stringify({ id: 'test-ctrl', establishedAt: Date.now() }));
}

describe('Replay Timeline', () => {

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('handles missing state dir', () => {
    // Should not throw, just print to stderr
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay('/nonexistent/path');
    } finally {
      process.stderr.write = origWrite;
    }
    expect(stderrChunks.join('')).toContain('No governance state found');
  });

  test('handles empty receipts', () => {
    setupStateDir([]);
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay(TEST_DIR);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(stderrChunks.join('')).toContain('No receipts');
  });

  test('renders timeline with phases', () => {
    const baseTime = 1000000;
    const receipts = [
      makeReceipt({ seq: 0, toolName: 'list_files', timestamp: baseTime, mutationType: 'readonly' }),
      makeReceipt({ seq: 1, toolName: 'read_file', timestamp: baseTime + 1000, mutationType: 'readonly' }),
      makeReceipt({ seq: 2, toolName: 'write_file', timestamp: baseTime + 2000, mutationType: 'mutating' }),
      makeReceipt({ seq: 3, toolName: 'write_file', timestamp: baseTime + 3000, mutationType: 'mutating' }),
    ];
    setupStateDir(receipts);

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay(TEST_DIR);
    } finally {
      process.stderr.write = origWrite;
    }

    const output = stderrChunks.join('');
    expect(output).toContain('SESSION REPLAY');
    expect(output).toContain('4 calls');
  });

  test('highlights errors and blocks', () => {
    const baseTime = 1000000;
    const receipts = [
      makeReceipt({ seq: 0, toolName: 'read_file', timestamp: baseTime, outcome: 'success' }),
      makeReceipt({ seq: 1, toolName: 'write_file', timestamp: baseTime + 1000, outcome: 'error', error: 'SyntaxError: bad code' }),
      makeReceipt({ seq: 2, toolName: 'write_file', timestamp: baseTime + 2000, outcome: 'blocked', error: 'G2 constraint' }),
    ];
    setupStateDir(receipts);

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay(TEST_DIR);
    } finally {
      process.stderr.write = origWrite;
    }

    const output = stderrChunks.join('');
    expect(output).toContain('1 errors');
    expect(output).toContain('1 blocked');
  });

  test('respects limit parameter', () => {
    const baseTime = 1000000;
    const receipts = Array.from({ length: 10 }, (_, i) =>
      makeReceipt({ seq: i, toolName: 'read_file', timestamp: baseTime + i * 1000 })
    );
    setupStateDir(receipts);

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay(TEST_DIR, 3);
    } finally {
      process.stderr.write = origWrite;
    }

    const output = stderrChunks.join('');
    expect(output).toContain('earlier receipts omitted');
    expect(output).toContain('3 calls');
  });

  test('shows turning points', () => {
    const baseTime = 1000000;
    const receipts = [
      makeReceipt({ seq: 0, toolName: 'read_file', timestamp: baseTime, outcome: 'success', mutationType: 'readonly' }),
      makeReceipt({ seq: 1, toolName: 'write_file', timestamp: baseTime + 5000, outcome: 'error', error: 'SyntaxError', mutationType: 'mutating' }),
      makeReceipt({ seq: 2, toolName: 'read_file', timestamp: baseTime + 10000, outcome: 'success', durationMs: 5000, mutationType: 'readonly' }),
    ];
    setupStateDir(receipts);

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;
    try {
      printReplay(TEST_DIR);
    } finally {
      process.stderr.write = origWrite;
    }

    const output = stderrChunks.join('');
    expect(output).toContain('turning points');
    expect(output).toContain('first error');
    expect(output).toContain('first mutation');
    expect(output).toContain('slowest call');
  });
});
