/**
 * Constraint Engine — The core of narrowing.
 *
 * Constraints are structural guardrails derived from execution failures.
 * They are enforced by the runtime BEFORE execution — the agent never
 * gets to try what's banned.
 *
 * Three constraint types:
 * - banned_strategy: An approach that failed 2+ times
 * - radius_limit: Progressive cap on change count
 * - parameter_ban: Specific values proven broken
 *
 * The star API: checkProposal() — makes the runtime active, not passive.
 *
 * Extracted from: src/lib/services/memory.ts (seedConstraintFromFailure,
 * checkPlanConstraints, buildRadiusLimit, buildStrategyBan)
 */
import type { Constraint, Proposal, ProposalCheck, Outcome, NarrowingConfig } from './types.js';
export declare class ConstraintStore {
    private constraints;
    private corroborationCounts;
    private readonly config;
    constructor(config: Pick<NarrowingConfig, 'corroborationThreshold' | 'radiusCurve' | 'constraintTtlMs' | 'maxConstraintDepth'>);
    /**
     * Check a proposal against all active constraints.
     *
     * This is the primary API — call before every execution attempt.
     * Returns whether the proposal is allowed, and if not, why.
     */
    checkProposal(proposal: Proposal): ProposalCheck;
    /**
     * Attempt to seed a constraint from a failure outcome.
     *
     * Rules:
     * 1. Infrastructure faults NEVER seed constraints
     * 2. Requires corroboration (2+ occurrences) by default
     * 3. Max constraint depth prevents suffocation
     * 4. Dedup: don't create identical constraints
     *
     * Returns the new constraint, or null if none was seeded.
     */
    seedFromOutcome(outcome: Outcome, sessionId?: string): Constraint | null;
    /** Get all non-expired constraints */
    getActive(): Constraint[];
    /** Get current radius limit (minimum of all active radius constraints) */
    getCurrentRadiusLimit(): number;
    /** Remove all session-scoped constraints */
    clearSession(): void;
    /** Remove expired constraints (garbage collection) */
    gc(): number;
    /** Get all constraints (including expired, for persistence) */
    getAll(): Constraint[];
    /** Load constraints from persisted state */
    load(constraints: Constraint[]): void;
    /** Get count of all known strategy classes (for search space math) */
    private countTotalStrategies;
    private buildStrategyBan;
    private buildRadiusLimit;
    private buildParameterBan;
    private checkOne;
    private checkStrategyBan;
    private checkRadiusLimit;
    private checkParameterBan;
    private isDuplicate;
}
//# sourceMappingURL=constraints.d.ts.map