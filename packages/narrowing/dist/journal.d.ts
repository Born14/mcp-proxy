/**
 * Execution Journal — Structured, append-only execution log.
 *
 * Every attempt, constraint, and convergence update is recorded.
 * The journal is the forensic record — it answers "why did the agent
 * end up here?" long after the session ends.
 *
 * Format: JSONL (one JSON object per line). Append-only. Crash-safe
 * via sync writes.
 */
import type { JournalEntry, Outcome, Constraint, ProposalCheck, ConvergenceState } from './types.js';
export declare class Journal {
    private readonly path;
    private attempt;
    constructor(path: string);
    /** Record an outcome */
    recordOutcome(outcome: Outcome): void;
    /** Record a constraint being seeded */
    recordConstraint(constraint: Constraint): void;
    /** Record a proposal being blocked */
    recordBlocked(check: ProposalCheck): void;
    /** Record convergence state update */
    recordConvergence(state: ConvergenceState): void;
    /** Read all journal entries */
    readAll(): JournalEntry[];
    /** Get current attempt number */
    getAttempt(): number;
    /** Load attempt counter from existing journal */
    resume(): void;
    private append;
    private ensureDir;
}
//# sourceMappingURL=journal.d.ts.map