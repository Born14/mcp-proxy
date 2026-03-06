/**
 * G4: Time Travel
 * ===============
 *
 * Complete rollback (code + data) is always possible.
 *
 * Born from: Database migration broke schema, code rolled back but DB
 * was not. App had old code with new schema.
 *
 * Pure functions. Zero side effects. Only external import: node:crypto.
 *
 * The kernel owns:
 *   - Hash computation (deterministic SHA-256)
 *   - Chain integrity verification (pure math: walk chain, verify hashes)
 *
 * The adapter owns:
 *   - State capture (what files/schema/resources to snapshot)
 *   - State restore (how to apply a checkpoint to the real system)
 *
 * Extracted from: src/lib/services/forensic-checkpoint.ts
 */

import { createHash } from 'crypto';
import type { CheckpointManifest } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of verifying a checkpoint chain.
 */
export interface ChainVerificationResult {
  /** Is the entire chain intact? */
  intact: boolean;

  /** Checkpoint ID where the chain broke (if any) */
  brokenAt?: string;

  /** Human-readable reason for failure */
  reason?: string;

  /** How many checkpoints were verified */
  depth: number;

  /** Per-checkpoint verification details */
  details: Array<{
    checkpointId: string;
    recomputedHash: string;
    chainIntact: boolean;
  }>;
}

// =============================================================================
// PURE FUNCTIONS
// =============================================================================

/**
 * Compute SHA-256 hash of a string.
 *
 * Extracted from: sha256() in forensic-checkpoint.ts:117
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute the deterministic hash of a checkpoint manifest.
 *
 * Canonical serialization: keys sorted, undefined values removed.
 * The same manifest always produces the same hash.
 *
 * Extracted from: computeManifestHash() in forensic-checkpoint.ts:132
 */
export function computeManifestHash(manifest: CheckpointManifest): string {
  const clean = Object.fromEntries(
    Object.entries(manifest)
      .filter(([_, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const canonical = JSON.stringify(clean);
  return sha256(canonical);
}

/**
 * Verify the integrity of a checkpoint chain.
 *
 * Pure function: takes an array of manifests, walks the chain by
 * matching parentHash to computed hashes, verifies integrity.
 *
 * The existing implementation in forensic-checkpoint.ts is coupled to
 * file I/O (loadManifest, readFileSync). This kernel version takes
 * pre-loaded manifests — the adapter handles I/O.
 *
 * NEW: Pure version of verifyChainIntegrity() from forensic-checkpoint.ts:399
 */
export function verifyChain(
  manifests: CheckpointManifest[],
  startCheckpointId?: string,
): ChainVerificationResult {
  if (manifests.length === 0) {
    return { intact: true, depth: 0, details: [] };
  }

  // Pre-pass: detect duplicate checkpointIds — possible manifest injection
  const seenIds = new Set<string>();
  for (const m of manifests) {
    if (seenIds.has(m.checkpointId)) {
      return {
        intact: false,
        brokenAt: m.checkpointId,
        reason: `Duplicate checkpointId "${m.checkpointId}" — possible manifest injection`,
        depth: 0,
        details: [],
      };
    }
    seenIds.add(m.checkpointId);
  }

  // Build lookup: checkpointId → manifest
  const byId = new Map<string, CheckpointManifest>();
  // Build lookup: computedHash → manifest (for resolving parentHash links)
  const byComputedHash = new Map<string, CheckpointManifest>();

  for (const m of manifests) {
    byId.set(m.checkpointId, m);
    byComputedHash.set(computeManifestHash(m), m);
  }

  // Start from specified checkpoint or the most recent (last in array)
  const startId = startCheckpointId || manifests[manifests.length - 1].checkpointId;
  const start = byId.get(startId);

  if (!start) {
    return {
      intact: false,
      brokenAt: startId,
      reason: `Starting checkpoint ${startId} not found in provided manifests`,
      depth: 0,
      details: [],
    };
  }

  // Walk backward from start toward genesis, verifying each link.
  // At each step: current.parentHash must be either 'genesis' or
  // must match the computeManifestHash() of some manifest in the set.
  const details: ChainVerificationResult['details'] = [];
  let current: CheckpointManifest | undefined = start;

  while (current) {
    const recomputedHash = computeManifestHash(current);

    details.push({
      checkpointId: current.checkpointId,
      recomputedHash,
      chainIntact: true, // Updated below if chain breaks
    });

    // Reached the root
    if (current.parentHash === 'genesis') {
      break;
    }

    // Find the parent by matching parentHash to a computed hash
    const parent = byComputedHash.get(current.parentHash);
    if (!parent) {
      // parentHash doesn't match any manifest's computed hash — chain broken HERE
      details[details.length - 1].chainIntact = false;
      return {
        intact: false,
        brokenAt: current.checkpointId,
        reason: `Parent hash ${current.parentHash.substring(0, 16)}... not found — chain broken at ${current.checkpointId}`,
        depth: details.length,
        details,
      };
    }

    current = parent;
  }

  return {
    intact: true,
    depth: details.length,
    details,
  };
}
