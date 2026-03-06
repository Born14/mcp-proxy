/**
 * Receipt Contract Tests
 * ======================
 *
 * Proves the receipt is a stable external artifact.
 * Tier 3-5 annotations follow strict presence/absence rules:
 *
 *   attribution:       always present on every receipt
 *   attributionMatch:  present iff attribution === 'direct'
 *   intentAgeMs:       present iff intent exists
 *   groundingAnnotation: always present (grounded:false when no intent)
 *   convergenceSignal: always present on every receipt
 *
 * These tests use the governance + state modules directly to build
 * receipts through the same path the live proxy uses, just without
 * the stdio transport layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStateDir,
  loadOrCreateController,
  loadAuthority,
  saveAuthority,
  loadConstraints,
  appendReceipt,
  getLastReceiptHash,
  verifyReceiptChain,
  computeIntentHash,
} from '../src/state.js';
import { toolCallToMutation, classifyMutationType } from '../src/fingerprint.js';
import {
  runGates,
  computeToolTarget,
  attributeToolCallHeuristic,
  annotateGrounding,
  checkConvergence,
  createConvergenceTracker,
} from '../src/governance.js';
import type {
  ProxyState,
  ToolCallRecord,
  IntentContext,
  ConvergenceTracker,
  ConstraintEntry,
  AuthorityState,
} from '../src/types.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-receipt-'));
  ensureStateDir(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Build a receipt exactly like proxy.ts does: governance gates → attribution →
 * grounding → convergence → intent age → appendReceipt.
 *
 * This mirrors the proxy's `handleToolsCall` flow without the stdio transport.
 */
function buildProxyReceipt(opts: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  intent?: IntentContext;
  convergence: ConvergenceTracker;
  constraints: ConstraintEntry[];
  authority: AuthorityState;
  controller: { id: string };
  seq: number;
  previousHash: string;
  outcome?: 'success' | 'error' | 'blocked';
  enforcement?: 'strict' | 'advisory';
}): ToolCallRecord {
  const enforcement = opts.enforcement ?? 'strict';
  const mutation = toolCallToMutation(opts.toolName, opts.toolArgs);
  const target = computeToolTarget(opts.toolName, opts.toolArgs);
  const convergenceSignal = checkConvergence(opts.convergence, opts.toolName, target);
  const gateResult = runGates(mutation, opts.constraints, opts.authority, enforcement, convergenceSignal);

  const attribution = attributeToolCallHeuristic(mutation, opts.intent);
  const groundingAnnotation = annotateGrounding(opts.intent);

  const record: Omit<ToolCallRecord, 'hash'> = {
    id: `r_${opts.seq}`,
    seq: opts.seq,
    timestamp: Date.now(),
    controllerId: opts.controller.id,
    authorityEpoch: opts.authority.epoch,
    enforcement,
    toolName: opts.toolName,
    arguments: opts.toolArgs,
    target: mutation.target,
    constraintCheck: gateResult.constraintCheck,
    authorityCheck: gateResult.authorityCheck,
    outcome: opts.outcome ?? (gateResult.forward ? 'success' : 'blocked'),
    durationMs: 10,
    previousHash: opts.previousHash,
    mutation: {
      verb: mutation.verb,
      target: mutation.target,
      capturedAt: mutation.capturedAt,
      args: mutation.args,
    },
    mutationType: classifyMutationType(opts.toolName, opts.toolArgs),
    // Tier 3-5 annotations (same logic as proxy.ts handleToolsCall)
    attribution: attribution.class,
    ...(attribution.match ? { attributionMatch: attribution.match } : {}),
    groundingAnnotation,
    convergenceSignal,
    ...(opts.intent ? { intentAgeMs: Date.now() - opts.intent.declaredAt } : {}),
    intentHash: computeIntentHash(opts.intent),
  };

  if (!gateResult.forward) {
    record.error = gateResult.blockReason;
  }

  return appendReceipt(stateDir, record);
}

// =============================================================================
// RECEIPT CONTRACT: TIER 3-5 FIELD PRESENCE RULES
// =============================================================================

