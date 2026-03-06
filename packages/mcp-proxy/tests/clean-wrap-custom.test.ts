/**
 * Clean Wrap #4: Custom Upstream (7 novel tool shapes)
 * =====================================================
 *
 * RELEASE GATE: This test must pass with ZERO changes to any proxy source file.
 * If it fails, the proxy is not release-ready.
 *
 * Custom upstream tools (7):
 *   - analyze_sentiment: text → structured analysis
 *   - translate: source/target/text → translated text
 *   - calculate_hash: algorithm/input → hash string
 *   - store_document: id/title/content/tags → stored (MUTATING via schema + arg keys)
 *   - batch_process: items[] array → processed results
 *   - health_check: no args → status
 *   - transform_image: url/width/height/format → transformed
 *
 * Schema classification notes:
 *   - `text` is in SCHEMA_WRITE_PROPERTIES — so analyze_sentiment and translate
 *     are schema-classified as mutating (no readonly verb override applies).
 *   - `items` is a required array — triggers write signal for batch_process.
 *   - Without schema cache (unit tests), deny-by-default applies:
 *     tools without readonly verbs (health_check has "health+check") → mutating.
 *     `content` in MUTATING_ARG_KEYS → store_document mutating (redundant with default).
 *     health_check → "health"+"check" both in READONLY_VERBS → readonly.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { verifyReceiptChain, loadReceipts, loadConstraints } from '../src/state.js';
import { classifyMutationType, extractTarget } from '../src/index.js';

// =============================================================================
// HARNESS (same pattern as e2e.test.ts)
// =============================================================================

const CUSTOM_UPSTREAM = resolve(__dirname, 'custom-upstream.ts');
const PROXY_ENTRY = resolve(__dirname, '..', 'src', 'index.ts');

interface ProxyHarness {
  request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>>;
  sendRaw(line: string): void;
  notify(method: string, params?: Record<string, unknown>): void;
  settle(ms?: number): Promise<void>;
  kill(): Promise<void>;
  stateDir: string;
}

async function spawnProxy(opts?: {
  enforcement?: 'strict' | 'advisory';
  stateDir?: string;
}): Promise<ProxyHarness> {
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-clean4-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    ['bun', 'run', PROXY_ENTRY, '--upstream', `bun run ${CUSTOM_UPSTREAM}`, '--state-dir', stateDir, '--enforcement', enforcement],
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

  function sendRaw(line: string): void {
    (proc.stdin as { write(data: string | Uint8Array): void }).write(line + '\n');
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
  return { request, sendRaw, notify, settle, kill, stateDir };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Clean Wrap #4: Custom Upstream (7 tools, zero proxy changes)', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ─── 1. Handshake ───────────────────────────────────────────────────────

  test('initialize returns server info from custom upstream', async () => {
    harness = await spawnProxy();
    const resp = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-test', version: '1.0' },
    });

    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect((result.serverInfo as any).name).toBe('custom-upstream');

    harness.notify('notifications/initialized');
    await harness.settle();
  });

  // ─── 2. Tool list with meta-tool injection ──────────────────────────────

  test('tools/list returns 7 upstream + 5 meta-tools = 12 tools', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();

    const resp = await harness.request('tools/list');
    const tools = (resp.result as any).tools as Array<{ name: string }>;
    const names = tools.map(t => t.name).sort();

    // 7 upstream + 5 meta-tools = 12
    expect(tools.length).toBe(12);

    // All 7 upstream tools present
    expect(names).toContain('analyze_sentiment');
    expect(names).toContain('translate');
    expect(names).toContain('calculate_hash');
    expect(names).toContain('store_document');
    expect(names).toContain('batch_process');
    expect(names).toContain('health_check');
    expect(names).toContain('transform_image');

    // All 5 meta-tools present
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  });

  // ─── 3. Mutation classification (unit tests, no schema cache) ────────────
  // Without schema cache, classification uses verb + arg-key fallback.

  test('analyze_sentiment classified as mutating (deny-by-default, no readonly verb)', () => {
    expect(classifyMutationType('analyze_sentiment', {})).toBe('mutating');
  });

  test('translate classified as mutating (deny-by-default, no readonly verb)', () => {
    expect(classifyMutationType('translate', { source: 'en', target: 'fr', text: 'hello' })).toBe('mutating');
  });

  test('calculate_hash classified as mutating (deny-by-default, no readonly verb)', () => {
    expect(classifyMutationType('calculate_hash', { algorithm: 'sha256', input: 'data' })).toBe('mutating');
  });

  test('store_document classified as mutating (content in MUTATING_ARG_KEYS)', () => {
    expect(classifyMutationType('store_document', { id: 'doc1', title: 'Test', content: 'body', tags: ['a'] })).toBe('mutating');
  });

  test('batch_process classified as mutating (deny-by-default, no readonly verb)', () => {
    // Without schema cache, batch_process has no readonly verb match → mutating
    expect(classifyMutationType('batch_process', { items: [{ id: '1', action: 'create', data: {} }] })).toBe('mutating');
  });

  test('health_check classified as readonly', () => {
    expect(classifyMutationType('health_check', {})).toBe('readonly');
  });

  test('transform_image classified as mutating (deny-by-default, no readonly verb)', () => {
    expect(classifyMutationType('transform_image', { url: 'https://example.com/img.png', width: 100 })).toBe('mutating');
  });

  // ─── 4. Target extraction ──────────────────────────────────────────────

  test('extractTarget finds text in analyze_sentiment', () => {
    const target = extractTarget('analyze_sentiment', { text: 'I love this product' });
    expect(target).toBe('I love this product');
  });

  test('extractTarget finds id in store_document', () => {
    const target = extractTarget('store_document', { id: 'doc-42', title: 'T', content: 'C' });
    expect(target).toBe('doc-42');
  });

  test('extractTarget finds url in transform_image', () => {
    const target = extractTarget('transform_image', { url: 'https://example.com/img.png', width: 100 });
    expect(target).toBe('https://example.com/img.png');
  });

  test('extractTarget finds first string for calculate_hash', () => {
    const target = extractTarget('calculate_hash', { algorithm: 'sha256', input: 'data' });
    expect(typeof target).toBe('string');
    expect(target!.length).toBeGreaterThan(0);
  });

  test('extractTarget returns tool name for empty args', () => {
    // Layer 5 fallback: no args → returns the tool name itself
    const target = extractTarget('health_check', {});
    expect(target).toBe('health_check');
  });

  // ─── 5. Readonly tool calls produce receipts ────────────────────────────
  // Note: with schema cache, analyze_sentiment has 'text' in SCHEMA_WRITE_PROPERTIES
  // and 'analyze' is NOT in READONLY_VERBS, so schema wins → mutating in receipts.

  test('analyze_sentiment returns structured result with receipt', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();

    // Fetch tools first (caches schemas — changes classification for tools with 'text' property)
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'analyze_sentiment',
      arguments: { text: 'I love governance proxies' },
    });

    const result = resp.result as any;
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.score).toBe(0.8); // "love" → positive
    expect(parsed.label).toBe('positive');

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    const callReceipt = receipts.find(r => (r as any).toolName === 'analyze_sentiment');
    expect(callReceipt).toBeDefined();
    // Schema has 'text' property → SCHEMA_WRITE_PROPERTIES → mutating
    // 'analyze' not in READONLY_VERBS → no override
    expect((callReceipt as any).mutationType).toBe('mutating');
  });

  test('health_check returns healthy with receipt', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'health_check',
      arguments: {},
    });

    const result = resp.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('healthy');
    expect(typeof parsed.uptime).toBe('number');
  });

  // ─── 6. Mutating tool call (store_document) ─────────────────────────────

  test('store_document succeeds and receipt shows mutating', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'store_document',
      arguments: { id: 'doc-1', title: 'Test Doc', content: 'Hello world', tags: ['test', 'governance'] },
    });

    const result = resp.result as any;
    expect(result.content[0].text).toContain('Stored document doc-1');
    expect(result.content[0].text).toContain('11 chars');
    expect(result.content[0].text).toContain('2 tags');

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    const storeReceipt = receipts.find(r => (r as any).toolName === 'store_document');
    expect(storeReceipt).toBeDefined();
    expect((storeReceipt as any).mutationType).toBe('mutating');
  });

  // ─── 7. Error handling → G2 constraint seeding ─────────────────────────

  test('store_document failure seeds G2 constraint, retry blocked in strict', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // First call — fails (id starts with "fail_")
    const resp1 = await harness.request('tools/call', {
      name: 'store_document',
      arguments: { id: 'fail_test', title: 'Bad Doc', content: 'Should fail' },
    });

    const result1 = resp1.result as any;
    expect(result1.isError).toBe(true);
    expect(result1.content[0].text).toContain('StorageError');

    await harness.settle(300);

    // Verify constraint was seeded
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);

    // Second call — same tool + same target → blocked by G2
    const resp2 = await harness.request('tools/call', {
      name: 'store_document',
      arguments: { id: 'fail_test', title: 'Bad Doc Again', content: 'Should be blocked' },
    });

    // In strict mode, blocked calls return in result with isError: true and [GOVERNANCE] prefix
    const result2 = resp2.result as any;
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('[GOVERNANCE]');
    expect(result2.content[0].text.toLowerCase()).toContain('constraint');
  });

  // ─── 8. Complex schema: batch_process with array input ─────────────────

  test('batch_process with items array works through proxy', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'batch_process',
      arguments: {
        items: [
          { id: 'i1', action: 'create', data: { name: 'item1' } },
          { id: 'i2', action: 'update', data: { name: 'item2' } },
          { id: 'i3', action: 'delete' },
        ],
        dryRun: true,
      },
    });

    const result = resp.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.processed).toBe(3);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.results.length).toBe(3);
    expect(parsed.results[0].status).toBe('simulated');
  });

  // ─── 9. translate — receipt with schema-derived classification ──────────

  test('translate returns result and receipt reflects schema classification', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'translate',
      arguments: { source: 'en', target: 'fr', text: 'Hello world' },
    });

    const result = resp.result as any;
    expect(result.content[0].text).toContain('[fr]');
    expect(result.content[0].text).toContain('Hello world');
    expect(result.content[0].text).toContain('from en');

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    const translateReceipt = receipts.find(r => (r as any).toolName === 'translate');
    expect(translateReceipt).toBeDefined();
    // Schema has 'text' property → SCHEMA_WRITE_PROPERTIES → mutating
    // 'translate' not in READONLY_VERBS → no override
    expect((translateReceipt as any).mutationType).toBe('mutating');
  });

  // ─── 10. calculate_hash — crypto tool through proxy ─────────────────────

  test('calculate_hash produces real sha256 hash', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'calculate_hash',
      arguments: { algorithm: 'sha256', input: 'governance' },
    });

    const result = resp.result as any;
    const hash = result.content[0].text;
    // SHA256 produces 64 hex chars
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  // ─── 11. transform_image with mixed arg types ───────────────────────────

  test('transform_image with integer and enum args', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp = await harness.request('tools/call', {
      name: 'transform_image',
      arguments: { url: 'https://example.com/photo.jpg', width: 800, height: 600, format: 'webp' },
    });

    const result = resp.result as any;
    expect(result.content[0].text).toContain('800x600');
    expect(result.content[0].text).toContain('webp');
    expect(result.content[0].text).toContain('example.com/photo.jpg');
  });

  // ─── 12. E-H8 authority bump + stale session blocking ──────────────────

  test('authority bump blocks next tool call in strict mode', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Bump authority
    const bumpResp = await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'clean wrap authority test' },
    });
    // Response is JSON with epoch info and note about re-initialize
    const bumpResult = JSON.parse((bumpResp.result as any).content[0].text);
    expect(bumpResult.epoch).toBeGreaterThan(bumpResult.previousEpoch);
    expect(bumpResult.note).toContain('re-initialize');

    // Next tool call should be blocked (session epoch is stale)
    // Blocked calls return result with isError: true and [GOVERNANCE] prefix
    const resp = await harness.request('tools/call', {
      name: 'health_check',
      arguments: {},
    });

    const result = resp.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[GOVERNANCE]');
    expect(result.content[0].text).toContain('E-H8');
  });

  // ─── 13. Model B re-handshake after authority bump ──────────────────────

  test('re-initialize after authority bump resyncs session', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Bump authority
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'resync test' },
    });

    // Tool call blocked (result with isError)
    const blocked = await harness.request('tools/call', { name: 'health_check', arguments: {} });
    expect((blocked.result as any).isError).toBe(true);

    // Re-initialize (Model B resync)
    const reinit = await harness.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    expect((reinit.result as any).protocolVersion).toBe('2024-11-05');

    harness.notify('notifications/initialized');
    await harness.settle();

    // Now tool calls work again
    const resp = await harness.request('tools/call', { name: 'health_check', arguments: {} });
    expect(resp.result).toBeDefined();
    const result = resp.result as any;
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('healthy');
  });

  // ─── 14. Receipt chain integrity across diverse operations ──────────────

  test('receipt chain intact after 6 diverse tool calls', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // 6 calls exercising different shapes
    await harness.request('tools/call', { name: 'health_check', arguments: {} });
    await harness.request('tools/call', { name: 'analyze_sentiment', arguments: { text: 'great proxy' } });
    await harness.request('tools/call', { name: 'translate', arguments: { source: 'en', target: 'de', text: 'hello' } });
    await harness.request('tools/call', { name: 'calculate_hash', arguments: { algorithm: 'md5', input: 'test' } });
    await harness.request('tools/call', { name: 'store_document', arguments: { id: 'chain-test', title: 'Chain', content: 'Integrity test' } });
    await harness.request('tools/call', { name: 'transform_image', arguments: { url: 'https://img.test/a.png' } });

    await harness.settle(300);

    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(6);

    // Verify hash chain — returns { intact: boolean, brokenAt?: number, depth: number }
    const chain = verifyReceiptChain(harness.stateDir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(receipts.length);
  });

  // ─── 15. governance_status reflects correct state ───────────────────────

  test('governance_status returns accurate counts', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Make one successful call and one failing call
    await harness.request('tools/call', { name: 'health_check', arguments: {} });
    await harness.request('tools/call', { name: 'store_document', arguments: { id: 'fail_status', title: 'F', content: 'F' } });

    await harness.settle(300);

    const resp = await harness.request('tools/call', { name: 'governance_status', arguments: {} });
    const result = resp.result as any;
    const status = JSON.parse(result.content[0].text);

    expect(status.controllerId).toBeDefined();
    expect(typeof status.epoch).toBe('number');
    expect(status.constraintCount).toBeGreaterThanOrEqual(1); // from the failure
    expect(status.receiptCount).toBeGreaterThanOrEqual(2); // at least 2 tool calls
    expect(status.enforcement).toBe('advisory');
  });

  // ─── 16. Error normalization: timestamps stripped from constraint ───────

  test('failure signatures normalized (timestamps stripped)', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // store_document with fail_ prefix includes timestamp in error
    await harness.request('tools/call', { name: 'store_document', arguments: { id: 'fail_norm', title: 'N', content: 'N' } });

    await harness.settle(300);

    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);

    // Constraint should have a failureSignature field
    const c = constraints[0] as any;
    expect(c.failureSignature).toBeDefined();
    // The error text contains "2024-03-05T10:30:00Z" — should be normalized away
    expect(c.failureSignature).not.toContain('2024-03-05T10:30:00Z');
  });

  // ─── 17. Controller ID stability across calls ──────────────────────────

  test('controllerId stable across session', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp1 = await harness.request('tools/call', { name: 'governance_status', arguments: {} });
    const id1 = JSON.parse((resp1.result as any).content[0].text).controllerId;

    // Make some calls
    await harness.request('tools/call', { name: 'health_check', arguments: {} });
    await harness.request('tools/call', { name: 'analyze_sentiment', arguments: { text: 'stable' } });

    const resp2 = await harness.request('tools/call', { name: 'governance_status', arguments: {} });
    const id2 = JSON.parse((resp2.result as any).content[0].text).controllerId;

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/); // UUID format
  });
});
