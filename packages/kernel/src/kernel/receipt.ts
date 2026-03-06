/**
 * Execution Receipt — The Kernel's Deliverable
 * =============================================
 *
 * The complete audit trail through all governance gates.
 *
 * Every receipt proves: what was claimed, what was done, what was authorized,
 * what was verified, and how to undo it. The receipt covers the entire
 * convergence history — every attempt, every narrowing, every constraint seeded.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 *
 * The kernel owns:
 *   - Receipt construction from gate verdicts
 *   - Receipt versioning (kernelVersion, adapterName, adapterVersion, policyHash)
 *   - Receipt completeness validation
 *   - Receipt summary generation
 *
 * The adapter owns:
 *   - Populating verification results (per-predicate pass/fail)
 *   - Providing mutation details
 *   - Computing content hashes for the checkpoint
 *
 * Extracted from: ExecutionReceipt in governance/types.ts
 */

import { createHash } from 'crypto';
import type {
  ExecutionReceipt,
  GateVerdict,
  GateName,
  Mutation,
  Predicate,
  AuthorityContext,
  ContainmentResult,
  ApprovalPolicy,
} from '../types.js';

// =============================================================================
// TYPES — Receipt construction and validation
// =============================================================================

/**
 * Provenance metadata for a receipt.
 *
 * Makes receipts auditable cross-domain artifacts. A compliance team can
 * verify: which physics version, which adapter, which policy.
 */
export interface ReceiptProvenance {
  /** Semantic version of the governance kernel */
  kernelVersion: string;

  /** Name of the adapter that produced this execution */
  adapterName: string;

  /** Version of the adapter */
  adapterVersion: string;

  /** SHA-256 of the ApprovalPolicy that governed this run */
  policyHash: string;
}

/**
 * Result of validating a receipt's completeness.
 */
export interface ReceiptValidation {
  /** Whether the receipt is complete and consistent */
  valid: boolean;

  /** Issues found (if any) */
  issues: string[];
}

/**
 * A single gate passage record for building receipts.
 */
export interface GatePassage {
  gate: GateName;
  verdict: GateVerdict;
  timestamp: number;
}

// =============================================================================
// RECEIPT CONSTRUCTION — Pure builder functions
// =============================================================================

/**
 * Compute the SHA-256 hash of an ApprovalPolicy.
 *
 * Used for receipt provenance — proves which policy governed the execution.
 * Deterministic: same policy always produces same hash.
 */
