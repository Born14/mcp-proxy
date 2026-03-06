/**
 * Clean Wrap #8 — Analytics Upstream
 * ===================================
 *
 * Custom analytics MCP server with 8 tools covering 4 distinct classification paths:
 *   - Verb-based readonly (get_report, fetch_stats)
 *   - Verb-based mutating (delete_report)
 *   - Schema-based mutating (update_metric, import_data)
 *   - Schema-based readonly (list_dashboards — filter ∈ READ_PROPERTIES)
 *   - Readonly verb override (describe_entity — schema says mutating but 'describe' overrides)
 *   - Default mutating (purge_cache — no readonly verb, deny-by-default)
 *
 * 8 upstream + 5 meta = 13 tools expected.
 *
 * extractTarget expectations (traced from code):
 *   - get_report({id: 'x'}):              Layer 1 → 'x' (id ∈ TARGET_KEYS)
 *   - list_dashboards({}):                 Layer 5 → 'list_dashboards' (no args)
 *   - list_dashboards({filter: 'x'}):      Layer 4 → 'x' (first string value)
 *   - update_metric({name: 'x', value: 1}): Layer 1 → 'x' (name ∈ TARGET_KEYS)
 *   - delete_report({id: 'x'}):           Layer 1 → 'x' (id ∈ TARGET_KEYS)
 *   - import_data({collection: 'x', data: []}): Layer 1 → 'x' (collection ∈ TARGET_KEYS)
 *   - fetch_stats({resource: 'x'}):       Layer 1 → 'x' (resource ∈ TARGET_KEYS)
 *   - describe_entity({input: 'x'}):      Layer 4 → 'x' (input not in TARGET_KEYS, first string)
 *   - purge_cache({region: 'x'}):         Layer 4 → 'x' (region not in TARGET_KEYS, first string)
 *
 * Error triggers:
 *   - get_report({id: 'nonexistent'})   → isError (report not found)
 *   - delete_report({id: 'missing_x'})  → isError (missing_ prefix)
 *   - import_data({collection: '__invalid__', data: []}) → isError (reserved name)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let proxy: ChildProcess;
let stateDir: string;
let msgId = 1;

function send(msg: Record<string, unknown>): void {
  proxy.stdin!.write(JSON.stringify(msg) + '\n');
}

function request(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for id=${id}`)), 10_000);
    const handler = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            proxy.stdout!.removeListener('data', handler);
            resolve(parsed);
            return;
          }
        } catch { /* skip non-JSON */ }
      }
    };
    proxy.stdout!.on('data', handler);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return request('tools/call', { name, arguments: args });
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw8-'));

  const upstreamPath = path.join(__dirname, 'analytics-upstream.ts');
  const proxyEntry = path.join(__dirname, '..', 'src', 'index.ts');

  proxy = spawn('bun', [
    'run', proxyEntry,
    '--upstream', `bun run ${upstreamPath}`,
    '--state-dir', stateDir,
    '--enforcement', 'strict',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BUN_DEBUG_QUIET_LOGS: '1' },
  });

  // Wait for upstream to settle
  await new Promise(r => setTimeout(r, 2000));

  // Initialize
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'clean-wrap-8', version: '1.0.0' },
  });
  expect(init.result).toBeDefined();

  // Send initialized notification
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise(r => setTimeout(r, 300));
});

