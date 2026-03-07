/**
 * @sovereign-labs/mcp-proxy — Human-Readable Narrative Engine
 * ============================================================
 *
 * Transforms raw receipt ledgers into plain-language explanations.
 * Two layers:
 *   1. Pattern-based heuristics (always works, zero deps, instant)
 *   2. LLM enhancement (optional, user-provided, any provider)
 *
 * Design principles:
 *   - Evidence is never altered — narratives are derived interpretations
 *   - Receipts remain the source of truth
 *   - Heuristics use causal connectives, intent grouping, and outcome framing
 *   - LLM layer is a graceful upgrade, not a requirement
 */

import type { ToolCallRecord } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface Narrative {
  /** One-line purpose of the run */
  purpose: string;

  /** 2-4 sentence natural language explanation */
  summary: string;

  /** Impact line: "2 files changed · 1 blocked · 0 errors" */
  impact: string;

  /** Bottom-line sentence: "should I worry?" */
  bottomLine: string;

  /** Trust footer */
  footer: string;
}

export interface LLMProvider {
  name: string;
  generate(prompt: string): Promise<string>;
}

// =============================================================================
// FILE NAME HUMANIZATION
// =============================================================================

interface HumanName {
  article: string;   // "the" or "a"
  name: string;      // "configuration file"
  short: string;     // "config.json"
}

const FILE_PATTERNS: Array<{ test: (s: string) => boolean; article: string; name: string }> = [
  { test: s => /secret|key|token|credential/i.test(s), article: 'a', name: 'sensitive file' },
  { test: s => /config/i.test(s),                       article: 'the', name: 'configuration file' },
  { test: s => /\.css$/i.test(s),                        article: 'the', name: 'stylesheet' },
  { test: s => /\.html?$/i.test(s),                      article: 'the', name: 'HTML page' },
  { test: s => /\.sql$/i.test(s),                        article: 'a', name: 'database script' },
  { test: s => /\.ya?ml$/i.test(s),                      article: 'the', name: 'configuration' },
  { test: s => /\.json$/i.test(s),                       article: 'a', name: 'JSON file' },
  { test: s => /\.env/i.test(s),                         article: 'the', name: 'environment file' },
  { test: s => /docker/i.test(s),                        article: 'the', name: 'Docker configuration' },
  { test: s => /server\./i.test(s),                      article: 'the', name: 'server code' },
  { test: s => /migration/i.test(s),                     article: 'a', name: 'database migration' },
  { test: s => /package\.json/i.test(s),                 article: 'the', name: 'package manifest' },
  { test: s => /readme/i.test(s),                        article: 'the', name: 'documentation' },
  { test: s => /\.jsx?$|\.tsx?$/i.test(s),               article: 'a', name: 'source file' },
  { test: s => /\.py$/i.test(s),                         article: 'a', name: 'Python file' },
  { test: s => /\.rs$/i.test(s),                         article: 'a', name: 'Rust file' },
  { test: s => /\.go$/i.test(s),                         article: 'a', name: 'Go file' },
  { test: s => /log/i.test(s),                           article: 'a', name: 'log file' },
];

function humanizeTarget(target: string): HumanName {
  const parts = target.replace(/[/\\]+$/, '').split(/[/\\]/);
  const basename = parts.pop() || target;

  for (const p of FILE_PATTERNS) {
    if (p.test(target)) {
      return { article: p.article, name: p.name, short: basename };
    }
  }

  // Directory path (trailing slash or no extension)
  if (target.endsWith('/') || target.endsWith('\\')) {
    return { article: 'the', name: `${basename} directory`, short: basename + '/' };
  }

  // Check if it looks like a file path
  if (target.includes('/') || target.includes('\\') || target.includes('.')) {
    return { article: 'a', name: `file called ${basename}`, short: basename };
  }

  // Resource name (service, database, etc.)
  return { article: 'the', name: target, short: target };
}

// =============================================================================
// PER-RECEIPT TITLE + SUMMARY — Deterministic, no LLM
// =============================================================================

