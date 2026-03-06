/**
 * Proxy Protocol Tests
 * ====================
 *
 * Proves:
 *   - Meta-tool detection works correctly
 *   - Meta-tool definitions are well-formed
 *   - bump_authority increments epoch and creates session gap
 *   - governance_status returns correct state snapshot
 *   - CLI argument parsing handles all forms
 */

import { describe, test, expect } from 'bun:test';
import { isMetaTool, META_TOOL_DEFS, META_TOOL_NAMES, handleBumpAuthority, handleGovernanceStatus } from '../src/meta-tools.js';
import { parseArgs } from '../src/index.js';
import type { ProxyState, ProxyConfig } from '../src/types.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStateDir } from '../src/state.js';

// =============================================================================
// META-TOOL DETECTION
// =============================================================================

describe('isMetaTool', () => {
  test('recognizes governance_bump_authority', () => {
    expect(isMetaTool('governance_bump_authority')).toBe(true);
  });

  test('recognizes governance_status', () => {
    expect(isMetaTool('governance_status')).toBe(true);
  });

  test('rejects upstream tool names', () => {
    expect(isMetaTool('write_file')).toBe(false);
    expect(isMetaTool('read_file')).toBe(false);
    expect(isMetaTool('execute_command')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isMetaTool('')).toBe(false);
  });

  test('rejects partial matches', () => {
    expect(isMetaTool('governance')).toBe(false);
    expect(isMetaTool('bump_authority')).toBe(false);
  });
});

// =============================================================================
// META-TOOL DEFINITIONS
// =============================================================================