afterAll(() => {
  if (proxy?.pid) {
    proxy.kill('SIGTERM');
  }
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Clean Wrap #8 — Analytics Upstream', () => {

  // =========================================================================
  // 1. Tool Discovery
  // =========================================================================

  test('1. tools/list returns 13 tools (8 upstream + 5 meta)', async () => {
    const resp = await request('tools/list');
    const tools = resp.result.tools;
    expect(tools).toBeArrayOfSize(13);

    const names = tools.map((t: any) => t.name).sort();
    // 8 upstream
    expect(names).toContain('get_report');
    expect(names).toContain('list_dashboards');
    expect(names).toContain('update_metric');
    expect(names).toContain('delete_report');
    expect(names).toContain('import_data');
    expect(names).toContain('fetch_stats');
    expect(names).toContain('describe_entity');
    expect(names).toContain('purge_cache');
    // 5 meta
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
    expect(names).toContain('governance_declare_intent');
    expect(names).toContain('governance_clear_intent');
    expect(names).toContain('governance_convergence_status');
  });

  // =========================================================================
  // 2. Readonly tools pass through cleanly
  // =========================================================================

  test('2. get_report (readonly verb) returns report data', async () => {
    const resp = await callTool('get_report', { id: 'rpt_001' });
    const text = resp.result.content[0].text;
    const data = JSON.parse(text);
    expect(data.id).toBe('rpt_001');
    expect(data.title).toBe('Weekly Summary');
    expect(resp.result.isError).toBeUndefined();
  });

  test('3. list_dashboards (schema readonly) returns all dashboards', async () => {
    const resp = await callTool('list_dashboards', {});
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.dashboards).toBeArrayOfSize(4);
    expect(data.total).toBe(4);
  });

  test('4. fetch_stats (readonly verb) returns statistics', async () => {
    const resp = await callTool('fetch_stats', { resource: 'cpu', period: '7d' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.resource).toBe('cpu');
    expect(data.period).toBe('7d');
    expect(data.samples).toBe(168);
  });

  test('5. describe_entity (readonly override) passes through', async () => {
    // Schema says mutating (input ∈ WRITE_PROPERTIES) but 'describe' ∈ READONLY_VERBS overrides
    const resp = await callTool('describe_entity', { input: 'cpu_usage' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.entity).toBe('cpu_usage');
    expect(data.type).toBe('metric');
    expect(data.records).toBe(50000);
  });

  test('6. purge_cache (deny-by-default mutating) passes through', async () => {
    // No readonly verb → deny-by-default mutating
    const resp = await callTool('purge_cache', { region: 'us-east', ttl: 3600 });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.region).toBe('us-east');
    expect(data.purged).toBe(127);
  });

  // =========================================================================
  // 3. Mutating tools pass through cleanly
  // =========================================================================

  test('7. update_metric (schema mutating) succeeds', async () => {
    const resp = await callTool('update_metric', { name: 'cpu_usage', value: 85.2 });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.name).toBe('cpu_usage');
    expect(data.new).toBe(85.2);
  });

  test('8. delete_report (verb mutating) succeeds', async () => {
    const resp = await callTool('delete_report', { id: 'rpt_003' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.deleted).toBe('rpt_003');
    expect(data.existed).toBe(true);
  });

  test('9. import_data (schema mutating) succeeds', async () => {
    const resp = await callTool('import_data', {
      collection: 'events',
      data: [{ type: 'click', ts: 1000 }, { type: 'view', ts: 2000 }],
    });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.collection).toBe('events');
    expect(data.imported).toBe(2);
  });

  // =========================================================================
  // 4. Error handling — upstream errors do not crash proxy
  // =========================================================================

  test('10. get_report on nonexistent ID returns upstream error', async () => {
    const resp = await callTool('get_report', { id: 'nonexistent' });
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('Report not found');
  });

  test('11. delete_report with missing_ prefix returns upstream error', async () => {
    const resp = await callTool('delete_report', { id: 'missing_xyz' });
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('DeleteError');
  });

  test('12. import_data to __invalid__ collection returns upstream error', async () => {
    const resp = await callTool('import_data', { collection: '__invalid__', data: [] });
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('ImportError');
  });

  // =========================================================================
  // 5. G2 — Constraint seeding on failure
  // =========================================================================

  test('13. failed mutating call seeds G2 constraint', async () => {
    // delete_report with missing_ prefix triggers error
    const fail = await callTool('delete_report', { id: 'missing_g2test' });
    expect(fail.result.isError).toBe(true);

    // Same tool + same target should be blocked
    const retry = await callTool('delete_report', { id: 'missing_g2test' });
    expect(retry.result.isError).toBe(true);
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');
  });

  test('14. G2 constraint is target-scoped for Layer 1 tools', async () => {
    // delete_report extracts target via Layer 1 (id ∈ TARGET_KEYS)
    // Constraint on 'missing_g2test' should NOT block different id
    const different = await callTool('delete_report', { id: 'rpt_002' });
    // Should pass through to upstream (not governance blocked)
    expect(different.result.content[0].text).not.toContain('[GOVERNANCE]');
  });

  test('15. failed readonly call ALSO seeds G2 constraint', async () => {
    // G2 seeds on ANY isError, regardless of mutationType
    const fail = await callTool('get_report', { id: 'no_such_report_readonly' });
    expect(fail.result.isError).toBe(true);
    expect(fail.result.content[0].text).toContain('Report not found');

    // Same target should now be blocked by G2
    const retry = await callTool('get_report', { id: 'no_such_report_readonly' });
    expect(retry.result.isError).toBe(true);
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');
  });

  // =========================================================================
  // 6. E-H7 — Identity persistence
  // =========================================================================

  test('16. controllerId is stable across calls', async () => {
    const s1 = await callTool('governance_status');
    const s2 = await callTool('governance_status');
    const d1 = JSON.parse(s1.result.content[0].text);
    const d2 = JSON.parse(s2.result.content[0].text);
    expect(d1.controllerId).toBe(d2.controllerId);
    // UUID format
    expect(d1.controllerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // =========================================================================
  // 7. E-H8 — Authority epoch
  // =========================================================================

  test('17. bump_authority increments epoch', async () => {
    const before = await callTool('governance_status');
    const epochBefore = JSON.parse(before.result.content[0].text).epoch;

    await callTool('governance_bump_authority', { reason: 'wrap-8 test' });

    const after = await callTool('governance_status');
    const epochAfter = JSON.parse(after.result.content[0].text).epoch;
    expect(epochAfter).toBe(epochBefore + 1);
  });

  test('18. stale session blocks tool calls until re-handshake', async () => {
    // Bump authority to advance epoch past session snapshot
    await callTool('governance_bump_authority', { reason: 'stale-test' });

    // Next tool call should be blocked (stale session)
    const blocked = await callTool('fetch_stats', { resource: 'memory' });
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0].text).toContain('[GOVERNANCE]');

    // Re-handshake via initialize
    const reinit = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-8', version: '1.0.0' },
    });
    expect(reinit.result).toBeDefined();

    // Now calls should work again
    const unblocked = await callTool('fetch_stats', { resource: 'memory' });
    expect(unblocked.result.isError).toBeUndefined();
    const data = JSON.parse(unblocked.result.content[0].text);
    expect(data.resource).toBe('memory');
  });

  // =========================================================================
  // 8. Receipt chain integrity
  // =========================================================================

  test('19. receipt chain is intact and non-empty', async () => {
    const receiptsPath = path.join(stateDir, 'receipts.jsonl');
    const content = fs.readFileSync(receiptsPath, 'utf-8').trim();
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThan(5);

    // Verify chain structure
    let prevHash = 'genesis';
    for (const line of lines) {
      const receipt = JSON.parse(line);
      expect(receipt.hash).toBeDefined();
      expect(receipt.previousHash).toBe(prevHash);
      prevHash = receipt.hash;
    }
  });

  // =========================================================================
  // 9. Classification correctness via receipts
  // =========================================================================

  test('20. receipts have correct mutationType classifications', async () => {
    const receiptsPath = path.join(stateDir, 'receipts.jsonl');
    const content = fs.readFileSync(receiptsPath, 'utf-8').trim();
    const receipts = content.split('\n').map(l => JSON.parse(l));

    // Build a map of tool → mutationType from receipts
    const classifications = new Map<string, Set<string>>();
    for (const r of receipts) {
      if (r.toolName && r.mutationType) {
        if (!classifications.has(r.toolName)) classifications.set(r.toolName, new Set());
        classifications.get(r.toolName)!.add(r.mutationType);
      }
    }

    // Verify expected classifications
    // Readonly tools
    expect(classifications.get('get_report')?.has('readonly')).toBe(true);
    expect(classifications.get('list_dashboards')?.has('readonly')).toBe(true);
    expect(classifications.get('fetch_stats')?.has('readonly')).toBe(true);
    expect(classifications.get('describe_entity')?.has('readonly')).toBe(true);
    // purge_cache is now correctly classified as mutating (deny-by-default: "purge" not in READONLY_VERBS)
    expect(classifications.get('purge_cache')?.has('mutating')).toBe(true);

    // Mutating tools
    expect(classifications.get('update_metric')?.has('mutating')).toBe(true);
    expect(classifications.get('delete_report')?.has('mutating')).toBe(true);
    expect(classifications.get('import_data')?.has('mutating')).toBe(true);

    // Meta-tools are handled locally (not forwarded to upstream, not receipted)
    // So they won't appear in receipts — verify they're absent
    expect(classifications.has('governance_status')).toBe(false);
    expect(classifications.has('governance_bump_authority')).toBe(false);
  });

  // =========================================================================
  // 10. Mixed scenario — full lifecycle
  // =========================================================================

  test('21. full lifecycle: read → mutate → read → fail → G2 blocks retry', async () => {
    // 1. Read stats (readonly, passes through)
    const stats = await callTool('fetch_stats', { resource: 'disk' });
    expect(stats.result.isError).toBeUndefined();

    // 2. Import data (mutating, succeeds)
    const imp = await callTool('import_data', {
      collection: 'logs',
      data: [{ level: 'info', msg: 'test' }],
    });
    const impData = JSON.parse(imp.result.content[0].text);
    expect(impData.imported).toBe(1);

    // 3. Read again (readonly)
    const stats2 = await callTool('fetch_stats', { resource: 'network' });
    expect(stats2.result.isError).toBeUndefined();

    // 4. Failed import (mutating, error)
    const fail = await callTool('import_data', {
      collection: '__invalid__',
      data: [{ x: 1 }],
    });
    expect(fail.result.isError).toBe(true);

    // 5. G2 blocks retry of same target
    const retry = await callTool('import_data', {
      collection: '__invalid__',
      data: [{ x: 2 }],
    });
    expect(retry.result.isError).toBe(true);
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');

    // 6. Different collection still works
    const other = await callTool('import_data', {
      collection: 'metrics',
      data: [{ y: 3 }],
    });
    expect(other.result.isError).toBeUndefined();
    expect(JSON.parse(other.result.content[0].text).imported).toBe(1);
  });
});
