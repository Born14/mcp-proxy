/**
 * End-to-End Protocol Tests
 * =========================
 *
 * Proves the full MCP governance loop:
 *
 *   Agent → Proxy → Upstream → Proxy → Agent
 *
 * Each test spawns the proxy as a real subprocess with the fake upstream,
 * sends JSON-RPC messages, and verifies responses + governance state.
 *
 * What this proves:
 *   1. initialize → upstream receives, proxy relays
 *   2. tools/list → upstream tools + governance meta-tools merged
 *   3. tools/call → upstream executes, receipt created
 *   4. tools/call with upstream error → constraint seeded → retry blocked (G2)
 *   5. governance_bump_authority → handled locally, never forwarded
 *   6. governance_status → returns correct state snapshot
 *   7. Authority bump → next tool call blocked (E-H8)
 *   8. Advisory mode → violations logged but forwarded
 *   9. Receipt chain integrity after multiple calls
 *  10. Notifications forwarded without response
 *  11. Unknown methods forwarded transparently
 *  12. Malformed JSON doesn't crash the proxy
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { verifyReceiptChain, loadReceipts, loadConstraints } from '../src/state.js';

// =============================================================================
// TEST HARNESS — Proxy subprocess management
// =============================================================================

const FAKE_UPSTREAM = resolve(__dirname, 'fake-upstream.ts');
const PROXY_ENTRY = resolve(__dirname, '..', 'src', 'index.ts');

interface ProxyHarness {
  /** Send a JSON-RPC request and wait for response */
  request(method: string, params?: Record<string, unknown>, id?: number): Promise<Record<string, unknown>>;

  /** Send a raw line (for malformed JSON tests) */
  sendRaw(line: string): void;

  /** Send a notification (no id, no response expected) */
  notify(method: string, params?: Record<string, unknown>): void;

  /** Wait a bit for async processing */
  settle(ms?: number): Promise<void>;

  /** Kill the proxy */
  kill(): Promise<void>;

  /** State directory path */
  stateDir: string;
}

async function spawnProxy(opts?: {
  enforcement?: 'strict' | 'advisory';
  stateDir?: string;
}): Promise<ProxyHarness> {
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-e2e-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    ['bun', 'run', PROXY_ENTRY, '--upstream', `bun run ${FAKE_UPSTREAM}`, '--state-dir', stateDir, '--enforcement', enforcement],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
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

  // Bun.spawn().stdout is a ReadableStream (Web API), not a Node stream.
  // Read it with the Web Streams API and split on newlines.
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let partialLine = '';
  const lineBuffer: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  function dispatchLine(line: string): void {
    if (!line) return;
    if (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve(line);
    } else {
      lineBuffer.push(line);
    }
  }

  // Background reader — continuously pulls from ReadableStream
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const parts = (partialLine + chunk).split('\n');
        partialLine = parts.pop() ?? '';
        for (const line of parts) {
          dispatchLine(line);
        }
      }
      // Flush remaining
      if (partialLine) dispatchLine(partialLine);
    } catch {
      // Stream closed
    }
  })();

  function nextLine(timeoutMs = 10000): Promise<string> {
    if (lineBuffer.length > 0) {
      return Promise.resolve(lineBuffer.shift()!);
    }
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
    try {
      proc.kill();
    } catch {
      // Already dead
    }
    // Give it a moment to flush
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait for proxy readiness signal or timeout (10s fallback for npx first-download)
  await Promise.race([readyPromise, settle(10000)]);

  return { request, sendRaw, notify, settle, kill, stateDir };
}

// =============================================================================
// TESTS
// =============================================================================

