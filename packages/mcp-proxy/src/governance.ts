/**
 * Governance Gate Checks
 * ======================
 *
 * Five gate levels before forwarding each tool call:
 *
 *   G2:   Has this exact tool+target failed before? (constraint check)
 *   E-H7: Is this controller known? (identity — structural via controllerId)
 *   E-H8: Is authority still valid? (temporal — session epoch vs authority epoch)
 *   Tier 3: Containment attribution — every tool call traced to a declared predicate
 *   Tier 5: Convergence enforcement — detect failure loops, escalate
 *
 * Plus: constraint seeding on failure (extract signature, persist).
 * Plus: Tier 4 grounding annotation on receipts.
 *
 * Uses kernel functions directly:
 *   - validateAuthority() for E-H8
 *   - checkIdentity() for E-H7
 *   - extractSignature() via fingerprint.ts for G2
 */

import { validateAuthority, checkIdentity, extractSignature } from '@sovereign-labs/kernel';
import type { AuthorityContext, GateVerdict } from '@sovereign-labs/kernel/types';
import type {
  AuthorityState,
  ConstraintEntry,
  IntentContext,
  AttributionClass,
  AttributionMatchDetail,
  ConvergenceTracker,
  ConvergenceSignal,
} from './types.js';
import type { Mutation } from '@sovereign-labs/kernel/types';
import { seedFromFailure } from './fingerprint.js';
import { saveConstraints } from './state.js';

/** Default constraint TTL: 1 hour */
export const CONSTRAINT_TTL_MS = 60 * 60 * 1000;

// =============================================================================
// G2: CONSTRAINT CHECK — Exact match on tool+target within TTL
// =============================================================================

/**
 * G2: Check if a tool call is blocked by a prior failure constraint.
 *
 * Exact match: same tool name + same target + within TTL.
 * v0 is intentionally conservative — blocks ALL retries of the same
 * tool+target within TTL, regardless of argument changes.
 *
 * The invariant: "Don't immediately retry the same tool against the
 * same target within TTL of a prior failure."
 */
export function checkConstraints(
  mutation: Mutation,
  constraints: ConstraintEntry[],
  now: number = Date.now(),
): { passed: boolean; blockedBy?: string } {

  const match = constraints.find(
    c =>
      c.toolName === mutation.verb &&
      c.target === mutation.target &&
      (now - c.createdAt) < (c.ttlMs ?? CONSTRAINT_TTL_MS),
  );

  if (match) {
    return { passed: false, blockedBy: match.id };
  }
  return { passed: true };
}

// =============================================================================
// E-H8: AUTHORITY CHECK — Session epoch vs authority epoch
// =============================================================================

/**
 * E-H8: Check if the current session's authority is still valid.
 *
 * Session epoch is captured at proxy startup and frozen.
 * If bump_authority has been called (incrementing the authority epoch),
 * the session epoch will be behind → stale → blocked/annotated.
 */
export function checkAuthority(state: AuthorityState): GateVerdict {
  const ctx: AuthorityContext = {
    controllerId: state.controllerId,
    authorityEpoch: state.epoch,
    planEpoch: state.activeSessionEpoch,
    isForeign: false,
  };
  return validateAuthority(ctx);
}

// =============================================================================
// E-H7: IDENTITY CHECK — Controller binding
// =============================================================================

/**
 * E-H7: Check if the controller identity is valid.
 *
 * In the proxy's single-session model, identity is always valid
 * (the proxy created or loaded the controller). This is included
 * for completeness and receipt audit trail.
 */
export function checkControllerIdentity(controllerId: string): GateVerdict {
  const ctx: AuthorityContext = {
    controllerId,
    authorityEpoch: 0,
    isForeign: false,
  };
  return checkIdentity(ctx);
}

// =============================================================================
// CONSTRAINT SEEDING — Failures become constraints
// =============================================================================

/**
 * Process a tool call failure: extract signature, seed constraint, persist.
 *
 * Returns the new constraint if one was seeded, null otherwise.
 */
export function processFailure(
  toolName: string,
  target: string,
  errorText: string,
  constraints: ConstraintEntry[],
  stateDir: string,
): ConstraintEntry | null {
  const newConstraint = seedFromFailure(toolName, target, errorText, constraints);
  if (newConstraint) {
    constraints.push(newConstraint);
    saveConstraints(stateDir, constraints);
  }
  return newConstraint;
}

// =============================================================================
// CANONICAL TARGET EXTRACTION
// =============================================================================

/**
 * Extract the canonical target from tool call arguments.
 *
 * Single function used everywhere: attribution matching, convergence key,
 * receipt target field. Consistent extraction prevents target drift
 * between subsystems.
 *
 * Priority: path > file > url > selector > table > key > name
 * Fallback: JSON.stringify(args) truncated to 200 chars
 */
