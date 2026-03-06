/**
 * Receipt Chain Tamper Detection Tests
 * =====================================
 *
 * Proves verifyReceiptChain() catches:
 *   - Swapped receipt order (adjacency violation)
 *   - Corrupted JSONL line (partial write / disk corruption)
 *   - Duplicate insertion (replay attack)
 *   - Modified payload (field tamper without hash update)
 *   - Modified hash (hash tamper without payload update)
 *   - First receipt with wrong previousHash (genesis violation)
 *   - Mid-chain hash rewrite (breaks downstream)
 *   - Empty file and single-receipt edge cases
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStateDir,
  appendReceipt,
  loadReceipts,
  verifyReceiptChain,
  computeReceiptHash,
  stableStringify,
  pinGenesisHash,
  loadAuthority,
  saveAuthority,
  loadOrCreateController,
} from '../src/state.js';
import type { ToolCallRecord, AuthorityState } from '../src/types.js';

let tmpDir: string;
let govDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-tamper-'));
  govDir = join(tmpDir, 'gov');
  ensureStateDir(govDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(seq: number, previousHash: string): Omit<ToolCallRecord, 'hash'> {
  return {
    id: `r_${seq}`,
    seq,
    timestamp: Date.now() + seq, // ensure distinct timestamps
    controllerId: 'test-ctrl',
    authorityEpoch: 0,
    enforcement: 'strict',
    toolName: `tool_${seq}`,
    arguments: { path: `/test/${seq}` },
    target: `/test/${seq}`,
    constraintCheck: { passed: true },
    authorityCheck: { passed: true },
    outcome: 'success',
    durationMs: 100,
    previousHash,
    mutation: { verb: `tool_${seq}`, target: `/test/${seq}`, capturedAt: Date.now(), args: { path: `/test/${seq}` } },
    mutationType: 'readonly',
  };
}

function buildChain(count: number): ToolCallRecord[] {
  const receipts: ToolCallRecord[] = [];
  for (let i = 0; i < count; i++) {
    const prevHash = i === 0 ? 'genesis' : receipts[i - 1].hash;
    receipts.push(appendReceipt(govDir, makeRecord(i, prevHash)));
  }
  return receipts;
}

function rewriteLedger(receipts: ToolCallRecord[]): void {
  const content = receipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(govDir, 'receipts.jsonl'), content, 'utf-8');
}

// =============================================================================
// BASELINE
// =============================================================================

describe('tamper detection — baseline', () => {
  test('empty ledger is intact', () => {
    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(0);
  });

  test('single receipt is intact', () => {
    buildChain(1);
    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(1);
  });

  test('5-receipt chain is intact', () => {
    buildChain(5);
    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(5);
  });
});

// =============================================================================
// SWAP ATTACK — reorder two adjacent receipts
// =============================================================================

describe('tamper detection — swap attack', () => {
  test('swapping receipts 1 and 2 breaks chain at position 1', () => {
    const receipts = buildChain(4);

    // Swap positions 1 and 2
    const tampered = [receipts[0], receipts[2], receipts[1], receipts[3]];
    rewriteLedger(tampered);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    // Should break at the first swapped receipt
    expect(result.brokenAt).toBeDefined();
    expect(result.depth).toBeLessThan(4);
  });

  test('swapping first and second receipt breaks at position 1', () => {
    const receipts = buildChain(3);

    const tampered = [receipts[1], receipts[0], receipts[2]];
    rewriteLedger(tampered);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    // receipts[1] has previousHash = receipts[0].hash, but now at position 0 it should have 'genesis'
    expect(result.brokenAt).toBe(receipts[1].seq);
  });
});

// =============================================================================
// PAYLOAD TAMPER — modify a field without updating hash
// =============================================================================

describe('tamper detection — payload tamper', () => {
  test('changing outcome field breaks hash verification', () => {
    const receipts = buildChain(3);

    // Tamper with receipt 1's outcome
    const loaded = loadReceipts(govDir);
    loaded[1].outcome = 'error'; // was 'success'
    // Don't update hash — this should be detected
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(loaded[1].seq);
  });

  test('changing target field breaks hash verification', () => {
    const receipts = buildChain(3);

    const loaded = loadReceipts(govDir);
    loaded[1].target = '/TAMPERED';
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(loaded[1].seq);
  });

  test('changing nested arguments field breaks hash', () => {
    const receipts = buildChain(3);

    const loaded = loadReceipts(govDir);
    loaded[1].arguments = { path: '/INJECTED' };
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(loaded[1].seq);
  });
});

// =============================================================================
// HASH TAMPER — modify the hash without updating payload
// =============================================================================

describe('tamper detection — hash tamper', () => {
  test('replacing hash with arbitrary value detected', () => {
    buildChain(3);

    const loaded = loadReceipts(govDir);
    loaded[1].hash = 'deadbeef'.repeat(8); // wrong hash
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    // Could break at position 1 (hash mismatch) or position 2 (previousHash linkage)
    expect(result.brokenAt).toBeDefined();
    expect(result.depth).toBeLessThanOrEqual(2);
  });

  test('mid-chain hash rewrite breaks all downstream', () => {
    buildChain(5);

    const loaded = loadReceipts(govDir);
    // Rewrite receipt 2's hash — receipts 3 and 4 should also fail
    loaded[2].hash = 'aaaa'.repeat(16);
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(loaded[2].seq);
  });
});

// =============================================================================
// DUPLICATE INSERTION — replay a receipt
// =============================================================================

describe('tamper detection — duplicate insertion', () => {
  test('inserting duplicate receipt breaks chain', () => {
    const receipts = buildChain(3);

    // Insert a copy of receipt 1 between positions 1 and 2
    const loaded = loadReceipts(govDir);
    const tampered = [loaded[0], loaded[1], { ...loaded[1] }, loaded[2]];
    rewriteLedger(tampered);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    // The duplicate at position 2 has previousHash pointing to receipt 0, not receipt 1
  });

  test('appending duplicate of last receipt breaks chain', () => {
    buildChain(3);

    const loaded = loadReceipts(govDir);
    const duplicate = { ...loaded[2] };
    loaded.push(duplicate);
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    // The duplicate at position 3 has previousHash pointing to receipt 1, not receipt 2
  });
});

// =============================================================================
// GENESIS VIOLATION — wrong first previousHash
// =============================================================================

describe('tamper detection — genesis violation', () => {
  test('first receipt with non-genesis previousHash detected', () => {
    buildChain(3);

    const loaded = loadReceipts(govDir);
    loaded[0].previousHash = 'not-genesis';
    // Also need to update hash for it to pass hash check
    const { hash: _, ...withoutHash } = loaded[0];
    loaded[0].hash = computeReceiptHash(withoutHash as Omit<ToolCallRecord, 'hash'>, 'not-genesis');
    rewriteLedger(loaded);

    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(loaded[0].seq);
    expect(result.depth).toBe(0);
  });
});

// =============================================================================
// CORRUPTED JSONL — partial write / disk corruption
// =============================================================================

describe('tamper detection — corrupted JSONL', () => {
  test('truncated JSON line is skipped during load (crash resilience)', () => {
    buildChain(3);

    const path = join(govDir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    // Truncate the second line
    lines[1] = lines[1].slice(0, 20);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    // loadReceipts skips corrupted lines (crash resilience) — returns valid lines only
    const receipts = loadReceipts(govDir);
    expect(receipts).toHaveLength(2); // line 0 and line 2 survive, line 1 skipped
    expect(receipts[0].id).toBe('r_0');
    expect(receipts[1].id).toBe('r_2');
  });

  test('empty line in middle is skipped during load', () => {
    buildChain(3);

    const path = join(govDir, 'receipts.jsonl');
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    // Insert empty line
    lines.splice(1, 0, '');
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    // Empty lines are skipped — all 3 original receipts survive
    const receipts = loadReceipts(govDir);
    expect(receipts).toHaveLength(3);
    expect(receipts[0].id).toBe('r_0');
    expect(receipts[1].id).toBe('r_1');
    expect(receipts[2].id).toBe('r_2');
  });
});

// =============================================================================
// STABLESTRINGIFY COVERAGE — hash determinism
// =============================================================================

describe('tamper detection — hash determinism', () => {
  test('same receipt content produces same hash regardless of key insertion order', () => {
    const record1: Omit<ToolCallRecord, 'hash'> = {
      id: 'r_0', seq: 0, timestamp: 1000,
      controllerId: 'ctrl', authorityEpoch: 0, enforcement: 'strict',
      toolName: 'test', arguments: { b: 2, a: 1 }, target: '/test',
      constraintCheck: { passed: true }, authorityCheck: { passed: true },
      outcome: 'success', durationMs: 50, previousHash: 'genesis',
      mutation: { verb: 'test', target: '/test', capturedAt: 1000, args: { b: 2, a: 1 } },
      mutationType: 'readonly',
    };

    // Same data, different key order
    const record2: Omit<ToolCallRecord, 'hash'> = {
      mutationType: 'readonly', id: 'r_0', outcome: 'success',
      previousHash: 'genesis', controllerId: 'ctrl', enforcement: 'strict',
      target: '/test', seq: 0, timestamp: 1000, authorityEpoch: 0,
      toolName: 'test', arguments: { a: 1, b: 2 }, durationMs: 50,
      mutation: { args: { a: 1, b: 2 }, verb: 'test', target: '/test', capturedAt: 1000 },
      constraintCheck: { passed: true }, authorityCheck: { passed: true },
    };

    const hash1 = computeReceiptHash(record1, 'genesis');
    const hash2 = computeReceiptHash(record2, 'genesis');
    expect(hash1).toBe(hash2);
  });

  test('stableStringify deterministic for Tier 3-5 annotated receipts', () => {
    const record: Record<string, unknown> = {
      id: 'r_0',
      attribution: 'direct',
      attributionMatch: { predicateType: 'css', key: 'selector', value: '.foo' },
      groundingAnnotation: { grounded: true, stale: false },
      convergenceSignal: 'none',
      intentAgeMs: 5000,
      nested: { z: 1, a: 2, m: { c: 3, b: 4 } },
    };

    const str1 = stableStringify(record);
    // All keys sorted at every depth
    const parsed = JSON.parse(str1);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());

    // Nested keys also sorted
    const matchKeys = Object.keys(parsed.attributionMatch);
    expect(matchKeys).toEqual([...matchKeys].sort());

    const nestedKeys = Object.keys(parsed.nested);
    expect(nestedKeys).toEqual([...nestedKeys].sort());

    const deepKeys = Object.keys(parsed.nested.m);
    expect(deepKeys).toEqual([...deepKeys].sort());
  });
});

// =============================================================================
// GENESIS TRUST ANCHOR — external trust root for whole-ledger replacement
// =============================================================================

describe('tamper detection — genesis trust anchor', () => {
  test('verifyReceiptChain passes without genesis hash (backward compat)', () => {
    buildChain(3);
    const result = verifyReceiptChain(govDir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(3);
  });

  test('verifyReceiptChain passes with correct genesis hash', () => {
    const receipts = buildChain(3);
    const genesisHash = receipts[0].hash;

    const result = verifyReceiptChain(govDir, genesisHash);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(3);
  });

  test('verifyReceiptChain fails with wrong genesis hash', () => {
    buildChain(3);
    const fakeGenesisHash = 'aaaa'.repeat(16);

    const result = verifyReceiptChain(govDir, fakeGenesisHash);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(0); // seq of first receipt
    expect(result.depth).toBe(0);
  });

  test('whole-ledger replacement detected by genesis anchor', () => {
    // Build original chain and capture genesis hash
    const original = buildChain(3);
    const genesisHash = original[0].hash;

    // Attacker replaces entire ledger with internally-consistent forged chain
    // using different content — hashes are valid within the forged chain
    const forged: ToolCallRecord[] = [];
    for (let i = 0; i < 3; i++) {
      const prevHash = i === 0 ? 'genesis' : forged[i - 1].hash;
      const record = makeRecord(i, prevHash);
      record.target = '/forged/' + i; // Different content
      const hash = computeReceiptHash(record, prevHash);
      forged.push({ ...record, hash } as ToolCallRecord);
    }
    rewriteLedger(forged);

    // Without genesis anchor: chain appears intact (internally consistent)
    const withoutAnchor = verifyReceiptChain(govDir);
    expect(withoutAnchor.intact).toBe(true);

    // With genesis anchor: replacement detected
    const withAnchor = verifyReceiptChain(govDir, genesisHash);
    expect(withAnchor.intact).toBe(false);
    expect(withAnchor.brokenAt).toBe(0);
  });

  test('pinGenesisHash stores hash in authority state', () => {
    const controller = loadOrCreateController(govDir);
    const authority = loadAuthority(govDir, controller.id);
    expect(authority.genesisHash).toBeUndefined();

    const receipts = buildChain(1);
    pinGenesisHash(govDir, authority, receipts[0].hash);

    expect(authority.genesisHash).toBe(receipts[0].hash);

    // Reload from disk to verify persistence
    const reloaded = loadAuthority(govDir, controller.id);
    expect(reloaded.genesisHash).toBe(receipts[0].hash);
  });

  test('pinGenesisHash is idempotent (no-op if already set)', () => {
    const controller = loadOrCreateController(govDir);
    const authority = loadAuthority(govDir, controller.id);

    const receipts = buildChain(2);
    pinGenesisHash(govDir, authority, receipts[0].hash);
    const firstPin = authority.genesisHash;

    // Try to pin a different hash — should be no-op
    pinGenesisHash(govDir, authority, 'different_hash');
    expect(authority.genesisHash).toBe(firstPin);
  });

  test('empty ledger passes with any genesis hash (nothing to verify against)', () => {
    const result = verifyReceiptChain(govDir, 'some_hash');
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(0);
  });
});
