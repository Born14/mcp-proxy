/**
 * Kernel G4: Time Travel Proof
 * ============================
 *
 * Complete rollback is always possible.
 * Hash chain integrity — pure math, zero I/O.
 *
 * Run with: bun test tests/constitutional/kernel/g4-time-travel.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  sha256,
  computeManifestHash,
  verifyChain,
} from '../../src/kernel/time-travel.js';
import type { CheckpointManifest } from '../../src/types.js';

// =============================================================================
// 1. SHA-256 — Deterministic hashing
// =============================================================================

describe('G4 Time Travel: SHA-256', () => {
  test('same input = same hash', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  test('different input = different hash', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  test('hash is 64-character hex string', () => {
    const hash = sha256('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('empty string produces valid hash', () => {
    const hash = sha256('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// =============================================================================
// 2. MANIFEST HASH — Canonical serialization
// =============================================================================

describe('G4 Time Travel: Manifest Hash', () => {
  const baseManifest: CheckpointManifest = {
    checkpointId: 'cp-1',
    appName: 'test-app',
    jobId: 'job-1',
    timestamp: 1707011400000,
    rootHash: 'genesis',
    parentHash: 'genesis',
    changeType: 'logic',
    files: [
      { path: 'server.js', hash: 'sha256:abc', action: 'modified' },
    ],
    contentHashes: { 'server.js': 'sha256:abc' },
  };

  test('same manifest = same hash', () => {
    expect(computeManifestHash(baseManifest)).toBe(computeManifestHash(baseManifest));
  });

  test('different content = different hash', () => {
    const altered = { ...baseManifest, jobId: 'job-2' };
    expect(computeManifestHash(baseManifest)).not.toBe(computeManifestHash(altered));
  });

  test('key order does not affect hash (canonical sort)', () => {
    // Object.entries returns in insertion order, but we sort
    const manifest1 = { checkpointId: 'cp-1', appName: 'test', rootHash: 'x', parentHash: 'y', timestamp: 1, files: [], contentHashes: {}, changeType: 'logic' as const, jobId: 'j' };
    const manifest2 = { appName: 'test', timestamp: 1, checkpointId: 'cp-1', files: [], rootHash: 'x', parentHash: 'y', contentHashes: {}, jobId: 'j', changeType: 'logic' as const };

    expect(computeManifestHash(manifest1 as any)).toBe(computeManifestHash(manifest2 as any));
  });

  test('undefined values are stripped before hashing', () => {
    const withUndefined = { ...baseManifest, snapshotVersion: undefined };
    const withoutField = { ...baseManifest };
    // @ts-ignore — testing undefined handling
    delete withoutField.snapshotVersion;

    expect(computeManifestHash(withUndefined as any)).toBe(computeManifestHash(withoutField));
  });
});

// =============================================================================
// 3. CHAIN VERIFICATION — Pure chain walk
// =============================================================================

describe('G4 Time Travel: Chain Verification', () => {
  test('empty chain = intact', () => {
    const result = verifyChain([]);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(0);
  });

  test('single checkpoint (genesis) = intact', () => {
    const manifest: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: 'ignored', // Will be recomputed
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };

    const result = verifyChain([manifest]);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].checkpointId).toBe('cp-1');
  });

  test('valid chain of 3 checkpoints', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp1.rootHash = computeManifestHash(cp1);

    const cp2: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-2',
      timestamp: 2000,
      rootHash: '',
      parentHash: computeManifestHash(cp1),
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp2.rootHash = computeManifestHash(cp2);

    const cp3: CheckpointManifest = {
      checkpointId: 'cp-3',
      appName: 'test',
      jobId: 'j-3',
      timestamp: 3000,
      rootHash: '',
      parentHash: computeManifestHash(cp2),
      changeType: 'config',
      files: [],
      contentHashes: {},
    };
    cp3.rootHash = computeManifestHash(cp3);

    const result = verifyChain([cp1, cp2, cp3]);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(3);
  });

  test('broken chain detected (tampered parent hash)', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp1.rootHash = computeManifestHash(cp1);

    const cp2: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-2',
      timestamp: 2000,
      rootHash: '',
      parentHash: 'TAMPERED_HASH_DOES_NOT_MATCH',
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp2.rootHash = computeManifestHash(cp2);

    const result = verifyChain([cp1, cp2]);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('cp-2');
    expect(result.reason).toContain('not found');
  });

  test('5-checkpoint chain breaks at exactly cp-3 (mid-chain tamper)', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp1.rootHash = computeManifestHash(cp1);

    const cp2: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-2',
      timestamp: 2000,
      rootHash: '',
      parentHash: computeManifestHash(cp1),
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp2.rootHash = computeManifestHash(cp2);

    // cp-3 has TAMPERED parentHash — does NOT point to cp-2's computed hash
    const cp3: CheckpointManifest = {
      checkpointId: 'cp-3',
      appName: 'test',
      jobId: 'j-3',
      timestamp: 3000,
      rootHash: '',
      parentHash: 'INJECTED_BY_ATTACKER',
      changeType: 'config',
      files: [],
      contentHashes: {},
    };
    cp3.rootHash = computeManifestHash(cp3);

    const cp4: CheckpointManifest = {
      checkpointId: 'cp-4',
      appName: 'test',
      jobId: 'j-4',
      timestamp: 4000,
      rootHash: '',
      parentHash: computeManifestHash(cp3),
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp4.rootHash = computeManifestHash(cp4);

    const cp5: CheckpointManifest = {
      checkpointId: 'cp-5',
      appName: 'test',
      jobId: 'j-5',
      timestamp: 5000,
      rootHash: '',
      parentHash: computeManifestHash(cp4),
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp5.rootHash = computeManifestHash(cp5);

    // Walk backward from cp-5: cp-5 → cp-4 → cp-3 (BREAK)
    // cp-3's parentHash is "INJECTED_BY_ATTACKER", not computeManifestHash(cp-2)
    const result = verifyChain([cp1, cp2, cp3, cp4, cp5]);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('cp-3');
    expect(result.reason).toContain('INJECTED_BY_ATTA');
    // Should have verified cp-5, cp-4, cp-3 before breaking
    expect(result.depth).toBe(3);
    // The broken node should be marked
    const brokenDetail = result.details.find(d => d.checkpointId === 'cp-3');
    expect(brokenDetail).toBeDefined();
    expect(brokenDetail!.chainIntact).toBe(false);
  });

  test('duplicate checkpointId detected — manifest injection blocked', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: { 'server.js': 'sha256:aaa' },
    };
    cp1.rootHash = computeManifestHash(cp1);

    // Impostor: same checkpointId but different content
    const impostor: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: { 'server.js': 'sha256:EVIL' },
    };
    impostor.rootHash = computeManifestHash(impostor);

    // The two manifests have different computed hashes but same checkpointId
    expect(computeManifestHash(cp1)).not.toBe(computeManifestHash(impostor));

    const result = verifyChain([cp1, impostor]);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('cp-1');
    expect(result.reason).toContain('Duplicate checkpointId');
    expect(result.reason).toContain('manifest injection');
    expect(result.depth).toBe(0);
  });

  test('duplicate checkpointId in mid-chain position detected', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp1.rootHash = computeManifestHash(cp1);

    const cp2: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-2',
      timestamp: 2000,
      rootHash: '',
      parentHash: computeManifestHash(cp1),
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp2.rootHash = computeManifestHash(cp2);

    // Impostor shadows cp-2 with different content
    const impostor: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-EVIL',
      timestamp: 2000,
      rootHash: '',
      parentHash: computeManifestHash(cp1),
      changeType: 'schema',
      files: [],
      contentHashes: { 'drop_tables.sql': 'sha256:EVIL' },
    };
    impostor.rootHash = computeManifestHash(impostor);

    const result = verifyChain([cp1, cp2, impostor]);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('cp-2');
    expect(result.reason).toContain('Duplicate checkpointId');
  });

  test('missing start checkpoint', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };

    const result = verifyChain([cp1], 'cp-nonexistent');
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('cp-nonexistent');
    expect(result.reason).toContain('not found');
  });

  test('start from specific checkpoint in chain', () => {
    const cp1: CheckpointManifest = {
      checkpointId: 'cp-1',
      appName: 'test',
      jobId: 'j-1',
      timestamp: 1000,
      rootHash: '',
      parentHash: 'genesis',
      changeType: 'logic',
      files: [],
      contentHashes: {},
    };
    cp1.rootHash = computeManifestHash(cp1);

    const cp2: CheckpointManifest = {
      checkpointId: 'cp-2',
      appName: 'test',
      jobId: 'j-2',
      timestamp: 2000,
      rootHash: '',
      parentHash: computeManifestHash(cp1),
      changeType: 'ui',
      files: [],
      contentHashes: {},
    };
    cp2.rootHash = computeManifestHash(cp2);

    // Start from cp-1 — should only verify 1 checkpoint
    const result = verifyChain([cp1, cp2], 'cp-1');
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(1);
  });
});