/** Verb → human action word */
const VERB_MAP: Record<string, string> = {
  read: 'Read', get: 'Read', list: 'Listed', search: 'Searched', find: 'Searched',
  write: 'Wrote', create: 'Created', edit: 'Edited', update: 'Updated', delete: 'Deleted',
  deploy: 'Deployed', restart: 'Restarted', start: 'Started', stop: 'Stopped',
  rebuild: 'Rebuilt', kill: 'Killed',
  query: 'Queried', approve: 'Approved', reject: 'Rejected', cancel: 'Cancelled',
};

function verbToAction(toolName: string, mutationType: 'mutating' | 'readonly'): string {
  const lower = toolName.toLowerCase().replace(/[-_]/g, ' ');
  for (const [verb, action] of Object.entries(VERB_MAP)) {
    if (lower.startsWith(verb) || lower.includes(` ${verb}`) || lower.includes(`_${verb}`)) {
      return action;
    }
  }
  return mutationType === 'mutating' ? 'Modified' : 'Inspected';
}

/**
 * Generate a short human-readable title for a single receipt.
 * e.g. "Read configuration file", "Write server code [BLOCKED]"
 */
export function generateReceiptTitle(r: { toolName: string; target: string; outcome: string; mutationType: 'mutating' | 'readonly' }): string {
  const action = verbToAction(r.toolName, r.mutationType);
  const suffix = r.outcome === 'blocked' ? ' [BLOCKED]' : r.outcome === 'error' ? ' [FAILED]' : '';
  if (!r.target) return `${action} (${r.toolName})${suffix}`;
  const h = humanizeTarget(r.target);
  return `${action} ${h.name}${suffix}`;
}

/**
 * Generate a one-sentence description for a single receipt.
 * e.g. "Examined config.json to understand the current state."
 */
export function generateReceiptSummary(r: { toolName: string; target: string; outcome: string; mutationType: 'mutating' | 'readonly'; error?: string; constraintCheck?: { passed: boolean; blockedBy?: string } }): string {
  const label = r.target ? humanizeTarget(r.target) : { article: 'the', name: r.toolName, short: r.toolName };

  if (r.outcome === 'blocked') {
    const reason = r.constraintCheck?.blockedBy ?? 'a known failure pattern';
    return `Blocked from retrying ${label.name} due to ${reason}.`;
  }

  if (r.outcome === 'error') {
    const errSnippet = r.error ? `: ${r.error.slice(0, 60)}` : '';
    return `Attempted to access ${label.name} but failed${errSnippet}.`;
  }

  if (r.mutationType === 'readonly') {
    return `Examined ${label.short || label.name} to understand the current state.`;
  }

  // Successful mutation
  if (/restart|deploy|start|stop|rebuild/i.test(r.toolName)) {
    return `${verbToAction(r.toolName, r.mutationType)} ${label.name} so the changes would take effect.`;
  }
  return `${verbToAction(r.toolName, r.mutationType)} ${label.name}.`;
}

// =============================================================================
// SCALE WORDS
// =============================================================================

function scaleWord(n: number): string {
  if (n === 1) return 'a single';
  if (n <= 3) return 'a few';
  if (n <= 7) return 'several';
  return 'many';
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? singular + 's');
}

// =============================================================================
// INTENT GROUPING — Group receipts by what the agent was DOING
// =============================================================================

interface ActionGroup {
  type: 'inspection' | 'modification' | 'failure' | 'protection' | 'system' | 'search';
  receipts: ToolCallRecord[];
  /** Unique targets in this group */
  targets: Set<string>;
}

function groupByIntent(receipts: ToolCallRecord[]): ActionGroup[] {
  const groups: ActionGroup[] = [];
  let current: ActionGroup | null = null;

  for (const r of receipts) {
    let type: ActionGroup['type'];

    if (r.outcome === 'blocked') {
      type = 'protection';
    } else if (r.outcome === 'error') {
      type = 'failure';
    } else if (r.mutationType === 'mutating') {
      // Check if it's a system operation (restart, deploy, etc.)
      const sysVerbs = /restart|deploy|start|stop|kill|rebuild/i;
      type = sysVerbs.test(r.toolName) ? 'system' : 'modification';
    } else {
      const searchVerbs = /search|find|grep|query/i;
      type = searchVerbs.test(r.toolName) ? 'search' : 'inspection';
    }

    if (current && current.type === type) {
      current.receipts.push(r);
      current.targets.add(r.target);
    } else {
      current = { type, receipts: [r], targets: new Set([r.target]) };
      groups.push(current);
    }
  }

  return groups;
}

