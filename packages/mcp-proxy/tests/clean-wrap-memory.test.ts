/**
 * Clean Wrap #7: Memory Server (Knowledge Graph)
 * ===============================================
 *
 * RELEASE GATE: This test must pass with ZERO changes to any proxy source file.
 * If it fails, the proxy is not release-ready.
 *
 * Upstream: @modelcontextprotocol/server-memory v2026.1.26
 *   9 upstream tools: create_entities, create_relations, add_observations,
 *   delete_entities, delete_observations, delete_relations, read_graph,
 *   search_nodes, open_nodes
 *
 * The memory server comes with pre-loaded example entities (API Gateway,
 * Auth Service, etc.) — tests must not assume an empty graph.
 *
 * Schema classification notes (with schema cache):
 *   - create_entities: mutating (verb 'create' ∈ MUTATING_VERBS)
 *   - create_relations: mutating (verb 'create' ∈ MUTATING_VERBS)
 *   - add_observations: mutating (verb 'add' ∈ MUTATING_VERBS)
 *   - delete_entities: mutating (verb 'delete' ∈ MUTATING_VERBS)
 *   - delete_observations: mutating (verb 'delete' ∈ MUTATING_VERBS)
 *   - delete_relations: mutating (verb 'delete' ∈ MUTATING_VERBS)
 *   - read_graph: readonly (verb 'read' ∈ READONLY_VERBS, no schema write props)
 *   - search_nodes: readonly (verb 'search' ∈ READONLY_VERBS overrides any schema)
 *   - open_nodes: mutating (no verb match, schema has 'names' required array → complex type write signal)
 *
 * Target extraction notes:
 *   - create_entities({entities: [{name: 'X', ...}]}): Layer 3 → first array object's 'name' → 'X'
 *   - create_relations({relations: [{from: 'A', to: 'B', relationType: 'R'}]}): Layer 5 → 'create_relations' (no TARGET_KEY match)
 *   - search_nodes({query: 'term'}): Layer 4 → first string value → 'term'
 *   - read_graph({}): Layer 5 → 'read_graph'
 *   - open_nodes({names: ['A']}): Layer 5 → 'open_nodes' (array of strings, no object elements for Layer 3)
 *   - delete_entities({entityNames: ['X']}): Layer 5 → 'delete_entities' (array of strings)
 *   - add_observations({observations: [{entityName: 'A', contents: [...]}]}): Layer 5 → 'add_observations' (no TARGET_KEY in nested object)
 *
 * G2 error trigger: add_observations on a non-existent entity returns isError: true
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { verifyReceiptChain, loadReceipts, loadConstraints } from '../src/state.js';
import { classifyMutationType, extractTarget } from '../src/index.js';

// =============================================================================
// HARNESS
// =============================================================================

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
  const stateDir = opts?.stateDir ?? mkdtempSync(join(tmpdir(), 'mcp-proxy-clean7-'));
  const enforcement = opts?.enforcement ?? 'strict';

  const proc = Bun.spawn(
    [
      'bun', 'run', PROXY_ENTRY,
      '--upstream', 'npx -y @modelcontextprotocol/server-memory',
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
        const parts = (partialLine + decoder.decode(value, { stream: true })).split('\n');
        partialLine = parts.pop() ?? '';
        for (const line of parts) dispatchLine(line);
      }
      if (partialLine) dispatchLine(partialLine);
    } catch {}
  })();

  function nextLine(timeoutMs = 15000): Promise<string> {
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

    // Skip notifications (messages without id field) — memory server may emit them
    while (true) {
      const line = await nextLine();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if ('id' in parsed) return parsed;
      // else: notification — skip and read next line
    }
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

// =============================================================================
// TESTS
// =============================================================================

describe('Clean Wrap #7: Memory Server (9 tools, zero proxy changes)', () => {
  let harness: ProxyHarness;

  afterEach(async () => {
    if (harness) {
      await harness.kill();
      try { rmSync(harness.stateDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ─── 1. Handshake ─────────────────────────────────────────────────────

  test('initialize returns memory-server info', async () => {
    harness = await spawnProxy();
    const resp = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-7', version: '1.0' },
    });

    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect((result.serverInfo as any).name).toBe('memory-server');

    harness.notify('notifications/initialized');
    await harness.settle();
  });

  // ─── 2. Tool list ─────────────────────────────────────────────────────

  test('tools/list returns 9 upstream + 5 meta = 14 tools', async () => {
    harness = await spawnProxy();
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();

    const resp = await harness.request('tools/list');
    const tools = (resp.result as any).tools as Array<{ name: string }>;
    const names = tools.map(t => t.name).sort();

    expect(tools.length).toBe(14);

    // All 9 upstream tools
    expect(names).toContain('create_entities');
    expect(names).toContain('create_relations');
    expect(names).toContain('add_observations');
    expect(names).toContain('delete_entities');
    expect(names).toContain('delete_observations');
    expect(names).toContain('delete_relations');
    expect(names).toContain('read_graph');
    expect(names).toContain('search_nodes');
    expect(names).toContain('open_nodes');

    // All 5 meta-tools
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  });

  // ─── 3. Unit-level mutation classification (no schema cache) ──────────

  test('create_entities classified as mutating (verb "create")', () => {
    expect(classifyMutationType('create_entities', {
      entities: [{ name: 'X', entityType: 'T', observations: [] }],
    })).toBe('mutating');
  });

  test('delete_relations classified as mutating (verb "delete")', () => {
    expect(classifyMutationType('delete_relations', {
      relations: [{ from: 'A', to: 'B', relationType: 'R' }],
    })).toBe('mutating');
  });

  test('add_observations classified as mutating (verb "add")', () => {
    expect(classifyMutationType('add_observations', {
      observations: [{ entityName: 'E', contents: ['obs'] }],
    })).toBe('mutating');
  });

  test('read_graph classified as readonly (verb "read")', () => {
    expect(classifyMutationType('read_graph', {})).toBe('readonly');
  });

  test('search_nodes classified as readonly (verb "search")', () => {
    expect(classifyMutationType('search_nodes', { query: 'term' })).toBe('readonly');
  });

  // ─── 4. Unit-level target extraction ──────────────────────────────────

  test('extractTarget: create_entities finds name in nested array object', () => {
    const target = extractTarget('create_entities', {
      entities: [{ name: 'Sovereign', entityType: 'system', observations: ['governs'] }],
    });
    // Layer 3: array of objects → first object's 'name' → 'Sovereign'
    expect(target).toBe('Sovereign');
  });

  test('extractTarget: search_nodes finds query as first string value', () => {
    const target = extractTarget('search_nodes', { query: 'governance' });
    // Layer 4: first string value → 'governance'
    expect(target).toBe('governance');
  });

  test('extractTarget: read_graph returns toolName for empty args', () => {
    const target = extractTarget('read_graph', {});
    // Layer 5: no args → toolName
    expect(target).toBe('read_graph');
  });

  test('extractTarget: open_nodes returns toolName (string array, no object elements)', () => {
    const target = extractTarget('open_nodes', { names: ['Alice', 'Bob'] });
    // Layer 3 skips (array elements are strings, not objects)
    // Layer 4 skips (no top-level string)
    // Layer 5: toolName
    expect(target).toBe('open_nodes');
  });

  test('extractTarget: create_relations returns toolName (no TARGET_KEY in nested)', () => {
    const target = extractTarget('create_relations', {
      relations: [{ from: 'A', to: 'B', relationType: 'knows' }],
    });
    // Layer 3: nested object has 'from', 'to', 'relationType' — none in TARGET_KEYS
    // Layer 5: toolName
    expect(target).toBe('create_relations');
  });

  // ─── 5. E2E: create + read round-trip through proxy ───────────────────

  test('create entity then read it back through proxy', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Use unique name to avoid cross-run collision (memory server persists to disk)
    const uniqueName = `Proxy_${Date.now()}`;

    // Create
    const createResp = await harness.request('tools/call', {
      name: 'create_entities',
      arguments: { entities: [{ name: uniqueName, entityType: 'software', observations: ['wraps MCP'] }] },
    });
    const createResult = createResp.result as any;
    expect(createResult.content[0].type).toBe('text');

    // Search — verify entity is findable
    const searchResp = await harness.request('tools/call', {
      name: 'search_nodes',
      arguments: { query: uniqueName },
    });
    const searchText = (searchResp.result as any).content[0].text;
    const found = JSON.parse(searchText);
    expect(found.entities.some((e: any) => e.name === uniqueName)).toBe(true);

    // Cleanup
    await harness.request('tools/call', {
      name: 'delete_entities',
      arguments: { entityNames: [uniqueName] },
    });
  });

  // ─── 6. Receipt chain from diverse operations ─────────────────────────

  test('receipt chain intact after create + search + read_graph', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    await harness.request('tools/call', {
      name: 'create_entities',
      arguments: { entities: [{ name: 'Chain', entityType: 'test', observations: ['integrity'] }] },
    });
    await harness.request('tools/call', {
      name: 'search_nodes',
      arguments: { query: 'Chain' },
    });
    await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });

    await harness.settle(300);

    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(3);

    const chain = verifyReceiptChain(harness.stateDir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(receipts.length);
  });

  // ─── 7. Receipt mutation classification with schema cache ─────────────

  test('receipts show correct mutationType per tool', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    // tools/list caches schemas — classification now uses schema
    await harness.request('tools/list');

    // Mutating call
    await harness.request('tools/call', {
      name: 'create_entities',
      arguments: { entities: [{ name: 'MutTest', entityType: 'test', observations: ['x'] }] },
    });
    // Readonly call
    await harness.request('tools/call', {
      name: 'search_nodes',
      arguments: { query: 'MutTest' },
    });

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);

    const createReceipt = receipts.find(r => (r as any).toolName === 'create_entities');
    expect(createReceipt).toBeDefined();
    expect((createReceipt as any).mutationType).toBe('mutating');

    const searchReceipt = receipts.find(r => (r as any).toolName === 'search_nodes');
    expect(searchReceipt).toBeDefined();
    expect((searchReceipt as any).mutationType).toBe('readonly');
  });

  // ─── 8. G2: add_observations on non-existent entity → constraint ──────

  test('add_observations failure seeds G2 constraint, retry blocked in strict', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // First call — fails (entity doesn't exist)
    const resp1 = await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'GhostEntity', contents: ['should fail'] }] },
    });
    const result1 = resp1.result as any;
    expect(result1.isError).toBe(true);
    expect(result1.content[0].text).toContain('not found');

    await harness.settle(300);

    // Verify constraint seeded
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);

    // Retry same tool + same target → G2 blocks
    const resp2 = await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'GhostEntity', contents: ['still should fail'] }] },
    });
    const result2 = resp2.result as any;
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('[GOVERNANCE]');
  });

  // ─── 9. E-H8: authority bump blocks, re-handshake resyncs ────────────

  test('authority bump blocks calls, re-initialize resyncs', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Bump authority
    const bumpResp = await harness.request('tools/call', {
      name: 'governance_bump_authority',
      arguments: { reason: 'wrap 7 authority test' },
    });
    const bumpResult = JSON.parse((bumpResp.result as any).content[0].text);
    expect(bumpResult.epoch).toBeGreaterThan(bumpResult.previousEpoch);

    // Next call blocked (stale session epoch)
    const blocked = await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });
    expect((blocked.result as any).isError).toBe(true);
    expect((blocked.result as any).content[0].text).toContain('[GOVERNANCE]');

    // Re-handshake (Model B resync)
    const reinit = await harness.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    expect((reinit.result as any).protocolVersion).toBe('2024-11-05');
    harness.notify('notifications/initialized');
    await harness.settle();

    // Now works again
    const resp = await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });
    expect((resp.result as any).isError).toBeUndefined();
    const graphText = (resp.result as any).content[0].text;
    const graph = JSON.parse(graphText);
    expect(graph.entities).toBeDefined();
    expect(graph.relations).toBeDefined();
  });

  // ─── 10. governance_status shows correct state ────────────────────────

  test('governance_status reflects operations', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Make a successful call and a failing call
    await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });
    await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'NonExistent', contents: ['x'] }] },
    });

    await harness.settle(300);

    const resp = await harness.request('tools/call', {
      name: 'governance_status',
      arguments: {},
    });
    const status = JSON.parse((resp.result as any).content[0].text);

    expect(status.controllerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof status.epoch).toBe('number');
    expect(status.constraintCount).toBeGreaterThanOrEqual(1); // from the failure
    expect(status.receiptCount).toBeGreaterThanOrEqual(2);
    expect(status.enforcement).toBe('advisory');
  });

  // ─── 11. Controller ID stability ──────────────────────────────────────

  test('controllerId stable across session', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    const resp1 = await harness.request('tools/call', { name: 'governance_status', arguments: {} });
    const id1 = JSON.parse((resp1.result as any).content[0].text).controllerId;

    await harness.request('tools/call', { name: 'read_graph', arguments: {} });
    await harness.request('tools/call', { name: 'search_nodes', arguments: { query: 'test' } });

    const resp2 = await harness.request('tools/call', { name: 'governance_status', arguments: {} });
    const id2 = JSON.parse((resp2.result as any).content[0].text).controllerId;

    expect(id1).toBe(id2);
  });

  // ─── 12. Full knowledge graph lifecycle through proxy ─────────────────

  test('create → relate → observe → delete lifecycle', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Create two entities
    await harness.request('tools/call', {
      name: 'create_entities',
      arguments: {
        entities: [
          { name: 'Alpha', entityType: 'node', observations: ['first'] },
          { name: 'Beta', entityType: 'node', observations: ['second'] },
        ],
      },
    });

    // Create relation
    const relResp = await harness.request('tools/call', {
      name: 'create_relations',
      arguments: { relations: [{ from: 'Alpha', to: 'Beta', relationType: 'connects_to' }] },
    });
    const relText = (relResp.result as any).content[0].text;
    expect(relText).toContain('Alpha');
    expect(relText).toContain('Beta');

    // Add observation
    const obsResp = await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'Alpha', contents: ['updated'] }] },
    });
    const obsText = (obsResp.result as any).content[0].text;
    expect(obsText).toContain('updated');

    // Verify via open_nodes
    const openResp = await harness.request('tools/call', {
      name: 'open_nodes',
      arguments: { names: ['Alpha'] },
    });
    const openGraph = JSON.parse((openResp.result as any).content[0].text);
    const alpha = openGraph.entities.find((e: any) => e.name === 'Alpha');
    expect(alpha).toBeDefined();
    expect(alpha.observations).toContain('updated');

    // Cleanup: delete relation then entities
    await harness.request('tools/call', {
      name: 'delete_relations',
      arguments: { relations: [{ from: 'Alpha', to: 'Beta', relationType: 'connects_to' }] },
    });
    const delResp = await harness.request('tools/call', {
      name: 'delete_entities',
      arguments: { entityNames: ['Alpha', 'Beta'] },
    });
    expect((delResp.result as any).content[0].text).toContain('deleted successfully');
  });

  // ─── 13. Advisory mode forwards despite G2 constraint ─────────────────

  test('advisory mode forwards G2-constrained call (annotates, does not block)', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Trigger error → seed constraint
    await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'MissingAdvisory', contents: ['x'] }] },
    });
    await harness.settle(300);

    // Same call again — in advisory mode, should forward (not block)
    const resp = await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'MissingAdvisory', contents: ['y'] }] },
    });
    // The upstream error is forwarded (not the governance block message)
    const result = resp.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  // ─── 14. First receipt has genesis hash ───────────────────────────────

  test('first receipt uses genesis previousHash', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // One call to generate a receipt
    await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    const first = receipts[0] as any;
    expect(first.previousHash).toBe('genesis');
    expect(first.hash).toBeDefined();
    expect(first.hash.length).toBeGreaterThan(0);
  });

  // ─── 15. read_graph receipt shows readonly ────────────────────────────

  test('read_graph receipt classified as readonly with schema cache', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    // Cache schemas
    await harness.request('tools/list');

    await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    const readReceipt = receipts.find(r => (r as any).toolName === 'read_graph');
    expect(readReceipt).toBeDefined();
    expect((readReceipt as any).mutationType).toBe('readonly');
  });

  // ─── 16. open_nodes classified as mutating in receipt (schema) ────────

  test('open_nodes receipt shows mutating (required array triggers schema write signal)', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    await harness.request('tools/call', {
      name: 'open_nodes',
      arguments: { names: ['Alice'] },
    });

    await harness.settle(300);
    const receipts = loadReceipts(harness.stateDir);
    const openReceipt = receipts.find(r => (r as any).toolName === 'open_nodes');
    expect(openReceipt).toBeDefined();
    // 'open' not in READONLY_VERBS → no override → schema's mutating stands
    expect((openReceipt as any).mutationType).toBe('mutating');
  });

  // ─── 17. delete_observations with non-existent observation succeeds ───

  test('delete_observations on existing entity succeeds (idempotent)', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Create entity first
    await harness.request('tools/call', {
      name: 'create_entities',
      arguments: { entities: [{ name: 'Idem', entityType: 'test', observations: ['obs1'] }] },
    });

    // Delete a non-existent observation (should succeed silently)
    const resp = await harness.request('tools/call', {
      name: 'delete_observations',
      arguments: { deletions: [{ entityName: 'Idem', observations: ['nonexistent_obs'] }] },
    });
    expect((resp.result as any).content[0].text).toContain('deleted successfully');

    // Cleanup
    await harness.request('tools/call', {
      name: 'delete_entities',
      arguments: { entityNames: ['Idem'] },
    });
  });

  // ─── 18. Mixed receipt chain: 5 diverse operations ────────────────────

  test('5 diverse operations produce intact receipt chain with correct depth', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    await harness.request('tools/call', { name: 'read_graph', arguments: {} });
    await harness.request('tools/call', { name: 'create_entities', arguments: { entities: [{ name: 'R5', entityType: 'test', observations: ['a'] }] } });
    await harness.request('tools/call', { name: 'search_nodes', arguments: { query: 'R5' } });
    await harness.request('tools/call', { name: 'open_nodes', arguments: { names: ['R5'] } });
    await harness.request('tools/call', { name: 'delete_entities', arguments: { entityNames: ['R5'] } });

    await harness.settle(300);

    const receipts = loadReceipts(harness.stateDir);
    expect(receipts.length).toBeGreaterThanOrEqual(5);

    const chain = verifyReceiptChain(harness.stateDir);
    expect(chain.intact).toBe(true);
    expect(chain.depth).toBe(receipts.length);
  });

  // ─── 19. G2 constraint on one tool does not block different tools ─────

  test('G2 constraint on add_observations does not block other tools', async () => {
    harness = await spawnProxy({ enforcement: 'strict' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Fail on non-existent entity → seeds constraint on add_observations
    // (target falls to toolName since entityName not in TARGET_KEYS)
    await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'GhostScope', contents: ['x'] }] },
    });
    await harness.settle(300);

    // Different tool (read_graph) → should NOT be blocked
    const resp = await harness.request('tools/call', {
      name: 'read_graph',
      arguments: {},
    });
    const result = resp.result as any;
    expect(result.isError).toBeUndefined();
    const graph = JSON.parse(result.content[0].text);
    expect(graph.entities).toBeDefined();

    // Different tool (search_nodes) → should NOT be blocked either
    const searchResp = await harness.request('tools/call', {
      name: 'search_nodes',
      arguments: { query: 'test' },
    });
    expect((searchResp.result as any).isError).toBeUndefined();
  });

  // ─── 20. Constraint failure signature normalized ──────────────────────

  test('constraint failureSignature exists and is non-empty', async () => {
    harness = await spawnProxy({ enforcement: 'advisory' });
    await harness.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    harness.notify('notifications/initialized');
    await harness.settle();
    await harness.request('tools/list');

    // Trigger error
    await harness.request('tools/call', {
      name: 'add_observations',
      arguments: { observations: [{ entityName: 'SigTest', contents: ['x'] }] },
    });

    await harness.settle(300);
    const constraints = loadConstraints(harness.stateDir);
    expect(constraints.length).toBeGreaterThanOrEqual(1);

    const c = constraints[0] as any;
    expect(c.failureSignature).toBeDefined();
    expect(c.failureSignature.length).toBeGreaterThan(0);
  });
});