describe('Receipt contract: Tier 3-5 field presence', () => {
  let controller: { id: string };
  let authority: AuthorityState;
  let convergence: ConvergenceTracker;

  beforeEach(() => {
    controller = loadOrCreateController(stateDir);
    authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);
    convergence = createConvergenceTracker();
  });

  // =========================================================================
  // Rule 1: attribution always present
  // =========================================================================

  test('attribution present on success receipt (no intent)', () => {
    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/a.js', content: 'hello' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('no_intent');
  });

  test('attribution present on success receipt (with intent, direct match)', () => {
    const intent: IntentContext = {
      goal: 'Update server',
      predicates: [{ type: 'content', fields: { path: '/tmp/server.js' } }],
      declaredAt: Date.now() - 1000,
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/server.js', content: 'updated' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('direct');
  });

  test('attribution present on blocked receipt', () => {
    // Seed a constraint to get a blocked receipt
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/blocked.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/blocked.js', content: 'retry' },
      convergence,
      constraints,
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.outcome).toBe('blocked');
    expect(receipt.attribution).toBeDefined();
    expect(['no_intent', 'direct', 'scaffolding', 'unexplained']).toContain(receipt.attribution);
  });

  test('attribution is scaffolding for infrastructure verbs', () => {
    const intent: IntentContext = {
      goal: 'Deploy app',
      predicates: [{ type: 'http', fields: { path: '/health' } }],
      declaredAt: Date.now(),
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'deploy_app',
      toolArgs: { name: 'myapp' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('scaffolding');
  });

  // =========================================================================
  // Rule 2: attributionMatch present iff attribution === 'direct'
  // =========================================================================

  test('attributionMatch present when attribution is direct', () => {
    const intent: IntentContext = {
      goal: 'Change color',
      predicates: [{ type: 'css', fields: { selector: '.roster-link', property: 'color' } }],
      declaredAt: Date.now(),
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/style.css', content: '.roster-link { color: red }' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('direct');
    expect(receipt.attributionMatch).toBeDefined();
    expect(receipt.attributionMatch!.predicateType).toBe('css');
    expect(receipt.attributionMatch!.key).toBeTruthy();
    expect(receipt.attributionMatch!.value).toBeTruthy();
  });

  test('attributionMatch absent when attribution is no_intent', () => {
    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/a.js', content: 'hello' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('no_intent');
    expect(receipt.attributionMatch).toBeUndefined();
  });

  test('attributionMatch absent when attribution is scaffolding', () => {
    const intent: IntentContext = {
      goal: 'Deploy',
      predicates: [{ type: 'http', fields: { path: '/health' } }],
      declaredAt: Date.now(),
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'restart_containers',
      toolArgs: {},
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('scaffolding');
    expect(receipt.attributionMatch).toBeUndefined();
  });

  test('attributionMatch absent when attribution is unexplained', () => {
    const intent: IntentContext = {
      goal: 'Change footer color',
      predicates: [{ type: 'css', fields: { selector: '.footer', property: 'background' } }],
      declaredAt: Date.now(),
      version: 1,
    };

    // Tool call that doesn't match any predicate and isn't infrastructure
    const receipt = buildProxyReceipt({
      toolName: 'query_database',
      toolArgs: { sql: 'SELECT * FROM users' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.attribution).toBe('unexplained');
    expect(receipt.attributionMatch).toBeUndefined();
  });

  // =========================================================================
  // Rule 3: intentAgeMs present iff intent exists
  // =========================================================================

  test('intentAgeMs present when intent exists', () => {
    const intent: IntentContext = {
      goal: 'Test',
      predicates: [],
      declaredAt: Date.now() - 5000, // 5 seconds ago
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.intentAgeMs).toBeDefined();
    expect(receipt.intentAgeMs).toBeGreaterThanOrEqual(5000);
    expect(receipt.intentAgeMs).toBeLessThan(10000); // Not more than 10s
  });

  test('intentAgeMs absent when no intent', () => {
    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.intentAgeMs).toBeUndefined();
  });

  // =========================================================================
  // Rule 4: groundingAnnotation always present
  // =========================================================================

  test('groundingAnnotation present with grounded=false when no intent', () => {
    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.groundingAnnotation).toBeDefined();
    expect(receipt.groundingAnnotation!.grounded).toBe(false);
    expect(receipt.groundingAnnotation!.stale).toBe(false);
  });

  test('groundingAnnotation grounded=false when intent has no grounding', () => {
    const intent: IntentContext = {
      goal: 'Test',
      predicates: [],
      declaredAt: Date.now(),
      version: 1,
      // No grounding field
    };

    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.groundingAnnotation).toBeDefined();
    expect(receipt.groundingAnnotation!.grounded).toBe(false);
  });

  test('groundingAnnotation grounded=true,stale=false when grounding is fresh', () => {
    const intent: IntentContext = {
      goal: 'Test',
      predicates: [],
      declaredAt: Date.now(),
      version: 1,
      grounding: {
        facts: { cssRules: ['body { color: black }'] },
        observedAt: Date.now() - 1000, // 1 second ago — fresh
      },
    };

    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.groundingAnnotation).toBeDefined();
    expect(receipt.groundingAnnotation!.grounded).toBe(true);
    expect(receipt.groundingAnnotation!.stale).toBe(false);
  });

  test('groundingAnnotation grounded=true,stale=true when grounding is old', () => {
    const intent: IntentContext = {
      goal: 'Test',
      predicates: [],
      declaredAt: Date.now(),
      version: 1,
      grounding: {
        facts: { cssRules: ['body { color: black }'] },
        observedAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago — stale (>5 min)
      },
    };

    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.groundingAnnotation).toBeDefined();
    expect(receipt.groundingAnnotation!.grounded).toBe(true);
    expect(receipt.groundingAnnotation!.stale).toBe(true);
  });

  // =========================================================================
  // Rule 5: convergenceSignal always present
  // =========================================================================

  test('convergenceSignal present on first call (none)', () => {
    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/a.js', content: 'x' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.convergenceSignal).toBe('none');
  });

  test('convergenceSignal present even on blocked receipt', () => {
    const constraints: ConstraintEntry[] = [{
      id: 'c_1',
      toolName: 'write_file',
      target: '/tmp/blocked.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'err',
      createdAt: Date.now(),
    }];

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/blocked.js' },
      convergence,
      constraints,
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.outcome).toBe('blocked');
    expect(receipt.convergenceSignal).toBeDefined();
    expect(['none', 'warning', 'exhausted', 'loop']).toContain(receipt.convergenceSignal);
  });
});