export function computeToolTarget(toolName: string, args: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'url', 'selector', 'table', 'key', 'name']) {
    if (typeof args[key] === 'string' && args[key]) return args[key] as string;
  }
  const json = JSON.stringify(args);
  if (json.length > 200) return json.slice(0, 200);
  return json || toolName;
}

// =============================================================================
// TIER 3: CONTAINMENT ATTRIBUTION (Heuristic)
// =============================================================================

/**
 * Infrastructure verbs that don't need predicate justification.
 * A tool call using one of these verbs is classified as 'scaffolding'.
 */
const INFRASTRUCTURE_VERBS = new Set([
  'deploy', 'restart', 'build', 'migrate', 'start', 'stop', 'kill',
  'push', 'pull', 'install', 'provision', 'bootstrap', 'backup',
  'restore', 'snapshot', 'revert', 'rollback',
]);

/**
 * Structured key priority order — checked first for predicate field matching.
 * These keys carry semantic weight for attribution.
 */
const STRUCTURED_KEY_PRIORITY = [
  'path', 'selector', 'table', 'column', 'method', 'key', 'property', 'expected',
];

/**
 * Normalize a string for matching: lower-case, trim, collapse whitespace.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check if a value looks "structured" — starts with a route/selector/key prefix,
 * or contains a colon (like key:value, port, protocol).
 */
function isStructuredValue(value: string): boolean {
  return /^[/.#\[]/.test(value) || value.includes(':');
}

/**
 * Check if a value is purely alphanumeric (with possible hyphens and underscores).
 * Used to decide matching strategy: word-boundary vs substring.
 */
function isAlphanumericOnly(value: string): boolean {
  return /^[a-z0-9_-]+$/i.test(value);
}

/**
 * Try to match a predicate field value against a haystack string.
 *
 * Match strategy depends on value structure:
 *   - Structured values (routes, selectors): bidirectional substring containment
 *   - Alphanumeric-only values: whitespace-boundary match (NOT \b — hyphens
 *     are part of tokens, not boundaries. "color" does NOT match "background-color")
 *
 * Returns true if the value is found in the haystack.
 */
function matchFieldValue(value: string, haystack: string): boolean {
  if (!value || !haystack) return false;

  const normValue = normalizeForMatch(value);
  const normHaystack = normalizeForMatch(haystack);

  // Reject normalized-empty values: whitespace-only inputs collapse to ""
  // which is a substring of everything — a vacuous match, not a real one.
  if (!normValue || !normHaystack) return false;

  if (isStructuredValue(value)) {
    // Bidirectional substring: either contains the other
    return normHaystack.includes(normValue) || normValue.includes(normHaystack);
  }

  if (isAlphanumericOnly(normValue)) {
    // Token-boundary match: value must be bounded by whitespace, JSON structural
    // characters, or string boundaries. This ensures "color" does NOT match
    // "background-color" (hyphen is NOT a boundary — it's part of the token),
    // while "item_1" DOES match inside JSON like {"id":"item_1"} (quotes ARE boundaries).
    const escaped = normValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadBoundary = `(?:^|[\\s"',:;\\[\\]{}()])`;
    const tailBoundary = `(?:$|[\\s"',:;\\[\\]{}()])`;
    const pattern = new RegExp(`${leadBoundary}${escaped}${tailBoundary}`);
    return pattern.test(normHaystack);
  }

  // Mixed content: substring
  return normHaystack.includes(normValue);
}

/**
 * Tier 3: Heuristic containment attribution for a tool call.
 *
 * Named *Heuristic explicitly so nobody confuses it with kernel-grade G5.
 * Uses string-containment matching against declared predicate fields.
 *
 * Returns the attribution class and (for 'direct') the match detail.
 */
export function attributeToolCallHeuristic(
  mutation: Mutation,
  intent: IntentContext | undefined,
): { class: AttributionClass; match?: AttributionMatchDetail } {
  if (!intent) return { class: 'no_intent' };

  const target = normalizeForMatch(mutation.target);
  const argsStr = normalizeForMatch(JSON.stringify(mutation.args));

  // Check each predicate's fields against the mutation
  for (const predicate of intent.predicates) {
    // Check structured keys first (priority order), then remaining
    const checkedKeys = new Set<string>();
    const keysToCheck = [...STRUCTURED_KEY_PRIORITY];

    // Add remaining keys not in priority list
    for (const key of Object.keys(predicate.fields)) {
      if (!STRUCTURED_KEY_PRIORITY.includes(key)) {
        keysToCheck.push(key);
      }
    }

    for (const key of keysToCheck) {
      if (checkedKeys.has(key)) continue;
      checkedKeys.add(key);

      const value = predicate.fields[key];
      if (typeof value !== 'string' || !value) continue;

      // Minimum token length: skip values < 4 chars UNLESS structured
      if (value.length < 4 && !isStructuredValue(value)) continue;

      // Try matching against target and stringified args
      if (matchFieldValue(value, target) || matchFieldValue(value, argsStr)) {
        return {
          class: 'direct',
          match: {
            predicateType: predicate.type,
            key,
            value,
          },
        };
      }
    }
  }

  // Check for infrastructure verb
  const verbTokens = mutation.verb.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/);
  for (const token of verbTokens) {
    if (INFRASTRUCTURE_VERBS.has(token)) {
      return { class: 'scaffolding' };
    }
  }

  return { class: 'unexplained' };
}

