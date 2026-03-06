/**
 * Gate Sequence — The Kernel's Execution Spine
 * =============================================
 *
 * The 16-gate orchestrator that owns the immutable execution ordering.
 *
 * classify → grounding(G7) → ground → extract → plan → syntax → constrain → scope(G6) → contain → approve → stage → execute → verify → evidence(G9) → converge(G8) → attest
 *
 * No adapter, no LLM, no configuration can reorder or skip gates.
 * Pure governance gates: constrain, scope, contain, approve, evidence, converge.
 *
 * Pure functions. Zero domain imports. Zero side effects (except via adapter callbacks).
 *
 * The kernel owns:
 *   - Gate ordering (immutable, this file)
 *   - Pure governance gates (constrain, scope, contain, approve, evidence, converge)
 *   - Verdict routing (proceed/block/narrow/escalate/invalidate)
 *   - Receipt construction (gate 16)
 *
 * The adapter owns:
 *   - Execution within each gate (classify, grounding, ground, extract, plan, syntax, stage, execute, verify, attest)
 *   - Domain-specific matching for containment (attributeMutation)
 *
 * Extracted from: The gate sequence described in governance/types.ts
 * and enforced across agent-loop.ts, staging.ts, containment.ts
 */

import type {
  DomainAdapter,
  GateVerdict,
  GateName,
  Mutation,
  Predicate,
  Evidence,
  GovernanceConstraint,
  AuthorityContext,
  ApprovalPolicy,
  ContainmentResult,
  ExecutionReceipt,
  CheckpointManifest,
  ConvergenceState,
  FailureEvent,
} from '../types.js';

import { checkAllConstraints, constraintVerdict } from './non-repetition.js';
import type { PlanSurface } from './non-repetition.js';
import { attributePlan, containmentVerdict } from './containment.js';
import { checkIdentity, assertMutable } from './identity.js';
import { validateAuthority, capturePlanEpoch } from './temporal.js';
import { buildReceipt, computePolicyHash } from './receipt.js';
import type { GatePassage, ReceiptProvenance } from './receipt.js';
import { verifyChain, computeManifestHash } from './time-travel.js';
import { createConvergenceState, recordIteration, addConstraint, gateConvergence } from './convergence.js';
import { gateScope } from './scope.js';
import { gateGrounding } from './grounding.js';
import { gateEvidence } from './evidence.js';

// =============================================================================
// TYPES — Gate sequence configuration
// =============================================================================

/**
 * Configuration for the gate sequence execution.
 */
export interface GateSequenceConfig {
  /** Kernel version for receipt provenance */
  kernelVersion: string;

  /** Convergence limits */
  maxIterations: number;
  maxEmptyPlans: number;
  maxConstraintDepth: number;

  /** Whether staging is required before execution */
  requireStaging: boolean;
}

/**
 * Options for a single execution through the gate sequence.
 */
export interface ExecutionOptions {
  /** The goal to execute */
  goal: string;

  /** The target (adapter-interpreted, e.g., app name) */
  target: string;

  /** Who authorized this */
  authority: AuthorityContext;

  /** Approval policy governing this execution */
  policy: ApprovalPolicy;

  /** Pre-existing constraints from prior failures */
  constraints?: GovernanceConstraint[];

  /** Override specific constraints (explicit human acknowledgment) */
  overrideConstraints?: string[];

  /** Observations gathered during the execution */
  evidence?: Evidence[];

  /**
   * Approval callback — kernel calls this at gate 8.
   * Must return { approved: true } for execution to proceed.
   */
  onApprovalRequired?: (context: {
    mutations: Mutation[];
    predicates: Predicate[];
    containment: ContainmentResult;
    riskClass: string;
    explanation: string;
  }) => Promise<{ approved: boolean; feedback?: string }>;
}

/**
 * Result of running through the gate sequence.
 * Includes the receipt plus intermediate state for callers that need it.
 */
export interface GateSequenceResult {
  /** The final execution receipt */
  receipt: ExecutionReceipt;

  /** Whether execution completed successfully */
  success: boolean;

  /** If execution was blocked, which gate stopped it */
  blockedAt?: GateName;

  /** The final verdict (last gate's decision) */
  finalVerdict: GateVerdict;

  /** Receipt provenance metadata */
  provenance: ReceiptProvenance;

  /** The convergence state at completion */
  convergence: ConvergenceState;
}

// =============================================================================
// CANONICAL GATE ORDER — The immutable sequence
// =============================================================================

/**
 * The canonical gate ordering.
 * This is physics, not policy. No configuration can change it.
 *
 * 16 gates — 7 original governance + 4 new invariants (G6-G9) + 5 adapter-driven.
 *
 * New gate positions (Feb 2026):
 *   G7 (grounding): after classify, before ground — claims must reference reality before execution
 *   G6 (scope): after constrain, before contain — blast radius must be estimable
 *   G9 (evidence): after verify, before converge — only deterministic evidence survives
 *   G8 (converge): after evidence, before attest — search space must narrow on failure
 */
