#!/usr/bin/env bun
/**
 * @sovereign-labs/mcp-proxy — Public API & CLI Entry
 * ===============================================
 *
 * Two entry points:
 *   1. Programmatic: import { createGovernedProxy } from '@sovereign-labs/mcp-proxy'
 *   2. CLI: npx @sovereign-labs/mcp-proxy --upstream "..." [--state-dir ...] [--enforcement ...]
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

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createGovernedProxy } from './proxy.js';
import { loadReceipts, loadConstraints, verifyReceiptChain, loadOrCreateController } from './state.js';
import { generateNarrative, generateNarrativeWithLLM, formatNarrative, createOllamaProvider, createOpenAIProvider, createGeminiProvider, createAnthropicProvider } from './explain.js';
import { runDemo } from './demo.js';
import { printReplay } from './replay.js';
import type { ProxyConfig, GovernedProxy, ProxyState, ToolCallRecord, ControllerState, AuthorityState, ConstraintEntry, IntentContext, DeclaredPredicate, GroundingContext, ConvergenceTracker, AttributionClass, AttributionMatchDetail, ConvergenceSignal } from './types.js';

// =============================================================================
// PUBLIC API
// =============================================================================

export { createGovernedProxy } from './proxy.js';
export { acquireLock, releaseLock, checkLock, StateDirLockError, computeIntentHash } from './state.js';
export { computeToolTarget, attributeToolCallHeuristic, annotateGrounding, checkConvergence, createConvergenceTracker, extractProxySignature } from './governance.js';
export { classifyMutationType, classifyFromSchema, extractTarget, seedFromFailure, cacheToolSchemas, getCachedSchema, clearSchemaCache, normalizeErrorText } from './fingerprint.js';
export { generateNarrative, generateNarrativeWithLLM, formatNarrative, compressForLLM, buildLLMPrompt, generateReceiptTitle, generateReceiptSummary, createOllamaProvider, createOpenAIProvider, createGeminiProvider, createAnthropicProvider } from './explain.js';
export type { Narrative, LLMProvider } from './explain.js';
export { createBudgetState, checkBudget, recordCall, recordBlocked, remainingCalls } from './budget.js';
export type { BudgetState } from './budget.js';
export { validateToolArgs } from './schema-check.js';
export type { SchemaCheckResult, SchemaMode } from './schema-check.js';
export { createLoopDetector, recordAndCheck, classifyError, getLoopStats } from './loop-detect.js';
export type { LoopDetector, LoopDetectorConfig, LoopCheckResult } from './loop-detect.js';
export { createSessionStats, recordOutcome, formatExitSummary } from './summary.js';
export type { SessionStats } from './summary.js';
export { printReplay } from './replay.js';
export { classifyFailureKind } from './failure-kind.js';
export type { FailureKind, FailureSource } from './failure-kind.js';
export { classifyActionClass } from './action-class.js';
export type { ActionClass, CodeChange } from './action-class.js';
export {
  detectExhaustion,
  detectSemanticDisagreement,
  convergenceVerdict,
  jaccardSimilarity,
} from './convergence-detect.js';
export type {
  IterationRecord,
  ConvergenceAnalysis,
  ConvergenceConfig,
  ConvergenceState as ConvergenceDetectState,
  ConvergenceVerdict,
  ConstraintLike,
} from './convergence-detect.js';
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
  let maxCalls: number | undefined;
  let schemaMode: 'off' | 'warn' | 'strict' = 'off';

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
    } else if (arg === '--max-calls' && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val <= 0) {
        process.stderr.write(`[mcp-proxy] Invalid --max-calls: must be a positive integer.\n`);
        return null;
      }
      maxCalls = val;
    } else if (arg === '--schema' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'off' || val === 'warn' || val === 'strict') {
        schemaMode = val;
      } else {
        process.stderr.write(`[mcp-proxy] Invalid --schema mode: ${val}. Use 'off', 'warn', or 'strict'.\n`);
        return null;
      }
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

  return { upstream, upstreamArgs, stateDir, enforcement, timeout, maxCalls, schemaMode };
}

function printUsage(): void {
  process.stderr.write(`
@sovereign-labs/mcp-proxy — Tamper-evident governance for MCP tool servers

Usage:
  npx @sovereign-labs/mcp-proxy --upstream "command" [options]
  npx @sovereign-labs/mcp-proxy --wrap <server>   [--config <path>] [--enforcement <mode>]
  npx @sovereign-labs/mcp-proxy --unwrap <server> [--config <path>]
  npx @sovereign-labs/mcp-proxy --view     [--state-dir <dir>] [--tool <name>] [--outcome <type>] [--limit <n>]
  npx @sovereign-labs/mcp-proxy --replay   [--state-dir <dir>] [N]
  npx @sovereign-labs/mcp-proxy --explain  [--state-dir <dir>] [--llm <provider>]
  npx @sovereign-labs/mcp-proxy --receipts [--state-dir <dir>]
  npx @sovereign-labs/mcp-proxy --verify  [--state-dir <dir>]

Proxy mode (wraps an upstream MCP server):
  --upstream <cmd>        Upstream MCP server command (required for proxy mode)
  --enforcement <mode>    'strict' (default) or 'advisory'
  --timeout <ms>          Upstream response timeout in ms (default: 300000)
  --max-calls <n>         Maximum tool calls before blocking (budget cap)
  --schema <mode>         Schema validation: 'off' (default), 'warn', 'strict'
  --state-dir <dir>       Governance state directory (default: .governance)

Setup commands (modify .mcp.json):
  --wrap <server>         Wrap an existing MCP server with governance (one command, done)
  --unwrap <server>       Remove governance, restore original config
  --config <path>         Path to .mcp.json (default: ./.mcp.json or ~/.claude/mcp.json)

Inspection commands (offline, no proxy needed):
  --demo                  Interactive demo — see governance in action (no config needed)
  --view                  Detailed per-receipt timeline (the proof you can show someone)
  --replay [N]            Timeline story view — phases, turning points (default: last 200)
  --explain               Plain-language summary of what the agent did
  --receipts              Show session summary: tool calls, mutations, blocked, constraints
  --verify                Verify receipt chain integrity (tamper detection)

Explain options:
  --llm <provider>        Enhance summary with LLM (ollama, openai, anthropic, gemini)
  --api-key <key>         API key for cloud LLM (or set EXPLAIN_API_KEY env var)
  --model <name>          Model name (provider-specific, uses sensible defaults)

View filters:
  --tool <name>           Filter by tool name (partial match)
  --outcome <type>        Filter by outcome: success, error, blocked
  --limit <n>             Number of receipts to show (default: 50)

  --help, -h              Show this help

Examples:
  npx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
  npx @sovereign-labs/mcp-proxy --view
  npx @sovereign-labs/mcp-proxy --view --tool sovereign_submit --outcome success
  npx @sovereign-labs/mcp-proxy --explain
  npx @sovereign-labs/mcp-proxy --explain --llm openai --api-key sk-...
  npx @sovereign-labs/mcp-proxy --explain --llm ollama --model qwen3:4b
  npx @sovereign-labs/mcp-proxy --receipts
  npx @sovereign-labs/mcp-proxy --verify

Claude Code config (.mcp.json):
  {
    "mcpServers": {
      "governed-filesystem": {
        "command": "npx",
        "args": ["-y", "@sovereign-labs/mcp-proxy", "--upstream", "npx -y @modelcontextprotocol/server-filesystem /tmp"]
      }
    }
  }
`);
}

// =============================================================================
// ANSI COLORS — Auto-disabled when piped (no TTY)
// =============================================================================

const isTTY = process.stdout.isTTY ?? false;
const c = {
  green:   (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:     (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow:  (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:    (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  dim:     (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold:    (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  magenta: (s: string) => isTTY ? `\x1b[35m${s}\x1b[0m` : s,
};

// =============================================================================
// OFFLINE COMMANDS — Read governance state without starting proxy
// =============================================================================

/**
 * Print a session summary from the receipts ledger.
 * Reads .governance/ (or custom stateDir) and prints stats to stdout.
 */