// =============================================================================
// TIER 4: GROUNDING ANNOTATION
// =============================================================================

/** Grounding staleness threshold: 5 minutes */
const GROUNDING_STALENESS_MS = 5 * 60 * 1000;

/**
 * Tier 4: Annotate whether a tool call was made with grounded context.
 *
 * Pure annotation — never blocks, never modifies state.
 * The proxy doesn't interpret grounding facts; it only checks staleness.
 */
export function annotateGrounding(
  intent: IntentContext | undefined,
  now?: number,
): { grounded: boolean; stale: boolean } {
  if (!intent || !intent.grounding) return { grounded: false, stale: false };

  const currentTime = now ?? Date.now();
  const age = currentTime - intent.grounding.observedAt;

  if (age > GROUNDING_STALENESS_MS) {
    return { grounded: true, stale: true };
  }

  return { grounded: true, stale: false };
}

// =============================================================================
// TIER 5: CONVERGENCE ENFORCEMENT
// =============================================================================

/** Failure signature threshold for 'warning' */
const CONVERGENCE_WARNING_THRESHOLD = 2;

/** Failure signature threshold for 'exhausted' */
const CONVERGENCE_EXHAUSTED_THRESHOLD = 3;

/** Tool+target call count threshold for 'loop' detection */
const CONVERGENCE_LOOP_THRESHOLD = 5;

/** Rolling window duration for loop detection: 2 minutes */
const CONVERGENCE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Tier 5: Check convergence state for a tool call.
 *
 * Updates the tracker in-place and returns the current signal level.
 *
 * Two independent detectors:
 *   1. Failure signature accumulation: same signature 2x = warning, 3x+ = exhausted
 *   2. Tool+target repetition: same tool:target 5x within 2min = loop
 *
 * Returns the highest-priority signal (exhausted > loop > warning > none).
 */
export function checkConvergence(
  tracker: ConvergenceTracker,
  toolName: string,
  target: string,
  failureSignature?: string,
  now?: number,
): ConvergenceSignal {
  const currentTime = now ?? Date.now();
  let signal: ConvergenceSignal = 'none';

  // Detector 1: Failure signature accumulation
  if (failureSignature) {
    const count = (tracker.failureSignatures.get(failureSignature) ?? 0) + 1;
    tracker.failureSignatures.set(failureSignature, count);

    if (count >= CONVERGENCE_EXHAUSTED_THRESHOLD) {
      signal = 'exhausted';
    } else if (count >= CONVERGENCE_WARNING_THRESHOLD) {
      signal = 'warning';
    }
  }

  // Detector 2: Tool+target repetition (rolling window)
  const key = `${toolName}:${target}`;
  const timestamps = tracker.toolTargetTimestamps.get(key) ?? [];

  // Push current timestamp
  timestamps.push(currentTime);

  // Prune entries older than the rolling window
  const cutoff = currentTime - CONVERGENCE_WINDOW_MS;
  const recent = timestamps.filter(t => t >= cutoff);
  tracker.toolTargetTimestamps.set(key, recent);

  if (recent.length >= CONVERGENCE_LOOP_THRESHOLD) {
    // Loop is less severe than exhausted but more severe than warning
    if (signal !== 'exhausted') {
      signal = 'loop';
    }
  }

  return signal;
}

/**
 * Create a fresh convergence tracker (empty Maps).
 * Called at proxy init and on session re-initialize.
 */
export function createConvergenceTracker(): ConvergenceTracker {
  return {
    failureSignatures: new Map(),
    toolTargetTimestamps: new Map(),
  };
}

/**
 * Extract a failure signature from an upstream response.
 *
 * Proxy-level extraction — uses kernel extractSignature() as fallback,
 * but prefers structured error fields when available.
 *
 * Priority: error.code > error.name > kernel extractSignature > first line (100 chars) > "unknown_error"
 */
