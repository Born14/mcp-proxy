/**
 * Clean Wrap #5: Sequential Thinking Server
 * ==========================================
 *
 * RELEASE GATE: This test must pass on FIRST RUN with ZERO changes to
 * any proxy source file OR this test file.
 *
 * Upstream: @modelcontextprotocol/server-sequential-thinking (1 tool)
 *   - sequentialthinking: thought/nextThoughtNeeded/thoughtNumber/totalThoughts → structured output
 *
 * Classification prediction:
 *   - Tool name tokens: ['sequential', 'thinking'] — no verb matches
 *   - Schema properties: thought, nextThoughtNeeded, thoughtNumber, totalThoughts,
 *     isRevision, revisesThought, branchFromThought, branchId, needsMoreThoughts
 *   - None of these are in SCHEMA_WRITE_PROPERTIES (thought ≠ text)
 *   - No MUTATING_ARG_KEYS match (content/data/body/value)
 *   - Final classification: readonly (default fallback)
 *
 * extractTarget prediction:
 *   - No TARGET_KEYS match (path/file/uri/url/name/key/id/resource/table/collection/database/topic/channel/queue)
 *   - No nested objects → Layer 2 skip
 *   - No arrays → Layer 3 skip
 *   - Layer 4: first string value → value of `thought` parameter
 *   - Empty args: Layer 5 fallback → toolName ('sequentialthinking')
 *
 * Error shape from upstream: { result: { content: [{type:'text', text:'MCP error...'}], isError: true } }
 * Success shape: { result: { content: [{type:'text', text:'...json...'}], structuredContent: {...} } }
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verifyReceiptChain, loadReceipts, loadConstraints } from '../src/state.js';

// =============================================================================
// HARNESS
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
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-clean5-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    [
      'bun', 'run', PROXY_ENTRY,
      '--upstream', 'npx -y @modelcontextprotocol/server-sequential-thinking',
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

  async function request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>> {
    const msgId = id ?? nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params });
    (proc.stdin as { write(data: string | Uint8Array): void }).write(msg + '\n');
    const line = await nextLine();
    return JSON.parse(line) as Record<string, unknown>;
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

describe('Clean Wrap #5: Sequential Thinking', () => {
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
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    expect(resp.jsonrpc).toBe('2.0');
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe('sequential-thinking-server');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 2. Tools list: 1 upstream + 5 meta-tools = 6 total
  // ---------------------------------------------------------------------------
  test('tools/list returns 6 tools (1 upstream + 5 meta)', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    const resp = await harness.request('tools/list');
    const result = resp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map(t => t.name).sort();

    expect(names).toHaveLength(6);
    expect(names).toContain('sequentialthinking');
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 3. Successful tool call returns structured content
  // ---------------------------------------------------------------------------
  test('sequentialthinking call returns thought data', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Analyzing the proxy governance layer',
        nextThoughtNeeded: true,
        thoughtNumber: 1,
        totalThoughts: 3,
      },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeArray();
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(result.content[0].type).toBe('text');

    // Parse the text content — it's JSON with thoughtNumber, totalThoughts, etc.
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.thoughtNumber).toBe(1);
    expect(parsed.totalThoughts).toBe(3);
    expect(parsed.nextThoughtNeeded).toBe(true);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 4. Receipt created for successful call
  // ---------------------------------------------------------------------------
  test('successful call creates a receipt', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Receipt test thought',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    const last = receipts[receipts.length - 1];
    expect(last.toolName).toBe('sequentialthinking');
    expect(last.outcome).toBe('success');
    expect(last.mutationType).toBe('mutating'); // deny-by-default: no readonly verb
    // extractTarget Layer 4: first string value = thought text
    expect(last.target).toBe('Receipt test thought');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 5. Classification: sequentialthinking is mutating (deny-by-default)
  // ---------------------------------------------------------------------------
  test('sequentialthinking classified as mutating in receipt (deny-by-default)', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Classification test',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'sequentialthinking');
    expect(receipt).toBeDefined();
    expect(receipt!.mutationType).toBe('mutating'); // deny-by-default: no readonly verb
  }, 30000);

  // ---------------------------------------------------------------------------
  // 6. extractTarget returns thought string (Layer 4)
  // ---------------------------------------------------------------------------
  test('extractTarget returns thought string value', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Target extraction test value',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const receipt = receipts.find(r => r.toolName === 'sequentialthinking');
    expect(receipt!.target).toBe('Target extraction test value');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 7. Upstream error creates receipt with error outcome
  // ---------------------------------------------------------------------------
  test('upstream validation error creates error receipt', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Empty arguments triggers upstream validation error (missing required fields)
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    // Upstream returns isError: true — proxy forwards it
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation error');

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const errorReceipt = receipts.find(r => r.outcome === 'error');
    expect(errorReceipt).toBeDefined();
    expect(errorReceipt!.toolName).toBe('sequentialthinking');
    // Empty args → Layer 5 fallback → toolName
    expect(errorReceipt!.target).toBe('sequentialthinking');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 8. G2: Upstream error seeds constraint, retry blocked (strict mode)
  // ---------------------------------------------------------------------------
  test('G2: same failing call blocked on retry', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // First call — upstream fails, constraint seeded
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    await harness.settle(500);

    // Verify constraint was seeded
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);
    const constraint = constraints.find(c => c.toolName === 'sequentialthinking');
    expect(constraint).toBeDefined();
    expect(constraint!.target).toBe('sequentialthinking');
    expect(typeof constraint!.failureSignature).toBe('string');

    // Second call — same tool + same empty args = same target → blocked
    const resp2 = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    // Blocked response shape: result.isError with [GOVERNANCE] prefix
    const result2 = resp2.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('[GOVERNANCE]');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 9. G2: Different target NOT blocked after failure
  // ---------------------------------------------------------------------------
  test('G2: different target not blocked', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Fail with empty args (target = 'sequentialthinking')
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    await harness.settle(500);

    // Call with real args (target = thought string, different from 'sequentialthinking')
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'This has a different target',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    // Should succeed — different target
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.thoughtNumber).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 10. E-H8: Authority bump blocks next call (strict mode)
  // ---------------------------------------------------------------------------
  test('E-H8: authority bump blocks subsequent calls', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Bump authority
    const bumpResp = await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'testing E-H8' },
    });

    const bumpResult = bumpResp.result as { content: Array<{ type: string; text: string }> };
    const bumpData = JSON.parse(bumpResult.content[0].text);
    expect(bumpData.epoch).toBeDefined();
    expect(bumpData.previousEpoch).toBeDefined();
    expect(bumpData.epoch).toBe(bumpData.previousEpoch + 1);

    // Next tool call should be blocked (stale session epoch)
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Should be blocked',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[GOVERNANCE]');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 11. Model B re-handshake: initialize resyncs epoch
  // ---------------------------------------------------------------------------
  test('re-initialize resyncs authority after bump', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Bump authority
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'resync test' },
    });

    // Blocked
    const blocked = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Blocked thought',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });
    const blockedResult = blocked.result as { isError?: boolean };
    expect(blockedResult.isError).toBe(true);

    // Re-initialize to resync
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Now should work again
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Unblocked after resync',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.thoughtNumber).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 12. governance_status returns state snapshot
  // ---------------------------------------------------------------------------
  test('governance_status returns correct state', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Make one call to have a receipt
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Status check thought',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    await harness.settle(500);

    const resp = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    const status = JSON.parse(result.content[0].text);

    expect(status.controllerId).toBeDefined();
    expect(typeof status.controllerId).toBe('string');
    expect(status.enforcement).toBe('strict');
    expect(status.receiptCount).toBeGreaterThanOrEqual(1);
    expect(typeof status.constraintCount).toBe('number');
    expect(typeof status.epoch).toBe('number');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 13. Receipt chain integrity
  // ---------------------------------------------------------------------------
  test('receipt chain is intact after multiple calls', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Make 3 successful calls to build a chain
    for (let i = 1; i <= 3; i++) {
      await harness.request('tools/call', {
        name: 'sequentialthinking',
        arguments: {
          thought: `Chain test thought ${i}`,
          nextThoughtNeeded: i < 3,
          thoughtNumber: i,
          totalThoughts: 3,
        },
      });
    }

    await harness.settle(500);

    const chainResult = verifyReceiptChain(harness.stateDir);
    expect(chainResult.intact).toBe(true);
    expect(chainResult.depth).toBeGreaterThanOrEqual(3);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 14. Advisory mode: violations logged but forwarded
  // ---------------------------------------------------------------------------
  test('advisory mode forwards despite authority violation', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Bump authority
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'advisory test' },
    });

    // In advisory mode, call is forwarded despite stale epoch
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Advisory mode allows this',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    // Should succeed — advisory mode forwards
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.thoughtNumber).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 15. Advisory mode: G2 constraint logged but forwarded
  // ---------------------------------------------------------------------------
  test('advisory mode forwards despite G2 constraint', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Fail to seed constraint
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    await harness.settle(500);

    // Retry — in advisory mode, constraint is logged but call is forwarded
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {},
    });

    // Forwarded to upstream, which will fail again (isError from upstream)
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    // But it contains the upstream error, not [GOVERNANCE] prefix
    expect(result.content[0].text).toContain('validation error');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 16. Multi-thought sequence: receipts track each call
  // ---------------------------------------------------------------------------
  test('multi-thought sequence creates receipts for each step', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    const thoughts = [
      'Step 1: Define the problem',
      'Step 2: Analyze components',
      'Step 3: Synthesize solution',
    ];

    for (let i = 0; i < thoughts.length; i++) {
      await harness.request('tools/call', {
        name: 'sequentialthinking',
        arguments: {
          thought: thoughts[i],
          nextThoughtNeeded: i < thoughts.length - 1,
          thoughtNumber: i + 1,
          totalThoughts: thoughts.length,
        },
      });
    }

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    const thinkingReceipts = receipts.filter(r => r.toolName === 'sequentialthinking');

    expect(thinkingReceipts.length).toBe(3);
    // Each receipt has a different target (the thought text)
    const targets = thinkingReceipts.map(r => r.target);
    expect(targets).toContain('Step 1: Define the problem');
    expect(targets).toContain('Step 2: Analyze components');
    expect(targets).toContain('Step 3: Synthesize solution');

    // All mutating (deny-by-default: no readonly verb in "sequentialthinking")
    for (const r of thinkingReceipts) {
      expect(r.mutationType).toBe('mutating');
      expect(r.outcome).toBe('success');
    }
  }, 30000);

  // ---------------------------------------------------------------------------
  // 17. Revision thought works through proxy
  // ---------------------------------------------------------------------------
  test('revision thought passes through correctly', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Initial thought
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Initial approach',
        nextThoughtNeeded: true,
        thoughtNumber: 1,
        totalThoughts: 2,
      },
    });

    // Revision thought
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Actually, revising thought 1',
        nextThoughtNeeded: false,
        thoughtNumber: 2,
        totalThoughts: 2,
        isRevision: true,
        revisesThought: 1,
      },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.thoughtNumber).toBe(2);
    expect(parsed.nextThoughtNeeded).toBe(false);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 18. Branch thought works through proxy
  // ---------------------------------------------------------------------------
  test('branch thought passes through correctly', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Initial thought
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Main approach',
        nextThoughtNeeded: true,
        thoughtNumber: 1,
        totalThoughts: 3,
      },
    });

    // Branch from thought 1
    const resp = await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Alternative approach branching from thought 1',
        nextThoughtNeeded: false,
        thoughtNumber: 2,
        totalThoughts: 3,
        branchFromThought: 1,
        branchId: 'alt-approach',
      },
    });

    const result = resp.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.branches).toContain('alt-approach');
  }, 30000);

  // ---------------------------------------------------------------------------
  // 19. E-H7: Controller ID persisted and stable
  // ---------------------------------------------------------------------------
  test('controller ID is stable across calls', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    // Get status to see controllerId
    const resp1 = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });
    const status1 = JSON.parse(
      (resp1.result as { content: Array<{ text: string }> }).content[0].text,
    );

    // Make a tool call
    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Identity test',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    // Get status again
    const resp2 = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });
    const status2 = JSON.parse(
      (resp2.result as { content: Array<{ text: string }> }).content[0].text,
    );

    // Same controller ID
    expect(status1.controllerId).toBe(status2.controllerId);
    // Receipt count increased
    expect(status2.receiptCount).toBeGreaterThan(status1.receiptCount);
  }, 30000);

  // ---------------------------------------------------------------------------
  // 20. Receipt hash chain starts from genesis
  // ---------------------------------------------------------------------------
  test('first receipt chains from genesis', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-5', version: '1.0.0' },
    });

    await harness.request('tools/call', {
      name: 'sequentialthinking',
      arguments: {
        thought: 'Genesis chain test',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    });

    await harness.settle(500);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    // First receipt should have a hash (computed from genesis + payload)
    const first = receipts[0];
    expect(first.hash).toBeDefined();
    expect(typeof first.hash).toBe('string');
    expect(first.hash.length).toBeGreaterThan(0);
    expect(first.previousHash).toBe('genesis');
  }, 30000);
});
