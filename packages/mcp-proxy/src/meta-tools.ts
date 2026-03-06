/**
 * Injected Governance Meta-Tools
 * ===============================
 *
 * Five tools injected into the upstream's tools/list response:
 *
 *   bump_authority          — E-H8 epoch increment (invalidates current session)
 *   governance_status       — Read-only state inspection
 *   governance_declare_intent — Tier 3: Declare intent for containment attribution
 *   governance_clear_intent   — Tier 3: Clear declared intent
 *   governance_convergence_status — Tier 5: Read-only convergence inspection
 *
 * These are handled locally by the proxy, never forwarded upstream.
 */

import { incrementAuthority } from '@sovereign-labs/kernel';
import type { AuthorityContext } from '@sovereign-labs/kernel/types';
import type { McpToolDef, ProxyState, AuthorityState, DeclaredPredicate, IntentContext } from './types.js';
import { saveAuthority, saveIntent, clearIntent } from './state.js';

/** Names of meta-tools — used to route calls locally vs upstream */
export const META_TOOL_NAMES = [
  'governance_bump_authority',
  'governance_status',
  'governance_declare_intent',
  'governance_clear_intent',
  'governance_convergence_status',
] as const;
export type MetaToolName = typeof META_TOOL_NAMES[number];

/**
 * Check if a tool name is a governance meta-tool.
 */
export function isMetaTool(toolName: string): toolName is MetaToolName {
  return (META_TOOL_NAMES as readonly string[]).includes(toolName);
}

/**
 * MCP tool definitions for the two meta-tools.
 */
export const META_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'governance_bump_authority',
    description: '[GOVERNANCE] Increment the authority epoch. Invalidates all tool calls from the current agent session. Use when the operator needs to override or redirect agent behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why authority is being bumped (audit trail)',
        },
      },
    },
  },
  {
    name: 'governance_status',
    description: '[GOVERNANCE · READ-ONLY] Inspect current governance state: controller identity, authority epoch, constraint count, receipt count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'governance_declare_intent',
    description: '[GOVERNANCE] Declare intent for containment attribution. Every tool call after this will be attributed to the declared predicates. Overwrites any prior intent.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'What the agent is trying to achieve',
        },
        predicates: {
          type: 'array',
          description: 'Testable claims about end-state. Each predicate has a type and key-value fields.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Predicate type (e.g. "css", "http", "db")' },
            },
            additionalProperties: { type: 'string' },
          },
        },
        grounding: {
          type: 'object',
          description: 'Optional grounding context (domain facts observed by the agent)',
          properties: {
            facts: { type: 'object', description: 'Opaque domain facts' },
            observedAt: { type: 'number', description: 'When facts were observed (ms epoch)' },
          },
        },
      },
      required: ['goal', 'predicates'],
    },
  },
  {
    name: 'governance_clear_intent',
    description: '[GOVERNANCE] Clear the declared intent. Prevents stale intent from affecting attribution.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'governance_convergence_status',
    description: '[GOVERNANCE · READ-ONLY] Inspect convergence state: failure signature counts, tool+target repetition counts, current signal level.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// =============================================================================
// META-TOOL HANDLERS
// =============================================================================

export interface MetaToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Handle a governance_bump_authority call.
 *
 * Increments the authority epoch using kernel incrementAuthority().
 * The activeSessionEpoch is NOT updated — it stays frozen at session start.
 * This creates the gap that validateAuthority() detects on subsequent calls.
 */
export function handleBumpAuthority(
  args: Record<string, unknown>,
  state: ProxyState,
  stateDir: string,
): MetaToolResult {
  const reason = (typeof args.reason === 'string' ? args.reason : 'Manual bump') as string;

  // Use kernel incrementAuthority() for the epoch math
  const ctx: AuthorityContext = {
    controllerId: state.authority.controllerId,
    authorityEpoch: state.authority.epoch,
    isForeign: false,
  };
  const incremented = incrementAuthority(ctx);

  // Update in-memory state
  state.authority.epoch = incremented.authorityEpoch;
  state.authority.lastBumpedAt = Date.now();
  // Note: activeSessionEpoch is NOT updated — this is the E-H8 mechanism

  // Persist
  saveAuthority(stateDir, state.authority);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        epoch: state.authority.epoch,
        previousEpoch: ctx.authorityEpoch,
        reason,
        sessionEpoch: state.authority.activeSessionEpoch,
        note: 'Current session tools will be blocked until agent re-initializes',
      }),
    }],
  };
}

/**
 * Handle a governance_status call.
 *
 * Read-only inspection of current governance state.
 */
export function handleGovernanceStatus(state: ProxyState, stateDir: string, enforcement?: 'strict' | 'advisory'): MetaToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        controllerId: state.controller.id,
        controllerEstablished: new Date(state.controller.establishedAt).toISOString(),
        authorityEpoch: state.authority.epoch,
        epoch: state.authority.epoch,  // Alias for convenience
        sessionEpoch: state.authority.activeSessionEpoch,
        enforcement: enforcement ?? 'strict',
        constraintCount: state.constraints.length,
        activeConstraints: state.constraints.filter(
          c => (Date.now() - c.createdAt) < (c.ttlMs ?? 60 * 60 * 1000),
        ).length,
        receiptCount: state.receiptSeq,
        stateDir,
      }),
    }],
  };
}

