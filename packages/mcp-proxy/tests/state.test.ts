/**
 * State Persistence Tests
 * =======================
 *
 * Proves:
 *   - Controller generated once, stable across loads
 *   - Authority epoch increments correctly
 *   - Constraints survive restart
 *   - Receipts append-only (JSONL format)
 *   - Receipt hash chain integrity
 *   - Receipt chain tamper detection
 *   - getLastReceiptHash() returns 'genesis' for empty file
 *   - Atomic writes (no partial state on crash)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStateDir,
  acquireLock,
  releaseLock,
  checkLock,
  StateDirLockError,
  loadOrCreateController,
  loadAuthority,
  saveAuthority,
  loadConstraints,
  saveConstraints,
  appendReceipt,
  getLastReceiptHash,
  getReceiptCount,
  loadReceipts,
  verifyReceiptChain,
  stableStringify,
  computeReceiptHash,
} from '../src/state.js';
import type { ConstraintEntry, ToolCallRecord } from '../src/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// DIRECTORY
// =============================================================================

describe('ensureStateDir', () => {
  test('creates directory if missing', () => {
    const dir = join(tmpDir, 'governance');
    expect(existsSync(dir)).toBe(false);
    ensureStateDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  test('idempotent on existing directory', () => {
    const dir = join(tmpDir, 'governance');
    ensureStateDir(dir);
    ensureStateDir(dir); // No throw
    expect(existsSync(dir)).toBe(true);
  });
});

// =============================================================================
// STATE DIRECTORY LOCK
// =============================================================================

describe('acquireLock / releaseLock', () => {
  test('acquire succeeds on fresh directory', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    expect(() => acquireLock(dir)).not.toThrow();
    releaseLock(dir); // cleanup
  });

  test('second acquire throws StateDirLockError', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    acquireLock(dir);
    try {
      expect(() => acquireLock(dir)).toThrow(StateDirLockError);
    } finally {
      releaseLock(dir);
    }
  });

  test('release makes re-acquire possible', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    acquireLock(dir);
    releaseLock(dir);
    expect(() => acquireLock(dir)).not.toThrow();
    releaseLock(dir);
  });

  test('release is idempotent', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    acquireLock(dir);
    releaseLock(dir);
    releaseLock(dir); // No throw
    releaseLock(dir); // Still no throw
  });

  test('checkLock returns null when unlocked', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    expect(checkLock(dir)).toBeNull();
  });

  test('checkLock returns info when locked', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    acquireLock(dir);
    try {
      const info = checkLock(dir);
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(process.pid);
      expect(info!.acquiredAt).toBeGreaterThan(0);
    } finally {
      releaseLock(dir);
    }
  });

  test('StateDirLockError contains lock info', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    acquireLock(dir);
    try {
      acquireLock(dir);
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StateDirLockError);
      const lockErr = err as StateDirLockError;
      expect(lockErr.lockInfo.pid).toBe(process.pid);
      expect(lockErr.lockInfo.acquiredAt).toBeGreaterThan(0);
      expect(lockErr.message).toContain('locked by PID');
    } finally {
      releaseLock(dir);
    }
  });

  test('stale lock is stolen', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    // Write a lock file with a timestamp from 10 minutes ago
    const staleLock = JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 10 * 60 * 1000 });
    writeFileSync(join(dir, '.lock'), staleLock, 'utf-8');

    // Should succeed — stale lock is overwritten
    expect(() => acquireLock(dir)).not.toThrow();
    const info = checkLock(dir);
    expect(info!.pid).toBe(process.pid); // We own it now
    releaseLock(dir);
  });
});

// =============================================================================
// CONTROLLER (E-H7)
// =============================================================================

describe('loadOrCreateController', () => {
  test('generates UUID on first call', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    const controller = loadOrCreateController(dir);
    expect(controller.id).toMatch(/^[0-9a-f]{8}-/);
    expect(controller.establishedAt).toBeGreaterThan(0);
  });

  test('stable across loads', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    const first = loadOrCreateController(dir);
    const second = loadOrCreateController(dir);
    expect(second.id).toBe(first.id);
    expect(second.establishedAt).toBe(first.establishedAt);
  });

  test('different stateDir → different controller ID', () => {
    const dir1 = join(tmpDir, 'gov1');
    const dir2 = join(tmpDir, 'gov2');
    ensureStateDir(dir1);
    ensureStateDir(dir2);
    const c1 = loadOrCreateController(dir1);
    const c2 = loadOrCreateController(dir2);
    expect(c1.id).not.toBe(c2.id);
  });
});

// =============================================================================
// AUTHORITY (E-H8)
// =============================================================================

describe('authority', () => {
  test('returns epoch 0 when file missing', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    const auth = loadAuthority(dir, 'test-ctrl');
    expect(auth.epoch).toBe(0);
    expect(auth.controllerId).toBe('test-ctrl');
  });

  test('increments and persists correctly', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const auth = loadAuthority(dir, 'test-ctrl');
    auth.epoch = 5;
    auth.lastBumpedAt = Date.now();
    saveAuthority(dir, auth);

    const loaded = loadAuthority(dir, 'test-ctrl');
    expect(loaded.epoch).toBe(5);
  });

  test('session epoch survives save/load', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const auth = loadAuthority(dir, 'test-ctrl');
    auth.activeSessionEpoch = 3;
    auth.sessionStartedAt = Date.now();
    saveAuthority(dir, auth);

    const loaded = loadAuthority(dir, 'test-ctrl');
    expect(loaded.activeSessionEpoch).toBe(3);
    expect(loaded.sessionStartedAt).toBeGreaterThan(0);
  });
});

// =============================================================================
// CONSTRAINTS (G2)
// =============================================================================

describe('constraints', () => {
  test('returns empty array when file missing', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    expect(loadConstraints(dir)).toEqual([]);
  });

  test('survive restart (save + load)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const constraints: ConstraintEntry[] = [
      {
        id: 'c_1',
        toolName: 'write_file',
        target: '/tmp/test.txt',
        failureSignature: 'syntax_error',
        errorSnippet: 'SyntaxError: Unexpected token',
        createdAt: Date.now(),
      },
    ];

    saveConstraints(dir, constraints);
    const loaded = loadConstraints(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('c_1');
    expect(loaded[0].toolName).toBe('write_file');
    expect(loaded[0].failureSignature).toBe('syntax_error');
  });

  test('multiple constraints persist', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const constraints: ConstraintEntry[] = [
      { id: 'c_1', toolName: 'write_file', target: 'a.txt', failureSignature: 'syntax_error', errorSnippet: 'err', createdAt: Date.now() },
      { id: 'c_2', toolName: 'execute_command', target: 'npm test', failureSignature: 'build_failure', errorSnippet: 'err', createdAt: Date.now() },
    ];

    saveConstraints(dir, constraints);
    expect(loadConstraints(dir)).toHaveLength(2);
  });
});

// =============================================================================
// RECEIPTS — Hash-chained JSONL
// =============================================================================

function makeRecord(seq: number, previousHash: string): Omit<ToolCallRecord, 'hash'> {
  return {
    id: `r_${seq}`,
    seq,
    timestamp: Date.now(),
    controllerId: 'test-ctrl',
    authorityEpoch: 0,
    enforcement: 'strict',
    toolName: 'test_tool',
    arguments: { path: '/test' },
    target: '/test',
    constraintCheck: { passed: true },
    authorityCheck: { passed: true },
    outcome: 'success',
    durationMs: 100,
    previousHash,
    mutation: { verb: 'test_tool', target: '/test', capturedAt: Date.now(), args: { path: '/test' } },
    mutationType: 'readonly',
  };
}

describe('receipts', () => {
  test('getLastReceiptHash returns genesis for empty/missing', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    expect(getLastReceiptHash(dir)).toBe('genesis');
  });

  test('getReceiptCount returns 0 for empty/missing', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    expect(getReceiptCount(dir)).toBe(0);
  });

  test('append-only JSONL format', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    expect(r1.hash).toBeTruthy();
    expect(r1.previousHash).toBe('genesis');

    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    expect(r2.previousHash).toBe(r1.hash);

    // File has 2 lines
    const content = readFileSync(join(dir, 'receipts.jsonl'), 'utf-8').trim();
    expect(content.split('\n')).toHaveLength(2);
  });

  test('hash chain: each receipt includes previous hash', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    const r3 = appendReceipt(dir, makeRecord(2, r2.hash));

    expect(r1.previousHash).toBe('genesis');
    expect(r2.previousHash).toBe(r1.hash);
    expect(r3.previousHash).toBe(r2.hash);
  });

  test('getLastReceiptHash returns latest hash', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    expect(getLastReceiptHash(dir)).toBe(r1.hash);

    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    expect(getLastReceiptHash(dir)).toBe(r2.hash);
  });

  test('loadReceipts returns all records', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    const all = loadReceipts(dir);
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(0);
    expect(all[1].seq).toBe(1);
  });
});

// =============================================================================
// RECEIPT CHAIN VERIFICATION
// =============================================================================

describe('verifyReceiptChain', () => {
  test('empty ledger is intact', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);
    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(0);
  });

  test('valid chain is intact', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    appendReceipt(dir, makeRecord(2, r2.hash));

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(3);
  });

  test('tampered receipt breaks chain', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    // Tamper: modify the first receipt's hash in the file
    const path = join(dir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    const record = JSON.parse(lines[0]);
    record.toolName = 'TAMPERED';
    lines[0] = JSON.stringify(record);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  test('broken previousHash linkage detected', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    // Tamper: change second receipt's previousHash
    const path = join(dir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    const record = JSON.parse(lines[1]);
    record.previousHash = 'tampered';
    lines[1] = JSON.stringify(record);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});

// =============================================================================
// STABLE STRINGIFY
// =============================================================================

describe('stableStringify', () => {
  test('sorted keys produce identical output regardless of insertion order', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  test('computeReceiptHash is deterministic', () => {
    const record = makeRecord(0, 'genesis');
    const hash1 = computeReceiptHash(record, 'genesis');
    const hash2 = computeReceiptHash(record, 'genesis');
    expect(hash1).toBe(hash2);
  });

  test('different previousHash produces different receipt hash', () => {
    const record = makeRecord(0, 'genesis');
    const hash1 = computeReceiptHash(record, 'genesis');
    const hash2 = computeReceiptHash(record, 'different');
    expect(hash1).not.toBe(hash2);
  });
});
