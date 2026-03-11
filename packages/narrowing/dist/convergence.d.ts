/**
 * Convergence Tracking — Is the search making progress?
 *
 * Three terminal states:
 * - plateau: No score improvement for N consecutive attempts
 * - exhausted: Budget exceeded or max constraints reached
 * - constrained_out: All known strategies are banned
 *
 * The runtime uses convergence state to decide when to escalate to human.
 *
 * Extracted from: packages/kernel/src/kernel/convergence.ts
 */
import type { ConvergenceState, Outcome, NarrowingConfig } from './types.js';
import type { ConstraintStore } from './constraints.js';
export declare class ConvergenceTracker {
    private state;
    private readonly config;
    constructor(config: Pick<NarrowingConfig, 'plateauWindow' | 'plateauTolerance' | 'direction' | 'maxConstraintDepth'>);
    /**
     * Update convergence state after an outcome.
     */
    update(outcome: Outcome, constraints: ConstraintStore): ConvergenceState;
    /**
     * Get current convergence state (immutable copy).
     */
    getState(): ConvergenceState;
    /**
     * Check if the convergence process should escalate.
     */
    shouldEscalate(): {
        escalate: boolean;
        reason: string;
    };
    /**
     * Load state from persisted data.
     */
    load(state: ConvergenceState): void;
    private isImprovement;
    private classifyStatus;
}
//# sourceMappingURL=convergence.d.ts.map