/**
 * Failure Kind Classification
 * ===========================
 *
 * Prevents "poisoned well" — infrastructure errors should never seed G2
 * constraints that narrow the agent's solution space. The agent should
 * only learn from its own mistakes.
 *
 * Three-valued classification on every failure:
 *   harness_fault — Infrastructure issue, not agent's fault
 *   app_failure   — Agent's code/predicates were wrong
 *   unknown       — Ambiguous, cannot determine
 *
 * Zero dependencies. Pure function.
 *
 * Ported from: src/lib/services/memory.ts (classifyFailureKind)
 */

// =============================================================================
// TYPES
// =============================================================================

export type FailureKind = 'harness_fault' | 'app_failure' | 'unknown';

/**
 * Sources where failures originate.
 * Affects classification — same error string can mean different things
 * depending on where it occurred.
 */
export type FailureSource =
  | 'staging'
  | 'post_deploy_evidence'
  | 'f9_gate'
  | 'rollback'
  | 'upstream'
  | string;

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classify a failure as harness infrastructure vs app code error.
 *
 * Design decisions:
 * - SyntaxError is source-sensitive — in post_deploy/staging it's app code
 * - getaddrinfo EAI_AGAIN/ENOTFOUND is always harness (staging has no DB network)
 * - ECONNREFUSED in staging is harness (container not ready), elsewhere is app
 * - Timeout in staging is harness (build bottleneck), elsewhere is unknown
 */
export function classifyFailureKind(
  error: string,
  source?: FailureSource,
): FailureKind {
  if (!error) return 'unknown';

  // --- HARNESS FAULTS: infrastructure broke, not agent code ---

  // DNS resolution failures — staging container can't reach DB (no network)
  if (/getaddrinfo.*(eai_again|enotfound)|eai_again|enotfound/i.test(error)) {
    return 'harness_fault';
  }

  // Connection refused in staging — container not ready or network not up
  if (/econnrefused|connection refused/i.test(error) && source === 'staging') {
    return 'harness_fault';
  }

  // Port conflicts — leftover containers or daemon race condition
  if (/eaddrinuse|port.*in use|address.*in use/i.test(error)) {
    return 'harness_fault';
  }

  // SSH/infrastructure failures
  if (/ssh.*timeout|ssh.*refused|ssh.*unreachable/i.test(error)) {
    return 'harness_fault';
  }

  // Docker daemon issues (not app's Docker config)
  if (/docker.*daemon.*not running|cannot connect to.*docker/i.test(error)) {
    return 'harness_fault';
  }

  // Timeout during staging build — infrastructure bottleneck, not app code
  if (/timeout|timed?\s*out/i.test(error) && source === 'staging') {
    return 'harness_fault';
  }

  // --- APP FAILURES: agent's code was genuinely wrong ---

  // SyntaxError — source-sensitive
  if (/syntaxerror|unexpected token|parse error|unterminated string/i.test(error)) {
    if (source === 'staging' || source === 'post_deploy_evidence' || source === 'f9_gate') {
      return 'app_failure';
    }
    return 'unknown';
  }

  // Build failures in staging — app's Dockerfile/code is broken
  if (/build.*fail|compilation.*fail/i.test(error) && source === 'staging') {
    return 'app_failure';
  }

  // DB constraint violations — agent's SQL/code logic is wrong
  if (/duplicate key|unique constraint|foreign key constraint|not-null constraint/i.test(error)) {
    return 'app_failure';
  }

  // Predicate/evidence mismatches — agent's code doesn't produce expected output
  if (/predicate.*failed|evidence.*failed|browser gate failed|value mismatch/i.test(error)) {
    return 'app_failure';
  }

  // CSS/selector not found — agent targeted wrong element
  if (/not found in dom|element not found|selector.*not found/i.test(error)) {
    return 'app_failure';
  }

  // Edit application failures — agent's search string doesn't match
  if (/search string not found|edit application failed/i.test(error)) {
    return 'app_failure';
  }

  // Missing module — agent forgot to add a dependency or import
  if (/cannot find module|module_not_found/i.test(error)) {
    return 'app_failure';
  }

  // --- DEFAULT: can't tell ---
  return 'unknown';
}