export const GATE_ORDER: readonly GateName[] = [
  'classify',   // 1.  What kind of work?
  'grounding',  // 2.  G7: Claims reference observable reality?
  'ground',     // 3.  What does reality look like?
  'extract',    // 4.  What testable claims?
  'plan',       // 5.  Produce mutations
  'syntax',     // 6.  Well-formed?
  'constrain',  // 7.  Violates known failures? (KERNEL — pure governance)
  'scope',      // 8.  G6: Blast radius bounded?
  'contain',    // 9.  Traces to predicates? (KERNEL + adapter)
  'approve',    // 10. Human authorizes? (KERNEL — pure governance)
  'stage',      // 11. Survives sandbox?
  'execute',    // 12. Apply to production
  'verify',     // 13. Reality matches claims?
  'evidence',   // 14. G9: Evidence deterministic?
  'converge',   // 15. G8: Solution space narrowing?
  'attest',     // 16. Create receipt
] as const;

// =============================================================================
// INDIVIDUAL GATE FUNCTIONS — Pure governance gates (6-8)
// =============================================================================

/**
 * Gate 6: CONSTRAIN — Check mutations against active constraints.
 *
 * Pure governance. No adapter needed.
 * This is K5 enforcement — prior failures create structural guardrails.
 */
export function gateConstrain(
  surface: PlanSurface,
  constraints: GovernanceConstraint[],
  riskClass: string,
  overrides?: string[],
): GateVerdict {
  const result = checkAllConstraints(surface, constraints, riskClass, overrides);
  return constraintVerdict(result);
}

/**
 * Gate 7: CONTAIN — Attribute mutations to predicates.
 *
 * Kernel orchestrates, adapter provides domain-specific matching.
 * Returns containment result + verdict.
 */
export function gateContain(
  mutations: Mutation[],
  predicates: Predicate[],
  evidence: Evidence[],
  adapter: DomainAdapter,
  mode: ApprovalPolicy['containmentMode'],
): { result: ContainmentResult; verdict: GateVerdict } {
  const result = attributePlan(mutations, predicates, evidence, adapter);
  const verdict = containmentVerdict(result, mode);
  return { result, verdict };
}

/**
 * Gate 8: APPROVE — Check authority and approval policy.
 *
 * Pure governance. Checks:
 * 1. Identity sovereignty (E-H7) — is the job mutable?
 * 2. Temporal sovereignty (E-H8) — is the plan still current?
 * 3. Auto-approve policy — does the risk class + containment allow auto-approve?
 *
 * If none of the above allow auto-proceed, returns 'escalate' for human review.
 */
export function gateApprove(
  authority: AuthorityContext,
  riskClass: string,
  containment: ContainmentResult,
  policy: ApprovalPolicy,
): GateVerdict {
  // E-H7: Identity check
  const identityVerdict = checkIdentity(authority);
  if (identityVerdict.action !== 'proceed') {
    return identityVerdict;
  }

  // E-H8: Temporal sovereignty check
  const temporalVerdict = validateAuthority(authority);
  if (temporalVerdict.action !== 'proceed') {
    return temporalVerdict;
  }

  // Campaign ceiling enforcement
  if (policy.ceiling) {
    // Risk class hierarchy: ui < logic < config < schema < infra < mixed
    // If the plan's risk class exceeds the ceiling, block
    const RISK_ORDER = ['ui', 'logic', 'config', 'schema', 'infra', 'mixed'];
    const planLevel = RISK_ORDER.indexOf(riskClass);
    const ceilingLevel = RISK_ORDER.indexOf(policy.ceiling);
    if (planLevel >= 0 && ceilingLevel >= 0 && planLevel > ceilingLevel) {
      return {
        action: 'block',
        gate: 'approve',
        reason: `Plan risk class "${riskClass}" exceeds campaign ceiling "${policy.ceiling}"`,
      };
    }
  }

  // Auto-approve check
  const trustLevel = policy.trustLevels[riskClass];
  if (trustLevel === 'auto') {
    // Check containment requirement for auto-approve
    if (policy.requireContainmentForAutoApprove && !containment.contained) {
      return {
        action: 'escalate',
        gate: 'approve',
        reason: `Auto-approve blocked: containment not satisfied (${containment.summary})`,
        escalationContext: { containment },
      };
    }

    // Time-boxed autonomy window
    if (policy.autonomyWindow && Date.now() < policy.autonomyWindow.expiresAt) {
      return {
        action: 'proceed',
        gate: 'approve',
        reason: `Auto-approved: dev mode active (${policy.autonomyWindow.reason})`,
      };
    }

    // Standard auto-approve
    return {
      action: 'proceed',
      gate: 'approve',
      reason: `Auto-approved: trust level "${trustLevel}" for risk class "${riskClass}"`,
    };
  }

  // Default: escalate for human review
  return {
    action: 'escalate',
    gate: 'approve',
    reason: `Human approval required: trust level "${trustLevel || 'gate'}" for risk class "${riskClass}"`,
    escalationContext: { containment },
  };
}

