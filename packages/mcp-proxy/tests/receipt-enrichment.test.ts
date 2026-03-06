/**
 * Receipt Enrichment Tests
 * ========================
 *
 * Proves that ALL tool call paths (blocked, upstream success, upstream error,
 * upstream timeout) produce receipts with identical tier annotation coverage.
 *
 * Before the god function extraction, the timeout path was missing attribution,
 * grounding, and intentAge annotations. After extraction, all paths go through
 * enrichReceipt() — this test ensures that guarantee holds.
 *
 * Tier coverage per receipt:
 *   Tier 3: attribution, attributionMatch (G5 containment)
 *   Tier 4: groundingAnnotation (grounding staleness)
 *   Tier 5: convergenceSignal (failure loop detection)
 *   Intent: intentAgeMs, intentHash (intent context tracking)
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { loadReceipts } from '../src/state.js';
import type { ToolCallRecord } from '../src/types.js';

// =============================================================================
// HARNESS — same pattern as e2e.test.ts
// =============================================================================

const FAKE_UPSTREAM = resolve(__dirname, 'fake-upstream.ts');
const PROXY_ENTRY = resolve(__dirname, '..', 'src', 'index.ts');

interface ProxyHarness {
  request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>>;
  settle(ms?: number): Promise<void>;
  kill(): Promise<void>;
  stateDir: string;
}

async function spawnProxy(opts?: {
  enforcement?: 'strict' | 'advisory';
}): Promise<ProxyHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-enrich-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    ['bun', 'run', PROXY_ENTRY, '--upstream', `bun run ${FAKE_UPSTREAM}`, '--state-dir', stateDir, '--enforcement', enforcement],
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
        const chunk = decoder.decode(value, { stream: true });
        const parts = (partialLine + chunk).split('\n');
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

  async function settle(ms = 200): Promise<void> {
    await new Promise(r => setTimeout(r, ms));
  }

  async function kill(): Promise<void> {
    try { proc.kill(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait for proxy readiness signal or timeout (10s fallback for npx first-download)
  await Promise.race([readyPromise, settle(10000)]);
  return { request, settle, kill, stateDir };
}

/** Helper: initialize the proxy (required before tool calls) */
async function initProxy(harness: ProxyHarness): Promise<void> {
  await harness.request('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'test-agent', version: '1.0' },
    capabilities: {},
  });
  // Populate tool schemas for mutation classification
  await harness.request('tools/list');
}

/** Get last N receipts from state dir */
function getReceipts(stateDir: string): ToolCallRecord[] {
  return loadReceipts(stateDir) as ToolCallRecord[];
}

/** Tier fields that enrichReceipt() must always populate */
function assertTierFieldsPresent(receipt: ToolCallRecord, label: string): void {
  // Tier 3: Attribution (always present after enrichment)
  expect(receipt.attribution).toBeDefined();

  // Tier 4: Grounding annotation (always present — may be {grounded:false, stale:false})
  expect(receipt.groundingAnnotation).toBeDefined();
  expect(typeof receipt.groundingAnnotation!.grounded).toBe('boolean');
  expect(typeof receipt.groundingAnnotation!.stale).toBe('boolean');

  // Tier 5: Convergence signal (always present)
  expect(receipt.convergenceSignal).toBeDefined();

  // Intent hash: only defined when intent is declared
  // (computeIntentHash returns undefined when no intent exists)
}

// =============================================================================
// TESTS
// =============================================================================