export function printReceiptsSummary(stateDir: string): void {
  
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
  console.log(`  ${c.bold('SESSION SUMMARY')}`);
  console.log(`  ${c.dim('═══════════════════════════════════════')}`);
  console.log('');
  console.log(`  receipts:          ${c.bold(String(receipts.length))}`);
  console.log(`  duration:          ${durationStr}`);
  console.log(`  chain integrity:   ${chain.intact ? c.green('✓ verified') : c.red(`✗ broken at seq ${chain.brokenAt}`)}`);
  console.log('');
  console.log(`  mutations:         ${mutations > 0 ? c.yellow(String(mutations)) : '0'}`);
  console.log(`  readonly:          ${readonly}`);
  console.log(`  blocked:           ${blocked > 0 ? c.red(String(blocked)) : '0'}`);
  console.log(`  errors:            ${errors > 0 ? c.red(String(errors)) : '0'}`);
  console.log(`  succeeded:         ${succeeded > 0 ? c.green(String(succeeded)) : '0'}`);
  console.log('');

  if (constraints.length > 0) {
    const active = constraints.filter(c => Date.now() - c.createdAt < (c.ttlMs ?? 3_600_000)).length;
    console.log(`  constraints:       ${constraints.length} (${active} active)`);
  } else {
    console.log(`  constraints:       0`);
  }

  if (direct + scaffolding + unexplained > 0) {
    console.log('');
    console.log(`  ${c.bold('containment:')}`);
    console.log(`    direct:          ${c.green(String(direct))}`);
    console.log(`    scaffolding:     ${c.cyan(String(scaffolding))}`);
    console.log(`    unexplained:     ${unexplained > 0 ? c.red(String(unexplained)) : '0'}`);
  }

  console.log('');
  console.log(`  ${c.bold('tools:')}`);
  const sorted = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 10)) {
    console.log(`    ${c.cyan(name.padEnd(30))} ${count}`);
  }
  if (sorted.length > 10) {
    console.log(c.dim(`    ... and ${sorted.length - 10} more`));
  }

  console.log('');
  console.log(`  last hash:         ${c.dim(last.hash.slice(0, 16) + '...')}`);
  console.log(`  state dir:         ${c.dim(stateDir + '/')}`);
  console.log('');
}

