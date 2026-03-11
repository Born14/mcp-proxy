/**
 * NarrowingLoop — The execution harness.
 *
 * Wraps any iterative agent loop with constraint learning.
 * Three responsibilities:
 * 1. checkProposal() before each attempt
 * 2. recordOutcome() after each attempt
 * 3. Track convergence and escalate when stuck
 *
 * The loop doesn't RUN the agent — it gates and observes.
 * The agent decides what to try. Narrowing decides what's allowed.
 *
 * Usage:
 *   const loop = new NarrowingLoop(config);
 *   while (!loop.isDone()) {
 *     const proposal = agent.generateProposal();
 *     const check = loop.checkProposal(proposal);
 *     if (!check.allowed) { agent.rejectAndRetry(check); continue; }
 *     const result = agent.execute(proposal);
 *     const narrowingResult = loop.recordOutcome(result);
 *   }
 */
import type { NarrowingConfig, Proposal, ProposalCheck, NarrowingResult, ConvergenceState, Constraint } from './types.js';
export declare class NarrowingLoop {
    private readonly config;
    private readonly constraints;
    private readonly convergence;
    private readonly journal;
    private readonly receipts;
    private attempt;
    private done;
    private sessionId;
    constructor(config: Partial<NarrowingConfig> & Pick<NarrowingConfig, 'adapter'>);
    /**
     * Check a proposal BEFORE execution.
     *
     * This is the primary interaction point. The agent generates a proposal,
     * the loop checks it against all active constraints. If blocked, the
     * agent must generate a different proposal.
     *
     * Returns ProposalCheck with:
     * - allowed: boolean
     * - violations: what constraints block this
     * - radiusLimit: current max change count
     * - searchSpaceReduction: percentage of strategies banned
     */
    checkProposal(proposal: Proposal): ProposalCheck;
    /**
     * Record the outcome AFTER execution.
     *
     * This is where learning happens. The outcome is classified, constraints
     * may be seeded, convergence is updated, and everything is journaled.
     *
     * Returns NarrowingResult with:
     * - outcome: the classified outcome
     * - newConstraints: any constraints seeded from this failure
     * - activeConstraints: all current constraints
     * - radiusLimit: current radius
     * - convergence: current convergence state
     */
    recordOutcome(raw: {
        score: number | null;
        status: 'success' | 'failure' | 'error';
        error?: string;
        parameters: Record<string, unknown>;
        targets: string[];
        durationMs: number;
        metadata?: Record<string, unknown>;
    }): NarrowingResult;
    /** Is the search done (converged or escalated)? */
    isDone(): boolean;
    /** Mark the loop as done (external termination) */
    stop(): void;
    /** Get current convergence state */
    getConvergence(): ConvergenceState;
    /** Get all active constraints */
    getActiveConstraints(): Constraint[];
    /** Get the current radius limit */
    getRadiusLimit(): number;
    /** Get the current attempt number */
    getAttempt(): number;
    /** Get the session ID */
    getSessionId(): string;
    /** Verify receipt chain integrity */
    verifyReceipts(): {
        valid: boolean;
        brokenAt?: number;
        receiptCount: number;
    } | null;
    /** Clear session-scoped constraints (for new session) */
    resetSession(): void;
    /** Get all data for persistence */
    snapshot(): {
        constraints: Constraint[];
        convergence: ConvergenceState;
        attempt: number;
        sessionId: string;
    };
    /** Restore from persisted data */
    restore(data: {
        constraints: Constraint[];
        convergence: ConvergenceState;
        attempt: number;
        sessionId: string;
    }): void;
}
//# sourceMappingURL=loop.d.ts.map