/**
 * E-H8: Temporal Sovereignty
 * ==========================
 *
 * Latest human authority invalidates stale plans.
 *
 * Born from: Operator sent message mid-planning. LLM finished stale plan
 * and committed it. Without temporal sovereignty, stale plan would commit.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 * 5 lines of integer comparison — the simplest physics.
 */

import type { AuthorityContext, GateVerdict } from '../types.js';

/**
 * Validate that a plan was created under the current authority.
 *
 * If authorityEpoch !== planEpoch, the plan is stale — a human message
 * arrived after planning started. The plan must be invalidated.
 *
 * Extracted from: src/lib/services/agent/tool-loop.ts:728
 */
export function validateAuthority(authority: AuthorityContext): GateVerdict {
  // No plan epoch captured yet — planning hasn't started
  if (authority.planEpoch === undefined) {
    return {
      action: 'proceed',
      gate: 'approve',
      reason: 'No plan epoch captured — pre-planning phase',
    };
  }

  // Plan epoch matches authority epoch — plan is current
  if (authority.authorityEpoch === authority.planEpoch) {
    return {
      action: 'proceed',
      gate: 'approve',
      reason: 'Plan authority is current',
    };
  }

  // Epoch mismatch — human authority arrived after planning started
  return {
    action: 'invalidate',
    gate: 'approve',
    reason: `PLAN_INVALIDATED: authority epoch ${authority.authorityEpoch} !== plan epoch ${authority.planEpoch} — human message arrived during planning`,
  };
}

/**
 * Capture the current authority epoch as the plan epoch.
 *
 * Called when the tool loop begins draining messages and starting a plan.
 * Returns the new AuthorityContext with planEpoch set.
 *
 * Extracted from: src/lib/services/agent/tool-loop.ts:410
 */
export function capturePlanEpoch(authority: AuthorityContext): AuthorityContext {
  return {
    ...authority,
    planEpoch: authority.authorityEpoch,
  };
}

/**
 * Increment the authority epoch (human message injection).
 *
 * Called when the operator sends a message to the job.
 * Returns the new AuthorityContext with incremented epoch.
 *
 * Extracted from: src/lib/services/agent/public-api.ts (3 call sites)
 */
export function incrementAuthority(authority: AuthorityContext): AuthorityContext {
  return {
    ...authority,
    authorityEpoch: authority.authorityEpoch + 1,
  };
}
