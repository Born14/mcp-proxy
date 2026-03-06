/**
 * Clean Wrap: G5 Containment (6-tool containment upstream)
 * =========================================================
 *
 * RELEASE GATE: This test must pass with ZERO changes to any proxy source file.
 * If it fails, the proxy is not release-ready.
 *
 * Tests Tier 3 G5 containment enforcement:
 *   - No intent → all calls pass (attribution = no_intent)
 *   - Declare intent → direct/scaffolding/unexplained classification
 *   - Strict mode: unexplained mutating calls BLOCKED
 *   - Readonly calls exempt from G5 regardless of attribution
 *   - Clear intent → back to no_intent (all pass)
 *   - Advisory mode: unexplained calls pass but receipt shows unexplained
 *   - Receipt fields carry attribution + match details
 *
 * Containment upstream tools (6):
 *   - read_items: readonly (verb: read)
 *   - list_items: readonly (verb: list)
 *   - create_item: mutating (verb: create, has content arg)
 *   - update_item: mutating (verb: update, has content arg)
 *   - delete_item: mutating (verb: delete)
 *   - deploy_app: mutating (verb: deploy → scaffolding)
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { loadReceipts, loadConstraints } from '../src/state.js';

// =============================================================================
// HARNESS
// =============================================================================

const CONTAINMENT_UPSTREAM = resolve(__dirname, 'containment-upstream.ts');
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
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-g5-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    ['bun', 'run', PROXY_ENTRY, '--upstream', `bun run ${CONTAINMENT_UPSTREAM}`, '--state-dir', stateDir, '--enforcement', enforcement],
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

/** Standard init handshake */
async function initProxy(harness: ProxyHarness): Promise<void> {
  await harness.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'g5-test', version: '1.0' },
  });
  harness.notify('notifications/initialized');
  await harness.settle();
}

/** Call a tool by name + args */
async function callTool(harness: ProxyHarness, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return harness.request('tools/call', { name, arguments: args });
}

/** Declare intent with predicates */
async function declareIntent(harness: ProxyHarness, goal: string, predicates: Array<Record<string, string>>): Promise<Record<string, unknown>> {
  return callTool(harness, 'governance_declare_intent', { goal, predicates });
}

/** Clear intent */
async function clearIntent(harness: ProxyHarness): Promise<Record<string, unknown>> {
  return callTool(harness, 'governance_clear_intent', {});
}

// =============================================================================
// TESTS
// =============================================================================

