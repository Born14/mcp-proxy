/**
 * @sovereign-labs/mcp-proxy — Interactive Demo
 * =============================================
 *
 * Self-contained demo that shows governance in action.
 * No upstream server needed. No config. One command.
 *
 * Uses the real governance pipeline (runGates, appendReceipt, processFailure)
 * against simulated tool calls to demonstrate:
 *   1. Receipt generation (Tier 0)
 *   2. Mutation classification
 *   3. Failure → constraint seeding (G2)
 *   4. Constraint blocking (G2)
 *   5. Chain integrity verification
 */

import {
  ensureStateDir,
  loadOrCreateController,
  loadAuthority,
  saveAuthority,
  loadConstraints,
  appendReceipt,
  getLastReceiptHash,
  getReceiptCount,
  verifyReceiptChain,
  computeIntentHash,
} from './state.js';
import { toolCallToMutation, classifyMutationType } from './fingerprint.js';
import {
  runGates,
  processFailure,
  computeToolTarget,
  annotateGrounding,
  checkConvergence,
  createConvergenceTracker,
} from './governance.js';
import { generateReceiptTitle, generateReceiptSummary } from './explain.js';
import {
  createSessionStats,
  recordOutcome,
  formatNarrativeSummary,
  formatExitSummary,
} from './summary.js';
import { createBudgetState, recordCall } from './budget.js';
import { createLoopDetector } from './loop-detect.js';
import { fireWebhook, blockedEvent, sessionCompleteEvent } from './webhook.js';
import type { ProxyState, ToolCallRecord, ConstraintEntry } from './types.js';
import { existsSync, rmSync } from 'fs';

// =============================================================================
// ANSI COLORS
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
// SIMULATED TOOL CALLS
// =============================================================================

interface SimulatedCall {
  toolName: string;
  args: Record<string, unknown>;
  outcome: 'success' | 'error' | 'blocked';
  errorText?: string;
  narration: string;  // What we tell the human is happening
  schemaWarning?: boolean;
  hallucinated?: string[];
}

const DEMO_SCRIPT: SimulatedCall[] = [
  {
    toolName: 'list_notes',
    args: {},
    outcome: 'success',
    narration: 'Agent reads existing notes',
  },
  {
    toolName: 'read_note',
    args: { name: 'meeting-notes' },
    outcome: 'success',
    narration: 'Agent reads a specific note',
  },
  {
    toolName: 'write_note',
    args: { name: 'todo-list', content: 'Buy groceries, fix CI pipeline' },
    outcome: 'success',
    narration: 'Agent creates a new note',
  },
  {
    toolName: 'write_note',
    args: { name: 'todo-list', content: 'Updated: Buy groceries, deploy v2' },
    outcome: 'error',
    errorText: 'Note "todo-list" already exists. Use update_note instead.',
    narration: 'Agent tries to overwrite — upstream returns error',
  },
  {
    toolName: 'write_note',
    args: { name: 'todo-list', content: 'Third attempt to overwrite' },
    outcome: 'blocked',  // This will be blocked by G2 — we handle it specially
    narration: 'Agent retries the same call — G2 blocks it',
  },
  {
    toolName: 'read_note',
    args: { name: 'todo-list' },
    outcome: 'success',
    narration: 'Agent reads instead (different strategy)',
  },
  {
    toolName: 'write_note',
    args: { name: 'summary', content: 'Sprint review notes', priority: 'high', format: 'markdown' },
    outcome: 'success',
    narration: 'Agent sends hallucinated parameters — schema catches them',
    schemaWarning: true,
    hallucinated: ['priority', 'format'],
  },
  {
    toolName: 'delete_note',
    args: { name: 'old-draft' },
    outcome: 'success',
    narration: 'Agent cleans up an old note',
  },
];

