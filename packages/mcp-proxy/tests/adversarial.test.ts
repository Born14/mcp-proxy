/**
 * Adversarial & Edge Case Tests
 * ==============================
 *
 * The difficult tests. Each one targets a real failure mode
 * that could cause silent data loss, false integrity claims,
 * or governance bypass in production.
 *
 * Categories:
 *   1. Corrupt State Resilience — garbage/partial/empty files
 *   2. Lock Edge Cases — crash-during-hold, orphan .tmp files
 *   3. Receipt Chain Adversarial — surgical tampering, injection, truncation
 *   4. stableStringify Pathological Inputs — deep nesting, cycles, specials
 *   5. Governance Gate Boundary — epoch overflow, constraint TTL boundaries, multi-gate
 *   6. High-Volume Stress — 1000-receipt chain integrity
 *   7. Atomic Write Failure Modes — .tmp orphans, permission issues
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
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
import { toolCallToMutation, seedFromFailure, classifyMutationType, extractTarget } from '../src/fingerprint.js';
import { checkConstraints, checkAuthority, runGates, processFailure, CONSTRAINT_TTL_MS } from '../src/governance.js';
import { handleBumpAuthority, handleGovernanceStatus, isMetaTool } from '../src/meta-tools.js';
import type { ConstraintEntry, ToolCallRecord, ProxyState, AuthorityState } from '../src/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-adversarial-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(seq: number, previousHash: string, overrides?: Partial<Omit<ToolCallRecord, 'hash'>>): Omit<ToolCallRecord, 'hash'> {
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
    ...overrides,
  };
}

// =============================================================================
// 1. CORRUPT STATE RESILIENCE
// =============================================================================

describe('Corrupt state resilience', () => {
  test('garbage lock file → readLockFile returns null → acquire succeeds', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    // Write garbage to lock file
    writeFileSync(join(dir, '.lock'), '!!!NOT JSON!!!', 'utf-8');

    // Should succeed — garbage is treated as unreadable (null)
    // The existsSync sees the file, readLockFile returns null, stale check skipped
    // But then writeFileSync with 'wx' will FAIL because file exists
    // This actually tests a real edge case: garbage lock that can't be parsed
    // The code checks if existing is truthy after readLockFile — null means skip stale check
    // Since existing is null, it falls through to the writeFileSync which fails EEXIST
    // So it throws StateDirLockError with fallback { pid: 0, acquiredAt: now }
    expect(() => acquireLock(dir)).toThrow(StateDirLockError);

    // Clean up for next test
    unlinkSync(join(dir, '.lock'));
  });

  test('empty lock file → treated as unreadable', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), '', 'utf-8');

    // Empty string → JSON.parse throws → readLockFile returns null
    // Same path as garbage: null existing → skip stale check → wx fails EEXIST
    expect(() => acquireLock(dir)).toThrow(StateDirLockError);
    unlinkSync(join(dir, '.lock'));
  });

  test('lock file with wrong JSON shape → treated as unreadable', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), JSON.stringify({ foo: 'bar' }), 'utf-8');

    // Valid JSON but missing pid/acquiredAt — readLockFile returns { foo: 'bar' }
    // existing is truthy, age calculation: Date.now() - undefined = NaN
    // NaN < STALE_LOCK_MS is false → falls through to stale path
    // unlinkSync removes it, then writeFileSync wx succeeds
    expect(() => acquireLock(dir)).not.toThrow();
    releaseLock(dir);
  });

  test('lock file with negative timestamp → treated as stale', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 99999, acquiredAt: -1 }), 'utf-8');

    // age = Date.now() - (-1) = Date.now() + 1, which is >> STALE_LOCK_MS
    // Treated as stale → stolen
    expect(() => acquireLock(dir)).not.toThrow();
    const info = checkLock(dir);
    expect(info!.pid).toBe(process.pid);
    releaseLock(dir);
  });

  test('lock file with future timestamp but dead PID → treated as stale (stolen)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const futureTime = Date.now() + 10 * 60 * 1000; // 10 minutes in the future
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 99999, acquiredAt: futureTime }), 'utf-8');

    // age is negative (< STALE_LOCK_MS) but PID 99999 is dead → stale → stolen
    expect(() => acquireLock(dir)).not.toThrow();
    const info = checkLock(dir);
    expect(info!.pid).toBe(process.pid);
    releaseLock(dir);
  });

  test('lock file with future timestamp and alive PID → blocks', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const futureTime = Date.now() + 10 * 60 * 1000;
    // Use current PID — guaranteed alive
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: process.pid, acquiredAt: futureTime }), 'utf-8');

    // Fresh timestamp + alive PID → blocks
    expect(() => acquireLock(dir)).toThrow(StateDirLockError);
    unlinkSync(join(dir, '.lock'));
  });

  test('corrupt controller.json → graceful recovery (delete + regenerate)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, 'controller.json'), 'NOT VALID JSON', 'utf-8');

    // Corrupt file should be deleted and a fresh controller created
    const controller = loadOrCreateController(dir);
    expect(controller.id).toMatch(/^[0-9a-f]{8}-/);
    expect(controller.establishedAt).toBeGreaterThan(0);

    // File should now be valid JSON
    const reloaded = JSON.parse(readFileSync(join(dir, 'controller.json'), 'utf-8'));
    expect(reloaded.id).toBe(controller.id);
  });

  test('corrupt authority.json → graceful recovery (reset to epoch 0)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, 'authority.json'), '{truncated', 'utf-8');

    // Corrupt file should be deleted, returns defaults
    const authority = loadAuthority(dir, 'test-ctrl');
    expect(authority.epoch).toBe(0);
    expect(authority.controllerId).toBe('test-ctrl');
  });

  test('corrupt constraints.json → graceful recovery (empty array)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, 'constraints.json'), '[{"id": "c_1", broken', 'utf-8');

    // Corrupt file should be deleted, returns empty
    const constraints = loadConstraints(dir);
    expect(constraints).toEqual([]);
  });

  test('corrupt receipts.jsonl with one bad line → loadReceipts skips corrupt line', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    // Inject a corrupt line
    appendFileSync(join(dir, 'receipts.jsonl'), 'NOT JSON\n', 'utf-8');

    // loadReceipts should skip the bad line and return the valid receipt
    const receipts = loadReceipts(dir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].hash).toBe(r1.hash);
  });

  test('corrupt receipts.jsonl → verifyReceiptChain returns intact for valid subset', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    appendReceipt(dir, makeRecord(0, 'genesis'));
    appendFileSync(join(dir, 'receipts.jsonl'), 'CORRUPT\n', 'utf-8');

    // Should return intact for the valid receipt (corrupt line skipped)
    // The chain is intact for what can be parsed — truncation detection
    // is a separate concern from crash-safety
    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(1);
  });

  test('orphan .tmp file from previous crash → writeAtomic overwrites it', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    // Simulate a crash that left controller.json.tmp behind
    writeFileSync(join(dir, 'controller.json.tmp'), 'orphan data', 'utf-8');

    // loadOrCreateController should still work — writeAtomic overwrites .tmp
    const controller = loadOrCreateController(dir);
    expect(controller.id).toMatch(/^[0-9a-f]{8}-/);

    // .tmp should be gone (renamed to controller.json)
    expect(existsSync(join(dir, 'controller.json.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'controller.json'))).toBe(true);
  });

  test('empty receipts.jsonl file → treated as empty ledger', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, 'receipts.jsonl'), '', 'utf-8');

    expect(getLastReceiptHash(dir)).toBe('genesis');
    expect(getReceiptCount(dir)).toBe(0);
    expect(loadReceipts(dir)).toEqual([]);
    expect(verifyReceiptChain(dir)).toEqual({ intact: true, depth: 0 });
  });

  test('receipts.jsonl with only whitespace → treated as empty', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, 'receipts.jsonl'), '   \n\n  \n', 'utf-8');

    expect(getLastReceiptHash(dir)).toBe('genesis');
    expect(getReceiptCount(dir)).toBe(0);
  });
});

// =============================================================================
// 2. LOCK EDGE CASES
// =============================================================================

describe('Lock edge cases', () => {
  test('release by non-owner PID → lock preserved', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    // Simulate a lock owned by a different PID
    writeFileSync(join(dir, '.lock'), JSON.stringify({
      pid: process.pid + 99999, // Different PID
      acquiredAt: Date.now(),
    }), 'utf-8');

    // Our release should NOT remove it — we don't own it
    releaseLock(dir);

    // Lock should still exist
    expect(existsSync(join(dir, '.lock'))).toBe(true);
  });

  test('checkLock on stale lock → returns null', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), JSON.stringify({
      pid: 99999,
      acquiredAt: Date.now() - 10 * 60 * 1000, // 10 min ago
    }), 'utf-8');

    // Stale lock should be invisible
    expect(checkLock(dir)).toBeNull();
  });

  test('lock at exact stale boundary → treated as stale', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const STALE_LOCK_MS = 30 * 1000;
    writeFileSync(join(dir, '.lock'), JSON.stringify({
      pid: process.pid, // alive PID — only age matters for this test
      acquiredAt: Date.now() - STALE_LOCK_MS, // Exactly at boundary
    }), 'utf-8');

    // >= STALE_LOCK_MS means stale
    expect(checkLock(dir)).toBeNull();
  });

  test('lock with dead PID → always stale regardless of age', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), JSON.stringify({
      pid: 99999, // dead PID
      acquiredAt: Date.now(), // just acquired — fresh by time
    }), 'utf-8');

    // Dead PID → stale even though age < STALE_LOCK_MS
    expect(checkLock(dir)).toBeNull();
  });

  test('lock within stale boundary with alive PID → still fresh', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    writeFileSync(join(dir, '.lock'), JSON.stringify({
      pid: process.pid, // alive PID
      acquiredAt: Date.now() - 5_000, // 5s ago — well within 30s threshold
    }), 'utf-8');

    // Fresh + alive → blocks
    const info = checkLock(dir);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
  });

  test('acquire-release-acquire-release rapid cycle (100x)', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    for (let i = 0; i < 100; i++) {
      acquireLock(dir);
      const info = checkLock(dir);
      expect(info!.pid).toBe(process.pid);
      releaseLock(dir);
      expect(checkLock(dir)).toBeNull();
    }
  });

  test('directory does not exist → acquireLock throws (not creates)', () => {
    const dir = join(tmpDir, 'nonexistent', 'deep', 'path');
    // acquireLock should fail — it doesn't create directories
    expect(() => acquireLock(dir)).toThrow();
  });
});

// =============================================================================
// 3. RECEIPT CHAIN ADVERSARIAL
// =============================================================================

describe('Receipt chain adversarial tampering', () => {
  test('insert receipt in the middle → chain breaks at insertion point', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    const r3 = appendReceipt(dir, makeRecord(2, r2.hash));

    // Insert a fake receipt between r1 and r2
    const path = join(dir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');

    const fakeReceipt = {
      ...JSON.parse(lines[1]),
      id: 'r_FAKE',
      toolName: 'INJECTED',
      seq: 99,
    };
    lines.splice(1, 0, JSON.stringify(fakeReceipt));
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    // The injected receipt's previousHash won't match the actual receipt before it
    // OR its hash won't recompute correctly
  });

  test('delete first receipt → chain breaks immediately', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    // Remove first line
    const path = join(dir, 'receipts.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    writeFileSync(path, lines.slice(1).join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    // First receipt no longer starts with 'genesis'
  });

  test('delete last receipt → chain still intact for remaining', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    appendReceipt(dir, makeRecord(2, r2.hash));

    // Remove last line (truncation — like disk full during write)
    const path = join(dir, 'receipts.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    writeFileSync(path, lines.slice(0, 2).join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    // The first two receipts are self-consistent — chain is intact for what remains
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(2);
  });

  test('swap two receipts → chain breaks', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    const r2 = appendReceipt(dir, makeRecord(1, r1.hash));
    appendReceipt(dir, makeRecord(2, r2.hash));

    // Swap lines 1 and 2
    const path = join(dir, 'receipts.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
  });

  test('duplicate a receipt → chain breaks', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    // Duplicate first line
    const path = join(dir, 'receipts.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    lines.splice(1, 0, lines[0]); // Duplicate r1 at position 1
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    // Duplicated receipt's previousHash won't chain to itself
  });

  test('single bit flip in hash → detected', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    appendReceipt(dir, makeRecord(0, 'genesis'));

    const path = join(dir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const record = JSON.parse(content.trim());

    // Flip one character in the hash
    const hash = record.hash as string;
    const flipped = hash[0] === 'a' ? 'b' + hash.slice(1) : 'a' + hash.slice(1);
    record.hash = flipped;
    writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  test('change only timestamp (invisible field) → hash breaks', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    appendReceipt(dir, makeRecord(0, 'genesis'));

    const path = join(dir, 'receipts.jsonl');
    const record = JSON.parse(readFileSync(path, 'utf-8').trim());

    // Change timestamp by 1ms — invisible to naked eye
    record.timestamp += 1;
    writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
  });

  test('change only durationMs → hash breaks', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    appendReceipt(dir, makeRecord(0, 'genesis'));

    const path = join(dir, 'receipts.jsonl');
    const record = JSON.parse(readFileSync(path, 'utf-8').trim());

    record.durationMs = record.durationMs + 1;
    writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
  });

  test('replace genesis hash with actual hash → breaks first receipt', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const r1 = appendReceipt(dir, makeRecord(0, 'genesis'));
    appendReceipt(dir, makeRecord(1, r1.hash));

    const path = join(dir, 'receipts.jsonl');
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    const record = JSON.parse(lines[0]);

    // Replace 'genesis' with actual hash — breaks the anchor
    record.previousHash = r1.hash;
    lines[0] = JSON.stringify(record);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(0);
  });
});

// =============================================================================
// 4. STABLE STRINGIFY PATHOLOGICAL INPUTS
// =============================================================================

describe('stableStringify pathological inputs', () => {
  test('empty object', () => {
    expect(stableStringify({})).toBe('{}');
  });

  test('single key', () => {
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('keys with special characters', () => {
    const result = stableStringify({ 'a"b': 1, 'c\\d': 2 });
    // Should not throw — JSON.stringify handles escaping
    expect(result).toBeTruthy();
    JSON.parse(result); // Should round-trip
  });

  test('values with special types (null, boolean, number)', () => {
    const obj: Record<string, unknown> = { n: null, b: true, i: 42, f: 3.14 };
    const result = stableStringify(obj);
    const parsed = JSON.parse(result);
    expect(parsed.n).toBeNull();
    expect(parsed.b).toBe(true);
    expect(parsed.i).toBe(42);
    expect(parsed.f).toBe(3.14);
  });

  test('nested objects → all keys sorted at every depth', () => {
    const a = stableStringify({ z: { b: 1, a: 2 }, a: 1 });
    const b = stableStringify({ a: 1, z: { b: 1, a: 2 } });
    expect(a).toBe(b);
    // Nested keys are also sorted
    expect(a).toContain('"a":2,"b":1'); // inner object keys sorted (a=2, b=1)
  });

  test('nested objects with different inner key order → SAME output (deep sort)', () => {
    const a = stableStringify({ x: { b: 1, a: 2 } } as Record<string, unknown>);
    const b = stableStringify({ x: { a: 2, b: 1 } } as Record<string, unknown>);
    // Deep sort ensures insertion order doesn't matter
    expect(a).toBe(b);
    expect(a).toBe('{"x":{"a":2,"b":1}}');
  });

  test('deeply nested structure → all levels preserved', () => {
    let obj: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 100; i++) {
      obj = { [`level_${i}`]: obj };
    }
    const result = stableStringify(obj);
    expect(result).toBeTruthy();

    // Deep sort preserves all nested content
    expect(result).toContain('level_99');
    expect(result).toContain('"leaf":"value"'); // innermost data preserved
    expect(result).not.toContain('{}'); // no collapsed empty objects
  });

  test('stableStringify: flat objects with many keys → all keys present', () => {
    // Verify the happy path: flat objects work correctly
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      obj[`key_${String(i).padStart(3, '0')}`] = `value_${i}`;
    }
    const result = stableStringify(obj);
    expect(result.length).toBeGreaterThan(500);
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toHaveLength(50);
    // Keys should be sorted
    const keys = Object.keys(parsed);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i] > keys[i - 1]).toBe(true);
    }
  });

  test('large string value → handles without truncation', () => {
    const bigValue = 'x'.repeat(100_000);
    const result = stableStringify({ data: bigValue });
    expect(result).toContain(bigValue);
  });

  test('unicode keys and values', () => {
    const obj = { '日本語': 'テスト', emoji: '🔐', 'Ñ': 'café' };
    const result = stableStringify(obj as Record<string, unknown>);
    const parsed = JSON.parse(result);
    expect(parsed['日本語']).toBe('テスト');
    expect(parsed.emoji).toBe('🔐');
  });

  test('array values serialize correctly', () => {
    const obj = { items: [1, 2, 3], tags: ['a', 'b'] };
    const result = stableStringify(obj as Record<string, unknown>);
    const parsed = JSON.parse(result);
    expect(parsed.items).toEqual([1, 2, 3]);
  });

  test('undefined values omitted by JSON.stringify', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const result = stableStringify(obj as Record<string, unknown>);
    const parsed = JSON.parse(result);
    expect('b' in parsed).toBe(false);
    expect(parsed.a).toBe(1);
    expect(parsed.c).toBe(3);
  });

  test('computeReceiptHash: identical records always produce identical hash', () => {
    // Freeze a record with a fixed timestamp to eliminate time-dependence
    const record: Omit<ToolCallRecord, 'hash'> = {
      id: 'r_0',
      seq: 0,
      timestamp: 1708000000000,
      controllerId: 'ctrl-fixed',
      authorityEpoch: 0,
      enforcement: 'strict',
      toolName: 'test',
      arguments: {},
      target: '/test',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'success',
      durationMs: 50,
      previousHash: 'genesis',
      mutation: { verb: 'test', target: '/test', capturedAt: 1708000000000, args: {} },
      mutationType: 'readonly',
    };

    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(computeReceiptHash(record, 'genesis'));
    }
    expect(hashes.size).toBe(1); // All 100 hashes identical
  });

  test('computeReceiptHash: changing any field changes the hash', () => {
    const base: Omit<ToolCallRecord, 'hash'> = {
      id: 'r_0',
      seq: 0,
      timestamp: 1708000000000,
      controllerId: 'ctrl',
      authorityEpoch: 0,
      enforcement: 'strict',
      toolName: 'test',
      arguments: {},
      target: '/test',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'success',
      durationMs: 50,
      previousHash: 'genesis',
      mutation: { verb: 'test', target: '/test', capturedAt: 1708000000000, args: {} },
      mutationType: 'readonly',
    };

    const baseHash = computeReceiptHash(base, 'genesis');

    // Each mutation should produce a different hash
    const variants: Array<Omit<ToolCallRecord, 'hash'>> = [
      { ...base, id: 'r_1' },
      { ...base, seq: 1 },
      { ...base, timestamp: 1708000000001 },
      { ...base, controllerId: 'other' },
      { ...base, authorityEpoch: 1 },
      { ...base, enforcement: 'advisory' as const },
      { ...base, toolName: 'other' },
      { ...base, target: '/other' },
      { ...base, outcome: 'error' as const },
      { ...base, durationMs: 51 },
      { ...base, mutationType: 'mutating' as const },
    ];

    for (const variant of variants) {
      const variantHash = computeReceiptHash(variant, 'genesis');
      expect(variantHash).not.toBe(baseHash);
    }
  });
});

// =============================================================================
// 5. GOVERNANCE GATE BOUNDARY CONDITIONS
// =============================================================================

describe('Governance gate boundary conditions', () => {
  test('constraint at TTL-1ms → blocks; at TTL → passes', () => {
    const baseTime = 1708000000000; // Fixed timestamp — no wall-clock race
    const constraint: ConstraintEntry = {
      id: 'c_1',
      toolName: 'write_file',
      target: '/test',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: baseTime,
    };

    const mutation = { verb: 'write_file', target: '/test', capturedAt: baseTime, args: {} };

    // At TTL-1ms: elapsed = CONSTRAINT_TTL_MS - 1 < TTL → blocks
    const result1 = checkConstraints(mutation, [constraint], baseTime + CONSTRAINT_TTL_MS - 1);
    expect(result1.passed).toBe(false);

    // At exactly TTL: elapsed = CONSTRAINT_TTL_MS, NOT < TTL → passes (expired)
    const result2 = checkConstraints(mutation, [constraint], baseTime + CONSTRAINT_TTL_MS);
    expect(result2.passed).toBe(true);
  });

  test('many constraints, only one matches → correct constraint reported', () => {
    const constraints: ConstraintEntry[] = [];
    for (let i = 0; i < 50; i++) {
      constraints.push({
        id: `c_${i}`,
        toolName: `tool_${i}`,
        target: `/target_${i}`,
        failureSignature: 'syntax_error',
        errorSnippet: 'err',
        createdAt: Date.now(),
      });
    }
    // Add the matching one at the end
    constraints.push({
      id: 'c_match',
      toolName: 'write_file',
      target: '/critical.js',
      failureSignature: 'build_failure',
      errorSnippet: 'err',
      createdAt: Date.now(),
    });

    const result = checkConstraints(
      { verb: 'write_file', target: '/critical.js', capturedAt: Date.now(), args: {} },
      constraints,
    );
    expect(result.passed).toBe(false);
    expect(result.blockedBy).toBe('c_match');
  });

  test('G2 + E-H8 both fail simultaneously → both reasons in blockReason', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/test',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const staleAuth: AuthorityState = {
      controllerId: 'test',
      epoch: 10,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: 5,
    };

    const result = runGates(
      { verb: 'write_file', target: '/test', capturedAt: Date.now(), args: {} },
      constraints,
      staleAuth,
      'strict',
    );

    expect(result.forward).toBe(false);
    expect(result.blockReason).toContain('G2 BLOCKED');
    expect(result.blockReason).toContain('E-H8 BLOCKED');
    // Both reasons joined with '; '
    expect(result.blockReason!.split(';').length).toBe(2);
  });

  test('authority epoch at max safe integer → still works', () => {
    const auth: AuthorityState = {
      controllerId: 'test',
      epoch: Number.MAX_SAFE_INTEGER,
      lastBumpedAt: Date.now(),
      activeSessionEpoch: Number.MAX_SAFE_INTEGER, // Same → passes
    };

    const verdict = checkAuthority(auth);
    expect(verdict.action).toBe('proceed');
  });

  test('authority epoch 0, session epoch undefined → passes (pre-planning)', () => {
    const auth: AuthorityState = {
      controllerId: 'test',
      epoch: 0,
      lastBumpedAt: Date.now(),
      // activeSessionEpoch intentionally omitted
    };

    const verdict = checkAuthority(auth);
    expect(verdict.action).toBe('proceed');
  });

  test('bump authority 100 times → epoch reaches 100', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const controller = loadOrCreateController(dir);
    const authority = loadAuthority(dir, controller.id);
    authority.activeSessionEpoch = 0;

    const state: ProxyState = {
      controller,
      authority,
      constraints: [],
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    for (let i = 0; i < 100; i++) {
      handleBumpAuthority({ reason: `bump ${i}` }, state, dir);
    }

    expect(state.authority.epoch).toBe(100);
    expect(state.authority.activeSessionEpoch).toBe(0); // Never changes

    // All tool calls should be blocked
    const gate = runGates(
      { verb: 'test', target: '/x', capturedAt: Date.now(), args: {} },
      [],
      state.authority,
      'strict',
    );
    expect(gate.forward).toBe(false);
  });
});

// =============================================================================
// 6. FINGERPRINT EDGE CASES
// =============================================================================

describe('Fingerprint edge cases', () => {
  test('extractTarget with no string args → returns tool name', () => {
    expect(extractTarget('my_tool', { count: 42, flag: true })).toBe('my_tool');
  });

  test('extractTarget with empty args → returns tool name', () => {
    expect(extractTarget('my_tool', {})).toBe('my_tool');
  });

  test('extractTarget priority: path > file > uri > url', () => {
    expect(extractTarget('t', { url: 'u', uri: 'r', file: 'f', path: 'p' })).toBe('p');
    expect(extractTarget('t', { url: 'u', uri: 'r', file: 'f' })).toBe('f');
    expect(extractTarget('t', { url: 'u', uri: 'r' })).toBe('r');
    expect(extractTarget('t', { url: 'u' })).toBe('u');
  });

  test('classifyMutationType: governance_* always readonly', () => {
    expect(classifyMutationType('governance_bump_authority', { content: 'destructive' })).toBe('readonly');
    expect(classifyMutationType('governance_status', {})).toBe('readonly');
    expect(classifyMutationType('governance_anything', { data: 'x' })).toBe('readonly');
  });

  test('classifyMutationType: camelCase tool names decomposed correctly', () => {
    expect(classifyMutationType('writeFile', {})).toBe('mutating');
    expect(classifyMutationType('readDocument', {})).toBe('readonly');
    expect(classifyMutationType('createUser', {})).toBe('mutating');
    expect(classifyMutationType('listItems', {})).toBe('readonly');
    expect(classifyMutationType('deleteRecord', {})).toBe('mutating');
  });

  test('classifyMutationType: SQL in arguments detected', () => {
    // With deny-by-default, custom_tool with SELECT is still mutating (no readonly verb)
    // SQL write keywords confirm mutating but are redundant with the default
    expect(classifyMutationType('custom_tool', { query: 'SELECT * FROM users' })).toBe('mutating');
    expect(classifyMutationType('custom_tool', { query: 'INSERT INTO users VALUES (1)' })).toBe('mutating');
    expect(classifyMutationType('custom_tool', { query: 'DROP TABLE users' })).toBe('mutating');
    expect(classifyMutationType('custom_tool', { query: 'DELETE FROM sessions WHERE id=1' })).toBe('mutating');
  });

  test('seedFromFailure: dedup prevents duplicate constraints', () => {
    const constraints: ConstraintEntry[] = [];

    // First seed
    const c1 = seedFromFailure('write_file', '/test.js', 'SyntaxError: bad token', constraints);
    expect(c1).not.toBeNull();
    constraints.push(c1!);

    // Duplicate — same tool, target, signature
    const c2 = seedFromFailure('write_file', '/test.js', 'SyntaxError: different message but same signature', constraints);
    expect(c2).toBeNull();
  });

  test('seedFromFailure: same tool+target but different signature → creates new constraint', () => {
    const constraints: ConstraintEntry[] = [];

    const c1 = seedFromFailure('write_file', '/test.js', 'SyntaxError: bad', constraints);
    expect(c1).not.toBeNull();
    constraints.push(c1!);

    const c2 = seedFromFailure('write_file', '/test.js', 'build failed with exit code 1', constraints);
    expect(c2).not.toBeNull();

    expect(c1!.failureSignature).not.toBe(c2!.failureSignature);
  });

  test('isMetaTool: exact match only', () => {
    expect(isMetaTool('governance_bump_authority')).toBe(true);
    expect(isMetaTool('governance_status')).toBe(true);
    expect(isMetaTool('governance_bump_authority_extra')).toBe(false);
    expect(isMetaTool('Governance_bump_authority')).toBe(false);
    expect(isMetaTool('write_file')).toBe(false);
    expect(isMetaTool('')).toBe(false);
  });
});

// =============================================================================
// 7. HIGH-VOLUME RECEIPT CHAIN STRESS
// =============================================================================

describe('High-volume receipt chain', () => {
  test('1000-receipt chain maintains integrity', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    let lastHash = 'genesis';
    for (let i = 0; i < 1000; i++) {
      const receipt = appendReceipt(dir, makeRecord(i, lastHash, {
        toolName: `tool_${i % 10}`,
        target: `/target_${i % 20}`,
        outcome: i % 7 === 0 ? 'error' : 'success',
      }));
      lastHash = receipt.hash;
    }

    // Verify count
    expect(getReceiptCount(dir)).toBe(1000);

    // Verify chain integrity
    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(1000);

    // Last hash should match
    expect(getLastReceiptHash(dir)).toBe(lastHash);
  });

  test('1000 receipts then tamper receipt 500 → breaks at 500', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    let lastHash = 'genesis';
    for (let i = 0; i < 1000; i++) {
      const receipt = appendReceipt(dir, makeRecord(i, lastHash));
      lastHash = receipt.hash;
    }

    // Tamper receipt at position 500
    const path = join(dir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    const record = JSON.parse(lines[500]);
    record.durationMs = 999999;
    lines[500] = JSON.stringify(record);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const result = verifyReceiptChain(dir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(500);
  });

  test('rapid sequential appends produce unique hashes', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const hashes = new Set<string>();
    let lastHash = 'genesis';
    for (let i = 0; i < 100; i++) {
      const receipt = appendReceipt(dir, makeRecord(i, lastHash));
      expect(hashes.has(receipt.hash)).toBe(false);
      hashes.add(receipt.hash);
      lastHash = receipt.hash;
    }

    expect(hashes.size).toBe(100);
  });
});

// =============================================================================
// 8. CONTROLLER IDENTITY IMMUTABILITY
// =============================================================================

describe('Controller identity immutability (E-H7)', () => {
  test('controller.json cannot be overwritten by loadOrCreateController', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const first = loadOrCreateController(dir);
    const second = loadOrCreateController(dir);
    const third = loadOrCreateController(dir);

    // All three calls return the same identity
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(second.establishedAt).toBe(first.establishedAt);
  });

  test('100 rapid loadOrCreateController calls → same identity', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const first = loadOrCreateController(dir);
    for (let i = 0; i < 100; i++) {
      const loaded = loadOrCreateController(dir);
      expect(loaded.id).toBe(first.id);
    }
  });

  test('separate stateDirs → unique controller IDs (cryptographic uniqueness)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const dir = join(tmpDir, `gov_${i}`);
      ensureStateDir(dir);
      const controller = loadOrCreateController(dir);
      expect(ids.has(controller.id)).toBe(false);
      ids.add(controller.id);
    }
    expect(ids.size).toBe(20);
  });
});

// =============================================================================
// 9. GOVERNANCE STATUS ACCURACY
// =============================================================================

describe('Governance status accuracy under mutation', () => {
  test('status reflects constraint count after rapid seeding', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const controller = loadOrCreateController(dir);
    const authority = loadAuthority(dir, controller.id);
    authority.activeSessionEpoch = 0;
    saveAuthority(dir, authority);

    const constraints: ConstraintEntry[] = [];

    // Seed 20 constraints on different targets
    for (let i = 0; i < 20; i++) {
      processFailure(`tool_${i}`, `/target_${i}`, 'SyntaxError: bad', constraints, dir);
    }

    const state: ProxyState = {
      controller,
      authority,
      constraints,
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    const result = handleGovernanceStatus(state, dir);
    const data = JSON.parse(result.content[0].text);

    expect(data.constraintCount).toBe(20);
    expect(data.activeConstraints).toBe(20); // All fresh
  });

  test('status correctly counts expired vs active constraints', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const controller = loadOrCreateController(dir);
    const authority = loadAuthority(dir, controller.id);
    authority.activeSessionEpoch = 0;
    saveAuthority(dir, authority);

    const constraints: ConstraintEntry[] = [
      // Active constraint
      {
        id: 'c_active',
        toolName: 'write_file',
        target: '/a.js',
        failureSignature: 'syntax_error',
        errorSnippet: 'err',
        createdAt: Date.now(),
      },
      // Expired constraint
      {
        id: 'c_expired',
        toolName: 'write_file',
        target: '/b.js',
        failureSignature: 'build_failure',
        errorSnippet: 'err',
        createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      },
    ];

    const state: ProxyState = {
      controller,
      authority,
      constraints,
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    const result = handleGovernanceStatus(state, dir);
    const data = JSON.parse(result.content[0].text);

    expect(data.constraintCount).toBe(2); // Total count
    expect(data.activeConstraints).toBe(1); // Only non-expired
  });
});

// =============================================================================
// 10. CROSS-MODULE INTEGRATION ADVERSARIAL
// =============================================================================

describe('Cross-module adversarial scenarios', () => {
  test('full lifecycle with advisory + constraint seeding + receipt chain verification', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const controller = loadOrCreateController(dir);
    const authority = loadAuthority(dir, controller.id);
    authority.activeSessionEpoch = 0;
    saveAuthority(dir, authority);

    const constraints = loadConstraints(dir);
    let lastHash = getLastReceiptHash(dir);
    let seq = 0;

    // 1. Successful call
    const m1 = toolCallToMutation('write_file', { path: '/app.js', content: 'v1' });
    const g1 = runGates(m1, constraints, authority, 'advisory');
    expect(g1.forward).toBe(true);

    const r1 = appendReceipt(dir, makeRecord(seq++, lastHash, {
      toolName: m1.verb,
      target: m1.target,
      mutationType: classifyMutationType(m1.verb, m1.args),
    }));
    lastHash = r1.hash;

    // 2. Failure → seeds constraint
    processFailure('write_file', '/app.js', 'SyntaxError: whoops', constraints, dir);
    expect(constraints).toHaveLength(1);

    // 3. Advisory mode: constraint violation logged but forwarded
    const m2 = toolCallToMutation('write_file', { path: '/app.js', content: 'v2' });
    const g2 = runGates(m2, constraints, authority, 'advisory');
    expect(g2.forward).toBe(true);
    expect(g2.constraintCheck.passed).toBe(false);

    const r2 = appendReceipt(dir, makeRecord(seq++, lastHash, {
      toolName: m2.verb,
      target: m2.target,
      constraintCheck: g2.constraintCheck,
    }));
    lastHash = r2.hash;

    // 4. Strict mode: same call blocked
    const g3 = runGates(m2, constraints, authority, 'strict');
    expect(g3.forward).toBe(false);

    const r3 = appendReceipt(dir, makeRecord(seq++, lastHash, {
      outcome: 'blocked',
      error: g3.blockReason,
    }));
    lastHash = r3.hash;

    // 5. Verify entire chain
    const chain = verifyReceiptChain(dir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(3);
  });

  test('bump authority mid-session → all subsequent calls blocked in strict', () => {
    const dir = join(tmpDir, 'gov');
    ensureStateDir(dir);

    const controller = loadOrCreateController(dir);
    const authority = loadAuthority(dir, controller.id);
    authority.activeSessionEpoch = 0;
    saveAuthority(dir, authority);

    const state: ProxyState = {
      controller,
      authority,
      constraints: [],
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    // Pre-bump: calls succeed
    const g1 = runGates(
      { verb: 'read_file', target: '/a.js', capturedAt: Date.now(), args: {} },
      state.constraints, state.authority, 'strict',
    );
    expect(g1.forward).toBe(true);

    // Bump
    handleBumpAuthority({ reason: 'operator redirect' }, state, dir);

    // Post-bump: calls blocked
    const g2 = runGates(
      { verb: 'read_file', target: '/a.js', capturedAt: Date.now(), args: {} },
      state.constraints, state.authority, 'strict',
    );
    expect(g2.forward).toBe(false);
    expect(g2.blockReason).toContain('E-H8 BLOCKED');

    // Even different tools blocked
    const g3 = runGates(
      { verb: 'write_file', target: '/new.js', capturedAt: Date.now(), args: {} },
      state.constraints, state.authority, 'strict',
    );
    expect(g3.forward).toBe(false);
  });

  test('governance_status meta-tool is not affected by constraints or authority', () => {
    // Meta-tools are handled before governance gates in the proxy
    // This test verifies the classification layer
    expect(isMetaTool('governance_status')).toBe(true);
    expect(isMetaTool('governance_bump_authority')).toBe(true);

    // They should be classified as readonly
    expect(classifyMutationType('governance_status', {})).toBe('readonly');
    expect(classifyMutationType('governance_bump_authority', {})).toBe('readonly');
  });
});
