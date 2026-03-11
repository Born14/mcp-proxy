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
import { ConstraintStore } from './constraints.js';
import { ConvergenceTracker } from './convergence.js';
import { Journal } from './journal.js';
import { ReceiptChain } from './receipts.js';
import { extractSignature } from './signatures.js';
import { classifyBlame } from './blame.js';
// =============================================================================
// DEFAULT CONFIG
// =============================================================================
const DEFAULTS = {
    direction: 'minimize',
    corroborationThreshold: 2,
    radiusCurve: [Infinity, 5, 3, 2, 1],
    constraintTtlMs: 3_600_000, // 1 hour
    maxConstraintDepth: 5,
    plateauWindow: 10,
    plateauTolerance: 0.001,
    journalPath: '.narrowing/journal.jsonl',
    receipts: true,
    receiptPath: '.narrowing/receipts.jsonl',
};
// =============================================================================
// NARROWING LOOP
// =============================================================================
export class NarrowingLoop {
    config;
    constraints;
    convergence;
    journal;
    receipts;
    attempt = 0;
    done = false;
    sessionId;
    constructor(config) {
        this.config = { ...DEFAULTS, ...config };
        this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.constraints = new ConstraintStore({
            corroborationThreshold: this.config.corroborationThreshold,
            radiusCurve: this.config.radiusCurve,
            constraintTtlMs: this.config.constraintTtlMs,
            maxConstraintDepth: this.config.maxConstraintDepth,
        });
        this.convergence = new ConvergenceTracker({
            plateauWindow: this.config.plateauWindow,
            plateauTolerance: this.config.plateauTolerance,
            direction: this.config.direction,
            maxConstraintDepth: this.config.maxConstraintDepth,
        });
        this.journal = new Journal(this.config.journalPath);
        this.receipts = this.config.receipts
            ? new ReceiptChain(this.config.receiptPath)
            : null;
    }
    // =========================================================================
    // THE THREE APIs
    // =========================================================================
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
    checkProposal(proposal) {
        // Auto-classify action class if not provided
        if (!proposal.actionClass) {
            proposal.actionClass = this.config.adapter.classifyAction(proposal.parameters, proposal.targets);
        }
        const check = this.constraints.checkProposal(proposal);
        if (!check.allowed) {
            this.journal.recordBlocked(check);
            this.receipts?.append('proposal_blocked', {
                violations: check.violations.map(v => ({
                    constraintId: v.constraint.id,
                    banType: v.banType,
                    reason: v.reason,
                })),
                actionClass: proposal.actionClass,
                targetCount: proposal.targets.length,
            }, this.attempt + 1);
        }
        else {
            this.receipts?.append('proposal_allowed', {
                actionClass: proposal.actionClass || null,
                targetCount: proposal.targets.length,
                activeConstraints: check.activeConstraints,
                radiusLimit: check.radiusLimit === Infinity ? 'unlimited' : check.radiusLimit,
            }, this.attempt + 1);
        }
        return check;
    }
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
    recordOutcome(raw) {
        this.attempt++;
        // Build the full outcome
        const outcome = {
            id: `attempt_${this.attempt}_${Date.now()}`,
            timestamp: Date.now(),
            durationMs: raw.durationMs,
            score: raw.score,
            direction: this.config.direction,
            status: raw.status,
            parameters: this.config.adapter.extractParameters(raw.parameters),
            targets: raw.targets,
            metadata: raw.metadata,
            error: raw.error,
        };
        // Signature extraction
        if (raw.error) {
            outcome.failureSignature = extractSignature(raw.error, this.config.adapter);
        }
        // Blame classification
        if (raw.error) {
            outcome.failureKind = classifyBlame(raw.error, this.config.adapter);
        }
        // Action class
        outcome.actionClass = this.config.adapter.classifyAction(raw.parameters, raw.targets);
        // Journal the outcome
        this.journal.recordOutcome(outcome);
        // Seed constraints from failure
        const newConstraints = [];
        if (outcome.status === 'failure' || outcome.status === 'error') {
            const constraint = this.constraints.seedFromOutcome(outcome, this.sessionId);
            if (constraint) {
                newConstraints.push(constraint);
                this.journal.recordConstraint(constraint);
                this.receipts?.append('constraint_seeded', {
                    constraintId: constraint.id,
                    type: constraint.type,
                    signature: constraint.signature,
                    actionClass: constraint.actionClass || null,
                    corroborated: constraint.corroborated,
                    occurrences: constraint.occurrences,
                }, this.attempt);
            }
        }
        // Update convergence
        const convergence = this.convergence.update(outcome, this.constraints);
        this.journal.recordConvergence(convergence);
        // Check for escalation
        const escalation = this.convergence.shouldEscalate();
        if (escalation.escalate) {
            this.receipts?.append('convergence_escalation', {
                status: convergence.status,
                reason: escalation.reason,
                totalAttempts: convergence.totalAttempts,
                activeConstraints: convergence.activeConstraintCount,
                searchSpaceRemaining: convergence.searchSpaceRemaining,
            }, this.attempt);
        }
        // Receipt for the outcome
        const receipt = this.receipts?.append('outcome_recorded', {
            attemptId: outcome.id,
            score: outcome.score,
            status: outcome.status,
            failureSignature: outcome.failureSignature || null,
            failureKind: outcome.failureKind || null,
            actionClass: outcome.actionClass || null,
            convergenceStatus: convergence.status,
        }, this.attempt);
        // GC expired constraints
        this.constraints.gc();
        return {
            outcome,
            newConstraints,
            activeConstraints: this.constraints.getActive(),
            radiusLimit: this.constraints.getCurrentRadiusLimit(),
            convergence,
            receiptHash: receipt?.hash,
        };
    }
    // =========================================================================
    // STATE QUERIES
    // =========================================================================
    /** Is the search done (converged or escalated)? */
    isDone() {
        if (this.done)
            return true;
        const { escalate } = this.convergence.shouldEscalate();
        return escalate;
    }
    /** Mark the loop as done (external termination) */
    stop() {
        this.done = true;
    }
    /** Get current convergence state */
    getConvergence() {
        return this.convergence.getState();
    }
    /** Get all active constraints */
    getActiveConstraints() {
        return this.constraints.getActive();
    }
    /** Get the current radius limit */
    getRadiusLimit() {
        return this.constraints.getCurrentRadiusLimit();
    }
    /** Get the current attempt number */
    getAttempt() {
        return this.attempt;
    }
    /** Get the session ID */
    getSessionId() {
        return this.sessionId;
    }
    /** Verify receipt chain integrity */
    verifyReceipts() {
        return this.receipts?.verify() ?? null;
    }
    // =========================================================================
    // SESSION LIFECYCLE
    // =========================================================================
    /** Clear session-scoped constraints (for new session) */
    resetSession() {
        this.constraints.clearSession();
        this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    /** Get all data for persistence */
    snapshot() {
        return {
            constraints: this.constraints.getAll(),
            convergence: this.convergence.getState(),
            attempt: this.attempt,
            sessionId: this.sessionId,
        };
    }
    /** Restore from persisted data */
    restore(data) {
        this.constraints.load(data.constraints);
        this.convergence.load(data.convergence);
        this.attempt = data.attempt;
        this.sessionId = data.sessionId;
        this.journal.resume();
    }
}
//# sourceMappingURL=loop.js.map