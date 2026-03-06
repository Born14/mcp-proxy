/**
 * Integration Tests — Full Round-Trip
 * ====================================
 *
 * End-to-end proof of the governance pipeline:
 *   1. State initialization creates all 4 files
 *   2. Constraint seeding from failure
 *   3. Constraint blocking on retry
 *   4. Authority bump creates session gap
 *   5. Advisory mode logs but forwards
 *   6. Receipt chain integrity across operations
 *   7. Full governance lifecycle: init → call → fail → seed → block → bump → verify
 *
 * These tests use the state, fingerprint, and governance modules directly
 * (not the stdio proxy layer) to prove the governance pipeline in isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStateDir,
  loadOrCreateController,
  loadAuthority,
  saveAuthority,
  loadConstraints,
  saveConstraints,
  appendReceipt,
  getLastReceiptHash,
  getReceiptCount,
  verifyReceiptChain,
} from '../src/state.js';
import { toolCallToMutation, seedFromFailure, classifyMutationType } from '../src/fingerprint.js';
import { checkConstraints, checkAuthority, runGates, processFailure } from '../src/governance.js';
import { handleBumpAuthority, handleGovernanceStatus } from '../src/meta-tools.js';
import type { ProxyState, ToolCallRecord } from '../src/types.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-integ-'));
  ensureStateDir(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

// =============================================================================
// FULL LIFECYCLE
// =============================================================================

describe('Full governance lifecycle', () => {
  test('init → call → fail → seed → block → bump → verify chain', () => {
    // 1. Initialize state
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    authority.sessionStartedAt = Date.now();
    saveAuthority(stateDir, authority);
    const constraints = loadConstraints(stateDir);

    expect(controller.id).toMatch(/^[0-9a-f]{8}-/);
    expect(authority.epoch).toBe(0);
    expect(constraints).toHaveLength(0);

    // State files should exist
    expect(existsSync(join(stateDir, 'controller.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'authority.json'))).toBe(true);

    // 2. First tool call — should pass all gates
    const mutation1 = toolCallToMutation('write_file', { path: '/tmp/server.js', content: 'console.log("hi")' });
    const gate1 = runGates(mutation1, constraints, authority, 'strict');
    expect(gate1.forward).toBe(true);

    // Record successful receipt
    let lastHash = getLastReceiptHash(stateDir);
    const receipt1 = appendReceipt(stateDir, {
      id: 'r_0',
      seq: 0,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: authority.epoch,
      enforcement: 'strict',
      toolName: 'write_file',
      arguments: { path: '/tmp/server.js' },
      target: '/tmp/server.js',
      constraintCheck: gate1.constraintCheck,
      authorityCheck: gate1.authorityCheck,
      outcome: 'success',
      durationMs: 50,
      previousHash: lastHash,
      mutation: { verb: 'write_file', target: '/tmp/server.js', capturedAt: Date.now(), args: {} },
      mutationType: 'mutating',
    });

    expect(receipt1.hash).toBeTruthy();
    expect(receipt1.previousHash).toBe('genesis');

    // 3. Simulate upstream failure → seed constraint
    const errorText = 'SyntaxError: Unexpected token } in server.js';
    const newConstraint = processFailure('write_file', '/tmp/server.js', errorText, constraints, stateDir);
    expect(newConstraint).not.toBeNull();
    expect(constraints).toHaveLength(1);

    // Record failure receipt
    lastHash = receipt1.hash;
    const receipt2 = appendReceipt(stateDir, {
      id: 'r_1',
      seq: 1,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: authority.epoch,
      enforcement: 'strict',
      toolName: 'write_file',
      arguments: { path: '/tmp/server.js' },
      target: '/tmp/server.js',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'error',
      error: errorText,
      failureSignature: 'syntax_error',
      durationMs: 30,
      previousHash: lastHash,
      mutation: { verb: 'write_file', target: '/tmp/server.js', capturedAt: Date.now(), args: {} },
      mutationType: 'mutating',
    });

    // 4. Retry same tool+target → G2 blocks
    const mutation2 = toolCallToMutation('write_file', { path: '/tmp/server.js', content: 'fixed' });
    const gate2 = runGates(mutation2, constraints, authority, 'strict');
    expect(gate2.forward).toBe(false);
    expect(gate2.blockReason).toContain('G2 BLOCKED');

    // Record blocked receipt
    lastHash = receipt2.hash;
    const receipt3 = appendReceipt(stateDir, {
      id: 'r_2',
      seq: 2,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: authority.epoch,
      enforcement: 'strict',
      toolName: 'write_file',
      arguments: { path: '/tmp/server.js' },
      target: '/tmp/server.js',
      constraintCheck: gate2.constraintCheck,
      authorityCheck: gate2.authorityCheck,
      outcome: 'blocked',
      error: gate2.blockReason,
      durationMs: 1,
      previousHash: lastHash,
      mutation: { verb: 'write_file', target: '/tmp/server.js', capturedAt: Date.now(), args: {} },
      mutationType: 'mutating',
    });

    // 5. Different target → allowed
    const mutation3 = toolCallToMutation('write_file', { path: '/tmp/other.js', content: 'ok' });
    const gate3 = runGates(mutation3, constraints, authority, 'strict');
    expect(gate3.forward).toBe(true);

    // 6. Bump authority → creates session gap
    const state: ProxyState = {
      controller,
      authority,
      constraints,
      receiptSeq: 3,
      lastReceiptHash: receipt3.hash,
    };

    handleBumpAuthority({ reason: 'redirect agent' }, state, stateDir);
    expect(state.authority.epoch).toBe(1);
    expect(state.authority.activeSessionEpoch).toBe(0); // Frozen at session start

    // 7. Next tool call → E-H8 blocks (session epoch < authority epoch)
    const gate4 = runGates(
      toolCallToMutation('write_file', { path: '/tmp/new.js', content: 'x' }),
      state.constraints,
      state.authority,
      'strict',
    );
    expect(gate4.forward).toBe(false);
    expect(gate4.blockReason).toContain('E-H8 BLOCKED');

    // 8. Verify receipt chain integrity
    const chainResult = verifyReceiptChain(stateDir);
    expect(chainResult.intact).toBe(true);
    expect(chainResult.depth).toBe(3);

    // 9. Verify receipt count
    expect(getReceiptCount(stateDir)).toBe(3);
  });
});

// =============================================================================
// ADVISORY MODE
// =============================================================================

describe('Advisory mode lifecycle', () => {
  test('logs violations but forwards all calls', () => {
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);

    // Seed a constraint
    const constraints: ConstraintEntry[] = [];
    processFailure('write_file', '/tmp/test.js', 'SyntaxError: bad', constraints, stateDir);
    expect(constraints).toHaveLength(1);

    // Advisory mode: constraint violation forwards
    const gate = runGates(
      toolCallToMutation('write_file', { path: '/tmp/test.js' }),
      constraints,
      authority,
      'advisory',
    );

    expect(gate.forward).toBe(true);
    expect(gate.constraintCheck.passed).toBe(false); // Violation recorded
    expect(gate.constraintCheck.blockedBy).toBe(constraints[0].id);
  });

  test('advisory mode authority violation forwards', () => {
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = 0;
    authority.epoch = 5; // Bumped past session
    saveAuthority(stateDir, authority);

    const gate = runGates(
      toolCallToMutation('write_file', { path: '/tmp/test.js' }),
      [],
      authority,
      'advisory',
    );

    expect(gate.forward).toBe(true);
    expect(gate.authorityCheck.passed).toBe(false); // Violation recorded
  });
});

// =============================================================================
// CROSS-SESSION CONTINUITY
// =============================================================================

describe('Cross-session state continuity', () => {
  test('constraints survive session restart', () => {
    // Session 1: seed constraint
    const controller = loadOrCreateController(stateDir);
    const constraints1 = loadConstraints(stateDir);
    processFailure('write_file', '/tmp/test.js', 'SyntaxError: bad', constraints1, stateDir);

    // Session 2: load constraints, verify constraint blocks
    const constraints2 = loadConstraints(stateDir);
    expect(constraints2).toHaveLength(1);

    const gate = runGates(
      toolCallToMutation('write_file', { path: '/tmp/test.js' }),
      constraints2,
      { controllerId: controller.id, epoch: 0, lastBumpedAt: Date.now(), activeSessionEpoch: 0 },
      'strict',
    );

    expect(gate.forward).toBe(false);
  });

  test('controller identity persists across sessions', () => {
    const c1 = loadOrCreateController(stateDir);
    const c2 = loadOrCreateController(stateDir);
    expect(c1.id).toBe(c2.id);
  });

  test('authority epoch persists across sessions', () => {
    const controller = loadOrCreateController(stateDir);
    const auth1 = loadAuthority(stateDir, controller.id);
    auth1.epoch = 42;
    saveAuthority(stateDir, auth1);

    const auth2 = loadAuthority(stateDir, controller.id);
    expect(auth2.epoch).toBe(42);
  });

  test('new session gets fresh session epoch', () => {
    const controller = loadOrCreateController(stateDir);

    // Session 1: bump authority to 5
    const auth1 = loadAuthority(stateDir, controller.id);
    auth1.epoch = 5;
    auth1.activeSessionEpoch = 5;
    saveAuthority(stateDir, auth1);

    // Session 2: snapshot current epoch as new session epoch
    const auth2 = loadAuthority(stateDir, controller.id);
    auth2.activeSessionEpoch = auth2.epoch; // Fresh snapshot

    // Should pass — new session epoch matches authority epoch
    const verdict = checkAuthority(auth2);
    expect(verdict.action).toBe('proceed');
  });
});

// =============================================================================
// GOVERNANCE STATUS
// =============================================================================

describe('Governance status reflects reality', () => {
  test('status shows correct counts after operations', () => {
    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);
    authority.activeSessionEpoch = authority.epoch;
    saveAuthority(stateDir, authority);

    const constraints: ConstraintEntry[] = [];
    processFailure('write_file', '/a.js', 'SyntaxError: bad', constraints, stateDir);
    processFailure('write_file', '/b.js', 'build failed with exit code 1', constraints, stateDir);

    // Append a receipt
    appendReceipt(stateDir, {
      id: 'r_0',
      seq: 0,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: 0,
      enforcement: 'strict',
      toolName: 'test',
      arguments: {},
      target: 'test',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'success',
      durationMs: 10,
      previousHash: 'genesis',
      mutation: { verb: 'test', target: 'test', capturedAt: Date.now(), args: {} },
      mutationType: 'readonly',
    });

    const state: ProxyState = {
      controller,
      authority,
      constraints,
      receiptSeq: 1,
      lastReceiptHash: 'abc',
    };

    const result = handleGovernanceStatus(state, stateDir);
    const data = JSON.parse(result.content[0].text);

    expect(data.controllerId).toBe(controller.id);
    expect(data.constraintCount).toBe(2);
    expect(data.receiptCount).toBe(1);
  });
});

// =============================================================================
// MUTATION CLASSIFICATION IN RECEIPTS
// =============================================================================

describe('Receipt mutation classification', () => {
  test('write_file receipt carries mutationType: mutating', () => {
    const controller = loadOrCreateController(stateDir);
    const receipt = appendReceipt(stateDir, {
      id: 'r_0',
      seq: 0,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: 0,
      enforcement: 'strict',
      toolName: 'write_file',
      arguments: { path: '/tmp/test.js', content: 'hello' },
      target: '/tmp/test.js',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'success',
      durationMs: 10,
      previousHash: 'genesis',
      mutation: { verb: 'write_file', target: '/tmp/test.js', capturedAt: Date.now(), args: {} },
      mutationType: classifyMutationType('write_file', { path: '/tmp/test.js', content: 'hello' }),
    });

    expect(receipt.mutationType).toBe('mutating');
  });

  test('read_file receipt carries mutationType: readonly', () => {
    const controller = loadOrCreateController(stateDir);
    const receipt = appendReceipt(stateDir, {
      id: 'r_0',
      seq: 0,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: 0,
      enforcement: 'strict',
      toolName: 'read_file',
      arguments: { path: '/tmp/test.js' },
      target: '/tmp/test.js',
      constraintCheck: { passed: true },
      authorityCheck: { passed: true },
      outcome: 'success',
      durationMs: 5,
      previousHash: 'genesis',
      mutation: { verb: 'read_file', target: '/tmp/test.js', capturedAt: Date.now(), args: {} },
      mutationType: classifyMutationType('read_file', { path: '/tmp/test.js' }),
    });

    expect(receipt.mutationType).toBe('readonly');
  });
});
