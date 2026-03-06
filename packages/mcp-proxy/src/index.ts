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
  bunx @sovereign-labs/mcp-proxy --wrap <server>   [--config <path>] [--enforcement <mode>]
  bunx @sovereign-labs/mcp-proxy --unwrap <server> [--config <path>]
  bunx @sovereign-labs/mcp-proxy --view     [--state-dir <dir>] [--tool <name>] [--outcome <type>] [--limit <n>]
  bunx @sovereign-labs/mcp-proxy --receipts [--state-dir <dir>]
  bunx @sovereign-labs/mcp-proxy --verify  [--state-dir <dir>]

Proxy mode (wraps an upstream MCP server):
  --upstream <cmd>        Upstream MCP server command (required for proxy mode)
  --enforcement <mode>    'strict' (default) or 'advisory'
  --timeout <ms>          Upstream response timeout in ms (default: 300000)
  --state-dir <dir>       Governance state directory (default: .governance)

Setup commands (modify .mcp.json):
  --wrap <server>         Wrap an existing MCP server with governance (one command, done)
  --unwrap <server>       Remove governance, restore original config
  --config <path>         Path to .mcp.json (default: ./.mcp.json or ~/.claude/mcp.json)

Inspection commands (offline, no proxy needed):
  --view                  Detailed per-receipt timeline (the proof you can show someone)
  --receipts              Show session summary: tool calls, mutations, blocked, constraints
  --verify                Verify receipt chain integrity (tamper detection)

View filters:
  --tool <name>           Filter by tool name (partial match)
  --outcome <type>        Filter by outcome: success, error, blocked
  --limit <n>             Number of receipts to show (default: 50)

  --help, -h              Show this help

Examples:
  bunx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
  bunx @sovereign-labs/mcp-proxy --view
  bunx @sovereign-labs/mcp-proxy --view --tool sovereign_submit --outcome success
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
 * Print a detailed per-receipt timeline — the "view" command.
 * This is the first visual proof object: every tool call, timestamped,
 * with outcome, mutation type, target, and governance status.
 */
export function printView(stateDir: string, filter?: { tool?: string; outcome?: string; limit?: number }): void {
  const { existsSync } = require('fs');
  if (!existsSync(stateDir)) {
    console.log(`No governance state found at ${stateDir}/`);
    console.log(`Run the proxy first to generate receipts.`);
    return;
  }

  let receipts = loadReceipts(stateDir);
  if (receipts.length === 0) {
    console.log(`No receipts in ${stateDir}/receipts.jsonl`);
    return;
  }

  // Apply filters
  if (filter?.tool) {
    const t = filter.tool.toLowerCase();
    receipts = receipts.filter(r => r.toolName.toLowerCase().includes(t));
  }
  if (filter?.outcome) {
    receipts = receipts.filter(r => r.outcome === filter.outcome);
  }

  const chain = verifyReceiptChain(stateDir);
  const controller = loadOrCreateController(stateDir);

  // Header
  console.log('');
  console.log('  RECEIPT LEDGER');
  console.log('  ═══════════════════════════════════════════════════════════════');
  console.log(`  controller:  ${controller.id.slice(0, 8)}...`);
  console.log(`  integrity:   ${chain.intact ? '✓ verified' : `✗ TAMPERED at seq ${chain.brokenAt}`}`);
  console.log(`  showing:     ${receipts.length} receipts`);
  console.log('  ───────────────────────────────────────────────────────────────');
  console.log('');

  // Apply limit (show most recent)
  const limit = filter?.limit ?? 50;
  const shown = receipts.slice(-limit);
  if (receipts.length > limit) {
    console.log(`  ... ${receipts.length - limit} earlier receipts omitted (use --limit to show more)`);
    console.log('');
  }

  for (const r of shown) {
    const time = new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const dur = r.durationMs < 1000 ? `${r.durationMs}ms` : `${(r.durationMs / 1000).toFixed(1)}s`;

    // Outcome indicator
    const icon = r.outcome === 'success' ? '✓' : r.outcome === 'blocked' ? '⊘' : '✗';

    // Mutation badge
    const badge = r.mutationType === 'mutating' ? ' [MUTATION]' : '';

    // Attribution
    const attr = r.attribution ? ` (${r.attribution})` : '';

    // Main line
    console.log(`  ${icon} #${String(r.seq).padStart(3)}  ${time}  ${dur.padStart(7)}  ${r.toolName}${badge}${attr}`);

    // Target (if different from tool name)
    if (r.target && r.target !== r.toolName) {
      console.log(`           target: ${r.target}`);
    }

    // Blocked reason
    if (r.outcome === 'blocked' && r.constraintCheck && !r.constraintCheck.passed) {
      console.log(`           blocked by: ${r.constraintCheck.blockedBy ?? 'constraint'}`);
    }

    // Error
    if (r.outcome === 'error' && r.error) {
      const errShort = r.error.length > 80 ? r.error.slice(0, 77) + '...' : r.error;
      console.log(`           error: ${errShort}`);
    }

    // Hash (truncated)
    console.log(`           hash: ${r.hash.slice(0, 16)}...`);
    console.log('');
  }

  // Footer
  console.log('  ───────────────────────────────────────────────────────────────');
  const mutations = shown.filter(r => r.mutationType === 'mutating').length;
  const blocked = shown.filter(r => r.outcome === 'blocked').length;
  const errors = shown.filter(r => r.outcome === 'error').length;
  console.log(`  ${shown.length} receipts  |  ${mutations} mutations  |  ${blocked} blocked  |  ${errors} errors`);
  console.log('');
}