// =============================================================================
// RECEIPT CONTRACT: HASH CHAIN INTEGRITY WITH TIER 3-5 FIELDS
// =============================================================================

describe('Receipt contract: hash chain with Tier 3-5 annotations', () => {
  test('hash chain intact across receipts with different tier annotations', () => {
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);
    const convergence = createConvergenceTracker();

    // Receipt 1: no intent
    const r1 = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(r1.previousHash).toBe('genesis');
    expect(r1.hash).toBeTruthy();
    expect(r1.attribution).toBe('no_intent');
    expect(r1.intentAgeMs).toBeUndefined();

    // Receipt 2: with intent (direct match)
    const intent: IntentContext = {
      goal: 'Update server',
      predicates: [{ type: 'content', fields: { path: '/tmp/server.js' } }],
      declaredAt: Date.now(),
      version: 1,
      grounding: {
        facts: { routes: ['/'] },
        observedAt: Date.now(),
      },
    };

    const r2 = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/server.js', content: 'updated' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 1,
      previousHash: r1.hash,
    });

    expect(r2.previousHash).toBe(r1.hash);
    expect(r2.hash).toBeTruthy();
    expect(r2.hash).not.toBe(r1.hash);
    expect(r2.attribution).toBe('direct');
    expect(r2.attributionMatch).toBeDefined();
    expect(r2.intentAgeMs).toBeDefined();
    expect(r2.groundingAnnotation!.grounded).toBe(true);
    expect(r2.convergenceSignal).toBe('none');

    // Receipt 3: infrastructure verb (scaffolding)
    const r3 = buildProxyReceipt({
      toolName: 'deploy_app',
      toolArgs: { name: 'myapp' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 2,
      previousHash: r2.hash,
    });

    expect(r3.previousHash).toBe(r2.hash);
    expect(r3.attribution).toBe('scaffolding');
    expect(r3.attributionMatch).toBeUndefined();
    expect(r3.intentAgeMs).toBeDefined();

    // Verify full chain integrity
    const chainResult = verifyReceiptChain(stateDir);
    expect(chainResult.intact).toBe(true);
    expect(chainResult.depth).toBe(3);
  });
});