// =============================================================================
// RUN PURPOSE INFERENCE
// =============================================================================

interface RunPurpose {
  pattern: (groups: ActionGroup[], receipts: ToolCallRecord[]) => boolean;
  purpose: string;
}

const RUN_PURPOSES: RunPurpose[] = [
  {
    // read → write same target → restart
    pattern: (groups, receipts) => {
      const hasRead = receipts.some(r => r.mutationType === 'readonly');
      const hasWrite = receipts.some(r => r.mutationType === 'mutating' && r.outcome === 'success' && !/restart|deploy|start|stop/i.test(r.toolName));
      const hasRestart = receipts.some(r => /restart|deploy|start|stop/i.test(r.toolName));
      return hasRead && hasWrite && hasRestart;
    },
    purpose: 'Update configuration and apply changes',
  },
  {
    // write → fail → blocked
    pattern: (_, receipts) => {
      const hasError = receipts.some(r => r.outcome === 'error');
      const hasBlocked = receipts.some(r => r.outcome === 'blocked');
      return hasError && hasBlocked;
    },
    purpose: 'Attempt operation (with failure prevention)',
  },
  {
    // mostly reads
    pattern: (_, receipts) => {
      const reads = receipts.filter(r => r.mutationType === 'readonly').length;
      return reads > receipts.length * 0.7;
    },
    purpose: 'Inspect and gather information',
  },
  {
    // mostly writes
    pattern: (_, receipts) => {
      const writes = receipts.filter(r => r.mutationType === 'mutating' && r.outcome === 'success').length;
      return writes > receipts.length * 0.5;
    },
    purpose: 'Make changes to the system',
  },
  {
    // all errors/blocked
    pattern: (_, receipts) => {
      return receipts.every(r => r.outcome === 'error' || r.outcome === 'blocked');
    },
    purpose: 'Attempted operations (all prevented)',
  },
];

function inferPurpose(groups: ActionGroup[], receipts: ToolCallRecord[]): string {
  for (const rp of RUN_PURPOSES) {
    if (rp.pattern(groups, receipts)) return rp.purpose;
  }
  return 'Agent tool execution session';
}

// =============================================================================
// CAUSAL CONNECTIVES — The magic that makes heuristics read naturally
// =============================================================================

interface CausalPair {
  /** Test if this pair of consecutive groups matches */
  test: (a: ActionGroup, b: ActionGroup) => boolean;
  /** Generate the connecting phrase */
  phrase: (a: ActionGroup, b: ActionGroup) => string;
}

const CAUSAL_PAIRS: CausalPair[] = [
  {
    // modification → system = "and restarted the service so the changes would take effect"
    test: (a, b) => a.type === 'modification' && b.type === 'system',
    phrase: (_, b) => {
      const target = [...b.targets][0];
      const human = humanizeTarget(target);
      return `, then restarted ${human.article} ${human.name} so the changes would take effect`;
    },
  },
  {
    // failure → protection = "tried X but was denied, then the proxy blocked a retry"
    test: (a, b) => a.type === 'failure' && b.type === 'protection',
    phrase: () => `. When it attempted the same operation again, the proxy blocked it automatically — preventing a wasted retry`,
  },
  {
    // inspection → modification = "inspected X, then updated it"
    test: (a, b) => {
      if (a.type !== 'inspection' || b.type !== 'modification') return false;
      // Check if they share a target
      for (const t of a.targets) {
        if (b.targets.has(t)) return true;
      }
      return false;
    },
    phrase: (a, b) => {
      const shared = [...a.targets].find(t => b.targets.has(t));
      if (shared) {
        const human = humanizeTarget(shared);
        return `, then made changes to it`;
      }
      return `, then made changes`;
    },
  },
  {
    // inspection → inspection = merge silently
    test: (a, b) => a.type === 'inspection' && b.type === 'inspection',
    phrase: () => '',
  },
];

// =============================================================================
// GROUP NARRATION — Turn each group into a phrase
// =============================================================================