describe('META_TOOL_DEFS', () => {
  test('has exactly 5 tools', () => {
    expect(META_TOOL_DEFS).toHaveLength(5);
  });

  test('tools have required MCP fields', () => {
    for (const tool of META_TOOL_DEFS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('tool names match META_TOOL_NAMES', () => {
    const names = META_TOOL_DEFS.map(t => t.name);
    expect(names).toEqual([...META_TOOL_NAMES]);
  });

  test('descriptions include [GOVERNANCE] prefix', () => {
    for (const tool of META_TOOL_DEFS) {
      expect(tool.description).toMatch(/^\[GOVERNANCE/);
    }
  });
});

// =============================================================================
// BUMP AUTHORITY (E-H8)
// =============================================================================

describe('handleBumpAuthority', () => {
  test('increments epoch', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-bump-'));
    ensureStateDir(tmpDir);

    const state: ProxyState = {
      controller: { id: 'test-ctrl', establishedAt: Date.now() },
      authority: { controllerId: 'test-ctrl', epoch: 3, lastBumpedAt: Date.now(), activeSessionEpoch: 3 },
      constraints: [],
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    const result = handleBumpAuthority({ reason: 'test bump' }, state, tmpDir);
    expect(state.authority.epoch).toBe(4);

    // Parse result
    const data = JSON.parse(result.content[0].text);
    expect(data.epoch).toBe(4);
    expect(data.previousEpoch).toBe(3);
    expect(data.reason).toBe('test bump');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('session epoch stays frozen after bump', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-bump-'));
    ensureStateDir(tmpDir);

    const state: ProxyState = {
      controller: { id: 'test-ctrl', establishedAt: Date.now() },
      authority: { controllerId: 'test-ctrl', epoch: 3, lastBumpedAt: Date.now(), activeSessionEpoch: 3 },
      constraints: [],
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    handleBumpAuthority({}, state, tmpDir);

    // Session epoch should NOT be updated — this is the E-H8 mechanism
    expect(state.authority.activeSessionEpoch).toBe(3);
    expect(state.authority.epoch).toBe(4);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default reason when none provided', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-bump-'));
    ensureStateDir(tmpDir);

    const state: ProxyState = {
      controller: { id: 'test-ctrl', establishedAt: Date.now() },
      authority: { controllerId: 'test-ctrl', epoch: 0, lastBumpedAt: Date.now(), activeSessionEpoch: 0 },
      constraints: [],
      receiptSeq: 0,
      lastReceiptHash: 'genesis',
    };

    const result = handleBumpAuthority({}, state, tmpDir);
    const data = JSON.parse(result.content[0].text);
    expect(data.reason).toBe('Manual bump');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// =============================================================================
// GOVERNANCE STATUS
// =============================================================================

describe('handleGovernanceStatus', () => {
  test('returns correct state snapshot', () => {
    const state: ProxyState = {
      controller: { id: 'ctrl-abc', establishedAt: 1700000000000 },
      authority: { controllerId: 'ctrl-abc', epoch: 7, lastBumpedAt: Date.now(), activeSessionEpoch: 5 },
      constraints: [
        { id: 'c_1', toolName: 'write', target: '/a', failureSignature: 'err', errorSnippet: 'e', createdAt: Date.now() },
        { id: 'c_2', toolName: 'write', target: '/b', failureSignature: 'err', errorSnippet: 'e', createdAt: Date.now() - 2 * 60 * 60 * 1000 }, // Expired
      ],
      receiptSeq: 42,
      lastReceiptHash: 'abc123',
    };

    const result = handleGovernanceStatus(state, '/tmp/gov');
    const data = JSON.parse(result.content[0].text);

    expect(data.controllerId).toBe('ctrl-abc');
    expect(data.authorityEpoch).toBe(7);
    expect(data.sessionEpoch).toBe(5);
    expect(data.constraintCount).toBe(2);
    expect(data.activeConstraints).toBe(1); // Only the non-expired one
    expect(data.receiptCount).toBe(42);
    expect(data.stateDir).toBe('/tmp/gov');
  });
});

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

describe('parseArgs', () => {
  test('--upstream sets upstream command', () => {
    const config = parseArgs(['--upstream', 'npx server']);
    expect(config).not.toBeNull();
    expect(config!.upstream).toBe('npx server');
  });

  test('--state-dir overrides default', () => {
    const config = parseArgs(['--upstream', 'cmd', '--state-dir', '/tmp/gov']);
    expect(config!.stateDir).toBe('/tmp/gov');
  });

  test('default state-dir is .governance', () => {
    const config = parseArgs(['--upstream', 'cmd']);
    expect(config!.stateDir).toBe('.governance');
  });

  test('--enforcement strict', () => {
    const config = parseArgs(['--upstream', 'cmd', '--enforcement', 'strict']);
    expect(config!.enforcement).toBe('strict');
  });

  test('--enforcement advisory', () => {
    const config = parseArgs(['--upstream', 'cmd', '--enforcement', 'advisory']);
    expect(config!.enforcement).toBe('advisory');
  });

  test('default enforcement is strict', () => {
    const config = parseArgs(['--upstream', 'cmd']);
    expect(config!.enforcement).toBe('strict');
  });

  test('invalid enforcement → returns null', () => {
    const config = parseArgs(['--upstream', 'cmd', '--enforcement', 'yolo']);
    expect(config).toBeNull();
  });

  test('missing --upstream → returns null', () => {
    const config = parseArgs(['--enforcement', 'strict']);
    expect(config).toBeNull();
  });

  test('empty args → returns null', () => {
    const config = parseArgs([]);
    expect(config).toBeNull();
  });

  test('--help → returns null', () => {
    const config = parseArgs(['--help']);
    expect(config).toBeNull();
  });

  test('-h → returns null', () => {
    const config = parseArgs(['-h']);
    expect(config).toBeNull();
  });

  test('-- separator splits upstream command and args', () => {
    const config = parseArgs(['--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(config).not.toBeNull();
    expect(config!.upstream).toBe('npx');
    expect(config!.upstreamArgs).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  });

  test('-- with options before separator', () => {
    const config = parseArgs(['--enforcement', 'advisory', '--state-dir', '/data', '--', 'node', 'server.js']);
    expect(config!.enforcement).toBe('advisory');
    expect(config!.stateDir).toBe('/data');
    expect(config!.upstream).toBe('node');
    expect(config!.upstreamArgs).toEqual(['server.js']);
  });

  test('flag without value at end of args → no crash', () => {
    // --upstream at end with no value
    const config = parseArgs(['--upstream']);
    expect(config).toBeNull(); // No upstream value
  });

  test('all options combined', () => {
    const config = parseArgs([
      '--upstream', 'bun run server.ts',
      '--state-dir', '/home/user/.gov',
      '--enforcement', 'advisory',
    ]);
    expect(config).not.toBeNull();
    expect(config!.upstream).toBe('bun run server.ts');
    expect(config!.stateDir).toBe('/home/user/.gov');
    expect(config!.enforcement).toBe('advisory');
  });
});
