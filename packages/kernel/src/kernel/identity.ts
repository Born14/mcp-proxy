/**
 * E-H7: Identity Sovereignty
 * ==========================
 *
 * Foreign controller jobs are immutable.
 *
 * Born from: Two daemons saw same persisted jobs. Without identity,
 * second daemon could hijack first's in-flight work.
 *
 * Pure functions. Zero domain imports. Zero side effects.
 */

import type { AuthorityContext, GateVerdict } from '../types.js';

/**
 * Assert that a job is mutable by the current controller.
 *
 * Returns true if the job belongs to this controller (not foreign).
 * Returns false if the job belongs to a different controller.
 *
 * Extracted from: src/lib/services/agent/public-api.ts:596
 */
export function assertMutable(authority: AuthorityContext): boolean {
  return !authority.isForeign;
}

/**
 * Determine whether a job should be marked foreign on load.
 *
 * When loading persisted jobs, compare the job's controller ID
 * against the current controller. If different, the job is foreign.
 *
 * Extracted from: src/lib/services/agent/job-store.ts:715
 */
export function isForeignJob(
  jobControllerId: string | undefined,
  currentControllerId: string,
): boolean {
  // Pre-E-H8 jobs (no controllerId) are adopted, not foreign
  if (!jobControllerId) return false;
  return jobControllerId !== currentControllerId;
}

/**
 * Gate verdict for identity check.
 *
 * If the job is foreign, return a 'block' verdict.
 * If mutable, return 'proceed'.
 */
export function checkIdentity(authority: AuthorityContext): GateVerdict {
  if (authority.isForeign) {
    return {
      action: 'block',
      gate: 'approve',
      reason: `Job belongs to controller ${authority.controllerId} — immutable by this controller`,
    };
  }

  return {
    action: 'proceed',
    gate: 'approve',
    reason: 'Job belongs to current controller',
  };
}