// =============================================================================
// CONSTRAINT SEEDING — From failure events to constraints
// =============================================================================

/**
 * Seed a constraint from a failure event.
 *
 * Pure function. Given a failure event and existing constraints,
 * determines whether a new constraint should be created.
 *
 * Returns the new constraint, or null if no constraint should be seeded.
 *
 * Extracted from: seedConstraintFromFailure() in memory.ts
 */
export function seedConstraint(
  failure: FailureEvent,
  existingConstraints: GovernanceConstraint[],
  maxDepth: number = 5,
): GovernanceConstraint | null {
  // Max constraint depth reached
  const jobConstraints = existingConstraints.filter(c => c.jobId === failure.jobId);
  if (jobConstraints.length >= maxDepth) {
    return null;
  }

  // Syntax failures mark pending only (need staging corroboration)
  if (failure.source === 'syntax' && failure.attempt < 2) {
    return null;
  }

  // Staging: only seed if attempt >= 2 or action class is repeated
  if (failure.source === 'staging' && failure.attempt < 2) {
    if (!failure.actionClass) return null;
    const priorWithSameClass = existingConstraints.filter(
      c => c.signature === failure.actionClass && c.jobId === failure.jobId,
    );
    if (priorWithSameClass.length === 0) return null;
  }

  // Determine constraint type based on failure
  const now = Date.now();

  // Action class ban (strategy ban)
  if (failure.actionClass) {
    const alreadyBanned = existingConstraints.some(
      c => c.type === 'forbidden_action' &&
        c.signature === failure.actionClass &&
        c.jobId === failure.jobId,
    );
    if (!alreadyBanned) {
      return {
        id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'forbidden_action',
        signature: failure.actionClass,
        appliesTo: failure.riskClass ? [failure.riskClass] : ['mutate'],
        surface: {
          files: failure.filesTouched,
          intents: [],
        },
        requires: {
          patterns: [],
        },
        reason: `Strategy "${failure.actionClass}" failed at ${failure.source} (attempt ${failure.attempt}): ${failure.error.substring(0, 100)}`,
        introducedAt: now,
        expiresAt: now + 3600000, // 1 hour TTL
        jobId: failure.jobId,
        jobScoped: true,
      };
    }
  }

  // Radius limit (progressive narrowing)
  const existingRadiusLimit = existingConstraints.find(
    c => c.type === 'radius_limit' && c.jobId === failure.jobId,
  );
  const currentMax = existingRadiusLimit?.requires.maxMutations ?? Infinity;
  const newMax = currentMax === Infinity ? 5 : Math.max(1, currentMax - 1);

  if (newMax < currentMax) {
    return {
      id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'radius_limit',
      signature: 'radius_narrowing',
      appliesTo: failure.riskClass ? [failure.riskClass] : ['mutate'],
      surface: { files: [], intents: [] },
      requires: { maxMutations: newMax },
      reason: `Radius narrowed to ${newMax} after ${failure.source} failure (attempt ${failure.attempt})`,
      introducedAt: now,
      expiresAt: now + 3600000,
      jobId: failure.jobId,
      jobScoped: true,
    };
  }

  return null;
}

// =============================================================================
// CHAIN VERIFICATION — Checkpoint integrity (G4)
// =============================================================================

/**
 * Verify the integrity of a checkpoint chain.
 *
 * Delegates to time-travel.ts pure functions.
 * Returns a simplified result for the kernel interface.
 */
export function verifyCheckpointChain(
  manifests: CheckpointManifest[],
): { intact: boolean; brokenAt?: string; reason?: string } {
  const result = verifyChain(manifests);

  if (result.intact) {
    return { intact: true };
  }

  return {
    intact: false,
    brokenAt: result.brokenAt,
    reason: result.reason || 'Chain verification failed',
  };
}

// =============================================================================
// PLAN SURFACE EXTRACTION — Domain-agnostic mutation analysis
// =============================================================================

/**
 * Extract a plan surface from mutations.
 *
 * The kernel provides a default implementation that extracts
 * file paths from mutation targets. Adapters can enrich this
 * with domain-specific intents and properties.
 */
export function extractPlanSurface(
  mutations: Mutation[],
  adapterIntents?: string[],
  adapterProperties?: Record<string, boolean>,
): PlanSurface {
  const files = [...new Set(mutations.map(m => m.target))];

  return {
    files,
    intents: adapterIntents || [],
    properties: adapterProperties || {},
  };
}
