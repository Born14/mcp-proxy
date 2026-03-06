/**
 * Governance Kernel — Public API
 * ==============================
 *
 * Eleven structural invariants of governed execution.
 * Zero domain imports. Pure functions. Constitutional proof.
 *
 * Import from this file for the kernel's public surface.
 * Each module enforces one or more invariants:
 *
 *   G1: Honesty                — Agent cannot declare success when reality disagrees
 *   G2: Non-Repetition         — Agent cannot repeat a strategy that already failed
 *   G3: Entropy Resilience     — Verification survives partial deploys and system entropy
 *   G4: Time Travel            — Complete rollback is always possible
 *   G5: Containment            — Every mutation traces to a predicate, or the human knows
 *   G6: Scope Boundedness      — Every mutation's blast radius must be estimable before execution
 *   G7: Epistemic Grounding    — Claims must reference observable reality, not hallucinated state
 *   G8: Convergence Monotonicity — On failure, the search space must strictly narrow
 *   G9: Deterministic Evidence  — Only deterministic evidence can cause a rollback
 *   E-H7: Identity             — Foreign controller jobs are immutable
 *   E-H8: Temporal             — Latest human authority invalidates stale plans
 */

// =============================================================================
// G1: HONESTY
// =============================================================================
export {
  buildHonestyVerdict,
  deriveFailureCategory,
} from './honesty.js';

export type {
  VerificationSignal,
  FailureCategory,
  HonestyVerdict,
} from './honesty.js';

// =============================================================================
// G2: NON-REPETITION
// =============================================================================
export {
  extractSignature,
  checkConstraint,
  checkAllConstraints,
  constraintVerdict,
  buildEvidenceBlock,
} from './non-repetition.js';

export type {
  PlanSurface,
  ConstraintCheckResult,
  ConstraintViolation,
  FileOutcomeEvidence,
  PatternEvidence,
} from './non-repetition.js';

// =============================================================================
// G3: ENTROPY RESILIENCE
// =============================================================================
export {
  scanForErrors,
  detectDrift,
  detectUnrollbackableChanges,
  verifyEvidenceChain,
  entropyVerdict,
} from './entropy.js';

export type {
  SnapshotRecord,
  DriftResult,
  ErrorScanResult,
  EvidenceChain,
  ChainCompletenessResult,
} from './entropy.js';

// =============================================================================
// G4: TIME TRAVEL
// =============================================================================
export {
  sha256,
  computeManifestHash,
  verifyChain,
} from './time-travel.js';

export type {
  ChainVerificationResult,
} from './time-travel.js';

// =============================================================================
// G5: CONTAINMENT
// =============================================================================
export {
  attributePlan,
  containmentVerdict,
} from './containment.js';

export type {
  AttributedMutation,
} from './containment.js';

// =============================================================================
// E-H7: IDENTITY SOVEREIGNTY
// =============================================================================
export {
  assertMutable,
  isForeignJob,
  checkIdentity,
} from './identity.js';

// =============================================================================
// E-H8: TEMPORAL SOVEREIGNTY
// =============================================================================
export {
  validateAuthority,
  capturePlanEpoch,
  incrementAuthority,
} from './temporal.js';

// =============================================================================
// G6: SCOPE BOUNDEDNESS
// =============================================================================
export {
  computeAlignment,
  computeEffectAlignmentScore,
  evaluateScopeContract,
  gateScope,
} from './scope.js';

export type {
  ScopeTrust,
  ScopeSource,
  ScopeEstimate,
  ObservedImpact,
  AlignmentStatus,
  ScopeAlignment,
  ImpactEvidence,
  AxisContributions,
  EffectAlignmentScore,
  ScopeContractVerdict,
  ScopeContractResult,
  ScopeTelemetry,
} from './scope.js';

// =============================================================================
// G7: EPISTEMIC GROUNDING
// =============================================================================
export {
  evaluateGroundingCoverage,
  gateGrounding,
} from './grounding.js';

export type {
  GroundingEvidence,
  CoverageResult,
  GroundingConfig,
} from './grounding.js';

// =============================================================================
// G8: CONVERGENCE MONOTONICITY + Solution space narrowing
// =============================================================================
export {
  createConvergenceState,
  recordIteration,
  addConstraint,
  jaccardSimilarity,
  detectSemanticDisagreement,
  detectExhaustion,
  convergenceVerdict,
  verifyMonotonicity,
  verifyMonotonicityChain,
  gateConvergence,
} from './convergence.js';

export type {
  IterationRecord,
  ConvergenceAnalysis,
  SolutionSpaceSnapshot,
  MonotonicityResult,
} from './convergence.js';

// =============================================================================
// G9: DETERMINISTIC EVIDENCE
// =============================================================================
export {
  classifyEvidenceReliability,
  filterReliableEvidence,
  gateEvidence,
} from './evidence.js';

export type {
  EvidenceStability,
  EvidenceRecord,
  EvidenceReliability,
} from './evidence.js';

// =============================================================================
// RECEIPT — Audit trail
// =============================================================================
export {
  computePolicyHash,
  generateReceiptId,
  buildReceipt,
  validateReceipt,
  summarizeReceipt,
} from './receipt.js';

export type {
  ReceiptProvenance,
  ReceiptValidation,
  GatePassage,
} from './receipt.js';

// =============================================================================
// GATE SEQUENCE — The execution spine (16 gates)
// =============================================================================
export {
  GATE_ORDER,
  gateConstrain,
  gateContain,
  gateApprove,
  seedConstraint,
  verifyCheckpointChain,
  extractPlanSurface,
} from './gate-sequence.js';

export type {
  GateSequenceConfig,
  ExecutionOptions,
  GateSequenceResult,
} from './gate-sequence.js';
