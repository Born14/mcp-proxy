#!/usr/bin/env bun
/**
 * @sovereign-labs/mcp-proxy — Public API & CLI Entry
 * ===============================================
 *
 * Two entry points:
 *   1. Programmatic: import { createGovernedProxy } from '@sovereign-labs/mcp-proxy'
 *   2. CLI: bunx @sovereign-labs/mcp-proxy --upstream "..." [--state-dir ...] [--enforcement ...]
 *
 * Usage:
 *
 *   import { createGovernedProxy } from '@sovereign-labs/mcp-proxy';
 *
 *   const proxy = createGovernedProxy({
 *     upstream: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
 *     stateDir: './.governance',
 *   });
 *   await proxy.start();
 */

import { createGovernedProxy } from './proxy.js';
import { loadReceipts, loadConstraints, verifyReceiptChain, loadOrCreateController } from './state.js';
import type { ProxyConfig, GovernedProxy, ProxyState, ToolCallRecord, ControllerState, AuthorityState, ConstraintEntry, IntentContext, DeclaredPredicate, GroundingContext, ConvergenceTracker, AttributionClass, AttributionMatchDetail, ConvergenceSignal } from './types.js';

// =============================================================================
// PUBLIC API
// =============================================================================

export { createGovernedProxy } from './proxy.js';
export { acquireLock, releaseLock, checkLock, StateDirLockError, computeIntentHash } from './state.js';
export { computeToolTarget, attributeToolCallHeuristic, annotateGrounding, checkConvergence, createConvergenceTracker, extractProxySignature } from './governance.js';
export { classifyMutationType, classifyFromSchema, extractTarget, seedFromFailure, cacheToolSchemas, getCachedSchema, clearSchemaCache, normalizeErrorText } from './fingerprint.js';
export type {
  ProxyConfig,
  GovernedProxy,
  ProxyState,
  ToolCallRecord,
  ControllerState,
  AuthorityState,
  ConstraintEntry,
  IntentContext,
  DeclaredPredicate,
  GroundingContext,
  ConvergenceTracker,
  AttributionClass,
  AttributionMatchDetail,
  ConvergenceSignal,
} from './types.js';

/**
 * Start a governed proxy from config. Stdio entry point.
 * Blocks until the process exits.
 */
export async function startProxy(config: ProxyConfig): Promise<void> {
  const proxy = createGovernedProxy(config);
  await proxy.start();
}

// =============================================================================
// CLI ENTRY — Only runs when executed directly (not imported)
// =============================================================================

/** @internal Exported for testing */
export function parseArgs(args: string[]): ProxyConfig | null {
  let upstream: string | undefined;
  let upstreamArgs: string[] = [];
  let stateDir = '.governance';
  let enforcement: 'strict' | 'advisory' = 'strict';
  let timeout: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--upstream' && i + 1 < args.length) {
      upstream = args[++i];
    } else if (arg === '--state-dir' && i + 1 < args.length) {
      stateDir = args[++i];
    } else if (arg === '--enforcement' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'strict' || val === 'advisory') {
        enforcement = val;
      } else {
        process.stderr.write(`[mcp-proxy] Invalid enforcement mode: ${val}. Use 'strict' or 'advisory'.\n`);
        return null;
      }
    } else if (arg === '--timeout' && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val <= 0) {
        process.stderr.write(`[mcp-proxy] Invalid timeout: must be a positive number of milliseconds.\n`);
        return null;
      }
      timeout = val;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    } else if (arg === '--') {
      // Everything after -- is the upstream command + args
      upstream = args[i + 1];
      upstreamArgs = args.slice(i + 2);
      break;
    }
  }

  if (!upstream) {
    process.stderr.write('[mcp-proxy] Missing --upstream argument.\n');
    printUsage();
    return null;
  }

  return { upstream, upstreamArgs, stateDir, enforcement, timeout };
}

