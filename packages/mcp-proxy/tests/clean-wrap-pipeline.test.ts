/**
 * Clean Wrap #9 — Pipeline Upstream
 * ===================================
 *
 * Custom CI/CD pipeline server. Stateless (no persistence).
 * 8 upstream + 5 meta = 13 tools.
 *
 * Classification paths exercised:
 *   - Verb readonly: check_status (check), inspect_logs (inspect), show_metrics (show), lookup_version (lookup)
 *   - Schema readonly: list_artifacts (filter ∈ READ_PROPERTIES)
 *   - Verb mutating: stop_pipeline (stop)
 *   - Schema mutating: run_pipeline (config ∈ WRITE_PROPERTIES), trigger_deploy (payload ∈ WRITE_PROPERTIES)
 *
 * Key behavioral facts applied:
 *   - G2 seeds on ALL isError (readonly or mutating)
 *   - Meta-tools handled locally, NOT receipted
 *   - Layer 1 target extraction for all tools with id/name/key args
 *   - list_artifacts target: Layer 4 (first string) or Layer 5 (toolName) when no args
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw9-'));

  const upstreamPath = path.join(__dirname, 'pipeline-upstream.ts');
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

  await new Promise(r => setTimeout(r, 2000));

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'clean-wrap-9', version: '1.0.0' },
  });
  expect(init.result).toBeDefined();

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise(r => setTimeout(r, 300));
});

afterAll(() => {
  if (proxy?.pid) proxy.kill('SIGTERM');
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Clean Wrap #9 — Pipeline Upstream', () => {

  // =========================================================================
  // 1. Discovery
  // =========================================================================

  test('1. tools/list returns 13 tools (8 upstream + 5 meta)', async () => {
    const resp = await request('tools/list');
    const tools = resp.result.tools;
    expect(tools).toBeArrayOfSize(13);

    const names = tools.map((t: any) => t.name).sort();
    expect(names).toContain('check_status');
    expect(names).toContain('run_pipeline');
    expect(names).toContain('list_artifacts');
    expect(names).toContain('inspect_logs');
    expect(names).toContain('stop_pipeline');
    expect(names).toContain('show_metrics');
    expect(names).toContain('trigger_deploy');
    expect(names).toContain('lookup_version');
    expect(names).toContain('governance_bump_authority');
    expect(names).toContain('governance_status');
  });

  // =========================================================================
  // 2. Readonly tools
  // =========================================================================

  test('2. check_status (readonly verb "check") returns pipeline status', async () => {
    const resp = await callTool('check_status', { id: 'run_001' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.id).toBe('run_001');
    expect(data.status).toBe('running');
    expect(data.progress).toBe(67);
  });

  test('3. inspect_logs (readonly verb "inspect") returns log output', async () => {
    const resp = await callTool('inspect_logs', { id: 'run_002', tail: 100 });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.id).toBe('run_002');
    expect(data.lines).toBe(100);
    expect(data.log).toContain('Building');
  });

  test('4. show_metrics (readonly verb "show") returns metric data', async () => {
    const resp = await callTool('show_metrics', { key: 'build_time' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.key).toBe('build_time');
    expect(data.value).toBe(42);
  });

  test('5. lookup_version (readonly verb "lookup") returns version info', async () => {
    const resp = await callTool('lookup_version', { name: 'api-gateway' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.name).toBe('api-gateway');
    expect(data.version).toBe('2.4.1');
  });

  test('6. list_artifacts (schema readonly via "filter") returns artifacts', async () => {
    const resp = await callTool('list_artifacts', { filter: 'build' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.artifacts).toContain('build.tar.gz');
    expect(data.total).toBeGreaterThan(0);
  });

  test('7. list_artifacts with no args returns all artifacts', async () => {
    const resp = await callTool('list_artifacts', {});
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.artifacts).toBeArrayOfSize(5);
  });

  // =========================================================================
  // 3. Mutating tools
  // =========================================================================

  test('8. run_pipeline (schema mutating via "config") starts pipeline', async () => {
    const resp = await callTool('run_pipeline', {
      name: 'build-all',
      config: { branch: 'develop', parallel: true },
    });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.name).toBe('build-all');
    expect(data.branch).toBe('develop');
    expect(data.parallel).toBe(true);
  });

  test('9. stop_pipeline (mutating verb "stop") stops pipeline', async () => {
    const resp = await callTool('stop_pipeline', { name: 'build-all' });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.name).toBe('build-all');
    expect(data.stopped).toBe(true);
  });

  test('10. trigger_deploy (schema mutating via "payload") triggers deploy', async () => {
    const resp = await callTool('trigger_deploy', {
      name: 'production',
      payload: { version: '3.0.0', environment: 'prod' },
    });
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.name).toBe('production');
    expect(data.version).toBe('3.0.0');
    expect(data.environment).toBe('prod');
  });

  // =========================================================================
  // 4. Error handling
  // =========================================================================

  test('11. check_status with err_ prefix returns upstream error', async () => {
    const resp = await callTool('check_status', { id: 'err_timeout' });
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('StatusError');
  });

  test('12. stop_pipeline with missing_ prefix returns upstream error', async () => {
    const resp = await callTool('stop_pipeline', { name: 'missing_nope' });
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('StopError');
  });

  // =========================================================================
  // 5. G2 constraints — correct behavioral expectations
  // =========================================================================

  test('13. G2 seeds on mutating tool failure and blocks retry', async () => {
    // stop_pipeline is mutating (verb 'stop'), error on missing_ prefix
    const fail = await callTool('stop_pipeline', { name: 'missing_g2mut' });
    expect(fail.result.isError).toBe(true);
    expect(fail.result.content[0].text).toContain('StopError');

    // Retry same target → blocked by G2
    const retry = await callTool('stop_pipeline', { name: 'missing_g2mut' });
    expect(retry.result.isError).toBe(true);
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');
  });

  test('14. G2 seeds on readonly tool failure too', async () => {
    // check_status is readonly (verb 'check'), but G2 seeds on ALL isError
    const fail = await callTool('check_status', { id: 'err_g2read' });
    expect(fail.result.isError).toBe(true);
    expect(fail.result.content[0].text).toContain('StatusError');

    // Retry same target → blocked by G2
    const retry = await callTool('check_status', { id: 'err_g2read' });
    expect(retry.result.isError).toBe(true);
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');
  });

  test('15. G2 constraint is target-scoped (Layer 1 extraction)', async () => {
    // stop_pipeline target via Layer 1 (name ∈ TARGET_KEYS)
    // Constraint on 'missing_g2mut' should NOT block different name
    const ok = await callTool('stop_pipeline', { name: 'frontend-build' });
    expect(ok.result.content[0].text).not.toContain('[GOVERNANCE]');
    const data = JSON.parse(ok.result.content[0].text);
    expect(data.stopped).toBe(true);
  });

  test('16. G2 cross-tool isolation — constraint on one tool does not block another', async () => {
    // check_status has a constraint on 'err_g2read' from test 14
    // inspect_logs is a different tool — should not be affected
    const resp = await callTool('inspect_logs', { id: 'err_g2read' });
    expect(resp.result.content[0].text).not.toContain('[GOVERNANCE]');
    const data = JSON.parse(resp.result.content[0].text);
    expect(data.id).toBe('err_g2read');
  });

  // =========================================================================
  // 6. E-H7 Identity
  // =========================================================================

  test('17. controllerId is stable UUID', async () => {
    const s1 = await callTool('governance_status');
    const d1 = JSON.parse(s1.result.content[0].text);
    expect(d1.controllerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const s2 = await callTool('governance_status');
    const d2 = JSON.parse(s2.result.content[0].text);
    expect(d1.controllerId).toBe(d2.controllerId);
  });

  // =========================================================================
  // 7. E-H8 Authority Epoch + Re-handshake
  // =========================================================================

  test('18. bump then re-handshake restores access', async () => {
    const before = await callTool('governance_status');
    const epochBefore = JSON.parse(before.result.content[0].text).epoch;

    // Bump authority
    await callTool('governance_bump_authority', { reason: 'wrap-9-epoch' });

    const after = await callTool('governance_status');
    const epochAfter = JSON.parse(after.result.content[0].text).epoch;
    expect(epochAfter).toBe(epochBefore + 1);

    // Next upstream call blocked (stale session)
    const blocked = await callTool('show_metrics', { key: 'latency' });
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0].text).toContain('[GOVERNANCE]');

    // Re-handshake
    const reinit = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'clean-wrap-9', version: '1.0.0' },
    });
    expect(reinit.result).toBeDefined();

    // Now works again
    const unblocked = await callTool('show_metrics', { key: 'latency' });
    expect(unblocked.result.isError).toBeUndefined();
    expect(JSON.parse(unblocked.result.content[0].text).key).toBe('latency');
  });

  // =========================================================================
  // 8. Receipts
  // =========================================================================

  test('19. receipt chain is intact', async () => {
    const receiptsPath = path.join(stateDir, 'receipts.jsonl');
    const content = fs.readFileSync(receiptsPath, 'utf-8').trim();
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThan(10);

    // Verify hash chain
    let prevHash = 'genesis';
    for (const line of lines) {
      const receipt = JSON.parse(line);
      expect(receipt.hash).toBeDefined();
      expect(receipt.previousHash).toBe(prevHash);
      prevHash = receipt.hash;
    }
  });

  test('20. receipt classifications match expectations', async () => {
    const receiptsPath = path.join(stateDir, 'receipts.jsonl');
    const receipts = fs.readFileSync(receiptsPath, 'utf-8').trim()
      .split('\n').map(l => JSON.parse(l));

    const classifications = new Map<string, Set<string>>();
    for (const r of receipts) {
      if (r.toolName && r.mutationType) {
        if (!classifications.has(r.toolName)) classifications.set(r.toolName, new Set());
        classifications.get(r.toolName)!.add(r.mutationType);
      }
    }

    // Readonly tools
    expect(classifications.get('check_status')?.has('readonly')).toBe(true);
    expect(classifications.get('inspect_logs')?.has('readonly')).toBe(true);
    expect(classifications.get('show_metrics')?.has('readonly')).toBe(true);
    expect(classifications.get('lookup_version')?.has('readonly')).toBe(true);
    expect(classifications.get('list_artifacts')?.has('readonly')).toBe(true);

    // Mutating tools
    expect(classifications.get('run_pipeline')?.has('mutating')).toBe(true);
    expect(classifications.get('stop_pipeline')?.has('mutating')).toBe(true);
    expect(classifications.get('trigger_deploy')?.has('mutating')).toBe(true);

    // Meta-tools NOT in receipts (handled locally)
    expect(classifications.has('governance_status')).toBe(false);
    expect(classifications.has('governance_bump_authority')).toBe(false);
  });

  // =========================================================================
  // 9. Full lifecycle
  // =========================================================================

  test('21. lifecycle: lookup → run → check → fail → G2 → different target ok', async () => {
    // 1. Read version (readonly)
    const ver = await callTool('lookup_version', { name: 'worker' });
    expect(JSON.parse(ver.result.content[0].text).version).toBe('2.4.1');

    // 2. Run pipeline (mutating)
    const run = await callTool('run_pipeline', {
      name: 'deploy-worker',
      config: { branch: 'main' },
    });
    expect(JSON.parse(run.result.content[0].text).name).toBe('deploy-worker');

    // 3. Check status (readonly)
    const status = await callTool('check_status', { id: 'run_lifecycle' });
    expect(JSON.parse(status.result.content[0].text).status).toBe('running');

    // 4. Fail: stop missing pipeline (mutating, error)
    const fail = await callTool('stop_pipeline', { name: 'missing_lifecycle' });
    expect(fail.result.isError).toBe(true);

    // 5. G2 blocks retry
    const retry = await callTool('stop_pipeline', { name: 'missing_lifecycle' });
    expect(retry.result.content[0].text).toContain('[GOVERNANCE]');

    // 6. Different target works
    const other = await callTool('stop_pipeline', { name: 'deploy-worker' });
    expect(other.result.content[0].text).not.toContain('[GOVERNANCE]');
    expect(JSON.parse(other.result.content[0].text).stopped).toBe(true);
  });
});