function narrateGroup(group: ActionGroup): string {
  const targets = [...group.targets];
  const count = group.receipts.length;

  switch (group.type) {
    case 'inspection': {
      if (targets.length === 1) {
        const human = humanizeTarget(targets[0]);
        return `inspected ${human.article} ${human.name}`;
      }
      return `examined ${scaleWord(targets.length)} ${pluralize(targets.length, 'file')}`;
    }

    case 'search': {
      return `searched through ${scaleWord(count)} ${pluralize(count, 'resource')}`;
    }

    case 'modification': {
      if (targets.length === 1) {
        const human = humanizeTarget(targets[0]);
        return `updated ${human.article} ${human.name}`;
      }
      return `made changes to ${scaleWord(targets.length)} ${pluralize(targets.length, 'file')}`;
    }

    case 'system': {
      const target = targets[0];
      const human = humanizeTarget(target);
      if (count === 1) {
        const verb = group.receipts[0].toolName;
        if (/restart/i.test(verb)) return `restarted ${human.article} ${human.name}`;
        if (/deploy/i.test(verb)) return `deployed ${human.article} ${human.name}`;
        if (/stop/i.test(verb)) return `stopped ${human.article} ${human.name}`;
        if (/start/i.test(verb)) return `started ${human.article} ${human.name}`;
      }
      return `performed ${scaleWord(count)} system ${pluralize(count, 'operation')}`;
    }

    case 'failure': {
      if (targets.length === 1) {
        const human = humanizeTarget(targets[0]);
        const errReceipt = group.receipts.find(r => r.error);
        const reason = errReceipt?.error
          ? summarizeError(errReceipt.error)
          : 'an error occurred';
        return `tried to access ${human.article} ${human.name} but ${reason}`;
      }
      return `encountered ${scaleWord(count)} ${pluralize(count, 'error')}`;
    }

    case 'protection': {
      if (count === 1) {
        return `the proxy blocked a repeated operation — preventing a wasted retry`;
      }
      return `the proxy blocked ${count} repeated ${pluralize(count, 'operation')} — preventing wasted retries`;
    }
  }
}

function summarizeError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('permission denied') || lower.includes('access denied') || lower.includes('forbidden'))
    return 'was denied access';
  if (lower.includes('not found') || lower.includes('no such file'))
    return 'the target was not found';
  if (lower.includes('timeout') || lower.includes('timed out'))
    return 'the operation timed out';
  if (lower.includes('connection refused') || lower.includes('econnrefused'))
    return 'the connection was refused';
  if (lower.includes('already exists'))
    return 'it already exists';
  if (lower.includes('syntax') || lower.includes('parse'))
    return 'there was a syntax error';
  // Fallback: first meaningful clause
  const firstLine = error.split('\n')[0]?.trim() ?? 'an error occurred';
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
}

// =============================================================================
// NARRATIVE ASSEMBLY
// =============================================================================

/**
 * Build aggregate summary for large receipt sets (>8 groups).
 * Instead of narrating each group, summarize by category.
 */
