/**
 * Clean Wrap #12: Ticket System (8-tool upstream)
 * ================================================
 *
 * RELEASE GATE: This test must pass with ZERO changes to any proxy source file.
 * If it fails, the proxy is not release-ready.
 *
 * Tests the full governance surface against a ticket management upstream:
 *   - Discovery: 8 upstream + 5 meta = 13 tools
 *   - G2: failure → constraint → block retry
 *   - E-H8: authority bump → stale session → re-handshake
 *   - G5: declare intent → direct/scaffolding/unexplained/readonly exempt
 *   - Receipts: hash chain integrity across all operation types
 *   - Convergence: loop detection on repeated failures
 *   - Multi-tier interaction: G2 + G5 combined behavior
 *
 * Upstream tools (8):
 *   Readonly:  get_ticket, list_tickets, search_tickets
 *   CRUD:      create_ticket, update_ticket, delete_ticket
 *   Workflow:  assign_ticket (mutating), close_ticket (mutating)
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { loadReceipts, loadConstraints } from '../src/state.js';

// =============================================================================
// HARNESS
// =============================================================================

const TICKET_UPSTREAM = resolve(__dirname, 'ticket-upstream.ts');
const PROXY_ENTRY = resolve(__dirname, '..', 'src', 'index.ts');

interface ProxyHarness {
  request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  settle(ms?: number): Promise<void>;
  kill(): Promise<void>;
  stateDir: string;
}

async function spawnProxy(opts?: {
  enforcement?: 'strict' | 'advisory';
  stateDir?: string;
}): Promise<ProxyHarness> {
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-ticket-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    ['bun', 'run', PROXY_ENTRY, '--upstream', `bun run ${TICKET_UPSTREAM}`, '--state-dir', stateDir, '--enforcement', enforcement],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );

  // Watch stderr for readiness signal ("Proxy started") instead of blind sleep
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const stderrDecoder = new TextDecoder();
  let proxyReady: () => void;
  const readyPromise = new Promise<void>(resolve => { proxyReady = resolve; });
  let readyFired = false;

  (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = stderrDecoder.decode(value, { stream: true });
        if (!readyFired && text.includes('Proxy started')) {
          readyFired = true;
          proxyReady!();
        }
      }
    } catch {}
    // If stderr closes without readiness signal, unblock anyway
    if (!readyFired) { readyFired = true; proxyReady!(); }
  })();

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let partialLine = '';
  const lineBuffer: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  function dispatchLine(line: string): void {
    if (!line) return;
    if (waiters.length > 0) {
      waiters.shift()!(line);
    } else {
      lineBuffer.push(line);
    }
  }

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parts = (partialLine + decoder.decode(value, { stream: true })).split('\n');
        partialLine = parts.pop() ?? '';
        for (const line of parts) dispatchLine(line);
      }
      if (partialLine) dispatchLine(partialLine);
    } catch {}
  })();

  function nextLine(timeoutMs = 10000): Promise<string> {
    if (lineBuffer.length > 0) return Promise.resolve(lineBuffer.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for proxy response (${timeoutMs}ms)`));
      }, timeoutMs);
      waiters.push((line: string) => { clearTimeout(timer); resolve(line); });
    });
  }

  let nextId = 1;

  async function request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>> {
    const msgId = id ?? nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params });
    (proc.stdin as { write(data: string | Uint8Array): void }).write(msg + '\n');
    const line = await nextLine();
    return JSON.parse(line) as Record<string, unknown>;
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    (proc.stdin as { write(data: string | Uint8Array): void }).write(msg + '\n');
  }

  async function settle(ms = 200): Promise<void> {
    await new Promise(r => setTimeout(r, ms));
  }

  async function kill(): Promise<void> {
    try { proc.kill(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait for proxy readiness signal or timeout (10s fallback for npx first-download)
  await Promise.race([readyPromise, settle(10000)]);
  return { request, notify, settle, kill, stateDir };
}

async function initProxy(harness: ProxyHarness): Promise<void> {
  await harness.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ticket-test', version: '1.0' },
  });
  harness.notify('notifications/initialized');
  await harness.settle();
}

async function callTool(harness: ProxyHarness, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return harness.request('tools/call', { name, arguments: args });
}

async function declareIntent(harness: ProxyHarness, goal: string, predicates: Array<Record<string, string>>): Promise<Record<string, unknown>> {
  return callTool(harness, 'governance_declare_intent', { goal, predicates });
}

async function clearIntent(harness: ProxyHarness): Promise<Record<string, unknown>> {
  return callTool(harness, 'governance_clear_intent', {});
}

// =============================================================================
// 1. DISCOVERY
// =============================================================================

describe('Clean Wrap #12: Ticket System — Discovery', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('tools/list returns 8 upstream + 5 meta = 13 tools', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    const resp = await harness.request('tools/list');
    const tools = (resp.result as any).tools as Array<{ name: string }>;
    expect(tools.length).toBe(13);

    // Upstream tools
    const names = tools.map(t => t.name).sort();
    expect(names).toContain('get_ticket');
    expect(names).toContain('list_tickets');
    expect(names).toContain('search_tickets');
    expect(names).toContain('create_ticket');
    expect(names).toContain('update_ticket');
    expect(names).toContain('delete_ticket');
    expect(names).toContain('assign_ticket');
    expect(names).toContain('close_ticket');

    // Meta tools
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  });
});

// =============================================================================
// 2. G2 — NON-REPETITION
// =============================================================================

describe('Clean Wrap #12: Ticket System — G2 Non-Repetition', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('failure on non-existent ticket seeds G2 constraint → retry blocked', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // First call: get_ticket for non-existent → fails (upstream isError)
    const r1 = await callTool(harness, 'get_ticket', { id: 'TKT-999' });
    expect((r1.result as any).isError).toBe(true);

    // Same call again → G2 blocks
    const r2 = await callTool(harness, 'get_ticket', { id: 'TKT-999' });
    expect((r2.result as any).isError).toBe(true);
    expect((r2.result as any).content[0].text).toContain('G2 BLOCKED');

    // Verify constraint exists
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });

  test('G2 does not block different target after same tool failure', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Fail on TKT-999
    await callTool(harness, 'get_ticket', { id: 'TKT-999' });

    // Create TKT-001, then get it — different target, should pass
    await callTool(harness, 'create_ticket', { id: 'TKT-001', title: 'Real ticket' });
    const resp = await callTool(harness, 'get_ticket', { id: 'TKT-001' });
    expect((resp.result as any).isError).toBeFalsy();
    const data = JSON.parse((resp.result as any).content[0].text);
    expect(data.id).toBe('TKT-001');
  });

  test('workflow error seeds constraint: close already-closed ticket', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create and close a ticket
    await callTool(harness, 'create_ticket', { id: 'TKT-100', title: 'Bug' });
    await callTool(harness, 'close_ticket', { id: 'TKT-100', resolution: 'Fixed' });

    // Try to close again → upstream error
    const r1 = await callTool(harness, 'close_ticket', { id: 'TKT-100' });
    expect((r1.result as any).isError).toBe(true);

    // Retry → G2 blocks
    const r2 = await callTool(harness, 'close_ticket', { id: 'TKT-100' });
    expect((r2.result as any).content[0].text).toContain('G2 BLOCKED');
  });
});

// =============================================================================
// 3. E-H8 — AUTHORITY
// =============================================================================

describe('Clean Wrap #12: Ticket System — E-H8 Authority', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('bump_authority → next tool call blocked as stale → re-init resyncs', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Normal call works
    const r1 = await callTool(harness, 'create_ticket', { id: 'TKT-A', title: 'Alpha' });
    expect((r1.result as any).isError).toBeFalsy();

    // Bump authority
    const bump = await callTool(harness, 'governance_bump_authority', { reason: 'policy change' });
    expect((bump.result as any).isError).toBeFalsy();

    // Next call should be blocked (stale session)
    const r2 = await callTool(harness, 'create_ticket', { id: 'TKT-B', title: 'Beta' });
    expect((r2.result as any).isError).toBe(true);
    expect((r2.result as any).content[0].text).toContain('E-H8');

    // Re-initialize to resync
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ticket-test', version: '1.0' },
    });
    harness.notify('notifications/initialized');
    await harness.settle();

    // Now calls work again
    const r3 = await callTool(harness, 'create_ticket', { id: 'TKT-B', title: 'Beta' });
    expect((r3.result as any).isError).toBeFalsy();
    expect((r3.result as any).content[0].text).toContain('Created ticket TKT-B');
  });
});

// =============================================================================
// 4. G5 — CONTAINMENT
// =============================================================================

describe('Clean Wrap #12: Ticket System — G5 Containment', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('no intent → all mutating calls pass with no_intent attribution', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    const r1 = await callTool(harness, 'create_ticket', { id: 'TKT-1', title: 'Test' });
    expect((r1.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    const r2 = await callTool(harness, 'assign_ticket', { id: 'TKT-1', assignee: 'alice' });
    expect((r2.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    const receipts = loadReceipts(harness.stateDir);
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));
    for (const r of toolReceipts) {
      expect(r.attribution).toBe('no_intent');
    }
  });

  test('declare intent → matching ticket ID → direct attribution', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await callTool(harness, 'create_ticket', { id: 'TKT-42', title: 'Login bug' });

    await declareIntent(harness, 'Fix TKT-42 login bug', [
      { type: 'ticket', id: 'TKT-42', title: 'Login bug fix' },
    ]);

    // update_ticket with TKT-42 → predicate field matches → direct
    const resp = await callTool(harness, 'update_ticket', { id: 'TKT-42', title: 'Login bug - fixed' });
    expect((resp.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('direct');
  });

  test('declare intent → unrelated ticket → unexplained → BLOCKED', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Fix TKT-42', [
      { type: 'ticket', id: 'TKT-42' },
    ]);

    // delete_ticket for TKT-999 → no predicate mentions TKT-999 → blocked
    const resp = await callTool(harness, 'delete_ticket', { id: 'TKT-999' });
    expect((resp.result as any).isError).toBe(true);
    expect((resp.result as any).content[0].text).toContain('G5 BLOCKED');

    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('unexplained');
    expect(last.outcome).toBe('blocked');
  });

  test('readonly tools exempt from G5 even with active intent', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Fix TKT-42 only', [
      { type: 'ticket', id: 'TKT-42' },
    ]);

    // get_ticket for unrelated TKT-999 → readonly → passes despite no match
    const r1 = await callTool(harness, 'get_ticket', { id: 'TKT-999' });
    // upstream returns isError (not found), but it's not governance-blocked
    expect((r1.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // list_tickets → readonly → passes
    const r2 = await callTool(harness, 'list_tickets', { status: 'open' });
    expect((r2.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // search_tickets → readonly → passes
    const r3 = await callTool(harness, 'search_tickets', { query: 'anything' });
    expect((r3.result as any).content[0].text).not.toContain('[GOVERNANCE]');
  });

  test('workflow tools (assign/close) subject to G5 containment', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create ticket first (no intent yet → passes)
    await callTool(harness, 'create_ticket', { id: 'TKT-50', title: 'Performance issue' });

    // Declare intent for TKT-50
    await declareIntent(harness, 'Triage TKT-50', [
      { type: 'ticket', id: 'TKT-50' },
    ]);

    // assign_ticket for TKT-50 → direct → passes
    const r1 = await callTool(harness, 'assign_ticket', { id: 'TKT-50', assignee: 'bob' });
    expect((r1.result as any).content[0].text).not.toContain('[GOVERNANCE]');
    expect((r1.result as any).content[0].text).toContain('Assigned ticket TKT-50');

    // close_ticket for TKT-50 → direct → passes
    const r2 = await callTool(harness, 'close_ticket', { id: 'TKT-50', resolution: 'Resolved' });
    expect((r2.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // assign_ticket for unrelated TKT-999 → unexplained → BLOCKED
    const r3 = await callTool(harness, 'assign_ticket', { id: 'TKT-999', assignee: 'eve' });
    expect((r3.result as any).content[0].text).toContain('G5 BLOCKED');
  });

  test('clear intent → workflow calls pass again', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await callTool(harness, 'create_ticket', { id: 'TKT-60', title: 'Cleanup' });

    await declareIntent(harness, 'Only TKT-60', [
      { type: 'ticket', id: 'TKT-60' },
    ]);

    // Unrelated assign → blocked
    const r1 = await callTool(harness, 'assign_ticket', { id: 'TKT-60', assignee: 'alice' });
    expect((r1.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Clear intent
    await clearIntent(harness);

    // Now create unrelated ticket → passes (no intent)
    const r2 = await callTool(harness, 'create_ticket', { id: 'TKT-99', title: 'New' });
    expect((r2.result as any).content[0].text).not.toContain('[GOVERNANCE]');
    expect((r2.result as any).content[0].text).toContain('Created ticket TKT-99');
  });
});

// =============================================================================
// 5. RECEIPTS & HASH CHAIN
// =============================================================================

describe('Clean Wrap #12: Ticket System — Receipts', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('mixed operations produce correct receipt chain', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create, read, update, assign, close — varied operations
    await callTool(harness, 'create_ticket', { id: 'TKT-R1', title: 'Receipt test' });
    await callTool(harness, 'get_ticket', { id: 'TKT-R1' });
    await callTool(harness, 'update_ticket', { id: 'TKT-R1', priority: 'high' });
    await callTool(harness, 'assign_ticket', { id: 'TKT-R1', assignee: 'charlie' });
    await callTool(harness, 'close_ticket', { id: 'TKT-R1', resolution: 'Done' });
    await callTool(harness, 'list_tickets', {});

    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(6);

    // Hash chain: first is genesis, each subsequent links to previous
    expect(receipts[0].previousHash).toBe('genesis');
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].previousHash).toBe(receipts[i - 1].hash);
    }

    // Mutation classification: create/update/assign/close = mutating, get/list = readonly
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));
    const mutating = toolReceipts.filter(r => r.mutationType === 'mutating');
    const readonly = toolReceipts.filter(r => r.mutationType === 'readonly');
    expect(mutating.length).toBe(4); // create, update, assign, close
    expect(readonly.length).toBe(2); // get, list
  });

  test('G5-blocked calls appear in receipt chain', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await callTool(harness, 'create_ticket', { id: 'TKT-B1', title: 'Base' });
    await declareIntent(harness, 'Only TKT-B1', [{ type: 'ticket', id: 'TKT-B1' }]);

    // This will be blocked
    await callTool(harness, 'delete_ticket', { id: 'TKT-OTHER' });

    const receipts = loadReceipts(harness.stateDir);
    const blocked = receipts.filter(r => r.outcome === 'blocked' && r.attribution === 'unexplained');
    expect(blocked.length).toBeGreaterThanOrEqual(1);

    // Blocked receipt still links into hash chain
    const blockedIdx = receipts.findIndex(r => r.outcome === 'blocked');
    if (blockedIdx > 0) {
      expect(receipts[blockedIdx].previousHash).toBe(receipts[blockedIdx - 1].hash);
    }
  });
});

// =============================================================================
// 6. MULTI-TIER INTERACTION
// =============================================================================

describe('Clean Wrap #12: Ticket System — Multi-Tier', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('G2 fires before G5 (constraint priority)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create and close TKT-200
    await callTool(harness, 'create_ticket', { id: 'TKT-200', title: 'Test' });
    await callTool(harness, 'close_ticket', { id: 'TKT-200' });

    // Try to close again → upstream error → seeds G2
    await callTool(harness, 'close_ticket', { id: 'TKT-200' });

    // Declare intent covering TKT-200
    await declareIntent(harness, 'Manage TKT-200', [
      { type: 'ticket', id: 'TKT-200' },
    ]);

    // close_ticket TKT-200 again → G2 fires first (before G5 even checks)
    const resp = await callTool(harness, 'close_ticket', { id: 'TKT-200' });
    expect((resp.result as any).content[0].text).toContain('G2 BLOCKED');
  });

  test('advisory mode: G5 unexplained passes but receipt records it', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Only TKT-1', [
      { type: 'ticket', id: 'TKT-1' },
    ]);

    // Unrelated mutating call in advisory → passes
    const resp = await callTool(harness, 'create_ticket', { id: 'TKT-ROGUE', title: 'Rogue' });
    expect((resp.result as any).content[0].text).not.toContain('[GOVERNANCE]');
    expect((resp.result as any).content[0].text).toContain('Created ticket TKT-ROGUE');

    // Receipt still shows unexplained
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('unexplained');
    expect(last.outcome).toBe('success'); // forwarded, not blocked
  });

  test('full lifecycle: create → intent → assign → close → clear → new ticket', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Phase 1: No intent, create freely
    await callTool(harness, 'create_ticket', { id: 'TKT-LC', title: 'Lifecycle test', priority: 'critical' });

    // Phase 2: Declare intent for TKT-LC
    await declareIntent(harness, 'Resolve TKT-LC', [
      { type: 'ticket', id: 'TKT-LC', priority: 'critical' },
    ]);

    // Phase 3: Workflow within intent — all pass
    const assign = await callTool(harness, 'assign_ticket', { id: 'TKT-LC', assignee: 'alice' });
    expect((assign.result as any).content[0].text).toContain('Assigned ticket TKT-LC');

    const update = await callTool(harness, 'update_ticket', { id: 'TKT-LC', description: 'Root cause found' });
    expect((update.result as any).content[0].text).toContain('Updated ticket TKT-LC');

    const close = await callTool(harness, 'close_ticket', { id: 'TKT-LC', resolution: 'Patched in v2.1' });
    expect((close.result as any).content[0].text).toContain('Closed ticket TKT-LC');

    // Phase 4: Unrelated ticket → blocked
    const rogue = await callTool(harness, 'create_ticket', { id: 'TKT-NEW', title: 'Feature request' });
    expect((rogue.result as any).content[0].text).toContain('G5 BLOCKED');

    // Phase 5: Clear intent → free again
    await clearIntent(harness);
    const free = await callTool(harness, 'create_ticket', { id: 'TKT-NEW', title: 'Feature request' });
    expect((free.result as any).content[0].text).toContain('Created ticket TKT-NEW');

    // Verify receipt count makes sense
    const receipts = loadReceipts(harness.stateDir);
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));
    expect(toolReceipts.length).toBe(6); // create, assign, update, close, blocked-create, create-after-clear

    // Verify attributions
    expect(toolReceipts[0].attribution).toBe('no_intent');   // create before intent
    expect(toolReceipts[1].attribution).toBe('direct');       // assign
    expect(toolReceipts[2].attribution).toBe('direct');       // update
    expect(toolReceipts[3].attribution).toBe('direct');       // close
    expect(toolReceipts[4].attribution).toBe('unexplained');  // blocked create
    expect(toolReceipts[5].attribution).toBe('no_intent');    // create after clear
  });
});