/**
 * Print a detailed per-receipt timeline — the "view" command.
 * This is the first visual proof object: every tool call, timestamped,
 * with outcome, mutation type, target, and governance status.
 */
export function printView(stateDir: string, filter?: { tool?: string; outcome?: string; limit?: number }): void {
  
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
  console.log(`  ${c.bold('RECEIPT LEDGER')}`);
  console.log(`  ${c.dim('═══════════════════════════════════════════════════════════════')}`);
  console.log(`  controller:  ${c.dim(controller.id.slice(0, 8) + '...')}`);
  console.log(`  integrity:   ${chain.intact ? c.green('✓ verified') : c.red(`✗ TAMPERED at seq ${chain.brokenAt}`)}`);
  console.log(`  showing:     ${c.bold(String(receipts.length))} receipts`);
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
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
    const icon = r.outcome === 'success' ? c.green('✓') : r.outcome === 'blocked' ? c.yellow('⊘') : c.red('✗');

    // Mutation badge
    const badge = r.mutationType === 'mutating' ? c.yellow(' [MUTATION]') : '';

    // Attribution
    const attrColor = r.attribution === 'direct' ? c.green : r.attribution === 'unexplained' ? c.red : c.dim;
    const attr = r.attribution ? ` ${attrColor('(' + r.attribution + ')')}` : '';

    // Main line
    console.log(`  ${icon} ${c.dim('#' + String(r.seq).padStart(3))}  ${c.dim(time)}  ${dur.padStart(7)}  ${c.cyan(r.toolName)}${badge}${attr}`);

    // Title (human-readable, if present)
    if (r.title) {
      console.log(`           ${r.title}`);
    }

    // Target (if different from tool name)
    if (r.target && r.target !== r.toolName) {
      console.log(`           target: ${c.dim(r.target)}`);
    }

    // Blocked reason
    if (r.outcome === 'blocked' && r.constraintCheck && !r.constraintCheck.passed) {
      console.log(`           ${c.yellow('blocked by:')} ${r.constraintCheck.blockedBy ?? 'constraint'}`);
    }

    // Error
    if (r.outcome === 'error' && r.error) {
      const errShort = r.error.length > 80 ? r.error.slice(0, 77) + '...' : r.error;
      console.log(`           ${c.red('error:')} ${errShort}`);
    }

    // Hash (truncated)
    console.log(`           ${c.dim('hash: ' + r.hash.slice(0, 16) + '...')}`);
    console.log('');
  }

  // Footer
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  const mutations = shown.filter(r => r.mutationType === 'mutating').length;
  const blocked = shown.filter(r => r.outcome === 'blocked').length;
  const errors = shown.filter(r => r.outcome === 'error').length;
  console.log(`  ${c.bold(String(shown.length))} receipts  |  ${mutations > 0 ? c.yellow(String(mutations)) : '0'} mutations  |  ${blocked > 0 ? c.red(String(blocked)) : '0'} blocked  |  ${errors > 0 ? c.red(String(errors)) : '0'} errors`);
  console.log('');

  // Append human-readable narrative
  const narrative = generateNarrative(shown);
  console.log(formatNarrative(narrative));
}