/**
 * Handle a governance_declare_intent call.
 *
 * Overwrites any existing intent. Returns previousAgeMs (if prior existed),
 * new predicate count, and grounding summary.
 */
export function handleDeclareIntent(
  args: Record<string, unknown>,
  state: ProxyState,
  stateDir: string,
): MetaToolResult {
  const goal = typeof args.goal === 'string' ? args.goal : '';
  const rawPredicates = Array.isArray(args.predicates) ? args.predicates : [];

  // Flatten each predicate's non-type fields into DeclaredPredicate.fields (string values only)
  const predicates: DeclaredPredicate[] = rawPredicates.map((p: Record<string, unknown>) => {
    const type = typeof p.type === 'string' ? p.type : 'unknown';
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'type') continue;
      if (typeof v === 'string') fields[k] = v;
    }
    return { type, fields };
  });

  // Capture previous intent age
  const previousAgeMs = state.intent
    ? Date.now() - state.intent.declaredAt
    : undefined;

  // Build grounding context if provided
  let grounding: IntentContext['grounding'];
  if (args.grounding && typeof args.grounding === 'object') {
    const g = args.grounding as Record<string, unknown>;
    grounding = {
      facts: (g.facts && typeof g.facts === 'object') ? g.facts as Record<string, unknown> : {},
      observedAt: typeof g.observedAt === 'number' ? g.observedAt : Date.now(),
    };
  }

  // Build and store intent
  const intent: IntentContext = {
    goal,
    predicates,
    declaredAt: Date.now(),
    grounding,
    version: 1,
  };

  state.intent = intent;
  saveIntent(stateDir, intent);

  // Build grounding summary
  const groundingSummary = grounding
    ? {
        factCount: Object.keys(grounding.facts).length,
        observedAt: new Date(grounding.observedAt).toISOString(),
        ageMs: Date.now() - grounding.observedAt,
      }
    : null;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        previousAgeMs,
        predicateCount: predicates.length,
        goal,
        grounding: groundingSummary,
      }),
    }],
  };
}

/**
 * Handle a governance_clear_intent call.
 *
 * Explicitly clears the declared intent. Prevents stale intent confusion.
 */
export function handleClearIntent(
  state: ProxyState,
  stateDir: string,
): MetaToolResult {
  const hadIntent = !!state.intent;
  state.intent = undefined;
  clearIntent(stateDir);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        cleared: hadIntent,
        message: hadIntent ? 'Intent cleared' : 'No intent was declared',
      }),
    }],
  };
}

/**
 * Handle a governance_convergence_status call.
 *
 * Read-only inspection of convergence state.
 */
export function handleConvergenceStatus(state: ProxyState): MetaToolResult {
  const failureSigs: Record<string, number> = {};
  for (const [sig, count] of state.convergence.failureSignatures) {
    failureSigs[sig] = count;
  }

  const toolTargets: Record<string, number> = {};
  for (const [key, timestamps] of state.convergence.toolTargetTimestamps) {
    toolTargets[key] = timestamps.length;
  }

  // Derive current signal level
  let maxSignal: string = 'none';
  for (const count of state.convergence.failureSignatures.values()) {
    if (count >= 3) { maxSignal = 'exhausted'; break; }
    if (count >= 2 && maxSignal !== 'exhausted') maxSignal = 'warning';
  }
  for (const timestamps of state.convergence.toolTargetTimestamps.values()) {
    const now = Date.now();
    const recent = timestamps.filter(t => (now - t) < 2 * 60 * 1000);
    if (recent.length >= 5 && maxSignal !== 'exhausted') maxSignal = 'loop';
  }

  // Recommendations
  const recommendations: string[] = [];
  if (maxSignal === 'warning') {
    recommendations.push('Consider changing approach — same failure seen multiple times');
  }
  if (maxSignal === 'exhausted') {
    recommendations.push('Session exhausted for this failure pattern — change strategy or declare new intent');
  }
  if (maxSignal === 'loop') {
    recommendations.push('Repetitive tool+target calls detected — consider a different approach');
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        signal: maxSignal,
        failureSignatures: failureSigs,
        toolTargetCounts: toolTargets,
        recommendations,
      }),
    }],
  };
}

/**
 * Dispatch a meta-tool call to the appropriate handler.
 */
export function handleMetaTool(
  toolName: MetaToolName,
  args: Record<string, unknown>,
  state: ProxyState,
  stateDir: string,
  enforcement?: 'strict' | 'advisory',
): MetaToolResult {
  switch (toolName) {
    case 'governance_bump_authority':
      return handleBumpAuthority(args, state, stateDir);
    case 'governance_status':
      return handleGovernanceStatus(state, stateDir, enforcement);
    case 'governance_declare_intent':
      return handleDeclareIntent(args, state, stateDir);
    case 'governance_clear_intent':
      return handleClearIntent(state, stateDir);
    case 'governance_convergence_status':
      return handleConvergenceStatus(state);
  }
}