/**
 * Wrap an existing MCP server in .mcp.json with governance.
 * Rewrites the config so the proxy sits in front of the original command.
 */
export function wrapServer(serverName: string, opts: { config?: string; enforcement?: string; stateDir?: string } = {}): void {
  const fs = require('fs');
  const path = require('path');

  // Find .mcp.json
  const configPath = opts.config
    ?? (fs.existsSync('.mcp.json') ? '.mcp.json' : null)
    ?? (fs.existsSync(path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json'))
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json')
      : null);

  if (!configPath || !fs.existsSync(configPath)) {
    console.error('No .mcp.json found in current directory or ~/.claude/mcp.json');
    console.error('Specify path with --config <path>');
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);
  const servers = config.mcpServers ?? {};

  if (!servers[serverName]) {
    console.error(`Server "${serverName}" not found in ${configPath}`);
    console.error(`Available servers: ${Object.keys(servers).join(', ')}`);
    process.exit(1);
  }

  const server = servers[serverName];

  // Check if already wrapped
  if (server._unwrap) {
    console.log(`"${serverName}" is already governed.`);
    console.log(`Use --unwrap ${serverName} to remove governance.`);
    return;
  }

  // Save original for unwrap
  const original = { command: server.command, args: [...(server.args ?? [])] };

  // Build upstream command from original
  const upstreamCmd = server.command;
  const upstreamArgs = server.args ?? [];

  // Determine governance state dir
  const govStateDir = opts.stateDir ?? `.governance-${serverName}`;
  const enforcement = opts.enforcement ?? 'advisory';

  // Rewrite to proxy (-y prevents interactive install prompt in MCP clients)
  server.command = 'npx';
  server.args = [
    '-y',
    '@sovereign-labs/mcp-proxy',
    '--enforcement', enforcement,
    '--state-dir', govStateDir,
    '--', upstreamCmd, ...upstreamArgs,
  ];

  // Stash original for unwrap
  server._unwrap = original;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log('');
  console.log(`  ✓ Wrapped "${serverName}" with governance`);
  console.log('');
  console.log(`  enforcement:  ${enforcement}`);
  console.log(`  state dir:    ${govStateDir}/`);
  console.log(`  config:       ${configPath}`);
  console.log('');
  console.log(`  Restart your MCP client to pick up the change.`);
  console.log(`  Run --unwrap ${serverName} to remove governance.`);
  console.log('');
}

/**
 * Unwrap a governed MCP server back to its original config.
 */
export function unwrapServer(serverName: string, opts: { config?: string } = {}): void {
  const fs = require('fs');
  const path = require('path');

  const configPath = opts.config
    ?? (fs.existsSync('.mcp.json') ? '.mcp.json' : null)
    ?? (fs.existsSync(path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json'))
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json')
      : null);

  if (!configPath || !fs.existsSync(configPath)) {
    console.error('No .mcp.json found.');
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);
  const servers = config.mcpServers ?? {};

  if (!servers[serverName]) {
    console.error(`Server "${serverName}" not found.`);
    process.exit(1);
  }

  const server = servers[serverName];

  if (!server._unwrap) {
    console.log(`"${serverName}" is not currently wrapped.`);
    return;
  }

  // Restore original
  server.command = server._unwrap.command;
  server.args = server._unwrap.args;
  delete server._unwrap;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log('');
  console.log(`  ✓ Unwrapped "${serverName}" — governance removed`);
  console.log(`  Receipts preserved in state dir.`);
  console.log(`  Restart your MCP client to pick up the change.`);
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

  if (args.includes('--wrap')) {
    const wrapIdx = args.indexOf('--wrap');
    const serverName = args[wrapIdx + 1];
    if (!serverName || serverName.startsWith('--')) {
      console.error('Usage: --wrap <server-name>');
      process.exit(1);
    }
    const configIdx = args.indexOf('--config');
    const enfIdx = args.indexOf('--enforcement');
    const sdIdx = args.indexOf('--state-dir');
    wrapServer(serverName, {
      config: configIdx !== -1 ? args[configIdx + 1] : undefined,
      enforcement: enfIdx !== -1 ? args[enfIdx + 1] : undefined,
      stateDir: sdIdx !== -1 ? args[sdIdx + 1] : undefined,
    });
    process.exit(0);
  }

  if (args.includes('--unwrap')) {
    const unwrapIdx = args.indexOf('--unwrap');
    const serverName = args[unwrapIdx + 1];
    if (!serverName || serverName.startsWith('--')) {
      console.error('Usage: --unwrap <server-name>');
      process.exit(1);
    }
    const configIdx = args.indexOf('--config');
    unwrapServer(serverName, {
      config: configIdx !== -1 ? args[configIdx + 1] : undefined,
    });
    process.exit(0);
  }

  if (args.includes('--view')) {
    const toolIdx = args.indexOf('--tool');
    const outcomeIdx = args.indexOf('--outcome');
    const limitIdx = args.indexOf('--limit');
    printView(stateDir, {
      tool: toolIdx !== -1 ? args[toolIdx + 1] : undefined,
      outcome: outcomeIdx !== -1 ? args[outcomeIdx + 1] : undefined,
      limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined,
    });
    process.exit(0);
  }

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