/**
 * Wrap an existing MCP server in .mcp.json with governance.
 * Rewrites the config so the proxy sits in front of the original command.
 */
export function wrapServer(serverName: string, opts: { config?: string; enforcement?: string; stateDir?: string } = {}): void {
  
  

  // Find .mcp.json
  const configPath = opts.config
    ?? (existsSync('.mcp.json') ? '.mcp.json' : null)
    ?? (existsSync(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json'))
      ? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json')
      : null);

  if (!configPath || !existsSync(configPath)) {
    console.error('No .mcp.json found in current directory or ~/.claude/mcp.json');
    console.error('Specify path with --config <path>');
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
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

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log('');
  console.log(`  ${c.green('✓')} Wrapped "${c.bold(serverName)}" with governance`);
  console.log('');
  console.log(`  enforcement:  ${c.cyan(enforcement)}`);
  console.log(`  state dir:    ${c.dim(govStateDir + '/')}`);
  console.log(`  config:       ${c.dim(configPath)}`);
  console.log('');
  console.log(`  Restart your MCP client to pick up the change.`);
  console.log(`  Run ${c.dim('--unwrap ' + serverName)} to remove governance.`);
  console.log('');
}

/**
 * Unwrap a governed MCP server back to its original config.
 */
export function unwrapServer(serverName: string, opts: { config?: string } = {}): void {
  
  

  const configPath = opts.config
    ?? (existsSync('.mcp.json') ? '.mcp.json' : null)
    ?? (existsSync(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json'))
      ? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'mcp.json')
      : null);

  if (!configPath || !existsSync(configPath)) {
    console.error('No .mcp.json found.');
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
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

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log('');
  console.log(`  ${c.green('✓')} Unwrapped "${c.bold(serverName)}" — governance removed`);
  console.log(`  Receipts preserved in state dir.`);
  console.log(`  Restart your MCP client to pick up the change.`);
  console.log('');
}

/**
 * Verify the receipt chain integrity and print results.
 */
export function printVerify(stateDir: string): void {
  
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
  console.log(`  ${c.bold('CHAIN VERIFICATION')}`);
  console.log(`  ${c.dim('═══════════════════════════════════════')}`);
  console.log('');
  console.log(`  receipts:          ${c.bold(String(receipts.length))}`);
  console.log(`  chain depth:       ${chain.depth}`);
  console.log(`  integrity:         ${chain.intact ? c.green('✓ all hashes verified') : c.red(`✗ TAMPERED at seq ${chain.brokenAt}`)}`);
  console.log(`  controller:        ${c.dim(controller.id.slice(0, 8) + '...')}`);
  console.log(`  first hash:        ${c.dim(receipts[0].hash.slice(0, 16) + '...')}`);
  console.log(`  last hash:         ${c.dim(receipts[receipts.length - 1].hash.slice(0, 16) + '...')}`);
  console.log('');

  if (!chain.intact) {
    console.log(`  ${c.red('⚠ The receipt chain has been tampered with or corrupted.')}`);
    console.log(`  ${c.red(`The break was detected at sequence number ${chain.brokenAt}.`)}`);
    console.log('');
    process.exit(1);
  }
}

/**
 * Print a plain-language explanation of what the agent did.
 * Heuristic by default, enhanced with LLM if --llm is provided.
 */
export async function printExplain(
  stateDir: string,
  opts: { llm?: string; apiKey?: string; model?: string } = {},
): Promise<void> {

  if (!existsSync(stateDir)) {
    console.log(`No governance state found at ${stateDir}/`);
    console.log(`Run the proxy first to generate receipts.`);
    return;
  }

  const receipts = loadReceipts(stateDir);
  if (receipts.length === 0) {
    console.log(`No receipts in ${stateDir}/receipts.jsonl`);
    return;
  }

  let narrative;

  if (opts.llm) {
    const provider = resolveLLMProvider(opts.llm, opts.apiKey, opts.model);
    if (provider) {
      console.log(`  Using ${provider.name} for enhanced summary...\n`);
      narrative = await generateNarrativeWithLLM(receipts, provider);
    } else {
      narrative = generateNarrative(receipts);
    }
  } else {
    narrative = generateNarrative(receipts);
  }

  console.log(formatNarrative(narrative));
}

/**
 * Resolve an LLM provider from CLI flags.
 */
function resolveLLMProvider(
  name: string,
  apiKey?: string,
  model?: string,
): ReturnType<typeof createOllamaProvider> | null {
  switch (name.toLowerCase()) {
    case 'ollama':
      return createOllamaProvider(model ?? 'llama3.2');
    case 'openai':
      if (!apiKey) {
        console.error('  --llm openai requires --api-key or EXPLAIN_API_KEY env var');
        return null;
      }
      return createOpenAIProvider(apiKey, model ?? 'gpt-4o-mini');
    case 'anthropic':
      if (!apiKey) {
        console.error('  --llm anthropic requires --api-key or EXPLAIN_API_KEY env var');
        return null;
      }
      return createAnthropicProvider(apiKey, model ?? 'claude-haiku-4-5-20251001');
    case 'gemini':
      if (!apiKey) {
        console.error('  --llm gemini requires --api-key or EXPLAIN_API_KEY env var');
        return null;
      }
      return createGeminiProvider(apiKey, model ?? 'gemini-2.0-flash');
    default:
      console.error(`  Unknown LLM provider: ${name}. Use ollama, openai, anthropic, or gemini.`);
      return null;
  }
}

// =============================================================================
// CLI ENTRY — Only runs when executed directly (not imported)
// =============================================================================

// Detect if running as CLI entry point (works in both Bun and Node)
const isMainModule = (() => {
  // Bun: direct comparison
  if (typeof Bun !== 'undefined') return Bun.main === import.meta.path;
  // Node ESM: compare import.meta.url with argv[1]
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const moduleUrl = import.meta.url;
    // Normalize argv[1] to file:// URL for comparison
    const scriptUrl = 'file:///' + argv1.replace(/\\/g, '/');
    return moduleUrl === scriptUrl;
  } catch { return false; }
})();

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

  if (args.includes('--replay')) {
    const replayIdx = args.indexOf('--replay');
    // Check if there's a numeric argument after --replay
    const nextArg = args[replayIdx + 1];
    const limit = nextArg && !nextArg.startsWith('--') ? parseInt(nextArg, 10) : 200;
    printReplay(stateDir, isNaN(limit) ? 200 : limit);
    process.exit(0);
  }

  if (args.includes('--explain')) {
    const llmIdx = args.indexOf('--llm');
    const llmProvider = llmIdx !== -1 ? args[llmIdx + 1] : undefined;
    const apiKeyIdx = args.indexOf('--api-key');
    const apiKey = apiKeyIdx !== -1 ? args[apiKeyIdx + 1] : process.env.EXPLAIN_API_KEY;
    const modelIdx = args.indexOf('--model');
    const modelName = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

    printExplain(stateDir, { llm: llmProvider, apiKey, model: modelName })
      .then(() => process.exit(0))
      .catch(err => {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      });
  } else if (args.includes('--receipts')) {
    printReceiptsSummary(stateDir);
    process.exit(0);
  } else if (args.includes('--verify')) {
    printVerify(stateDir);
    process.exit(0);
  } else if (args.includes('--demo')) {
    runDemo()
      .then(() => process.exit(0))
      .catch(err => {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      });
  } else {

  // Debug log for MCP server startup diagnosis (stderr is invisible in Claude Code)
  const debugLog = (msg: string) => {
    try {
      
      appendFileSync(
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

  } // end else (proxy startup — only when no CLI command handled)
}