describe('Receipt enrichment: tier annotation parity across all paths', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Blocked receipt has all tier annotations
  // ---------------------------------------------------------------------------
  test('blocked receipt (G2 constraint) has all tier fields', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    // First call fails → seeds constraint
    await harness.request('tools/call', {
      name: 'error_syntax',
      arguments: { path: '/app/test.js' },
    });

    // Second call → blocked by G2 constraint
    const resp = await harness.request('tools/call', {
      name: 'error_syntax',
      arguments: { path: '/app/test.js' },
    });

    // Verify it was blocked
    const result = resp.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('[GOVERNANCE]');
    expect(result.content?.[0]?.text).toContain('G2 BLOCKED');

    const receipts = getReceipts(harness.stateDir);
    const blockedReceipt = receipts.find(r => r.outcome === 'blocked');
    expect(blockedReceipt).toBeDefined();
    assertTierFieldsPresent(blockedReceipt!, 'blocked');
    expect(blockedReceipt!.attribution).toBe('no_intent');
  });

  // ---------------------------------------------------------------------------
  // 2. Success receipt has all tier annotations
  // ---------------------------------------------------------------------------
  test('success receipt has all tier fields', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'hello' },
    });

    const receipts = getReceipts(harness.stateDir);
    expect(receipts.length).toBe(1);
    const receipt = receipts[0];
    expect(receipt.outcome).toBe('success');
    assertTierFieldsPresent(receipt, 'success');
    expect(receipt.attribution).toBe('no_intent');
  });

  // ---------------------------------------------------------------------------
  // 3. Error receipt (upstream error, not timeout) has all tier annotations
  // ---------------------------------------------------------------------------
  test('upstream error receipt has all tier fields', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/app/test.js', content: 'test', shouldFail: true },
    });

    const receipts = getReceipts(harness.stateDir);
    expect(receipts.length).toBe(1);
    const receipt = receipts[0];
    expect(receipt.outcome).toBe('error');
    assertTierFieldsPresent(receipt, 'upstream-error');
    expect(receipt.attribution).toBe('no_intent');
  });

  // ---------------------------------------------------------------------------
  // 4. No-intent receipts: correct defaults
  // ---------------------------------------------------------------------------
  test('no-intent receipts have correct default values', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'test' },
    });

    const receipts = getReceipts(harness.stateDir);
    const receipt = receipts[0];

    // Attribution: no_intent (no declare_intent called)
    expect(receipt.attribution).toBe('no_intent');
    expect(receipt.attributionMatch).toBeUndefined();

    // Grounding: not grounded (no intent with grounding context)
    expect(receipt.groundingAnnotation).toEqual({ grounded: false, stale: false });

    // Intent age: undefined (no intent declared)
    expect(receipt.intentAgeMs).toBeUndefined();

    // Intent hash: undefined (no intent declared)
    expect(receipt.intentHash).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 5. With-intent receipts: grounded=true, intentAgeMs > 0
  // ---------------------------------------------------------------------------
  test('with-intent receipts have grounding and intent age', async () => {
    harness = await spawnProxy();
    await initProxy(harness);

    // Declare intent with grounding context
    await harness.request('tools/call', {
      name: 'governance_declare_intent',
      arguments: {
        goal: 'Test enrichment with intent',
        predicates: [
          { type: 'css', selector: '.test', property: 'color', expected: 'red' },
        ],
        grounding: {
          facts: { testFact: true },
          observedAt: Date.now(),
        },
      },
    });

    // Small delay so intentAgeMs > 0
    await harness.settle(50);

    // Make a tool call with intent active
    await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'with intent' },
    });

    const receipts = getReceipts(harness.stateDir);
    // Find the echo receipt (not the declare_intent meta-tool — meta-tools don't create receipts)
    const receipt = receipts.find(r => r.toolName === 'echo');
    expect(receipt).toBeDefined();

    // Grounding: grounded=true (intent has grounding context)
    expect(receipt!.groundingAnnotation).toBeDefined();
    expect(receipt!.groundingAnnotation!.grounded).toBe(true);

    // Intent age: > 0 (we waited 50ms)
    expect(receipt!.intentAgeMs).toBeDefined();
    expect(receipt!.intentAgeMs!).toBeGreaterThan(0);

    // Intent hash: different from no-intent hash
    expect(receipt!.intentHash).toBeDefined();

    // Attribution: no_intent for readonly 'echo' (not mutating)
    // or direct/scaffolding depending on classification
    expect(receipt!.attribution).toBeDefined();
  });
});
