/**
 * Budget Cap — Call Counter with Threshold
 * =========================================
 *
 * Tracks total tool calls in the session. When --max-calls N is set,
 * blocks all calls after the Nth call. The proxy doesn't know which LLM
 * or pricing model is in use, so budget is measured in calls, not dollars.
 *
 * Zero dependencies. Pure counter.
 */

export interface BudgetState {
  /** Total tool calls forwarded (not blocked) this session */
  callCount: number;

  /** Total tool calls blocked by governance gates this session */
  blockedCount: number;

  /** Maximum allowed calls (undefined = unlimited) */
  maxCalls?: number;
}

/**
 * Create a fresh budget tracker.
 */
export function createBudgetState(maxCalls?: number): BudgetState {
  return { callCount: 0, blockedCount: 0, maxCalls };
}

/**
 * Check if the budget allows another call.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkBudget(
  budget: BudgetState,
): { allowed: boolean; reason?: string } {
  if (budget.maxCalls === undefined) return { allowed: true };

  if (budget.callCount >= budget.maxCalls) {
    return {
      allowed: false,
      reason: `BUDGET EXCEEDED: ${budget.callCount}/${budget.maxCalls} tool calls used. Session limit reached.`,
    };
  }

  return { allowed: true };
}

/**
 * Record a forwarded call (increments counter).
 */
export function recordCall(budget: BudgetState): void {
  budget.callCount++;
}

/**
 * Record a blocked call (increments blocked counter, not call counter).
 */
export function recordBlocked(budget: BudgetState): void {
  budget.blockedCount++;
}

/**
 * Get remaining calls. Returns Infinity if no limit set.
 */
export function remainingCalls(budget: BudgetState): number {
  if (budget.maxCalls === undefined) return Infinity;
  return Math.max(0, budget.maxCalls - budget.callCount);
}