describe('Clean Wrap: G5 Containment (6 tools, strict mode)', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ─── 1. Discovery ────────────────────────────────────────────────────────

  test('tools/list returns 6 upstream + 5 meta = 11 tools', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    const resp = await harness.request('tools/list');
    const tools = (resp.result as any).tools as Array<{ name: string }>;
    expect(tools.length).toBe(11);

    const names = tools.map(t => t.name).sort();
    expect(names).toContain('read_items');
    expect(names).toContain('list_items');
    expect(names).toContain('create_item');
    expect(names).toContain('update_item');
    expect(names).toContain('delete_item');
    expect(names).toContain('deploy_app');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
  });

  // ─── 2. No intent → all calls pass ──────────────────────────────────────

  test('mutating calls pass when no intent declared (no_intent)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Mutating call with no intent → should pass
    const resp = await callTool(harness, 'create_item', { id: 'item_1', name: 'Widget' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as any;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Created item item_1');

    // Verify receipt has no_intent attribution
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('no_intent');
  });

  test('multiple mutating calls pass without intent (G5 is opt-in)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    const r1 = await callTool(harness, 'create_item', { id: 'a', name: 'A' });
    const r2 = await callTool(harness, 'update_item', { id: 'a', name: 'B' });
    const r3 = await callTool(harness, 'delete_item', { id: 'a' });

    expect((r1.result as any).isError).toBeFalsy();
    expect((r2.result as any).isError).toBeFalsy();
    // delete succeeds because item was created
    expect((r3.result as any).isError).toBeFalsy();
  });

  // ─── 3. Declare intent ──────────────────────────────────────────────────

  test('declare_intent stores goal and predicates', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    const resp = await declareIntent(harness, 'Update item_1 name to Widget Pro', [
      { type: 'content', id: 'item_1', name: 'Widget Pro' },
    ]);

    const result = JSON.parse((resp.result as any).content[0].text);
    expect(result.predicateCount).toBe(1);
    expect(result.goal).toBe('Update item_1 name to Widget Pro');
  });

  // ─── 4. Direct match → passes ──────────────────────────────────────────

  test('update_item with matching predicate → direct attribution, passes', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create item first
    await callTool(harness, 'create_item', { id: 'item_1', name: 'Widget' });

    // Declare intent mentioning item_1
    await declareIntent(harness, 'Update item_1 name', [
      { type: 'content', id: 'item_1', name: 'Widget Pro' },
    ]);

    // update_item with item_1 → predicate field "item_1" matches args → direct
    const resp = await callTool(harness, 'update_item', { id: 'item_1', name: 'Widget Pro' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as any;
    expect(result.isError).toBeFalsy();

    // Verify receipt
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('direct');
    expect(last.attributionMatch).toBeDefined();
    expect(last.attributionMatch!.predicateType).toBe('content');
  });

  // ─── 5. Scaffolding match → passes ────────────────────────────────────

  test('deploy_app → scaffolding attribution (infra verb), passes', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Declare intent (deploy verb is infra → scaffolding regardless of predicates)
    await declareIntent(harness, 'Deploy latest version', [
      { type: 'http', path: '/health', status: '200' },
    ]);

    const resp = await callTool(harness, 'deploy_app', { target: 'prod' });
    expect(resp.error).toBeUndefined();

    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('scaffolding');
  });

  // ─── 6. Unexplained → BLOCKED in strict mode ─────────────────────────

  test('unexplained mutating call BLOCKED in strict mode', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Declare intent about item_1
    await declareIntent(harness, 'Update item_1', [
      { type: 'content', id: 'item_1', name: 'Widget' },
    ]);

    // delete_item targeting item_99 → no predicate mentions item_99 → unexplained → BLOCKED
    const resp = await callTool(harness, 'delete_item', { id: 'item_99' });
    expect(resp.error).toBeUndefined(); // JSON-RPC level OK
    const result = resp.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[GOVERNANCE]');
    expect(result.content[0].text).toContain('G5 BLOCKED');

    // Verify receipt shows blocked
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.outcome).toBe('blocked');
    expect(last.attribution).toBe('unexplained');
  });

  // ─── 7. Readonly exempt ───────────────────────────────────────────────

  test('readonly calls pass regardless of attribution (G5 only on mutating)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Declare intent about something specific
    await declareIntent(harness, 'Update item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // read_items with unrelated query → would be unexplained, but readonly → passes
    const resp = await callTool(harness, 'read_items', { query: 'something_unrelated' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as any;
    expect(result.isError).toBeFalsy();

    // list_items is also readonly → passes
    const resp2 = await callTool(harness, 'list_items', { category: 'unknown' });
    expect(resp2.error).toBeUndefined();
  });

  // ─── 8. Clear intent → back to no_intent ──────────────────────────────

  test('clear_intent → subsequent mutating calls pass (no_intent)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Declare intent
    await declareIntent(harness, 'Update item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // Clear it
    const clearResp = await clearIntent(harness);
    const clearResult = JSON.parse((clearResp.result as any).content[0].text);
    expect(clearResult.cleared).toBe(true);

    // Now mutating call with no matching predicate → but no intent → no_intent → passes
    const resp = await callTool(harness, 'delete_item', { id: 'item_99' });
    expect(resp.error).toBeUndefined();
    // delete_item returns isError when item not found, but that's upstream behavior not G5
    // The key assertion is: it was NOT governance-blocked
    const text = (resp.result as any).content[0].text;
    expect(text).not.toContain('[GOVERNANCE]');

    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('no_intent');
    expect(last.outcome).not.toBe('blocked');
  });

  // ─── 9. Receipt attribution fields ────────────────────────────────────

  test('receipts carry attribution and attributionMatch fields', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Step 1: no intent → no_intent, no match
    await callTool(harness, 'create_item', { id: 'item_1', name: 'Widget' });

    // Step 2: declare intent → direct match
    await declareIntent(harness, 'Manage item_1', [
      { type: 'content', id: 'item_1', name: 'Widget Pro' },
    ]);
    await callTool(harness, 'update_item', { id: 'item_1', name: 'Widget Pro' });

    // Step 3: scaffolding
    await callTool(harness, 'deploy_app', { target: 'staging' });

    const receipts = loadReceipts(harness.stateDir);
    // Filter to upstream tool calls only (skip meta-tools which are handled locally)
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));

    // Receipt 1: create_item with no intent
    expect(toolReceipts[0].attribution).toBe('no_intent');
    expect(toolReceipts[0].attributionMatch).toBeUndefined();

    // Receipt 2: update_item with direct match
    expect(toolReceipts[1].attribution).toBe('direct');
    expect(toolReceipts[1].attributionMatch).toBeDefined();
    expect(toolReceipts[1].attributionMatch!.predicateType).toBe('content');

    // Receipt 3: deploy_app → scaffolding
    expect(toolReceipts[2].attribution).toBe('scaffolding');
  });

  // ─── 10. G5 does NOT block when no intent ─────────────────────────────

  test('sequence of mutating calls without intent → all pass', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Multiple mutating calls, no intent declared
    const results = await Promise.all([
      callTool(harness, 'create_item', { id: 'a', name: 'A' }),
    ]);
    // Can't parallel these since they depend on order
    const r2 = await callTool(harness, 'update_item', { id: 'a', name: 'A2' });
    const r3 = await callTool(harness, 'delete_item', { id: 'a' });
    const r4 = await callTool(harness, 'deploy_app', { target: 'prod' });

    // None should be governance-blocked
    for (const r of [results[0], r2, r3, r4]) {
      const text = (r.result as any).content?.[0]?.text ?? '';
      expect(text).not.toContain('[GOVERNANCE]');
    }

    // All receipts should be no_intent
    const receipts = loadReceipts(harness.stateDir);
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));
    for (const receipt of toolReceipts) {
      expect(receipt.attribution).toBe('no_intent');
    }
  });

  // ─── 11. G2 + G5 interaction ──────────────────────────────────────────

  test('G2 constraint fires before G5 (G2 takes priority)', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Create an item, then make it fail to seed G2 constraint
    // First, create item_1
    await callTool(harness, 'create_item', { id: 'item_1', name: 'Test' });

    // Delete a non-existent item to seed a failure constraint
    const failResp = await callTool(harness, 'delete_item', { id: 'nonexistent' });
    // This returns isError from upstream → seeds G2 constraint on delete_item+nonexistent

    // Now declare intent that does NOT cover "nonexistent"
    await declareIntent(harness, 'Manage item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // Try the same failed call again → G2 should block (prior failure on same tool+target)
    const resp = await callTool(harness, 'delete_item', { id: 'nonexistent' });
    const text = (resp.result as any).content[0].text;
    expect(text).toContain('[GOVERNANCE]');
    expect(text).toContain('G2 BLOCKED');

    // The receipt shows blocked by G2 (not G5)
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.outcome).toBe('blocked');
    expect(last.error).toContain('G2 BLOCKED');
  });

  // ─── 12. Re-declare intent replaces old one ───────────────────────────

  test('re-declare intent → old predicates no longer match', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // First intent: about item_1
    await declareIntent(harness, 'Manage item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // Create with matching ID → direct match → passes
    const r1 = await callTool(harness, 'create_item', { id: 'item_1', name: 'Widget' });
    expect((r1.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Re-declare intent: now about item_2 (item_1 no longer covered)
    await declareIntent(harness, 'Manage item_2', [
      { type: 'content', id: 'item_2' },
    ]);

    // update_item for item_1 → no predicate mentions item_1 now → unexplained → BLOCKED
    const r2 = await callTool(harness, 'update_item', { id: 'item_1', name: 'Updated' });
    const text = (r2.result as any).content[0].text;
    expect(text).toContain('[GOVERNANCE]');
    expect(text).toContain('G5 BLOCKED');

    // create_item with item_2 → predicate covers → direct → passes
    const r3 = await callTool(harness, 'create_item', { id: 'item_2', name: 'Widget 2' });
    expect((r3.result as any).content[0].text).not.toContain('[GOVERNANCE]');
  });

  // ─── 13. Full lifecycle ───────────────────────────────────────────────

  test('lifecycle: declare → direct ok → unexplained blocked → clear → ok → re-declare → different direct ok', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Phase 1: No intent — everything passes
    const p1 = await callTool(harness, 'create_item', { id: 'item_A', name: 'Alpha' });
    expect((p1.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Phase 2: Declare intent for item_A
    await declareIntent(harness, 'Manage item_A', [
      { type: 'content', id: 'item_A' },
    ]);

    // Phase 3: Direct match → passes (id: 'item_A' in args matches predicate field)
    const p3 = await callTool(harness, 'update_item', { id: 'item_A', name: 'Alpha Updated' });
    expect((p3.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Phase 4: Unexplained → blocked (id 'item_Z' not in predicate)
    const p4 = await callTool(harness, 'create_item', { id: 'item_Z', name: 'Zeta' });
    expect((p4.result as any).content[0].text).toContain('G5 BLOCKED');

    // Phase 5: Clear intent → passes again
    await clearIntent(harness);
    const p5 = await callTool(harness, 'create_item', { id: 'item_Z', name: 'Zeta' });
    expect((p5.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Phase 6: Re-declare for item_Z
    await declareIntent(harness, 'Manage item_Z', [
      { type: 'content', id: 'item_Z' },
    ]);

    // Phase 7: item_Z is now direct
    const p7 = await callTool(harness, 'update_item', { id: 'item_Z', name: 'Zeta Updated' });
    expect((p7.result as any).content[0].text).not.toContain('[GOVERNANCE]');

    // Phase 8: item_A is now unexplained → blocked
    const p8 = await callTool(harness, 'update_item', { id: 'item_A', name: 'Alpha Again' });
    expect((p8.result as any).content[0].text).toContain('G5 BLOCKED');
  });
});

// =============================================================================
// ADVISORY MODE
// =============================================================================

describe('Clean Wrap: G5 Containment (advisory mode)', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('unexplained mutating calls PASS in advisory mode but receipt shows unexplained', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await initProxy(harness);
    await harness.request('tools/list');

    // Declare intent about item_1
    await declareIntent(harness, 'Manage item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // Mutating call targeting item_99 → unexplained but advisory → passes
    const resp = await callTool(harness, 'create_item', { id: 'item_99', name: 'Rogue' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as any;
    // Should NOT be governance-blocked in advisory
    expect(result.content[0].text).not.toContain('[GOVERNANCE]');
    expect(result.content[0].text).toContain('Created item item_99');

    // But the receipt should still record unexplained
    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('unexplained');
    expect(last.outcome).toBe('success');
  });

  test('direct and scaffolding still attributed correctly in advisory mode', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Update item_1 and deploy', [
      { type: 'content', id: 'item_1', name: 'Widget' },
    ]);

    // Direct match: "item_1" in predicate matches "item_1" in args
    await callTool(harness, 'create_item', { id: 'item_1', name: 'Widget' });

    // Scaffolding
    await callTool(harness, 'deploy_app', { target: 'prod' });

    const receipts = loadReceipts(harness.stateDir);
    const toolReceipts = receipts.filter(r => !r.toolName.startsWith('governance_'));

    expect(toolReceipts[0].attribution).toBe('direct');
    expect(toolReceipts[1].attribution).toBe('scaffolding');
  });
});

// =============================================================================
// CONTAINMENT CHECK ON GATE RESULT
// =============================================================================

describe('Clean Wrap: G5 containmentCheck on GateResult (unit-level)', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('blocked receipt has containment attribution in error message', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Manage item_1', [
      { type: 'content', id: 'item_1' },
    ]);

    // Unexplained mutating → blocked
    const resp = await callTool(harness, 'delete_item', { id: 'rogue_item' });
    const text = (resp.result as any).content[0].text;
    expect(text).toContain('G5 BLOCKED');
    expect(text).toContain('delete_item');
    expect(text).toContain('unexplained');
  });

  test('create_item with matching predicate field → direct, not blocked', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    await declareIntent(harness, 'Create special item', [
      { type: 'item', id: 'special_widget', name: 'Special Widget' },
    ]);

    // "special_widget" appears in predicate fields, and will match args string
    const resp = await callTool(harness, 'create_item', { id: 'special_widget', name: 'Special Widget' });
    const result = resp.result as any;
    expect(result.content[0].text).not.toContain('[GOVERNANCE]');
    expect(result.content[0].text).toContain('Created item special_widget');

    const receipts = loadReceipts(harness.stateDir);
    const last = receipts[receipts.length - 1];
    expect(last.attribution).toBe('direct');
  });

  test('receipts hash chain intact after G5 blocked calls', async () => {
    harness = await spawnProxy();
    await initProxy(harness);
    await harness.request('tools/list');

    // Multiple operations including G5 blocks
    await callTool(harness, 'create_item', { id: 'item_1', name: 'One' }); // no_intent → pass
    await declareIntent(harness, 'Manage item_1', [{ type: 'content', id: 'item_1' }]);
    await callTool(harness, 'update_item', { id: 'item_1', name: 'Updated' }); // direct → pass
    await callTool(harness, 'delete_item', { id: 'item_99' }); // unexplained → blocked
    await clearIntent(harness);
    await callTool(harness, 'create_item', { id: 'item_99', name: 'Now OK' }); // no_intent → pass

    // Verify hash chain integrity
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(3);

    // Check that chain is valid (each receipt references previous hash)
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].previousHash).toBe(receipts[i - 1].hash);
    }
    // First receipt references genesis
    expect(receipts[0].previousHash).toBe('genesis');
  });
});