export function extractProxySignature(response: {
  error?: { code?: number | string; message?: string; name?: string };
  result?: unknown;
}): string {
  // Structured error fields
  if (response.error?.code !== undefined) {
    return String(response.error.code);
  }
  if (response.error?.name) {
    return response.error.name;
  }

  // Try kernel extractSignature on the error message
  const errorText = response.error?.message
    ?? (typeof response.result === 'object' && response.result !== null
      ? (response.result as { content?: Array<{ text?: string }>; isError?: boolean }).isError
        ? ((response.result as { content?: Array<{ text?: string }> }).content ?? [])
          .map(c => c.text ?? '').join('\n')
        : undefined
      : undefined);

  if (errorText) {
    const kernelSig = extractSignature(errorText);
    if (kernelSig) return kernelSig;

    // First line truncated to 100 chars
    const firstLine = errorText.split('\n')[0]?.trim();
    if (firstLine) return firstLine.slice(0, 100);
  }

  return 'unknown_error';
}

// =============================================================================
// GATE ORCHESTRATION — Run all checks, return combined result
// =============================================================================

export interface GateResult {
  /** Should the call be forwarded to upstream? */
  forward: boolean;

  /** G2 constraint check result */
  constraintCheck: { passed: boolean; blockedBy?: string };

  /** E-H8 authority check result */
  authorityCheck: { passed: boolean; reason?: string };

  /** Tier 3: G5 containment attribution result */
  containmentCheck: {
    passed: boolean;
    attribution: AttributionClass;
    match?: AttributionMatchDetail;
  };

  /** Tier 5: Convergence signal at time of gate check */
  convergenceSignal?: ConvergenceSignal;

  /** If blocked, the error message to return to the agent */
  blockReason?: string;
}

/**
 * Run all governance gates for a tool call.
 *
 * Gate order: G2 → E-H8 → G5 → Convergence
 *
 * In strict mode: any failure blocks the call. Convergence exhausted/loop also blocks.
 * In advisory mode: failures are logged but the call is forwarded. Advisory NEVER blocks.
 *
 * G5 containment (Tier 3): Only activates when ALL of:
 *   1. Intent has been declared (via governance_declare_intent)
 *   2. The tool call is classified as 'mutating' (readonly calls are exempt)
 *   3. Attribution comes back as 'unexplained' (not direct, scaffolding, or no_intent)
 */
export function runGates(
  mutation: Mutation,
  constraints: ConstraintEntry[],
  authority: AuthorityState,
  enforcement: 'strict' | 'advisory',
  convergenceSignal?: ConvergenceSignal,
  intent?: IntentContext,
  mutationType?: 'mutating' | 'readonly',
): GateResult {
  // G2: Constraint check
  const constraintCheck = checkConstraints(mutation, constraints);

  // E-H8: Authority check
  const authorityVerdict = checkAuthority(authority);
  const authorityCheck: { passed: boolean; reason?: string } = {
    passed: authorityVerdict.action === 'proceed',
    reason: authorityVerdict.action !== 'proceed' ? authorityVerdict.reason : undefined,
  };

  // G5: Containment attribution (Tier 3)
  const attribution = attributeToolCallHeuristic(mutation, intent);
  // G5 only blocks when: intent exists AND call is mutating AND attribution is unexplained
  const g5Blocks = attribution.class === 'unexplained' && mutationType === 'mutating';
  const containmentCheck = {
    passed: !g5Blocks,
    attribution: attribution.class,
    match: attribution.match,
  };

  // Tier 5: Convergence blocks in strict mode only
  const convergenceBlocks = enforcement === 'strict' &&
    (convergenceSignal === 'exhausted' || convergenceSignal === 'loop');

  // Determine whether to forward
  const anyFailed = !constraintCheck.passed || !authorityCheck.passed || g5Blocks || convergenceBlocks;

  if (anyFailed && enforcement === 'strict') {
    const reasons: string[] = [];
    if (!constraintCheck.passed) {
      reasons.push(`G2 BLOCKED: Tool "${mutation.verb}" on target "${mutation.target}" has a prior failure constraint (${constraintCheck.blockedBy})`);
    }
    if (!authorityCheck.passed) {
      reasons.push(`E-H8 BLOCKED: ${authorityCheck.reason}`);
    }
    if (g5Blocks) {
      reasons.push(`G5 BLOCKED: Tool "${mutation.verb}" on target "${mutation.target}" is unexplained — no declared predicate justifies this mutation`);
    }
    if (convergenceBlocks) {
      reasons.push(`CONVERGENCE BLOCKED: Signal "${convergenceSignal}" — ${convergenceSignal === 'exhausted' ? 'same failure signature repeated 3+ times' : 'same tool+target called 5+ times within 2 minutes'}`);
    }

    return {
      forward: false,
      constraintCheck,
      authorityCheck,
      containmentCheck,
      convergenceSignal,
      blockReason: reasons.join('; '),
    };
  }

  // Advisory mode or all passed — forward
  return {
    forward: true,
    constraintCheck,
    authorityCheck,
    containmentCheck,
    convergenceSignal,
  };
}