// =============================================================================
// RECEIPT CONTRACT: FIELD STABILITY (no silent drops)
// =============================================================================

describe('Receipt contract: field stability', () => {
  test('all Tier 0-2 fields always present', () => {
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/a.js', content: 'hello' },
      convergence: createConvergenceTracker(),
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    // Tier 0: Core receipt fields
    expect(receipt.id).toBeTruthy();
    expect(receipt.seq).toBe(0);
    expect(receipt.timestamp).toBeGreaterThan(0);
    expect(receipt.controllerId).toBe(controller.id);
    expect(receipt.authorityEpoch).toBe(0);
    expect(receipt.enforcement).toBe('strict');
    expect(receipt.toolName).toBe('write_file');
    expect(receipt.arguments).toBeDefined();
    expect(receipt.target).toBeTruthy();
    expect(receipt.outcome).toBe('success');
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
    expect(receipt.previousHash).toBe('genesis');
    expect(receipt.hash).toBeTruthy();

    // Tier 0: Mutation
    expect(receipt.mutation).toBeDefined();
    expect(receipt.mutation.verb).toBe('write_file');
    expect(receipt.mutation.target).toBeTruthy();
    expect(receipt.mutation.capturedAt).toBeGreaterThan(0);

    // Tier 0: Mutation classification
    expect(receipt.mutationType).toBe('mutating');

    // Tier 1: G2 constraint check
    expect(receipt.constraintCheck).toBeDefined();
    expect(receipt.constraintCheck.passed).toBe(true);

    // Tier 2: E-H8 authority check
    expect(receipt.authorityCheck).toBeDefined();
    expect(receipt.authorityCheck.passed).toBe(true);

    // Tier 3: Attribution (always present)
    expect(receipt.attribution).toBeDefined();

    // Tier 4: Grounding (always present)
    expect(receipt.groundingAnnotation).toBeDefined();

    // Tier 5: Convergence (always present)
    expect(receipt.convergenceSignal).toBeDefined();
  });
});

// =============================================================================
// RECEIPT CONTRACT: INTENT HASH — TAMPER DETECTION FOR INTENT
// =============================================================================

