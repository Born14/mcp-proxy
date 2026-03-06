/**
 * @sovereign-labs/kernel — Governance Kernel for Autonomous Agents
 * ===========================================================
 *
 * Eleven structural invariants of governed execution.
 * Zero domain imports. Pure functions. Constitutional proof.
 *
 *   G1: Honesty                — Agent cannot declare success when reality disagrees
 *   G2: Non-Repetition         — Agent cannot repeat a strategy that already failed
 *   G3: Entropy Resilience     — Verification survives partial deploys and system entropy
 *   G4: Time Travel            — Complete rollback is always possible
 *   G5: Containment            — Every mutation traces to a predicate, or the human knows
 *   G6: Scope Boundedness      — Every mutation's blast radius must be estimable
 *   G7: Epistemic Grounding    — Claims must reference observable reality
 *   G8: Convergence Monotonicity — On failure, the search space must strictly narrow
 *   G9: Deterministic Evidence  — Only deterministic evidence can cause a rollback
 *   E-H7: Identity             — Foreign controller jobs are immutable
 *   E-H8: Temporal             — Latest human authority invalidates stale plans
 */

// Re-export all kernel functions
export * from './kernel/index.js';

// Re-export all types
export * from './types.js';

// Note: mock adapter available via @sovereign-labs/kernel/mock
// Note: pure heuristics available via direct import from @sovereign-labs/kernel
export * from './pure/classification-heuristics.js';
export * from './pure/attribution-heuristics.js';
