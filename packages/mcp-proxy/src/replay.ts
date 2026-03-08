/**
 * Replay — Timeline Story Renderer
 * ==================================
 *
 * `--replay` is a story view: what happened, in what order, told as a timeline.
 * Different from `--view` (per-receipt ledger) and `--receipts` (summary stats).
 *
 * Replay groups consecutive calls into phases (planning, executing, verifying)
 * and highlights the turning points: errors, blocks, loops, mutations.
 *
 * Default: last 200 receipts. `--replay N` for custom count.
 */

import { existsSync } from 'fs';
import { loadReceipts } from './state.js';
import type { ToolCallRecord } from './types.js';

// ANSI colors (same as index.ts — duplicated to keep replay self-contained)
const isTTY = process.stderr.isTTY ?? false;
const c = {
  green:   (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:     (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow:  (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:    (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  dim:     (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold:    (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  magenta: (s: string) => isTTY ? `\x1b[35m${s}\x1b[0m` : s,
};

interface Phase {
  name: string;
  receipts: ToolCallRecord[];
  startTime: number;
  endTime: number;
}

/**
 * Print the replay timeline to stderr.
 */
export function printReplay(stateDir: string, limit: number = 200): void {
  if (!existsSync(stateDir)) {
    process.stderr.write(`No governance state found at ${stateDir}/\n`);
    return;
  }

  const allReceipts = loadReceipts(stateDir);
  if (allReceipts.length === 0) {
    process.stderr.write(`No receipts in ${stateDir}/receipts.jsonl\n`);
    return;
  }

  const receipts = allReceipts.slice(-limit);
  const omitted = allReceipts.length - receipts.length;

  // Group into phases
  const phases = groupIntoPhases(receipts);

  // Header
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${c.bold('SESSION REPLAY')}`);
  lines.push(`  ${c.dim('═══════════════════════════════════════════════════════════')}`);

  if (omitted > 0) {
    lines.push(`  ${c.dim(`(${omitted} earlier receipts omitted — showing last ${limit})`)}`);
  }

  const totalDuration = receipts.length > 1
    ? receipts[receipts.length - 1].timestamp - receipts[0].timestamp
    : 0;
  lines.push(`  ${c.dim('total duration: ' + formatDuration(totalDuration))}`);
  lines.push('');

  // Render each phase
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseDuration = phase.endTime - phase.startTime;

    // Phase header
    const phaseIcon = getPhaseIcon(phase.name);
    lines.push(`  ${phaseIcon} ${c.bold(phase.name)} ${c.dim(`(${phase.receipts.length} calls, ${formatDuration(phaseDuration)})`)}`);

    // Show key events in this phase
    for (const r of phase.receipts) {
      const relTime = formatRelTime(r.timestamp - receipts[0].timestamp);
      const line = formatReceiptLine(r, relTime);
      lines.push(`  │ ${line}`);
    }

    // Phase separator
    if (i < phases.length - 1) {
      lines.push(`  │`);
      lines.push(`  ├${'─'.repeat(55)}`);
      lines.push(`  │`);
    }
  }

  // Footer summary
  lines.push('');
  lines.push(`  ${c.dim('───────────────────────────────────────────────────────────')}`);

  const mutations = receipts.filter(r => r.mutationType === 'mutating').length;
  const blocked = receipts.filter(r => r.outcome === 'blocked').length;
  const errors = receipts.filter(r => r.outcome === 'error').length;
  const success = receipts.filter(r => r.outcome === 'success').length;

  lines.push(`  ${c.bold(String(receipts.length))} calls  ·  ${c.green(String(success))} ok  ·  ${mutations > 0 ? c.yellow(String(mutations)) : '0'} mutations  ·  ${errors > 0 ? c.red(String(errors)) : '0'} errors  ·  ${blocked > 0 ? c.red(String(blocked)) : '0'} blocked`);

  // Turning points
  const turningPoints = findTurningPoints(receipts);
  if (turningPoints.length > 0) {
    lines.push('');
    lines.push(`  ${c.bold('turning points:')}`);
    for (const tp of turningPoints) {
      lines.push(`    ${tp}`);
    }
  }

  lines.push('');

  process.stderr.write(lines.join('\n') + '\n');
}

/**
 * Group receipts into phases based on tool patterns.
 */
function groupIntoPhases(receipts: ToolCallRecord[]): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | null = null;

  for (const r of receipts) {
    const phaseName = classifyPhase(r);

    if (!current || current.name !== phaseName) {
      current = {
        name: phaseName,
        receipts: [],
        startTime: r.timestamp,
        endTime: r.timestamp,
      };
      phases.push(current);
    }

    current.receipts.push(r);
    current.endTime = r.timestamp + r.durationMs;
  }

  return phases;
}

/**
 * Classify a receipt into a phase name.
 */
function classifyPhase(r: ToolCallRecord): string {
  const tool = r.toolName.toLowerCase();

  // Governance meta-tools
  if (tool.startsWith('governance_')) return 'governance';

  // Blocked calls
  if (r.outcome === 'blocked') return 'blocked';

  // Read-only tools
  if (r.mutationType === 'readonly') {
    if (tool.includes('list') || tool.includes('search') || tool.includes('find')) return 'exploring';
    if (tool.includes('read') || tool.includes('get') || tool.includes('view')) return 'reading';
    if (tool.includes('status') || tool.includes('health') || tool.includes('check')) return 'checking';
    return 'observing';
  }

  // Mutating tools
  if (tool.includes('write') || tool.includes('edit') || tool.includes('create')) return 'writing';
  if (tool.includes('deploy') || tool.includes('restart') || tool.includes('build')) return 'deploying';
  if (tool.includes('delete') || tool.includes('remove') || tool.includes('drop')) return 'removing';

  return 'executing';
}

function getPhaseIcon(phase: string): string {
  switch (phase) {
    case 'exploring': return c.cyan('🔍');
    case 'reading': return c.cyan('📖');
    case 'observing': return c.cyan('👁');
    case 'checking': return c.cyan('🔎');
    case 'writing': return c.yellow('✏️');
    case 'deploying': return c.yellow('🚀');
    case 'removing': return c.red('🗑');
    case 'executing': return c.yellow('⚡');
    case 'governance': return c.magenta('🛡');
    case 'blocked': return c.red('⊘');
    default: return c.dim('·');
  }
}

/**
 * Format a single receipt as a timeline entry.
 */
function formatReceiptLine(r: ToolCallRecord, relTime: string): string {
  const outcomeIcon = r.outcome === 'success' ? c.green('✓')
    : r.outcome === 'blocked' ? c.yellow('⊘')
    : c.red('✗');

  const mutBadge = r.mutationType === 'mutating' ? c.yellow(' [M]') : '';

  // Use title if available, otherwise tool name
  const label = r.title || r.toolName;
  const shortLabel = label.length > 45 ? label.slice(0, 42) + '...' : label;

  let line = `${c.dim(relTime)} ${outcomeIcon} ${shortLabel}${mutBadge}`;

  // Add error detail for errors
  if (r.outcome === 'error' && r.error) {
    const shortErr = r.error.length > 40 ? r.error.slice(0, 37) + '...' : r.error;
    line += `\n  │   ${c.red('└─ ' + shortErr)}`;
  }

  // Add block reason for blocked calls
  if (r.outcome === 'blocked' && r.error) {
    const shortReason = r.error.length > 50 ? r.error.slice(0, 47) + '...' : r.error;
    line += `\n  │   ${c.yellow('└─ ' + shortReason)}`;
  }

  return line;
}

/**
 * Find turning points in the session — moments where behavior changed.
 */
function findTurningPoints(receipts: ToolCallRecord[]): string[] {
  const points: string[] = [];

  // First error
  const firstError = receipts.find(r => r.outcome === 'error');
  if (firstError) {
    const relTime = formatRelTime(firstError.timestamp - receipts[0].timestamp);
    points.push(`${c.red('first error')} at ${relTime}: ${firstError.toolName} — ${(firstError.error ?? '').slice(0, 50)}`);
  }

  // First block
  const firstBlock = receipts.find(r => r.outcome === 'blocked');
  if (firstBlock) {
    const relTime = formatRelTime(firstBlock.timestamp - receipts[0].timestamp);
    points.push(`${c.yellow('first block')} at ${relTime}: ${firstBlock.toolName}`);
  }

  // First mutation
  const firstMutation = receipts.find(r => r.mutationType === 'mutating');
  if (firstMutation) {
    const relTime = formatRelTime(firstMutation.timestamp - receipts[0].timestamp);
    points.push(`${c.yellow('first mutation')} at ${relTime}: ${firstMutation.toolName}`);
  }

  // Longest call
  const longest = receipts.reduce((max, r) => r.durationMs > max.durationMs ? r : max, receipts[0]);
  if (longest.durationMs > 1000) {
    const relTime = formatRelTime(longest.timestamp - receipts[0].timestamp);
    points.push(`${c.cyan('slowest call')} at ${relTime}: ${longest.toolName} (${formatDuration(longest.durationMs)})`);
  }

  return points;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatRelTime(ms: number): string {
  if (ms < 1000) return '+0s'.padStart(6);
  if (ms < 60_000) return `+${(ms / 1000).toFixed(0)}s`.padStart(6);
  if (ms < 3_600_000) return `+${(ms / 60_000).toFixed(1)}m`.padStart(6);
  return `+${(ms / 3_600_000).toFixed(1)}h`.padStart(6);
}