describe('Receipt contract: intentHash', () => {
  let controller: { id: string };
  let authority: AuthorityState;
  let convergence: ConvergenceTracker;

  beforeEach(() => {
    controller = loadOrCreateController(stateDir);
    authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);
    convergence = createConvergenceTracker();
  });

  test('intentHash present when intent exists', () => {
    const intent: IntentContext = {
      goal: 'Change background color',
      predicates: [{ type: 'css', fields: { selector: 'body', property: 'background-color' } }],
      declaredAt: Date.now() - 1000,
      version: 1,
    };

    const receipt = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/style.css', content: 'body { background: navy }' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.intentHash).toBeDefined();
    expect(typeof receipt.intentHash).toBe('string');
    expect(receipt.intentHash!.length).toBe(64); // SHA-256 hex length
  });

  test('intentHash absent when no intent', () => {
    const receipt = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    expect(receipt.intentHash).toBeUndefined();
  });

  test('same intent produces same hash (deterministic)', () => {
    const intent: IntentContext = {
      goal: 'Test determinism',
      predicates: [{ type: 'css', fields: { selector: '.foo', property: 'color' } }],
      declaredAt: 1709000000000, // Fixed timestamp for determinism
      version: 1,
    };

    const hash1 = computeIntentHash(intent);
    const hash2 = computeIntentHash(intent);
    expect(hash1).toBe(hash2);
  });

  test('different intent produces different hash', () => {
    const intent1: IntentContext = {
      goal: 'Goal A',
      predicates: [{ type: 'css', fields: { selector: '.foo' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const intent2: IntentContext = {
      goal: 'Goal B',
      predicates: [{ type: 'css', fields: { selector: '.bar' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const hash1 = computeIntentHash(intent1);
    const hash2 = computeIntentHash(intent2);
    expect(hash1).not.toBe(hash2);
  });

  test('intentHash is key-order independent (stableStringify)', () => {
    // Same data, different key insertion order
    const intent1: IntentContext = {
      goal: 'Test',
      predicates: [{ type: 'css', fields: { selector: '.foo', property: 'color' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const intent2 = {
      version: 1,
      declaredAt: 1709000000000,
      predicates: [{ fields: { property: 'color', selector: '.foo' }, type: 'css' }],
      goal: 'Test',
    } as IntentContext;

    const hash1 = computeIntentHash(intent1);
    const hash2 = computeIntentHash(intent2);
    expect(hash1).toBe(hash2);
  });

  test('intentHash changes when intent goal is modified', () => {
    const intent: IntentContext = {
      goal: 'Original goal',
      predicates: [{ type: 'css', fields: { selector: '.foo' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const hashBefore = computeIntentHash(intent);

    // Simulate retroactive tampering
    const tampered = { ...intent, goal: 'Tampered goal' };
    const hashAfter = computeIntentHash(tampered);

    expect(hashBefore).not.toBe(hashAfter);
  });

  test('intentHash changes when predicates are added', () => {
    const intent: IntentContext = {
      goal: 'Test',
      predicates: [{ type: 'css', fields: { selector: '.foo' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const hashBefore = computeIntentHash(intent);

    // Add a predicate retroactively
    const tampered = {
      ...intent,
      predicates: [
        ...intent.predicates,
        { type: 'http', fields: { path: '/injected' } },
      ],
    };
    const hashAfter = computeIntentHash(tampered);

    expect(hashBefore).not.toBe(hashAfter);
  });

  test('intentHash embedded in receipt survives hash chain verification', () => {
    const intent: IntentContext = {
      goal: 'Chain test',
      predicates: [{ type: 'css', fields: { selector: '.test' } }],
      declaredAt: Date.now(),
      version: 1,
    };

    // Build 3 receipts: no intent → with intent → with intent
    const r1 = buildProxyReceipt({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/a.js' },
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 0,
      previousHash: 'genesis',
    });

    const r2 = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/b.js', content: 'x' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 1,
      previousHash: r1.hash,
    });

    const r3 = buildProxyReceipt({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/c.js', content: 'y' },
      intent,
      convergence,
      constraints: [],
      authority,
      controller,
      seq: 2,
      previousHash: r2.hash,
    });

    // Chain should be intact
    const result = verifyReceiptChain(stateDir);
    expect(result.intact).toBe(true);
    expect(result.depth).toBe(3);

    // Receipt 1 has no intentHash, receipts 2-3 have it
    expect(r1.intentHash).toBeUndefined();
    expect(r2.intentHash).toBeDefined();
    expect(r3.intentHash).toBeDefined();

    // Both receipts with same intent should have same intentHash
    expect(r2.intentHash).toBe(r3.intentHash);
  });

  test('intentHash with grounding context included in hash', () => {
    const intentWithoutGrounding: IntentContext = {
      goal: 'Test',
      predicates: [{ type: 'css', fields: { selector: '.foo' } }],
      declaredAt: 1709000000000,
      version: 1,
    };

    const intentWithGrounding: IntentContext = {
      ...intentWithoutGrounding,
      grounding: {
        facts: { cssRules: ['body { color: black }'] },
        observedAt: 1709000000000,
      },
    };

    const hash1 = computeIntentHash(intentWithoutGrounding);
    const hash2 = computeIntentHash(intentWithGrounding);
    expect(hash1).not.toBe(hash2);
  });
});