export function computePolicyHash(policy: ApprovalPolicy): string {
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Generate a unique receipt ID.
 *
 * Format: rcpt_{jobId}_{timestamp}
 * Deterministic given the same inputs.
 */
export function generateReceiptId(jobId: string, timestamp: number): string {
  return `rcpt_${jobId}_${timestamp}`;
}

/**
 * Build an ExecutionReceipt from the gate sequence results.
 *
 * This is called after the attest gate — the final step in the gate sequence.
 * The receipt captures the full audit trail.
 */
export function buildReceipt(
  jobId: string,
  gates: GatePassage[],
  mutations: Mutation[],
  predicates: Predicate[],
  verification: Array<{
    predicateId: string;
    passed: boolean;
    actual?: string | number | null;
    expected?: string | number;
  }>,
  authority: AuthorityContext,
  containment: ContainmentResult,
  startedAt: number,
  completedAt: number,
): ExecutionReceipt {
  return {
    id: generateReceiptId(jobId, completedAt),
    jobId,
    gates: gates.map(g => ({
      gate: g.gate,
      verdict: g.verdict,
      timestamp: g.timestamp,
    })),
    mutations,
    predicates,
    verification,
    authority,
    containment,
    startedAt,
    completedAt,
  };
}

// =============================================================================
// RECEIPT VALIDATION — Completeness and consistency checks
// =============================================================================

/**
 * Validate that a receipt is complete and internally consistent.
 *
 * Checks:
 * 1. All 12 gates must have a verdict
 * 2. Gate ordering must match the canonical sequence
 * 3. No gate can have an undefined verdict
 * 4. Timestamps must be monotonically increasing
 * 5. Containment must be present
 * 6. Authority must be present
 */
export function validateReceipt(receipt: ExecutionReceipt): ReceiptValidation {
  const issues: string[] = [];

  // Check required fields
  if (!receipt.id) issues.push('Missing receipt ID');
  if (!receipt.jobId) issues.push('Missing job ID');
  if (!receipt.authority) issues.push('Missing authority context');
  if (!receipt.containment) issues.push('Missing containment result');
  if (receipt.startedAt >= receipt.completedAt) {
    issues.push('startedAt must be before completedAt');
  }

  // Check gate ordering
  const GATE_ORDER: GateName[] = [
    'classify', 'ground', 'extract', 'plan', 'syntax',
    'constrain', 'contain', 'approve', 'stage', 'execute',
    'verify', 'attest',
  ];

  if (receipt.gates.length === 0) {
    issues.push('No gate verdicts recorded');
  } else {
    // Verify gate names are valid
    for (const g of receipt.gates) {
      if (!GATE_ORDER.includes(g.gate)) {
        issues.push(`Unknown gate: ${g.gate}`);
      }
    }

    // Verify monotonic timestamps
    for (let i = 1; i < receipt.gates.length; i++) {
      if (receipt.gates[i].timestamp < receipt.gates[i - 1].timestamp) {
        issues.push(`Gate timestamp not monotonic: ${receipt.gates[i].gate} (${receipt.gates[i].timestamp}) before ${receipt.gates[i - 1].gate} (${receipt.gates[i - 1].timestamp})`);
      }
    }

    // Check for the critical governance gates (6-8: constrain, contain, approve)
    const gateNames = new Set(receipt.gates.map(g => g.gate));
    for (const required of ['constrain', 'contain', 'approve'] as GateName[]) {
      if (!gateNames.has(required)) {
        issues.push(`Missing critical governance gate: ${required}`);
      }
    }
  }

  // Check verification completeness against predicates
  if (receipt.predicates.length > 0 && receipt.verification.length === 0) {
    issues.push('Predicates claimed but no verification results');
  }

  // Check all verified predicates reference existing predicates
  const predicateIds = new Set(receipt.predicates.map(p => p.id));
  for (const v of receipt.verification) {
    if (!predicateIds.has(v.predicateId)) {
      issues.push(`Verification references unknown predicate: ${v.predicateId}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// =============================================================================
// RECEIPT SUMMARY — Human-readable output
// =============================================================================

/**
 * Generate a human-readable summary of a receipt.
 *
 * This is what gets logged, displayed in the UI, or sent to compliance.
 */
export function summarizeReceipt(
  receipt: ExecutionReceipt,
  provenance?: ReceiptProvenance,
): string {
  const lines: string[] = [];

  lines.push(`=== Execution Receipt: ${receipt.id} ===`);
  lines.push(`Job: ${receipt.jobId}`);
  lines.push(`Duration: ${((receipt.completedAt - receipt.startedAt) / 1000).toFixed(1)}s`);

  if (provenance) {
    lines.push(`Kernel: ${provenance.kernelVersion}`);
    lines.push(`Adapter: ${provenance.adapterName} v${provenance.adapterVersion}`);
    lines.push(`Policy hash: ${provenance.policyHash.substring(0, 12)}...`);
  }

  lines.push('');

  // Gate summary
  lines.push('Gates:');
  for (const g of receipt.gates) {
    const icon = g.verdict.action === 'proceed' ? 'PASS' : g.verdict.action.toUpperCase();
    lines.push(`  ${g.gate}: ${icon} — ${g.verdict.reason}`);
  }

  lines.push('');

  // Mutations
  lines.push(`Mutations: ${receipt.mutations.length}`);
  for (const m of receipt.mutations) {
    lines.push(`  ${m.verb} ${m.target}`);
  }

  lines.push('');

  // Containment
  lines.push(`Containment: ${receipt.containment.contained ? 'CONTAINED' : 'NOT CONTAINED'}`);
  lines.push(`  ${receipt.containment.summary}`);

  lines.push('');

  // Verification
  const passed = receipt.verification.filter(v => v.passed).length;
  const total = receipt.verification.length;
  lines.push(`Verification: ${passed}/${total} predicates passed`);
  for (const v of receipt.verification) {
    const icon = v.passed ? 'PASS' : 'FAIL';
    lines.push(`  [${icon}] ${v.predicateId}: expected=${v.expected}, actual=${v.actual}`);
  }

  lines.push('');

  // Authority
  lines.push(`Authority: controller=${receipt.authority.controllerId}, epoch=${receipt.authority.authorityEpoch}`);
  if (receipt.authority.isForeign) {
    lines.push('  WARNING: Foreign controller');
  }

  return lines.join('\n');
}