function buildAggregateSummary(groups: ActionGroup[], receipts: ToolCallRecord[]): string {
  const inspections = groups.filter(g => g.type === 'inspection' || g.type === 'search');
  const modifications = groups.filter(g => g.type === 'modification');
  const systems = groups.filter(g => g.type === 'system');
  const failures = groups.filter(g => g.type === 'failure');
  const protections = groups.filter(g => g.type === 'protection');

  const totalReads = inspections.reduce((n, g) => n + g.receipts.length, 0);
  const totalWrites = modifications.reduce((n, g) => n + g.receipts.length, 0);
  const uniqueWriteTargets = new Set(modifications.flatMap(g => [...g.targets]));
  const totalErrors = failures.reduce((n, g) => n + g.receipts.length, 0);
  const totalBlocked = protections.reduce((n, g) => n + g.receipts.length, 0);

  // Get the most-touched write targets for specificity
  const writeTargetCounts = new Map<string, number>();
  for (const g of modifications) {
    for (const r of g.receipts) {
      writeTargetCounts.set(r.target, (writeTargetCounts.get(r.target) ?? 0) + 1);
    }
  }
  const topTargets = [...writeTargetCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => humanizeTarget(t));

  const sentences: string[] = [];

  // Reading phase
  if (totalReads > 0) {
    const allReadTargets = new Set(inspections.flatMap(g => [...g.targets]));
    sentences.push(`examined ${scaleWord(allReadTargets.size)} ${pluralize(allReadTargets.size, 'resource')} to understand the current state`);
  }

  // Writing phase
  if (totalWrites > 0) {
    if (topTargets.length === 1) {
      sentences.push(`made ${totalWrites} ${pluralize(totalWrites, 'change')} to ${topTargets[0].article} ${topTargets[0].name}`);
    } else if (topTargets.length <= 3) {
      const names = topTargets.map(t => `${t.article} ${t.name}`);
      const last = names.pop()!;
      sentences.push(`made changes across ${uniqueWriteTargets.size} ${pluralize(uniqueWriteTargets.size, 'resource')}, primarily ${names.join(', ')} and ${last}`);
    } else {
      sentences.push(`made changes across ${uniqueWriteTargets.size} ${pluralize(uniqueWriteTargets.size, 'resource')}`);
    }
  }

  // System operations
  if (systems.length > 0) {
    const sysReceipts = systems.flatMap(g => g.receipts);
    const restarts = sysReceipts.filter(r => /restart/i.test(r.toolName)).length;
    const deploys = sysReceipts.filter(r => /deploy/i.test(r.toolName)).length;
    if (restarts > 0 && deploys > 0) {
      sentences.push(`deployed and restarted services so changes would take effect`);
    } else if (restarts > 0) {
      sentences.push(`restarted ${pluralize(restarts, 'service')} so changes would take effect`);
    } else if (deploys > 0) {
      sentences.push(`deployed the changes`);
    } else {
      sentences.push(`performed ${scaleWord(sysReceipts.length)} system ${pluralize(sysReceipts.length, 'operation')}`);
    }
  }

  // Failures
  if (totalErrors > 0) {
    const errorTargets = new Set(failures.flatMap(g => [...g.targets]));
    const firstError = failures[0]?.receipts.find(r => r.error);
    if (errorTargets.size === 1 && firstError?.error) {
      const human = humanizeTarget([...errorTargets][0]);
      sentences.push(`encountered errors accessing ${human.article} ${human.name} (${summarizeError(firstError.error)})`);
    } else {
      sentences.push(`encountered ${totalErrors} ${pluralize(totalErrors, 'error')} across ${errorTargets.size} ${pluralize(errorTargets.size, 'resource')}`);
    }
  }

  // Protections
  if (totalBlocked > 0) {
    sentences.push(`the proxy blocked ${totalBlocked} repeated ${pluralize(totalBlocked, 'operation')} to prevent wasted retries`);
  }

  // Assemble
  if (sentences.length === 0) return 'No tool calls were recorded.';

  const parts: string[] = [`The agent ${sentences[0]}`];
  for (let j = 1; j < sentences.length; j++) {
    if (sentences[j].startsWith('the proxy')) {
      parts.push(sentences[j].charAt(0).toUpperCase() + sentences[j].slice(1));
    } else {
      parts.push(`It ${sentences[j]}`);
    }
  }
  return parts.join('. ') + '.';
}