function printUsage(): void {
  process.stderr.write(`
@sovereign-labs/mcp-proxy — Tamper-evident governance for MCP tool servers

Usage:
  bunx @sovereign-labs/mcp-proxy --upstream "command" [options]
  bunx @sovereign-labs/mcp-proxy --receipts [--state-dir <dir>]
  bunx @sovereign-labs/mcp-proxy --verify  [--state-dir <dir>]

Proxy mode (wraps an upstream MCP server):
  --upstream <cmd>        Upstream MCP server command (required for proxy mode)
  --enforcement <mode>    'strict' (default) or 'advisory'
  --timeout <ms>          Upstream response timeout in ms (default: 300000)
  --state-dir <dir>       Governance state directory (default: .governance)

Inspection commands (offline, no proxy needed):
  --receipts              Show session summary: tool calls, mutations, blocked, constraints
  --verify                Verify receipt chain integrity (tamper detection)

  --help, -h              Show this help

Examples:
  bunx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
  bunx @sovereign-labs/mcp-proxy --receipts
  bunx @sovereign-labs/mcp-proxy --verify

Claude Code config (.mcp.json):
  {
    "mcpServers": {
      "governed-filesystem": {
        "command": "bunx",
        "args": ["@sovereign-labs/mcp-proxy", "--upstream", "npx -y @modelcontextprotocol/server-filesystem /tmp"]
      }
    }
  }
`);
}

// =============================================================================
// OFFLINE COMMANDS — Read governance state without starting proxy
// =============================================================================

/**
 * Print a session summary from the receipts ledger.
 * Reads .governance/ (or custom stateDir) and prints stats to stdout.
 */
export function printReceiptsSummary(stateDir: string): void {
  const { existsSync } = require('fs');
  if (!existsSync(stateDir)) {
    console.log(`No governance state found at ${stateDir}/`);
    console.log(`Run the proxy first to generate receipts.`);
    return;
  }

  const receipts = loadReceipts(stateDir);
  const constraints = loadConstraints(stateDir);

  if (receipts.length === 0) {
    console.log(`No receipts in ${stateDir}/receipts.jsonl`);
    console.log(`Run the proxy to start recording tool calls.`);
    return;
  }

  // Compute stats
  const mutations = receipts.filter(r => r.mutationType === 'mutating').length;
  const readonly = receipts.filter(r => r.mutationType === 'readonly').length;
  const blocked = receipts.filter(r => r.outcome === 'blocked').length;
  const errors = receipts.filter(r => r.outcome === 'error').length;
  const succeeded = receipts.filter(r => r.outcome === 'success').length;

  // Unique tools
  const tools = new Map<string, number>();
  for (const r of receipts) {
    tools.set(r.toolName, (tools.get(r.toolName) ?? 0) + 1);
  }

  // Time range
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  const durationMs = last.timestamp - first.timestamp;
  const durationStr = durationMs < 60_000
    ? `${(durationMs / 1000).toFixed(1)}s`
    : durationMs < 3_600_000
      ? `${(durationMs / 60_000).toFixed(1)}m`
      : `${(durationMs / 3_600_000).toFixed(1)}h`;

  // Chain integrity (quick check)
  const chain = verifyReceiptChain(stateDir);

  // Attribution stats (Tier 3)
  const attributed = receipts.filter(r => r.attribution);
  const direct = attributed.filter(r => r.attribution === 'direct').length;
  const scaffolding = attributed.filter(r => r.attribution === 'scaffolding').length;
  const unexplained = attributed.filter(r => r.attribution === 'unexplained').length;
  const noIntent = attributed.filter(r => r.attribution === 'no_intent').length;

  // Print summary
  console.log('');
  console.log('  SESSION SUMMARY');
  console.log('  ═══════════════════════════════════════');
  console.log('');
  console.log(`  receipts:          ${receipts.length}`);
  console.log(`  duration:          ${durationStr}`);
  console.log(`  chain integrity:   ${chain.intact ? '✓ verified' : `✗ broken at seq ${chain.brokenAt}`}`);
  console.log('');
  console.log(`  mutations:         ${mutations}`);
  console.log(`  readonly:          ${readonly}`);
  console.log(`  blocked:           ${blocked}`);
  console.log(`  errors:            ${errors}`);
  console.log(`  succeeded:         ${succeeded}`);
  console.log('');

  if (constraints.length > 0) {
    const active = constraints.filter(c => Date.now() - c.createdAt < (c.ttlMs ?? 3_600_000)).length;
    console.log(`  constraints:       ${constraints.length} (${active} active)`);
  } else {
    console.log(`  constraints:       0`);
  }

  if (direct + scaffolding + unexplained > 0) {
    console.log('');
    console.log('  containment:');
    console.log(`    direct:          ${direct}`);
    console.log(`    scaffolding:     ${scaffolding}`);
    console.log(`    unexplained:     ${unexplained}`);
  }

  console.log('');
  console.log('  tools:');
  const sorted = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 10)) {
    console.log(`    ${name.padEnd(30)} ${count}`);
  }
  if (sorted.length > 10) {
    console.log(`    ... and ${sorted.length - 10} more`);
  }

  console.log('');
  console.log(`  last hash:         ${last.hash.slice(0, 16)}...`);
  console.log(`  state dir:         ${stateDir}/`);
  console.log('');
}

