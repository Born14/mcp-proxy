/**
 * Exit Summary — Auto-printed on Session End
 * =============================================
 *
 * When the proxy exits (upstream dies, SIGTERM, SIGINT), prints a compact
 * session summary to stderr. Never stdout — stdout is MCP protocol.
 *
 * The summary shows: call count, mutations, blocked, errors, loops detected,
 * budget usage, schema violations, duration, and chain integrity.
 *
 * This is the "what just happened?" readout that appears in the terminal
 * after an agent session ends. Zero configuration required.
 */

import type { BudgetState } from './budget.js';
import type { LoopDetector } from './loop-detect.js';
import type { SchemaMode } from './schema-check.js';
import { getLoopStats } from './loop-detect.js';

export interface SessionStats {
  /** Total tool calls receipted */
  totalCalls: number;

  /** Calls classified as mutating */
  mutations: number;

  /** Calls classified as readonly */
  readonly: number;

  /** Calls blocked by any governance gate */
  blocked: number;

  /** Calls that resulted in upstream errors */
  errors: number;

  /** Calls forwarded successfully */
  succeeded: number;

  /** Schema validation warnings emitted */
  schemaWarnings: number;

  /** Schema validation blocks (strict mode only) */
  schemaBlocks: number;

  /** Session start time (Date.now()) */
  startTime: number;

  /** Budget state */
  budget: BudgetState;

  /** Loop detector */
  loopDetector: LoopDetector;

  /** Schema mode */
  schemaMode: SchemaMode;

  /** Tools seen → call count */
  toolCounts: Map<string, number>;

  /** Block reasons → count */
  blockReasons: Map<string, number>;
}

/**
 * Create a fresh session stats tracker.
 */
export function createSessionStats(
  budget: BudgetState,
  loopDetector: LoopDetector,
  schemaMode: SchemaMode,
): SessionStats {
  return {
    totalCalls: 0,
    mutations: 0,
    readonly: 0,
    blocked: 0,
    errors: 0,
    succeeded: 0,
    schemaWarnings: 0,
    schemaBlocks: 0,
    startTime: Date.now(),
    budget,
    loopDetector,
    schemaMode,
    toolCounts: new Map(),
    blockReasons: new Map(),
  };
}

/**
 * Record a tool call outcome in session stats.
 */
export function recordOutcome(
  stats: SessionStats,
  toolName: string,
  outcome: 'success' | 'error' | 'blocked',
  mutationType: 'mutating' | 'readonly',
  blockReason?: string,
): void {
  stats.totalCalls++;
  stats.toolCounts.set(toolName, (stats.toolCounts.get(toolName) ?? 0) + 1);

  if (mutationType === 'mutating') stats.mutations++;
  else stats.readonly++;

  if (outcome === 'success') stats.succeeded++;
  else if (outcome === 'error') stats.errors++;
  else if (outcome === 'blocked') {
    stats.blocked++;
    if (blockReason) {
      // Classify the block reason
      const category = classifyBlockReason(blockReason);
      stats.blockReasons.set(category, (stats.blockReasons.get(category) ?? 0) + 1);
    }
  }
}

/**
 * Classify a block reason into a short category for the summary.
 */
function classifyBlockReason(reason: string): string {
  if (reason.includes('BUDGET')) return 'budget';
  if (reason.includes('LOOP')) return 'loop';
  if (reason.includes('SCHEMA')) return 'schema';
  if (reason.includes('G2')) return 'constraint (G2)';
  if (reason.includes('E-H8')) return 'authority (E-H8)';
  if (reason.includes('G5')) return 'containment (G5)';
  if (reason.includes('CONVERGENCE')) return 'convergence';
  return 'other';
}

/**
 * Format the exit summary for stderr output.
 * Returns a multi-line string ready to write.
 */
export function formatExitSummary(stats: SessionStats): string {
  const durationMs = Date.now() - stats.startTime;
  const durationStr = formatDuration(durationMs);
  const loopStats = getLoopStats(stats.loopDetector);

  const lines: string[] = [];
  lines.push('');
  lines.push('┌─────────────────────────────────────────┐');
  lines.push('│          SESSION SUMMARY                 │');
  lines.push('├─────────────────────────────────────────┤');
  lines.push(`│  duration:       ${pad(durationStr, 22)}│`);
  lines.push(`│  tool calls:     ${pad(String(stats.totalCalls), 22)}│`);
  lines.push(`│  ├─ succeeded:   ${pad(String(stats.succeeded), 22)}│`);
  lines.push(`│  ├─ errors:      ${pad(String(stats.errors), 22)}│`);
  lines.push(`│  └─ blocked:     ${pad(String(stats.blocked), 22)}│`);
  lines.push(`│  mutations:      ${pad(String(stats.mutations), 22)}│`);
  lines.push(`│  readonly:       ${pad(String(stats.readonly), 22)}│`);

  // Budget
  if (stats.budget.maxCalls !== undefined) {
    const used = `${stats.budget.callCount}/${stats.budget.maxCalls}`;
    lines.push(`│  budget:         ${pad(used, 22)}│`);
  }

  // Loops
  if (loopStats.activeLoops > 0) {
    lines.push(`│  loops detected: ${pad(String(loopStats.activeLoops), 22)}│`);
  }

  // Schema
  if (stats.schemaMode !== 'off') {
    if (stats.schemaWarnings > 0 || stats.schemaBlocks > 0) {
      const schemaStr = stats.schemaMode === 'strict'
        ? `${stats.schemaBlocks} blocked`
        : `${stats.schemaWarnings} warnings`;
      lines.push(`│  schema:         ${pad(schemaStr, 22)}│`);
    }
  }

  // Block breakdown (if any blocks)
  if (stats.blocked > 0) {
    lines.push('├─────────────────────────────────────────┤');
    lines.push('│  blocks by reason:                      │');
    for (const [reason, count] of stats.blockReasons.entries()) {
      lines.push(`│    ${pad(reason, 17)} ${pad(String(count), 20)}│`);
    }
  }

  // Top tools
  if (stats.toolCounts.size > 0) {
    lines.push('├─────────────────────────────────────────┤');
    lines.push('│  top tools:                             │');
    const sorted = [...stats.toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted.slice(0, 5)) {
      const shortName = name.length > 25 ? name.slice(0, 22) + '...' : name;
      lines.push(`│    ${pad(shortName, 25)} ${pad(String(count), 12)}│`);
    }
    if (sorted.length > 5) {
      lines.push(`│    ... and ${sorted.length - 5} more${' '.repeat(22)}│`);
    }
  }

  lines.push('└─────────────────────────────────────────┘');
  lines.push('');

  return lines.join('\n');
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