function buildSummary(groups: ActionGroup[], receipts: ToolCallRecord[]): string {
  if (receipts.length === 0) return 'No tool calls were recorded.';
  if (groups.length === 0) return 'No tool calls were recorded.';

  // For large receipt sets, use aggregate mode
  if (groups.length > 8) {
    return buildAggregateSummary(groups, receipts);
  }

  const sentences: string[] = [];
  let i = 0;

  while (i < groups.length) {
    const group = groups[i];
    let phrase = narrateGroup(group);

    // Check for causal pair with next group
    if (i + 1 < groups.length) {
      const next = groups[i + 1];
      const causal = CAUSAL_PAIRS.find(cp => cp.test(group, next));
      if (causal) {
        const connector = causal.phrase(group, next);
        if (connector) {
          phrase += connector;
        }
        i += 2; // Skip next group (consumed by causal pair)
        sentences.push(phrase);
        continue;
      }
    }

    sentences.push(phrase);
    i++;
  }

  // Assemble into flowing text
  if (sentences.length === 0) return 'No tool calls were recorded.';

  if (sentences.length === 1) {
    return `The agent ${sentences[0]}.`;
  }

  if (sentences.length === 2) {
    if (sentences[1].startsWith('the proxy')) {
      return `The agent ${sentences[0]}. ${sentences[1].charAt(0).toUpperCase() + sentences[1].slice(1)}.`;
    }
    return `The agent ${sentences[0]}. It then ${sentences[1]}.`;
  }

  // 3+ sentences
  const parts: string[] = [`The agent ${sentences[0]}`];
  for (let j = 1; j < sentences.length - 1; j++) {
    if (sentences[j].startsWith('the proxy')) {
      parts.push(sentences[j].charAt(0).toUpperCase() + sentences[j].slice(1));
    } else {
      parts.push(`It ${sentences[j]}`);
    }
  }
  const last = sentences[sentences.length - 1];
  if (last.startsWith('the proxy')) {
    parts.push(last.charAt(0).toUpperCase() + last.slice(1));
  } else {
    parts.push(`It ${last}`);
  }

  return parts.join('. ') + '.';
}

// =============================================================================
// IMPACT LINE
// =============================================================================

function buildImpact(receipts: ToolCallRecord[]): string {
  const mutations = receipts.filter(r => r.mutationType === 'mutating' && r.outcome === 'success').length;
  const reads = receipts.filter(r => r.mutationType === 'readonly').length;
  const blocked = receipts.filter(r => r.outcome === 'blocked').length;
  const errors = receipts.filter(r => r.outcome === 'error').length;

  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} ${pluralize(reads, 'read')}`);
  if (mutations > 0) parts.push(`${mutations} ${pluralize(mutations, 'change')}`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (errors > 0) parts.push(`${errors} ${pluralize(errors, 'error')}`);

  return parts.join('  ·  ') || 'no operations recorded';
}

// =============================================================================
// BOTTOM LINE — The sentence people actually want
// =============================================================================

function buildBottomLine(receipts: ToolCallRecord[]): string {
  const errors = receipts.filter(r => r.outcome === 'error').length;
  const blocked = receipts.filter(r => r.outcome === 'blocked').length;
  const succeeded = receipts.filter(r => r.outcome === 'success').length;
  const total = receipts.length;

  if (total === 0) return 'No operations were recorded.';

  if (errors === 0 && blocked === 0) {
    return 'Everything completed successfully.';
  }

  if (blocked > 0 && errors > 0) {
    return `One operation failed, and the proxy blocked ${blocked} ${pluralize(blocked, 'retry')} to prevent repeating the same mistake.`;
  }

  if (blocked > 0) {
    return `The proxy blocked ${blocked} ${pluralize(blocked, 'operation')} that matched a known failure pattern.`;
  }

  if (errors > 0 && succeeded > 0) {
    return `${succeeded} ${pluralize(succeeded, 'operation')} succeeded, but ${errors} ${pluralize(errors, 'operation')} failed.`;
  }

  if (errors > 0 && succeeded === 0) {
    return 'The agent was unable to complete any operations successfully.';
  }

  return 'The session completed.';
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Generate a human-readable narrative from receipts.
 * Pure heuristics — no LLM, no network, instant.
 */
export function generateNarrative(receipts: ToolCallRecord[]): Narrative {
  const groups = groupByIntent(receipts);
  const purpose = inferPurpose(groups, receipts);
  const summary = buildSummary(groups, receipts);
  const impact = buildImpact(receipts);
  const bottomLine = buildBottomLine(receipts);

  return {
    purpose,
    summary,
    impact,
    bottomLine,
    footer: 'This summary was generated from verifiable execution receipts.\nRun --verify to confirm the record has not been altered.',
  };
}

/**
 * Format a narrative for terminal output.
 */
export function formatNarrative(narrative: Narrative): string {
  const lines: string[] = [
    '',
    '  WHAT HAPPENED',
    '  ───────────────────────────────────────────────────────────────',
    '',
    `  Purpose:      ${narrative.purpose}`,
    '',
    `  ${narrative.summary}`,
    '',
    `  Impact:       ${narrative.impact}`,
    '',
    `  Bottom line:  ${narrative.bottomLine}`,
    '',
    `  ${narrative.footer.split('\n').join('\n  ')}`,
    '',
  ];

  return lines.join('\n');
}

// =============================================================================
// LLM ENHANCEMENT (OPTIONAL)
// =============================================================================

/**
 * Compress receipts into a minimal prompt for LLM summarization.
 * Strips hashes, authority fields, and internal metadata.
 * Typically produces 50-100 tokens for a 10-50 receipt session.
 */
export function compressForLLM(receipts: ToolCallRecord[]): string {
  return receipts.map((r, i) => {
    const outcome = r.outcome === 'success' ? 'ok' : r.outcome === 'blocked' ? 'BLOCKED' : 'FAILED';
    const mut = r.mutationType === 'mutating' ? ' [MUTATION]' : '';
    const err = r.error ? ` — ${r.error.split('\n')[0]?.slice(0, 80)}` : '';
    const blocked = r.outcome === 'blocked' && r.constraintCheck?.blockedBy
      ? ` — blocked: ${r.constraintCheck.blockedBy}`
      : '';
    return `${i + 1}. ${outcome} ${r.toolName} → ${r.target}${mut}${err}${blocked}`;
  }).join('\n');
}

/**
 * Build the LLM prompt for narrative generation.
 */
export function buildLLMPrompt(compressed: string): string {
  return `You are summarizing an AI agent's tool execution history for someone who is not technical.