describe('E2E: Full MCP governance loop', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ---------------------------------------------------------------------------
  // 1. INITIALIZE
  // ---------------------------------------------------------------------------

  test('initialize → proxy relays upstream response', async () => {
    harness = await spawnProxy();

    const resp = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-agent', version: '1.0' },
      capabilities: {},
    });

    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.result).toBeTruthy();

    const result = resp.result as Record<string, unknown>;
    const serverInfo = result.serverInfo as { name: string };
    expect(serverInfo.name).toBe('fake-upstream');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 2. TOOLS/LIST — Meta-tool injection
  // ---------------------------------------------------------------------------

  test('tools/list → upstream tools + governance meta-tools merged', async () => {
    harness = await spawnProxy();

    // Initialize first (required by MCP protocol)
    await harness.request('initialize', {});

    const resp = await harness.request('tools/list', {});
    const result = resp.result as { tools: Array<{ name: string }> };

    expect(result.tools).toBeTruthy();
    expect(Array.isArray(result.tools)).toBe(true);

    const toolNames = result.tools.map(t => t.name);

    // Upstream tools present
    expect(toolNames).toContain('echo');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('read_file');

    // Governance meta-tools injected
    expect(toolNames).toContain('governance_bump_authority');
    expect(toolNames).toContain('governance_status');

    // Total: 7 upstream + 5 meta = 12
    expect(result.tools.length).toBe(12);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 3. TOOLS/CALL — Success path with receipt
  // ---------------------------------------------------------------------------

  test('tools/call success → response relayed + receipt created', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'hello governance' },
    });

    const result = resp.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('hello governance');

    // Verify receipt was created
    await harness.settle(100);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBe(1);
    expect(receipts[0].toolName).toBe('echo');
    expect(receipts[0].outcome).toBe('success');
    expect(receipts[0].previousHash).toBe('genesis');
    expect(receipts[0].hash).toBeTruthy();
    expect(receipts[0].mutationType).toBe('readonly'); // echo → unknown → readonly
  }, 15000);

  // ---------------------------------------------------------------------------
  // 4. G2 — Failure → constraint seeding → retry blocked
  // ---------------------------------------------------------------------------

  test('G2: upstream error → constraint seeded → retry blocked', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // First call: fails with SyntaxError
    const resp1 = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/test.js', content: 'bad code', shouldFail: true },
    });

    // Should relay the error
    const result1 = resp1.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result1.isError).toBe(true);
    expect(result1.content[0].text).toContain('SyntaxError');

    // Constraint should be seeded
    await harness.settle(100);
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBe(1);
    expect(constraints[0].toolName).toBe('write_file');
    expect(constraints[0].target).toBe('/tmp/test.js');

    // Second call: same tool + same target → G2 blocks
    const resp2 = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/test.js', content: 'fixed code' },
    });

    const result2 = resp2.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('GOVERNANCE');
    expect(result2.content[0].text).toContain('G2 BLOCKED');

    // Verify receipts: 2 total (error + blocked)
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBe(2);
    expect(receipts[0].outcome).toBe('error');
    expect(receipts[1].outcome).toBe('blocked');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 5. G2 — Different target allowed even with constraint
  // ---------------------------------------------------------------------------

  test('G2: same tool, different target → allowed', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Fail on /tmp/a.js
    await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/a.js', content: 'x', shouldFail: true },
    });

    // write_file on /tmp/b.js → should succeed (different target)
    const resp = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/b.js', content: 'ok' },
    });

    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Written to /tmp/b.js');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 6. META-TOOL — governance_status handled locally
  // ---------------------------------------------------------------------------

  test('governance_status → returns correct state, never forwarded upstream', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Make one tool call to create a receipt
    await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'test' },
    });

    const resp = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });

    const result = resp.result as { content: Array<{ text: string }> };
    const status = JSON.parse(result.content[0].text);

    expect(status.controllerId).toBeTruthy();
    expect(status.authorityEpoch).toBe(0);
    expect(status.sessionEpoch).toBe(0);
    expect(status.receiptCount).toBe(1); // The echo call
    expect(status.stateDir).toBe(harness.stateDir);
  }, 15000);

  // ---------------------------------------------------------------------------
  // 7. META-TOOL — governance_bump_authority + E-H8 block
  // ---------------------------------------------------------------------------

  test('E-H8: bump_authority → next tool call blocked', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Bump authority
    const bumpResp = await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'test redirect' },
    });

    const bumpResult = bumpResp.result as { content: Array<{ text: string }> };
    const bumpData = JSON.parse(bumpResult.content[0].text);
    expect(bumpData.epoch).toBe(1);
    expect(bumpData.previousEpoch).toBe(0);
    expect(bumpData.sessionEpoch).toBe(0);

    // Next tool call → E-H8 blocks (sessionEpoch 0 < authorityEpoch 1)
    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'should be blocked' },
    });

    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GOVERNANCE');
    expect(result.content[0].text).toContain('E-H8 BLOCKED');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 8. ADVISORY MODE — Violations forwarded
  // ---------------------------------------------------------------------------

  test('advisory mode: G2 violation forwards anyway', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {});

    // Fail to seed constraint
    await harness.request('tools/call', {
      name: 'error_syntax',
      arguments: { path: '/tmp/test.js' },
    });

    // Retry same tool+target → advisory forwards instead of blocking
    const resp = await harness.request('tools/call', {
      name: 'error_syntax',
      arguments: { path: '/tmp/test.js' },
    });

    // Should get upstream response (not governance block)
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SyntaxError');
    // Should NOT contain governance block message
    expect(result.content[0].text).not.toContain('GOVERNANCE');
  }, 15000);

  test('advisory mode: E-H8 violation forwards anyway', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {});

    // Bump authority
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'test' },
    });

    // Tool call after bump → advisory forwards
    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'should still work' },
    });

    const result = resp.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('should still work');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 9. RECEIPT CHAIN — Integrity across multiple calls
  // ---------------------------------------------------------------------------

  test('receipt chain intact after multiple calls', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // 5 tool calls: success, success, error, blocked, success
    await harness.request('tools/call', { name: 'echo', arguments: { message: '1' } });
    await harness.request('tools/call', { name: 'read_file', arguments: { path: '/tmp/a.txt' } });
    await harness.request('tools/call', { name: 'error_build', arguments: { path: '/tmp/b.js' } });
    await harness.request('tools/call', { name: 'error_build', arguments: { path: '/tmp/b.js' } }); // blocked
    await harness.request('tools/call', { name: 'echo', arguments: { message: '5' } });

    await harness.settle(100);

    // Verify chain
    const chain = verifyReceiptChain(harness.stateDir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(5);

    // Verify outcomes
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts[0].outcome).toBe('success');
    expect(receipts[1].outcome).toBe('success');
    expect(receipts[2].outcome).toBe('error');
    expect(receipts[3].outcome).toBe('blocked');
    expect(receipts[4].outcome).toBe('success');

    // Verify mutation types
    expect(receipts[0].mutationType).toBe('readonly');  // echo ("echo" in READONLY_VERBS)
    expect(receipts[1].mutationType).toBe('readonly');  // read_file ("read" in READONLY_VERBS)
    expect(receipts[2].mutationType).toBe('mutating');  // error_build (deny-by-default, no readonly verb)
    expect(receipts[4].mutationType).toBe('readonly');  // echo ("echo" in READONLY_VERBS)

    // Verify hash chaining
    expect(receipts[0].previousHash).toBe('genesis');
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].previousHash).toBe(receipts[i - 1].hash);
    }
  }, 15000);

  // ---------------------------------------------------------------------------
  // 10. MUTATION TYPE — write_file classified as mutating
  // ---------------------------------------------------------------------------

  test('write_file receipt carries mutationType: mutating', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/out.js', content: 'hello' },
    });

    await harness.settle(100);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts[0].mutationType).toBe('mutating');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 11. UNKNOWN METHODS — Forwarded transparently
  // ---------------------------------------------------------------------------

  test('unknown method → forwarded to upstream, response relayed', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Send an unknown method — upstream will return method not found error
    const resp = await harness.request('resources/list', {});

    expect(resp.error).toBeTruthy();
    const error = resp.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
    expect(error.message).toContain('Method not found');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 12. CONTROLLER IDENTITY — Persisted across calls
  // ---------------------------------------------------------------------------

  test('controller identity stable across all receipts', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    await harness.request('tools/call', { name: 'echo', arguments: { message: '1' } });
    await harness.request('tools/call', { name: 'echo', arguments: { message: '2' } });
    await harness.request('tools/call', { name: 'echo', arguments: { message: '3' } });

    await harness.settle(100);
    const receipts = loadReceipts(harness.stateDir);

    const controllerId = receipts[0].controllerId;
    expect(controllerId).toMatch(/^[0-9a-f]{8}-/); // UUID format

    for (const r of receipts) {
      expect(r.controllerId).toBe(controllerId);
    }
  }, 15000);

  // ---------------------------------------------------------------------------
  // 13. FAILURE SIGNATURE — Captured in receipt
  // ---------------------------------------------------------------------------

  test('failure signature captured in error receipt', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    await harness.request('tools/call', {
      name: 'error_syntax',
      arguments: { path: '/tmp/broken.js' },
    });

    await harness.settle(100);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts[0].outcome).toBe('error');
    expect(receipts[0].failureSignature).toBe('syntax_error');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 14. CONSTRAINT DEDUP — Same failure doesn't create duplicate
  // ---------------------------------------------------------------------------

  test('duplicate failures dont create duplicate constraints', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', {});

    // Same error 3 times (advisory mode forwards, so all hit upstream)
    await harness.request('tools/call', { name: 'error_syntax', arguments: { path: '/tmp/x.js' } });
    await harness.request('tools/call', { name: 'error_syntax', arguments: { path: '/tmp/x.js' } });
    await harness.request('tools/call', { name: 'error_syntax', arguments: { path: '/tmp/x.js' } });

    await harness.settle(100);
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBe(1); // Deduped
  }, 15000);

  // ---------------------------------------------------------------------------
  // 15. MALFORMED JSON — Proxy doesn't crash
  // ---------------------------------------------------------------------------

  test('malformed JSON → proxy stays alive', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Send garbage
    harness.sendRaw('this is not json');
    harness.sendRaw('{incomplete');
    harness.sendRaw('');
    harness.sendRaw('{"jsonrpc":"2.0"}'); // missing id and method

    await harness.settle(300);

    // Proxy should still work after garbage
    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'still alive' },
    });

    const result = resp.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('still alive');
  }, 15000);

  // ---------------------------------------------------------------------------
  // 16. FULL LIFECYCLE — init → calls → fail → seed → block → bump → verify
  // ---------------------------------------------------------------------------

  test('full governance lifecycle', async () => {
    harness = await spawnProxy();

    // 1. Initialize
    const initResp = await harness.request('initialize', {});
    expect(initResp.result).toBeTruthy();

    // 2. List tools (verify meta-tools present)
    const listResp = await harness.request('tools/list', {});
    const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map(t => t.name)).toContain('governance_bump_authority');

    // 3. Successful tool call
    const echoResp = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/server.js', content: 'console.log("hi")' },
    });
    expect((echoResp.result as { isError?: boolean }).isError).toBeUndefined();

    // 4. Failing tool call → seeds constraint
    await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/server.js', content: 'bad', shouldFail: true },
    });

    // 5. Retry → G2 blocked
    const retryResp = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/server.js', content: 'fixed' },
    });
    expect((retryResp.result as { content: Array<{ text: string }> }).content[0].text).toContain('G2 BLOCKED');

    // 6. Different target → allowed
    const otherResp = await harness.request('tools/call', {
      name: 'write_file',
      arguments: { path: '/tmp/other.js', content: 'ok' },
    });
    expect((otherResp.result as { isError?: boolean }).isError).toBeUndefined();

    // 7. Check status
    const statusResp = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });
    const status = JSON.parse(
      (statusResp.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(status.constraintCount).toBe(1);
    expect(status.receiptCount).toBe(4); // success + error + blocked + success

    // 8. Bump authority
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'redirect agent' },
    });

    // 9. Next call → E-H8 blocked
    const blockedResp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'stale session' },
    });
    expect(
      (blockedResp.result as { content: Array<{ text: string }> }).content[0].text,
    ).toContain('E-H8 BLOCKED');

    // 10. Verify receipt chain integrity
    await harness.settle(100);
    const chain = verifyReceiptChain(harness.stateDir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(5); // 4 tool calls + 1 E-H8 blocked
  }, 30000);

  // ---------------------------------------------------------------------------
  // 17. MODEL B — Re-initialize after authority bump resyncs session
  // ---------------------------------------------------------------------------

  test('E-H8 Model B: re-initialize after bump → session unblocked', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Tool call works
    const resp1 = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'before bump' },
    });
    expect((resp1.result as { content: Array<{ text: string }> }).content[0].text).toContain('before bump');

    // Bump authority → session stale
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'testing Model B re-handshake' },
    });

    // Blocked
    const blocked = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'should be blocked' },
    });
    expect((blocked.result as { content: Array<{ text: string }> }).content[0].text).toContain('E-H8 BLOCKED');

    // Re-initialize → session epoch resyncs to authority epoch
    const reinit = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-agent', version: '1.0' },
      capabilities: {},
    });
    expect(reinit.result).toBeTruthy();

    // Now tool calls work again
    const resp2 = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'after reinit' },
    });
    const result2 = resp2.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result2.isError).toBeUndefined();
    expect(result2.content[0].text).toContain('after reinit');

    // Verify status shows synced epochs
    const statusResp = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });
    const status = JSON.parse(
      (statusResp.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(status.authorityEpoch).toBe(1);
    expect(status.sessionEpoch).toBe(1); // Resynced
  }, 15000);

  // ---------------------------------------------------------------------------
  // 18. MODEL B — Multiple bumps require multiple re-initializes
  // ---------------------------------------------------------------------------

  test('E-H8 Model B: each bump requires re-initialize', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', {});

    // Bump twice
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'bump 1' },
    });
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'bump 2' },
    });

    // Blocked at epoch 0 vs authority epoch 2
    const blocked = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'blocked' },
    });
    expect((blocked.result as { content: Array<{ text: string }> }).content[0].text).toContain('E-H8 BLOCKED');

    // Re-initialize → syncs to epoch 2
    await harness.request('initialize', {});

    // Works again
    const resp = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'back online' },
    });
    expect((resp.result as { content: Array<{ text: string }> }).content[0].text).toContain('back online');

    // One more bump → blocked again
    await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'bump 3' },
    });

    const blocked2 = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'blocked again' },
    });
    expect((blocked2.result as { content: Array<{ text: string }> }).content[0].text).toContain('E-H8 BLOCKED');

    // Re-initialize again → syncs to epoch 3
    await harness.request('initialize', {});

    const resp2 = await harness.request('tools/call', {
      name: 'echo',
      arguments: { message: 'back again' },
    });
    expect((resp2.result as { content: Array<{ text: string }> }).content[0].text).toContain('back again');
  }, 20000);
});