/**
 * Verify the receipt chain integrity and print results.
 */
export function printVerify(stateDir: string): void {
  const { existsSync } = require('fs');
  if (!existsSync(stateDir)) {
    console.log(`No governance state found at ${stateDir}/`);
    return;
  }

  const receipts = loadReceipts(stateDir);
  if (receipts.length === 0) {
    console.log('No receipts to verify.');
    return;
  }

  // Load genesis anchor from authority
  const controller = loadOrCreateController(stateDir);
  const chain = verifyReceiptChain(stateDir);

  console.log('');
  console.log('  CHAIN VERIFICATION');
  console.log('  ═══════════════════════════════════════');
  console.log('');
  console.log(`  receipts:          ${receipts.length}`);
  console.log(`  chain depth:       ${chain.depth}`);
  console.log(`  integrity:         ${chain.intact ? '✓ all hashes verified' : `✗ TAMPERED at seq ${chain.brokenAt}`}`);
  console.log(`  controller:        ${controller.id.slice(0, 8)}...`);
  console.log(`  first hash:        ${receipts[0].hash.slice(0, 16)}...`);
  console.log(`  last hash:         ${receipts[receipts.length - 1].hash.slice(0, 16)}...`);
  console.log('');

  if (!chain.intact) {
    console.log('  ⚠ The receipt chain has been tampered with or corrupted.');
    console.log(`  The break was detected at sequence number ${chain.brokenAt}.`);
    console.log('');
    process.exit(1);
  }
}

// =============================================================================
// CLI ENTRY — Only runs when executed directly (not imported)
// =============================================================================

// Detect if running as CLI entry point
const isMainModule = typeof Bun !== 'undefined' && Bun.main === import.meta.path;

if (isMainModule) {
  const args = process.argv.slice(2);

  // Handle offline commands first (no proxy needed)
  const stateDirIdx = args.indexOf('--state-dir');
  const stateDir = stateDirIdx !== -1 && args[stateDirIdx + 1] ? args[stateDirIdx + 1] : '.governance';

  if (args.includes('--receipts')) {
    printReceiptsSummary(stateDir);
    process.exit(0);
  }

  if (args.includes('--verify')) {
    printVerify(stateDir);
    process.exit(0);
  }

  // Debug log for MCP server startup diagnosis (stderr is invisible in Claude Code)
  const debugLog = (msg: string) => {
    try {
      const fs = require('fs');
      fs.appendFileSync(
        (config?.stateDir ?? '.governance') + '/startup.log',
        `[${new Date().toISOString()}] ${msg}\n`
      );
    } catch {}
    process.stderr.write(`[mcp-proxy] ${msg}\n`);
  };

  const config = parseArgs(args);
  debugLog(`Parsed config: ${config ? JSON.stringify({ upstream: config.upstream, upstreamArgs: config.upstreamArgs, stateDir: config.stateDir, enforcement: config.enforcement }) : 'null'}`);

  if (config) {
    debugLog('Starting proxy...');
    startProxy(config)
      .then(() => debugLog('Proxy started successfully'))
      .catch(err => {
        if ((err as any)?.name === 'StateDirLockError') {
          // Double module evaluation by Bun — first instance already has the lock.
          // Do NOT process.exit() — that would kill the first instance too (same process).
          // Just log and let the event loop continue serving from the first instance.
          debugLog(`Lock held by first instance — ignoring duplicate evaluation`);
          return;
        }
        debugLog(`Fatal: ${(err as Error).message}\n${(err as Error).stack}`);
        process.exit(1);
      });
  }
}
