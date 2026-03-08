/**
 * Loop Detection — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import { createLoopDetector, recordAndCheck, classifyError, getLoopStats } from '../src/loop-detect.js';

describe('Loop Detection', () => {

  test('no loop on first error', () => {
    const detector = createLoopDetector();
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 1000);
    expect(result.loopDetected).toBe(false);
  });

  test('no loop on two errors', () => {
    const detector = createLoopDetector();
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 1000);
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 2000);
    expect(result.loopDetected).toBe(false);
  });

  test('loop detected on third identical error', () => {
    const detector = createLoopDetector();
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 1000);
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 2000);
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 3000);
    expect(result.loopDetected).toBe(true);
    expect(result.count).toBe(3);
    expect(result.reason).toContain('LOOP DETECTED');
    expect(result.reason).toContain('write_file');
  });

  test('different targets do not cross-contaminate', () => {
    const detector = createLoopDetector();
    recordAndCheck(detector, 'write_file', '/tmp/a.js', 'SyntaxError', 1000);
    recordAndCheck(detector, 'write_file', '/tmp/b.js', 'SyntaxError', 2000);
    const result = recordAndCheck(detector, 'write_file', '/tmp/c.js', 'SyntaxError', 3000);
    expect(result.loopDetected).toBe(false);
  });

  test('different error categories do not cross-contaminate', () => {
    const detector = createLoopDetector();
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError: Unexpected token', 1000);
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'ENOENT: no such file', 2000);
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'EACCES: permission denied', 3000);
    expect(result.loopDetected).toBe(false);
  });

  test('window expiry clears old entries', () => {
    const detector = createLoopDetector({ threshold: 3, windowMs: 5000 });
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 1000);
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 2000);
    // Third call after window expires
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 100_000);
    expect(result.loopDetected).toBe(false);
  });

  test('custom threshold', () => {
    const detector = createLoopDetector({ threshold: 2 });
    recordAndCheck(detector, 'read_file', '/x', 'Error', 1000);
    const result = recordAndCheck(detector, 'read_file', '/x', 'Error', 2000);
    expect(result.loopDetected).toBe(true);
    expect(result.count).toBe(2);
  });

  test('loop stats tracks active loops', () => {
    const detector = createLoopDetector({ threshold: 2, windowMs: 60_000 });
    const now = Date.now();
    recordAndCheck(detector, 'tool_a', '/a', 'err_a', now);
    recordAndCheck(detector, 'tool_a', '/a', 'err_a', now + 1000);
    recordAndCheck(detector, 'tool_b', '/b', 'err_b', now + 2000);
    recordAndCheck(detector, 'tool_b', '/b', 'err_b', now + 3000);

    const stats = getLoopStats(detector);
    expect(stats.activeLoops).toBe(2);
    expect(stats.totalTrackedPatterns).toBeGreaterThanOrEqual(2);
  });

  test('classifyError uses kernel extractSignature for known patterns', () => {
    const cat = classifyError('SyntaxError: Unexpected token )');
    expect(cat).toBe('syntax_error');
  });

  test('classifyError falls back to normalized first line', () => {
    const cat = classifyError('Some weird custom error on line 42\nStack trace here');
    expect(typeof cat).toBe('string');
    expect(cat.length).toBeGreaterThan(0);
    expect(cat.length).toBeLessThanOrEqual(80);
  });

  test('classifyError returns unknown for empty input', () => {
    expect(classifyError('')).toBe('unknown');
  });

  test('loop key includes error category', () => {
    const detector = createLoopDetector({ threshold: 3 });
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 1000);
    recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 2000);
    const result = recordAndCheck(detector, 'write_file', '/tmp/test.js', 'SyntaxError', 3000);
    expect(result.key).toContain('write_file');
    expect(result.key).toContain('/tmp/test.js');
    // Key should have three parts: tool:target:category
    expect(result.key!.split(':').length).toBeGreaterThanOrEqual(3);
  });
});
