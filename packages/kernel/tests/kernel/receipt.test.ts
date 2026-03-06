/**
 * Kernel Receipt Proof
 * ====================
 *
 * Execution receipt construction, validation, and summarization.
 *
 * Run with: bun test tests/constitutional/kernel/receipt.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  computePolicyHash,
  generateReceiptId,
  buildReceipt,
  validateReceipt,
  summarizeReceipt,
} from '../../src/kernel/receipt.js';
import type { GatePassage, ReceiptProvenance } from '../../src/kernel/receipt.js';
import type {
  ApprovalPolicy,
  ExecutionReceipt,
  GateName,
  GateVerdict,
  Mutation,
  Predicate,
  AuthorityContext,
  ContainmentResult,
} from '../../src/types.js';

// =============================================================================
// FIXTURES
// =============================================================================

const GATES: GateName[] = [
  'classify', 'ground', 'extract', 'plan', 'syntax',
  'constrain', 'contain', 'approve', 'stage', 'execute',
  'verify', 'attest',
];

function makeGatePassages(start?: number): GatePassage[] {
  const now = start ?? Date.now();
  return GATES.map((gate, i) => ({
    gate,
    verdict: { action: 'proceed' as const, gate, reason: `${gate} passed` },
    timestamp: now + i * 100,
  }));
}

function makeAuthority(): AuthorityContext {
  return { controllerId: 'ctrl-A', authorityEpoch: 1, planEpoch: 1, isForeign: false };
}

function makeContainment(): ContainmentResult {
  return {
    contained: true,
    attributions: [],
    identityMismatches: [],
    directCount: 1,
    scaffoldingCount: 0,
    unexplainedCount: 0,
    summary: '1 traced',
  };
}

function makePolicy(): ApprovalPolicy {
  return {
    trustLevels: { ui: 'auto', logic: 'gate' },
    containmentMode: 'advisory',
    requireContainmentForAutoApprove: false,
  };
}

// =============================================================================
// 1. POLICY HASH — Deterministic SHA-256
// =============================================================================

describe('Receipt: Policy Hash', () => {
  test('same policy = same hash', () => {
    const policy = makePolicy();
    expect(computePolicyHash(policy)).toBe(computePolicyHash(policy));
  });

  test('different policy = different hash', () => {
    const p1 = makePolicy();
    const p2: ApprovalPolicy = { ...makePolicy(), containmentMode: 'hard_gate' };
    expect(computePolicyHash(p1)).not.toBe(computePolicyHash(p2));
  });

  test('hash is 64-char hex', () => {
    expect(computePolicyHash(makePolicy())).toMatch(/^[a-f0-9]{64}$/);
  });
});

// =============================================================================
// 2. RECEIPT ID — Deterministic generation
// =============================================================================

describe('Receipt: ID Generation', () => {
  test('starts with rcpt_', () => {
    expect(generateReceiptId('job-1', Date.now())).toMatch(/^rcpt_/);
  });

  test('deterministic: same inputs = same id', () => {
    const ts = 1700000000000;
    expect(generateReceiptId('j1', ts)).toBe(generateReceiptId('j1', ts));
  });

  test('different inputs = different id', () => {
    const ts = Date.now();
    expect(generateReceiptId('j1', ts)).not.toBe(generateReceiptId('j2', ts));
  });

  test('contains jobId and timestamp', () => {
    const id = generateReceiptId('job-42', 1700000000000);
    expect(id).toContain('job-42');
    expect(id).toContain('1700000000000');
  });
});

// =============================================================================
// 3. RECEIPT BUILDING
// =============================================================================

describe('Receipt: Building', () => {
  test('builds complete receipt', () => {
    const now = Date.now();
    const passages = makeGatePassages(now);
    const mutations: Mutation[] = [
      { verb: 'set_value', target: 'x', capturedAt: now, args: { key: 'x', value: '42' } },
    ];
    const predicates: Predicate[] = [
      { id: 'p0', type: 'kv', description: 'x == 42', fields: { key: 'x' }, operator: '==', value: '42' },
    ];
    const verification = [{ predicateId: 'p0', passed: true, actual: '42', expected: '42' }];
    const authority = makeAuthority();
    const containment = makeContainment();

    const receipt = buildReceipt(
      'job-1', passages, mutations, predicates, verification,
      authority, containment, now, now + 5000,
    );

    expect(receipt.id).toMatch(/^rcpt_/);
    expect(receipt.id).toContain('job-1');
    expect(receipt.jobId).toBe('job-1');
    expect(receipt.gates).toHaveLength(12);
    expect(receipt.mutations).toHaveLength(1);
    expect(receipt.predicates).toHaveLength(1);
    expect(receipt.verification).toHaveLength(1);
    expect(receipt.authority.controllerId).toBe('ctrl-A');
    expect(receipt.containment.contained).toBe(true);
    expect(receipt.startedAt).toBe(now);
    expect(receipt.completedAt).toBe(now + 5000);
  });

  test('receipt gates preserve verdict structure', () => {
    const now = Date.now();
    const passages = makeGatePassages(now);

    const receipt = buildReceipt(
      'j', passages, [], [], [],
      makeAuthority(), makeContainment(), now, now + 1000,
    );

    expect(receipt.gates[0].gate).toBe('classify');
    expect(receipt.gates[0].verdict.action).toBe('proceed');
    expect(receipt.gates[0].verdict.reason).toContain('classify');
  });

  test('partial gate sequence (early block)', () => {
    const now = Date.now();
    const passages: GatePassage[] = [
      { gate: 'classify', verdict: { action: 'proceed', gate: 'classify', reason: 'ok' }, timestamp: now },
      { gate: 'ground', verdict: { action: 'block', gate: 'ground', reason: 'blocked' }, timestamp: now + 100 },
    ];

    const receipt = buildReceipt(
      'j', passages, [], [], [],
      makeAuthority(), makeContainment(), now, now + 200,
    );

    expect(receipt.gates).toHaveLength(2);
    expect(receipt.gates[1].verdict.action).toBe('block');
  });
});

// =============================================================================
// 4. RECEIPT VALIDATION
// =============================================================================

describe('Receipt: Validation', () => {
  function makeValidReceipt(): ExecutionReceipt {
    const now = Date.now();
    return {
      id: 'rcpt_job-1_' + now,
      jobId: 'job-1',
      gates: GATES.map((gate, i) => ({
        gate,
        verdict: { action: 'proceed' as const, gate, reason: 'ok' },
        timestamp: now + i * 100,
      })),
      mutations: [{ verb: 'set_value', target: 'x', capturedAt: now, args: { key: 'x', value: '1' } }],
      predicates: [{ id: 'p0', type: 'kv', description: 'x == 1', fields: { key: 'x' }, operator: '==', value: '1' }],
      verification: [{ predicateId: 'p0', passed: true, actual: '1', expected: '1' }],
      authority: makeAuthority(),
      containment: makeContainment(),
      startedAt: now,
      completedAt: now + 2000,
    };
  }

  test('valid receipt passes', () => {
    const result = validateReceipt(makeValidReceipt());
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('missing receipt id fails', () => {
    const receipt = makeValidReceipt();
    receipt.id = '';
    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.includes('ID') || e.includes('id'))).toBe(true);
  });

  test('missing jobId fails', () => {
    const receipt = makeValidReceipt();
    receipt.jobId = '';
    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.toLowerCase().includes('job'))).toBe(true);
  });

  test('non-monotonic timestamps fail', () => {
    const receipt = makeValidReceipt();
    // Make second gate timestamp before first
    receipt.gates[1].timestamp = receipt.gates[0].timestamp - 100;

    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.includes('monotonic') || e.includes('timestamp'))).toBe(true);
  });

  test('missing critical governance gate fails', () => {
    const receipt = makeValidReceipt();
    // Remove 'constrain' gate (gate 6 — critical governance gate)
    receipt.gates = receipt.gates.filter(g => g.gate !== 'constrain');

    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.includes('constrain'))).toBe(true);
  });

  test('verification referencing unknown predicate fails', () => {
    const receipt = makeValidReceipt();
    receipt.verification = [{ predicateId: 'p_nonexistent', passed: true }];

    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.includes('p_nonexistent'))).toBe(true);
  });

  test('startedAt >= completedAt fails', () => {
    const receipt = makeValidReceipt();
    receipt.startedAt = receipt.completedAt + 1;

    const result = validateReceipt(receipt);
    expect(result.valid).toBe(false);
    expect(result.issues.some(e => e.includes('startedAt') || e.includes('before'))).toBe(true);
  });
});

// =============================================================================
// 5. RECEIPT SUMMARY
// =============================================================================

describe('Receipt: Summary', () => {
  test('summarizes success receipt', () => {
    const now = Date.now();
    const receipt: ExecutionReceipt = {
      id: 'rcpt_j1_' + now,
      jobId: 'j-1',
      gates: [
        { gate: 'classify', verdict: { action: 'proceed', gate: 'classify', reason: 'ok' }, timestamp: now },
        { gate: 'verify', verdict: { action: 'proceed', gate: 'verify', reason: 'ok' }, timestamp: now + 1000 },
      ],
      mutations: [
        { verb: 'set_value', target: 'x', capturedAt: now, args: { key: 'x', value: '42' } },
        { verb: 'set_value', target: 'y', capturedAt: now, args: { key: 'y', value: '1' } },
        { verb: 'delete_key', target: 'z', capturedAt: now, args: { key: 'z' } },
      ],
      predicates: [
        { id: 'p0', type: 'kv', description: 'x == 42', fields: { key: 'x' }, operator: '==', value: '42' },
        { id: 'p1', type: 'kv', description: 'y == 1', fields: { key: 'y' }, operator: '==', value: '1' },
      ],
      verification: [
        { predicateId: 'p0', passed: true, actual: '42', expected: '42' },
        { predicateId: 'p1', passed: true, actual: '1', expected: '1' },
      ],
      authority: makeAuthority(),
      containment: makeContainment(),
      startedAt: now,
      completedAt: now + 2000,
    };

    const summary = summarizeReceipt(receipt);
    expect(summary).toContain('j-1');
    expect(summary).toContain('2/2');          // 2/2 predicates passed
    expect(summary).toContain('3');             // 3 mutations
    expect(summary).toContain('CONTAINED');
  });

  test('summarizes receipt with provenance', () => {
    const now = Date.now();
    const receipt: ExecutionReceipt = {
      id: 'rcpt_j2_' + now,
      jobId: 'j-2',
      gates: [
        { gate: 'classify', verdict: { action: 'proceed', gate: 'classify', reason: 'ok' }, timestamp: now },
      ],
      mutations: [],
      predicates: [],
      verification: [],
      authority: makeAuthority(),
      containment: makeContainment(),
      startedAt: now,
      completedAt: now + 1000,
    };

    const provenance: ReceiptProvenance = {
      kernelVersion: '0.1.0',
      adapterName: 'mock-kv-store',
      adapterVersion: '0.1.0',
      policyHash: 'abc123def456',
    };

    const summary = summarizeReceipt(receipt, provenance);
    expect(summary).toContain('0.1.0');
    expect(summary).toContain('mock-kv-store');
    expect(summary).toContain('abc123def456');
  });

  test('summarizes blocked gate', () => {
    const now = Date.now();
    const receipt: ExecutionReceipt = {
      id: 'rcpt_j3_' + now,
      jobId: 'j-3',
      gates: [
        { gate: 'classify', verdict: { action: 'proceed', gate: 'classify', reason: 'ok' }, timestamp: now },
        { gate: 'constrain', verdict: { action: 'block', gate: 'constrain', reason: 'constraint violated' }, timestamp: now + 500 },
      ],
      mutations: [],
      predicates: [],
      verification: [],
      authority: makeAuthority(),
      containment: makeContainment(),
      startedAt: now,
      completedAt: now + 600,
    };

    const summary = summarizeReceipt(receipt);
    expect(summary).toContain('constrain');
    expect(summary).toContain('BLOCK');
  });
});