Rules:
- Explain what happened in plain, friendly language
- Do not invent details — only describe what the receipts show
- If something was blocked, explain that the governance system prevented a repeated mistake
- End with a one-sentence "bottom line" assessment
- Keep it under 100 words

Tool execution log:
${compressed}

Write a clear, friendly summary:`;
}

/**
 * Generate narrative with optional LLM enhancement.
 * Falls back to heuristics if LLM fails.
 */
export async function generateNarrativeWithLLM(
  receipts: ToolCallRecord[],
  provider: LLMProvider,
): Promise<Narrative> {
  const heuristic = generateNarrative(receipts);

  try {
    const compressed = compressForLLM(receipts);
    const prompt = buildLLMPrompt(compressed);
    const llmText = await provider.generate(prompt);

    if (llmText && llmText.trim().length > 20) {
      return {
        ...heuristic,
        summary: llmText.trim(),
        // Keep heuristic purpose, impact, bottomLine, footer
        // LLM only replaces the main summary paragraph
      };
    }
  } catch {
    // LLM failed — fall back to heuristics silently
  }

  return heuristic;
}

// =============================================================================
// LLM PROVIDER FACTORIES
// =============================================================================

/**
 * Create an Ollama LLM provider.
 */
export function createOllamaProvider(model = 'llama3.2', host = 'http://localhost:11434'): LLMProvider {
  return {
    name: `ollama/${model}`,
    async generate(prompt: string): Promise<string> {
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
      const data = await res.json() as { response: string };
      return data.response;
    },
  };
}

/**
 * Create an OpenAI-compatible LLM provider.
 * Works with OpenAI, Anthropic (via proxy), and other compatible APIs.
 */
export function createOpenAIProvider(
  apiKey: string,
  model = 'gpt-4o-mini',
  baseUrl = 'https://api.openai.com/v1',
): LLMProvider {
  return {
    name: `openai/${model}`,
    async generate(prompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? '';
    },
  };
}

/**
 * Create a Google Gemini LLM provider.
 */
export function createGeminiProvider(
  apiKey: string,
  model = 'gemini-2.0-flash',
): LLMProvider {
  return {
    name: `gemini/${model}`,
    async generate(prompt: string): Promise<string> {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
          }),
        },
      );
      if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return data.candidates[0]?.content?.parts[0]?.text ?? '';
    },
  };
}

/**
 * Create an Anthropic LLM provider.
 */
export function createAnthropicProvider(
  apiKey: string,
  model = 'claude-haiku-4-5-20251001',
): LLMProvider {
  return {
    name: `anthropic/${model}`,
    async generate(prompt: string): Promise<string> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
      const data = await res.json() as { content: Array<{ text: string }> };
      return data.content[0]?.text ?? '';
    },
  };
}
