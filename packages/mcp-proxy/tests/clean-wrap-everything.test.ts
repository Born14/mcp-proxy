/**
 * Clean Wrap #6: Everything Reference Server (13 diverse tools)
 * ==============================================================
 *
 * RELEASE GATE: This test must pass on FIRST RUN with ZERO changes to
 * any proxy source file OR this test file.
 *
 * Upstream: @modelcontextprotocol/server-everything v2.0.0 (13 tools)
 *
 * Upstream quirk: Sends notifications/tools/list_changed spontaneously.
 * The harness must skip notifications when waiting for request responses.
 *
 * Classification predictions:
 *   echo:                         readonly (verb 'echo' in READONLY_VERBS; schema has 'message' in WRITE_PROPS but readonly verb override wins)
 *   get-sum:                      readonly (verb 'get' in READONLY_VERBS; schema props a,b not in WRITE_PROPS)
 *   get-env:                      readonly (verb 'get'; no schema props)
 *   get-tiny-image:               readonly (verb 'get'; no schema props)
 *   get-annotated-message:        readonly (verb 'get'; 'messageType'/'includeImage' not in WRITE_PROPS)
 *   get-resource-links:           readonly (verb 'get'; 'count' not in WRITE_PROPS)
 *   get-resource-reference:       readonly (verb 'get'; 'resourceType'/'resourceId' not in WRITE_PROPS)
 *   get-structured-content:       readonly (verb 'get'; 'location' not in WRITE_PROPS)
 *   gzip-file-as-resource:        mutating (no verb match; 'data' in SCHEMA_WRITE_PROPERTIES)
 *   toggle-simulated-logging:     mutating (deny-by-default; no readonly verb in name)
 *   toggle-subscriber-updates:    mutating (deny-by-default; no readonly verb in name)
 *   trigger-long-running-operation: mutating (deny-by-default; no readonly verb in name)
 *   simulate-research-query:      readonly (verb 'query' in READONLY_VERBS; 'topic','ambiguous' not in WRITE_PROPS)
 *
 * extractTarget predictions:
 *   echo { message: 'X' }:        'X' (Layer 4: first string value; 'message' not in TARGET_KEYS)
 *   get-sum { a: 5, b: 3 }:       'get-sum' (Layer 5: no strings, no TARGET_KEYS)
 *   get-env {}:                    'get-env' (Layer 5: empty args)
 *   gzip-file-as-resource { name: 'X', data: 'Y' }: 'X' (Layer 1: 'name' in TARGET_KEYS)
 *   simulate-research-query { topic: 'X' }: 'X' (Layer 4: first string value)
 *   get-structured-content { location: 'X' }: 'X' (Layer 4: first string value)
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verifyReceiptChain, loadReceipts, loadConstraints } from '../src/state.js';

// =============================================================================
// HARNESS — notification-aware (everything server sends spontaneous notifications)
// =============================================================================

const PROXY_ENTRY = join(__dirname, '..', 'src', 'index.ts');

interface ProxyHarness {
  request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>>;
  settle(ms?: number): Promise<void>;
  kill(): Promise<void>;
  stateDir: string;
}

async function spawnProxy(opts?: {
  enforcement?: 'strict' | 'advisory';
  stateDir?: string;
}): Promise<ProxyHarness> {
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-clean6-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    [
      'bun', 'run', PROXY_ENTRY,
      '--upstream', 'npx -y @modelcontextprotocol/server-everything',
      '--state-dir', stateDir,
      '--enforcement', enforcement,
    ],
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
    } catch {
      // Stream closed
    }
  })();

  function nextLine(timeoutMs = 15000): Promise<string> {
    if (lineBuffer.length > 0) return Promise.resolve(lineBuffer.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for proxy response (${timeoutMs}ms)`));
      }, timeoutMs);
      waiters.push((line: string) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  let nextId = 1;

  /**
   * Send a JSON-RPC request and wait for the matching response.
   * Skips notifications (messages without an 'id' field) that the
   * everything server sends spontaneously.
   */
  async function request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>> {
    const msgId = id ?? nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params });
    (proc.stdin as { write(data: string | Uint8Array): void }).write(msg + '\n');

    // Read lines until we find one with our id
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const line = await nextLine(deadline - Date.now());
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // Skip notifications (no id) and responses for different ids
      if (parsed.id === msgId) return parsed;
      // If it's a notification, just drop it and keep waiting
    }
    throw new Error(`Timeout waiting for response to id ${msgId}`);
  }

  async function settle(ms = 300): Promise<void> {
    await new Promise(r => setTimeout(r, ms));
  }

  async function kill(): Promise<void> {
    try { proc.kill(); } catch { /* Already dead */ }
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait for proxy readiness signal or timeout (10s fallback for npx first-download)
  await Promise.race([readyPromise, settle(10000)]);

  return { request, settle, kill, stateDir };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Clean Wrap #6: Everything Server', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Initialize handshake
  // ---------------------------------------------------------------------------
  test('initialize returns server info', async () => {
    harness = await spawnProxy();
    const resp = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    expect(resp.jsonrpc).toBe('2.0');
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe('mcp-servers/everything');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 2. Tools list: 12 initial upstream + 5 meta-tools = 17 total
  //    (simulate-research-query is dynamically registered after list_changed
  //    notification — not in initial tools/list but callable via tools/call)
  // ---------------------------------------------------------------------------
  test('tools/list returns 17 tools (12 initial upstream + 5 meta)', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/list');
    const result = resp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map(t => t.name).sort();

    expect(names).toHaveLength(17);

    // Initial upstream tools (12 — simulate-research-query added dynamically)
    expect(names).toContain('echo');
    expect(names).toContain('get-sum');
    expect(names).toContain('get-env');
    expect(names).toContain('get-tiny-image');
    expect(names).toContain('get-annotated-message');
    expect(names).toContain('get-resource-links');
    expect(names).toContain('get-resource-reference');
    expect(names).toContain('get-structured-content');
    expect(names).toContain('gzip-file-as-resource');
    expect(names).toContain('toggle-simulated-logging');
    expect(names).toContain('toggle-subscriber-updates');
    expect(names).toContain('trigger-long-running-operation');

    // Governance meta-tools
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 3. echo: readonly, target = message text
  // ---------------------------------------------------------------------------
  test('echo: readonly classification, target is message text', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'governance test message' },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('governance test message');

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'echo');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    expect(receipt!.outcome).toBe('success');
    // extractTarget: 'message' not in TARGET_KEYS, Layer 4 first string → message text
    expect(receipt!.target).toBe('governance test message');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 4. get-sum: readonly, target = tool name (no strings in args)
  // ---------------------------------------------------------------------------
  test('get-sum: readonly, target is tool name', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'get-sum',
      arguments: { a: 10, b: 20 },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('30');

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'get-sum');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    // No string values, no TARGET_KEYS → Layer 5 → tool name
    expect(receipt!.target).toBe('get-sum');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 5. get-env: readonly, target = tool name (no args)
  // ---------------------------------------------------------------------------
  test('get-env: readonly, target is tool name', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'get-env',
      arguments: {},
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'get-env');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    expect(receipt!.target).toBe('get-env');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 6. gzip-file-as-resource: MUTATING (schema has 'data'), target from 'name'
  // ---------------------------------------------------------------------------
  test('gzip-file-as-resource: mutating classification, target from name key', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'gzip-file-as-resource',
      arguments: { name: 'test-file.txt', data: 'Hello World' },
    });

    // This tool creates a resource — should succeed
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'gzip-file-as-resource');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('mutating');
    // 'name' is in TARGET_KEYS → Layer 1
    expect(receipt!.target).toBe('test-file.txt');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 7. simulate-research-query: readonly, target = topic text
  // ---------------------------------------------------------------------------
  test('simulate-research-query: readonly, target is topic', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'simulate-research-query',
      arguments: { topic: 'governance systems' },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'simulate-research-query');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    // 'topic' not in TARGET_KEYS, Layer 4 first string → topic value
    expect(receipt!.target).toBe('governance systems');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 8. get-structured-content: readonly, target = location
  // ---------------------------------------------------------------------------
  test('get-structured-content: readonly, target is location', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'get-structured-content',
      arguments: { location: 'New York' },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'get-structured-content');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    // 'location' not in TARGET_KEYS, Layer 4 → location value
    expect(receipt!.target).toBe('New York');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 9. toggle tools: mutating (deny-by-default, "toggle" not in READONLY_VERBS)
  // ---------------------------------------------------------------------------
  test('toggle tools classified as mutating (deny-by-default)', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'toggle-simulated-logging',
      arguments: {},
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'toggle-simulated-logging');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('mutating');
    expect(receipt!.target).toBe('toggle-simulated-logging');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 10. Receipt chain integrity after mixed tool calls
  // ---------------------------------------------------------------------------
  test('receipt chain intact after diverse tool calls', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // Mix of different tools
    await harness.request('tools/call', { name: 'echo', arguments: { message: 'chain-1' } });
    await harness.request('tools/call', { name: 'get-sum', arguments: { a: 1, b: 2 } });
    await harness.request('tools/call', { name: 'get-env', arguments: {} });
    await harness.request('tools/call', {
      name: 'gzip-file-as-resource',
      arguments: { name: 'chain-test.txt', data: 'test data' },
    });

    await harness.settle(500);
    const chainResult = verifyReceiptChain(harness.stateDir);
    expect(chainResult.intact).toBe(true);
    expect(chainResult.depth).toBeGreaterThanOrEqual(4);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 11. Error handling: bad tool name → upstream error, constraint seeded
  // ---------------------------------------------------------------------------
  test('nonexistent tool: upstream error receipted, constraint seeded', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });

    // Upstream returns isError: true with "Tool nonexistent-tool not found"
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const errorReceipt = receipts.find(r => r.toolName === 'nonexistent-tool');
    expect(errorReceipt).toBeDefined();
    expect(errorReceipt!.outcome).toBe('error');

    // Constraint seeded
    const constraints = loadConstraints(harness.stateDir);
    const constraint = constraints.find(c => c.toolName === 'nonexistent-tool');
    expect(constraint).toBeDefined();
  }, 30000);

  // ---------------------------------------------------------------------------
  // 12. G2: Retry of failed tool blocked in strict mode
  // ---------------------------------------------------------------------------
  test('G2: retry of nonexistent tool blocked', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // First call fails
    await harness.request('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });
    await harness.settle(500);

    // Retry blocked
    const resp2 = await harness.request('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });

    const result2 = resp2.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('[GOVERNANCE]');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 13. E-H8: Authority bump blocks, re-initialize resyncs
  // ---------------------------------------------------------------------------
  test('E-H8: authority bump and resync cycle', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // Bump
    const bumpResp = await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'everything server test' },
    });
    const bumpData = JSON.parse(
      (bumpResp.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(bumpData.epoch).toBe(bumpData.previousEpoch + 1);

    // Blocked
    const blocked = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'should be blocked' },
    });
    expect((blocked.result as { isError?: boolean }).isError).toBe(true);

    // Resync
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // Unblocked
    const unblocked = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'should work now' },
    });
    const result = unblocked.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('should work now');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 14. Advisory mode: violations forwarded, not blocked
  // ---------------------------------------------------------------------------
  test('advisory mode forwards G2 violations', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // Fail to seed constraint
    await harness.request('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });
    await harness.settle(500);

    // Retry — forwarded in advisory mode
    const resp = await harness.request('tools/call', {
      name: 'nonexistent-tool',
      arguments: {},
    });

    // Gets upstream error (not governance block)
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 15. Controller ID stable across calls
  // ---------------------------------------------------------------------------
  test('E-H7: controller ID stable', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const status1 = JSON.parse(
      ((await harness.request('tools/call', { name: 'governance_status', arguments: {} }))
        .result as { content: Array<{ text: string }> }).content[0].text,
    );

    await harness.request('tools/call', { name: 'echo', arguments: { message: 'mid-call' } });

    const status2 = JSON.parse(
      ((await harness.request('tools/call', { name: 'governance_status', arguments: {} }))
        .result as { content: Array<{ text: string }> }).content[0].text,
    );

    expect(status1.controllerId).toBe(status2.controllerId);
    expect(status2.receiptCount).toBeGreaterThan(status1.receiptCount);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 16. First receipt chains from genesis
  // ---------------------------------------------------------------------------
  test('first receipt has previousHash genesis', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'genesis test' },
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    expect(receipts[0].previousHash).toBe('genesis');
    expect(typeof receipts[0].hash).toBe('string');
    expect(receipts[0].hash.length).toBeGreaterThan(0);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 17. Mixed mutating + readonly receipts have correct types
  // ---------------------------------------------------------------------------
  test('mixed mutating and readonly calls correctly typed', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    // Readonly
    await harness.request('tools/call', { name: 'echo', arguments: { message: 'readonly call' } });
    // Mutating (schema has 'data' in SCHEMA_WRITE_PROPERTIES)
    await harness.request('tools/call', {
      name: 'gzip-file-as-resource',
      arguments: { name: 'mixed-test.txt', data: 'mixed data' },
    });
    // Readonly
    await harness.request('tools/call', { name: 'get-sum', arguments: { a: 1, b: 1 } });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);

    const echoR = receipts.find(r => r.toolName === 'echo');
    const gzipR = receipts.find(r => r.toolName === 'gzip-file-as-resource');
    const sumR = receipts.find(r => r.toolName === 'get-sum');

    expect(echoR!.mutationType).toBe('readonly');
    expect(gzipR!.mutationType).toBe('mutating');
    expect(sumR!.mutationType).toBe('readonly');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 18. get-annotated-message: readonly ('messageType' != 'message')
  // ---------------------------------------------------------------------------
  test('get-annotated-message: readonly classification', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'get-annotated-message',
      arguments: { messageType: 'error' },
    });

    const result = resp.result as { content: Array<{ type: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'get-annotated-message');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    // Layer 4 first string value → 'error' (messageType value)
    expect(receipt!.target).toBe('error');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 19. trigger-long-running-operation: mutating (deny-by-default, no readonly verb)
  // ---------------------------------------------------------------------------
  test('trigger-long-running-operation: mutating (deny-by-default), succeeds through proxy', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'trigger-long-running-operation',
      arguments: { duration: 1, steps: 2 },
    });

    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('completed');

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'trigger-long-running-operation');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('mutating');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 20. get-tiny-image: readonly, returns image content
  // ---------------------------------------------------------------------------
  test('get-tiny-image: readonly, returns content', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-6', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'get-tiny-image',
      arguments: {},
    });

    const result = resp.result as { content: Array<{ type: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content).toBeArray();

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'get-tiny-image');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('readonly');
    expect(receipt!.target).toBe('get-tiny-image');
  }, 30000);
});