// =============================================================================
// DEMO ENGINE
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDemo(): Promise<void> {
  const stateDir = '.governance-demo';

  // Clean slate
  if (existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true });
  }

  // Initialize governance state
  ensureStateDir(stateDir);
  const controller = loadOrCreateController(stateDir);
  const authority = loadAuthority(stateDir, controller.id);
  authority.activeSessionEpoch = authority.epoch;
  authority.sessionStartedAt = Date.now();
  saveAuthority(stateDir, authority);

  const enforcement = 'strict';
  const convergence = createConvergenceTracker();

  // Session stats for narrative summary
  const budget = createBudgetState();
  const loopDetector = createLoopDetector();
  const sessionStats = createSessionStats(budget, loopDetector, 'warn');

  let constraints: ConstraintEntry[] = loadConstraints(stateDir);
  let lastHash = getLastReceiptHash(stateDir);
  let seq = getReceiptCount(stateDir);

  // Header
  console.log('');
  console.log(`  ${c.bold('GOVERNANCE DEMO')}`);
  console.log(`  ${c.dim('═══════════════════════════════════════════════════════════════')}`);
  console.log('');
  console.log(`  ${c.dim('Simulating an agent making tool calls through governance.')}`);
  console.log(`  ${c.dim('No upstream server needed. Everything runs locally.')}`);
  console.log('');
  console.log(`  controller:  ${c.dim(controller.id.slice(0, 8) + '...')}`);
  console.log(`  enforcement: ${c.cyan(enforcement)}`);
  console.log(`  schema:      ${c.cyan('warn')} ${c.dim('(catches hallucinated parameters)')}`);
  console.log(`  state dir:   ${c.dim(stateDir + '/')}`);
  console.log('');
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');

  await sleep(500);

  // Run each simulated call
  for (let i = 0; i < DEMO_SCRIPT.length; i++) {
    const call = DEMO_SCRIPT[i];
    const stepNum = i + 1;

    // Narration
    console.log(`  ${c.bold(`Step ${stepNum}`)}  ${call.narration}`);
    await sleep(300);

    // Build mutation and classify
    const mutation = toolCallToMutation(call.toolName, call.args);
    const mutationType = classifyMutationType(mutation.verb, call.args);
    const target = computeToolTarget(call.toolName, call.args);
    const convergenceSignal = checkConvergence(convergence, call.toolName, target);

    // Run governance gates
    const gateResult = runGates(
      mutation, constraints, authority,
      enforcement, convergenceSignal, undefined, mutationType,
    );

    const startTime = Date.now();
    const mutBadge = mutationType === 'mutating' ? c.yellow(' [MUTATION]') : '';

    if (!gateResult.forward) {
      // BLOCKED by governance
      const icon = c.yellow('⊘');
      console.log(`  ${icon}  ${c.cyan(call.toolName)}${mutBadge}  ${c.dim('→')} target: ${c.dim(target)}`);
      console.log(`      ${c.yellow('BLOCKED')}: ${gateResult.blockReason}`);

      // Build and record receipt
      const record: Omit<ToolCallRecord, 'hash'> = {
        id: `r_${seq}`,
        seq,
        timestamp: Date.now(),
        controllerId: controller.id,
        authorityEpoch: authority.epoch,
        enforcement,
        toolName: call.toolName,
        arguments: call.args,
        target,
        constraintCheck: gateResult.constraintCheck,
        authorityCheck: gateResult.authorityCheck,
        outcome: 'blocked',
        error: gateResult.blockReason,
        durationMs: Date.now() - startTime,
        previousHash: lastHash,
        mutation: {
          verb: mutation.verb,
          target: mutation.target,
          capturedAt: mutation.capturedAt,
          args: mutation.args,
        },
        mutationType,
        attribution: gateResult.containmentCheck.attribution,
        groundingAnnotation: annotateGrounding(undefined),
        convergenceSignal,
        intentHash: computeIntentHash(undefined),
      };
      record.title = generateReceiptTitle(record);
      record.summary = generateReceiptSummary(record);
      const receipt = appendReceipt(stateDir, record);
      lastHash = receipt.hash;
      seq++;

      console.log(`      ${c.dim('hash: ' + receipt.hash.slice(0, 16) + '...')}`);
      console.log('');
      recordOutcome(sessionStats, call.toolName, 'blocked', mutationType, gateResult.blockReason);
      recordCall(budget);
      await sleep(600);
      continue;
    }

    // Simulated upstream response
    if (call.outcome === 'error') {
      // Error path — seeds a G2 constraint
      const icon = c.red('✗');
      console.log(`  ${icon}  ${c.cyan(call.toolName)}${mutBadge}  ${c.dim('→')} target: ${c.dim(target)}`);
      console.log(`      ${c.red('ERROR')}: ${call.errorText}`);

      // Seed constraint from failure
      processFailure(call.toolName, target, call.errorText!, constraints, stateDir);
      // Reload constraints after seeding
      constraints = loadConstraints(stateDir);

      console.log(`      ${c.magenta('⚡ G2 constraint seeded')} — this tool+target is now blocked for 1 hour`);

      const record: Omit<ToolCallRecord, 'hash'> = {
        id: `r_${seq}`,
        seq,
        timestamp: Date.now(),
        controllerId: controller.id,
        authorityEpoch: authority.epoch,
        enforcement,
        toolName: call.toolName,
        arguments: call.args,
        target,
        constraintCheck: gateResult.constraintCheck,
        authorityCheck: gateResult.authorityCheck,
        outcome: 'error',
        error: call.errorText,
        durationMs: Date.now() - startTime,
        previousHash: lastHash,
        mutation: {
          verb: mutation.verb,
          target: mutation.target,
          capturedAt: mutation.capturedAt,
          args: mutation.args,
        },
        mutationType,
        attribution: gateResult.containmentCheck.attribution,
        groundingAnnotation: annotateGrounding(undefined),
        convergenceSignal,
        intentHash: computeIntentHash(undefined),
      };
      record.title = generateReceiptTitle(record);
      record.summary = generateReceiptSummary(record);
      const receipt = appendReceipt(stateDir, record);
      lastHash = receipt.hash;
      seq++;

      console.log(`      ${c.dim('hash: ' + receipt.hash.slice(0, 16) + '...')}`);
      console.log('');
      recordOutcome(sessionStats, call.toolName, 'error', mutationType);
      recordCall(budget);
      await sleep(600);
      continue;
    }

    // Success path
    const icon = c.green('✓');
    console.log(`  ${icon}  ${c.cyan(call.toolName)}${mutBadge}  ${c.dim('→')} target: ${c.dim(target)}`);

    // Schema validation warning (v0.7.0)
    if (call.schemaWarning && call.hallucinated) {
      const params = call.hallucinated.map(p => c.yellow(p)).join(', ');
      console.log(`      ${c.yellow('⚠ schema')}  unknown parameters: ${params}`);
      console.log(`      ${c.dim('call forwarded (warn mode) — strict would block')}`);
      sessionStats.schemaWarnings += call.hallucinated.length;
    }

    const record: Omit<ToolCallRecord, 'hash'> = {
      id: `r_${seq}`,
      seq,
      timestamp: Date.now(),
      controllerId: controller.id,
      authorityEpoch: authority.epoch,
      enforcement,
      toolName: call.toolName,
      arguments: call.args,
      target,
      constraintCheck: gateResult.constraintCheck,
      authorityCheck: gateResult.authorityCheck,
      outcome: 'success',
      durationMs: Date.now() - startTime,
      previousHash: lastHash,
      mutation: {
        verb: mutation.verb,
        target: mutation.target,
        capturedAt: mutation.capturedAt,
        args: mutation.args,
      },
      mutationType,
      attribution: gateResult.containmentCheck.attribution,
      groundingAnnotation: annotateGrounding(undefined),
      convergenceSignal,
      intentHash: computeIntentHash(undefined),
    };
    record.title = generateReceiptTitle(record);
    record.summary = generateReceiptSummary(record);
    const receipt = appendReceipt(stateDir, record);
    lastHash = receipt.hash;
    seq++;

    console.log(`      ${c.dim('hash: ' + receipt.hash.slice(0, 16) + '...')}`);
    console.log('');
    recordOutcome(sessionStats, call.toolName, 'success', mutationType);
    recordCall(budget);
    await sleep(400);
  }

  // Chain verification
  await sleep(300);
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${c.bold('CHAIN VERIFICATION')}`);
  console.log('');

  const chain = verifyReceiptChain(stateDir);
  if (chain.intact) {
    console.log(`  ${c.green('✓')} ${c.green(`All ${seq} receipts verified`)} — chain is tamper-evident`);
  } else {
    console.log(`  ${c.red('✗')} Chain broken at seq ${chain.brokenAt}`);
  }

  console.log('');

  // Summary stats
  console.log(`  ${c.bold(String(seq))} receipts  |  ${sessionStats.mutations > 0 ? c.yellow(String(sessionStats.mutations)) : '0'} mutations  |  ${sessionStats.blocked > 0 ? c.yellow(String(sessionStats.blocked)) : '0'} blocked  |  ${sessionStats.errors > 0 ? c.red(String(sessionStats.errors)) : '0'} errors`);
  console.log('');

  // Narrative exit summary (v0.7.0)
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${c.bold('NARRATIVE SUMMARY')}`);
  const narrative = formatNarrativeSummary(sessionStats);
  for (const line of narrative.split('\n')) {
    if (line.trim()) console.log(`  ${line}`);
  }
  console.log('');

  // Webhook notification (v0.7.0)
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${c.bold('WEBHOOKS')}`);
  console.log('');
  console.log(`  ${c.dim('If configured, these events would fire:')}`);
  console.log(`  ${c.yellow('⊘')} ${c.dim('blocked')}      → write_note on todo-list (constraint violation)`);
  console.log(`  ${c.green('📋')} ${c.dim('session_complete')} → ${seq} calls, ${sessionStats.mutations} mutations, ${sessionStats.blocked} blocked`);
  console.log('');
  console.log(`  ${c.dim('Configure with --webhook or DISCORD_WEBHOOK / TELEGRAM_BOT_TOKEN env vars.')}`);
  console.log('');

  // What just happened
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${c.bold('WHAT JUST HAPPENED')}`);
  console.log('');
  console.log(`  Every tool call was ${c.cyan('receipted')} with a tamper-evident hash chain.`);
  console.log(`  When the agent's write failed, the proxy ${c.magenta('seeded a G2 constraint')}.`);
  console.log(`  When the agent retried the same call, it was ${c.yellow('blocked')} automatically.`);
  console.log(`  When the agent ${c.yellow('hallucinated parameters')}, schema validation caught it.`);
  console.log(`  A ${c.green('narrative summary')} and ${c.green('webhook events')} closed the session.`);
  console.log('');
  console.log(`  No prompting. No rules file. ${c.bold('Structural governance.')}`);
  console.log('');

  // Next steps
  console.log(`  ${c.dim('───────────────────────────────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${c.bold('TRY IT YOURSELF')}`);
  console.log('');
  console.log(`  Your demo receipts:  ${c.cyan(stateDir + '/receipts.jsonl')}`);
  console.log(`  Verify the chain:    ${c.dim('npx @sovereign-labs/mcp-proxy --verify --state-dir ' + stateDir)}`);
  console.log(`  View the ledger:     ${c.dim('npx @sovereign-labs/mcp-proxy --view --state-dir ' + stateDir)}`);
  console.log(`  Explain what happened: ${c.dim('npx @sovereign-labs/mcp-proxy --explain --state-dir ' + stateDir)}`);
  console.log('');
  console.log(`  ${c.bold('Govern your own MCP server:')}`);
  console.log(`  ${c.cyan('npx @sovereign-labs/mcp-proxy --wrap <server-name>')}`);
  console.log('');
}
