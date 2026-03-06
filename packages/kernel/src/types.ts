/**
 * @sovereign-labs/kernel — Type Definitions
 * =====================================
 *
 * The boundary types for governance physics.
 * No implementation. No runtime behavior. No domain knowledge.
 *
 * These types define WHAT the kernel enforces. Domain adapters
 * implement the DomainAdapter interface (defined in the consuming
 * application, not in this package).
 *
 * Origin: Feb 22, 2026 — extracted from observed invariants in Sovereign's
 * agent pipeline (G1-G5, E-H7/8, K5). Every type here describes something
 * that already works in production.
 */

// =============================================================================
// PRIMITIVES — The atoms of governance. Domain-free.
// =============================================================================

/**
 * A testable claim about desired end-state.
 *
 * The kernel doesn't know what CSS is. It knows that a predicate has
 * an ID, a type (opaque string from the adapter), a description, and
 * fields the adapter uses for validation. The kernel matches predicates
 * to mutations by ID. The adapter decides what "matches" means.
 */
export interface Predicate {
  /** Unique identifier within a job */
  id: string;

  /** Adapter-defined type (e.g., 'css', 'html', 'content', 'db', 'terraform_resource', 'k8s_manifest') */
  type: string;

  /** Human-readable description of what this predicate asserts */
  description: string;

  /** Adapter-specific fields — the kernel never reads these, only passes them through */
  fields: Record<string, unknown>;

  /** Operator for comparison — universal across domains */
  operator: '==' | '!=' | 'contains' | 'not_contains' | '>' | '<' | 'exists' | 'not_exists';

  /** Expected value (adapter-interpreted) */
  value?: string | number;

  /** Current value from grounding (adapter-populated before execution) */
  current?: string | number;
}

/**
 * A captured action the agent wants to take.
 *
 * The kernel doesn't know what edit_file does. It knows a mutation
 * has a verb, a target, a timestamp, and arguments the adapter interprets.
 */
export interface Mutation {
  /** The action verb — adapter-defined (e.g., 'edit_file', 'run_migration', 'terraform_apply') */
  verb: string;

  /** What the mutation targets — adapter-interpreted (e.g., file path, resource ID, table name) */
  target: string;

  /** When the mutation was captured */
  capturedAt: number;

  /** Adapter-specific arguments — the kernel never reads these */
  args: Record<string, unknown>;
}

/**
 * A piece of evidence gathered from observing reality.
 *
 * The kernel uses this for identity binding (G5.5) — checking whether
 * mutations reference entities the agent actually observed.
 */
export interface Evidence {
  /** What tool gathered this evidence */
  source: string;

  /** Summary of what was observed */
  summary: string;

  /** Whether the observation returned empty results */
  empty: boolean;

  /** When the evidence was gathered */
  timestamp: number;

  /** Adapter-specific structured data — the kernel passes to adapter for identity checks */
  data: Record<string, unknown>;
}

// =============================================================================
// AUTHORITY — Who authorized this, and is it still valid?
// =============================================================================

/**
 * The identity of who controls this execution context.
 *
 * Currently a UUID persisted to disk. Could become a cryptographic key
 * without changing the kernel interface.
 */
export interface ControllerIdentity {
  /** Unique identifier for this controller instance */
  id: string;

  /** When this identity was established */
  establishedAt: number;
}

/**
 * Authority context for a single job.
 *
 * The kernel uses this to answer: "Is the current plan authorized by
 * the most recent human input?"
 */
export interface AuthorityContext {
  /** Controller that created this job */
  controllerId: string;

  /** Incremented on every human message injection */
  authorityEpoch: number;

  /** Captured at planning start — compared to authorityEpoch at commit */
  planEpoch?: number;

  /** True if this job belongs to a different controller */
  isForeign: boolean;
}

// =============================================================================
// CONSTRAINTS — What the agent is NOT allowed to do (K5).
// =============================================================================

/**
 * A hard guardrail derived from prior failures.
 *
 * Constraints are enforced by the kernel, not the LLM. A plan that
 * violates a constraint is rejected before it reaches the approval gate.
 */
export interface GovernanceConstraint {
  id: string;

  /** What kind of constraint */
  type: 'forbidden_action' | 'radius_limit' | 'goal_drift_ban';

  /** Stable identifier for the failure pattern */
  signature: string;

  /** Which mutation risk classes trigger this constraint */
  appliesTo: string[];

  /** Structural surface — what files/intents this constraint watches */
  surface: {
    files: string[];
    intents: string[];
  };

  /** What must be present in the plan to satisfy the constraint */
  requires: {
    files?: string[];
    patterns?: string[];
    maxMutations?: number;
  };

  /** Human-readable explanation */
  reason: string;

  /** When this constraint was created */
  introducedAt: number;

  /** If set, constraint auto-expires */
  expiresAt?: number;

  /** If set, constraint is removed when this job ends */
  jobId?: string;
  jobScoped?: boolean;
}

// =============================================================================
// RISK CLASSIFICATION — How dangerous is this set of mutations?
// =============================================================================

/**
 * Risk class for a mutation verb.
 *
 * Adapters declare these. The kernel uses them for approval routing
 * and constraint matching. The kernel can escalate but never downgrade.
 */
export type MutationRisk = 'read' | 'mutate' | 'destroy';

/**
 * Blast radius classification for a plan.
 *
 * The adapter classifies the overall change type. The kernel uses it
 * for auto-approve policy evaluation and constraint matching.
 */
export type RiskClass = string;

// =============================================================================
// CONTAINMENT — Does every mutation trace to a predicate? (G5)
// =============================================================================

/**
 * How a mutation relates to the declared predicates.
 */
export type Attribution = 'direct' | 'scaffolding' | 'unexplained';

/**
 * Per-mutation attribution result.
 */
export interface MutationAttribution {
  /** Index in the mutations array */
  index: number;

  /** The mutation verb */
  verb: string;

  /** What was targeted */
  target: string;

  /** How this mutation relates to predicates */
  attribution: Attribution;

  /** Which predicate this traces to (if direct) */
  predicateId?: string;

  /** Why this attribution was assigned */
  reason: string;
}

/**
 * Identity mismatch — agent mutates an entity it didn't observe (G5.5).
 */
export interface IdentityMismatch {
  /** Index in the mutations array */
  index: number;

  /** What the agent observed */
  observedValue: string;

  /** What the mutation targets */
  mutationValue: string;

  /** The mutation verb */
  verb: string;

  /** Human-readable explanation */
  detail: string;
}

/**
 * Full containment result for a plan.
 */
export interface ContainmentResult {
  /** True if all mutations are direct or scaffolding (none unexplained) */
  contained: boolean;

  /** Per-mutation attribution */
  attributions: MutationAttribution[];

  /** Identity binding violations */
  identityMismatches: IdentityMismatch[];

  /** Counts */
  directCount: number;
  scaffoldingCount: number;
  unexplainedCount: number;

  /** Human-readable summary */
  summary: string;
}

// =============================================================================
// VERDICTS — What the kernel tells the execution loop to do.
// =============================================================================

/**
 * The kernel's decision at each gate.
 *
 * This is the fundamental output. Every gate returns a verdict.
 * The execution loop (kernel-owned) acts on the verdict.
 */
export type VerdictAction =
  | 'proceed'          // Gate passed, continue to next gate
  | 'block'            // Gate failed, do not continue
  | 'narrow'           // Constraint or failure detected — retry with tighter bounds
  | 'escalate'         // Requires human decision
  | 'invalidate';      // Authority stale — replan

export interface GateVerdict {
  /** What to do */
  action: VerdictAction;

  /** Which gate produced this verdict */
  gate: string;

  /** Human-readable explanation */
  reason: string;

  /** If action is 'narrow': what new constraints apply */
  constraints?: GovernanceConstraint[];

  /** If action is 'escalate': context for human review */
  escalationContext?: {
    containment?: ContainmentResult;
    constraintViolation?: { constraintId: string; signature: string; reason: string };
    clarificationNeeded?: { evidence: string[]; similarity: number };
  };
}

// =============================================================================
// GATE SEQUENCE — The kernel's execution spine.
// =============================================================================

/**
 * The ordered sequence of governance gates.
 *
 * The kernel owns this ordering. No adapter, no LLM, no configuration
 * can change the sequence. This is physics, not policy.
 */
export type GateName =
  | 'classify'
  | 'grounding'  // G7: Epistemic Grounding (claims reference observable reality)
  | 'ground'
  | 'extract'
  | 'plan'
  | 'syntax'
  | 'constrain'
  | 'scope'      // G6: Scope Boundedness (blast radius estimable before execution)
  | 'contain'
  | 'approve'
  | 'stage'
  | 'execute'
  | 'verify'
  | 'evidence'   // G9: Deterministic Evidence (only deterministic evidence can cause rollback)
  | 'converge'   // G8: Convergence Monotonicity (search space strictly narrows on failure)
  | 'attest';

/**
 * Result of passing through the full gate sequence.
 */
export interface ExecutionReceipt {
  /** Unique receipt ID */
  id: string;

  /** The job this receipt covers */
  jobId: string;

  /** Ordered list of gate verdicts (audit trail) */
  gates: Array<{ gate: GateName; verdict: GateVerdict; timestamp: number }>;

  /** The mutations that were approved and executed */
  mutations: Mutation[];

  /** The predicates that were claimed */
  predicates: Predicate[];

  /** Post-execution verification results */
  verification: Array<{
    predicateId: string;
    passed: boolean;
    actual?: string | number | null;
    expected?: string | number;
  }>;

  /** Authority chain */
  authority: AuthorityContext;

  /** Containment result at approval gate */
  containment: ContainmentResult;

  /** Timestamp range */
  startedAt: number;
  completedAt: number;
}

// =============================================================================
// APPROVAL POLICY — Rules for when human review is required.
// =============================================================================

/**
 * Enforcement mode for containment.
 *
 * Advisory:   Log attribution, never block.
 * Soft gate:  Approve disabled when unexplained > 0. Human must acknowledge.
 * Hard gate:  Unexplained mutations rejected. Agent retries.
 */
export type ContainmentMode = 'advisory' | 'soft_gate' | 'hard_gate';

/**
 * Trust level per risk class — when auto-approve is allowed.
 */
export type TrustLevel = 'gate' | 'auto';

/**
 * Approval policy for a governed context.
 */
export interface ApprovalPolicy {
  /** Per-risk-class trust levels */
  trustLevels: Record<string, TrustLevel>;

  /** Containment enforcement mode */
  containmentMode: ContainmentMode;

  /** If true, auto-approve only fires when containment.contained === true */
  requireContainmentForAutoApprove: boolean;

  /** Time-boxed autonomy window (if active) */
  autonomyWindow?: {
    expiresAt: number;
    reason: string;
  };

  /** Maximum risk class ceiling (from campaigns) — auto-approve capped here */
  ceiling?: string;
}

// =============================================================================
// CONVERGENCE — How the system narrows on retry (K5 physics).
// =============================================================================

/**
 * Failure event — the normalized input to constraint seeding.
 */
export interface FailureEvent {
  /** Which job failed */
  jobId: string;

  /** Where in the pipeline the failure occurred */
  source: 'syntax' | 'staging' | 'post_deploy' | 'rollback';

  /** The error message or signal */
  error: string;

  /** What files were touched in the failing plan */
  filesTouched: string[];

  /** Which attempt this was */
  attempt: number;

  /** Risk classification of the failing plan */
  riskClass?: string;

  /** Adapter-classified action strategy (e.g., 'rewrite_page', 'schema_migration') */
  actionClass?: string;
}

/**
 * Convergence state for an active job.
 *
 * Tracks how the solution space is narrowing across iterations.
 */
export interface ConvergenceState {
  /** Active constraints for this job */
  activeConstraints: GovernanceConstraint[];

  /** How many iterations have run */
  iterations: number;

  /** How many consecutive empty plans */
  emptyPlanCount: number;

  /** Previous verification evidence (for similarity comparison) */
  priorEvidence: string[];

  /** Whether the system has detected semantic disagreement */
  semanticDisagreement: boolean;
}

// =============================================================================
// CHECKPOINT — Attestation receipt with integrity chain (F10).
// =============================================================================

/**
 * Checkpoint manifest — tamper-evident record of system state.
 *
 * The kernel owns the chain integrity logic (hash chain, parent references).
 * The adapter populates the domain-specific hashes (files, schema, etc.)
 */
export interface CheckpointManifest {
  /** Unique checkpoint ID */
  checkpointId: string;

  /** The job that created this checkpoint */
  jobId: string;

  /** Timestamp */
  timestamp: number;

  /** Hash of the previous checkpoint (or 'genesis') */
  parentHash: string;

  /** Adapter-provided content hashes — the kernel verifies the chain, not the contents */
  contentHashes: Record<string, string>;

  /** Aggregate hash covering all content hashes + parent hash */
  rootHash: string;

  /** Risk classification of the changes in this checkpoint */
  riskClass: string;
}

// =============================================================================
// GENERIC ATTRIBUTION TYPES — For G5 containment in pure heuristics
// =============================================================================

/**
 * Generic predicate with optional domain-specific fields for G5 attribution.
 * Structurally compatible with domain-specific types (e.g., GoalPredicate).
 */
export interface AttributionPredicate {
  id: string;
  type: string;
  selector?: string;
  property?: string;
  value?: unknown;
  path?: string;
  file?: string;
  table?: string;
  column?: string;
  pattern?: string;
  description?: string;
}

/**
 * Generic captured mutation for G5 attribution.
 * Structurally compatible with domain-specific types (e.g., CapturedMutation).
 */
export interface AttributionMutation {
  tool: string;
  args: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Generic observation record for G5 identity binding.
 * Structurally compatible with domain-specific types (e.g., ObservationRecord).
 */
export interface AttributionObservation {
  tool: string;
  resultSummary?: string;
  timestamp?: number;
}

// =============================================================================
// DOMAIN ADAPTER — What the kernel requires from a domain.
// =============================================================================

/**
 * Capability manifest — what this adapter can do and what limits apply.
 *
 * The kernel reads this once at registration. It determines:
 * - What mutation verbs exist (and ONLY these verbs)
 * - What risk class each verb belongs to
 * - What minimum approval floor applies
 * - What verification authority the adapter provides
 *
 * The kernel can escalate risk. It can never downgrade below the
 * adapter's declared floor.
 */
export interface CapabilityManifest {
  /** Human-readable adapter name */
  name: string;

  /** What mutation verbs exist in this domain */
  verbs: Array<{
    name: string;
    risk: MutationRisk;
    description: string;
  }>;

  /** Minimum approval floor per risk class — kernel enforces, never downgrades */
  approvalFloor: Record<MutationRisk, 'auto' | 'human' | 'never'>;

  /** Hard limits on what the adapter can do */
  ceilings: {
    /** Maximum mutations in a single plan */
    maxMutationsPerPlan: number;

    /** Whether predicates are required before mutations (true = no blind execution) */
    requiresPredicates: boolean;
  };

  /**
   * Verification authority — determines containment strength.
   *
   * independent:     Adapter probes reality itself. G1-G5 hold fully.
   * hybrid:          Adapter verifies some aspects, relies on agent for others.
   * agent-reported:  Adapter cannot independently verify. Advisory only.
   */
  verificationMode: 'independent' | 'hybrid' | 'agent-reported';
}

/**
 * The domain adapter interface.
 *
 * This is the contract between the governance kernel and any domain.
 * The kernel calls these methods at specific points in the gate sequence.
 * The adapter never calls the kernel — data flows one direction.
 */
export interface DomainAdapter {
  /** The adapter's declared capabilities */
  manifest: CapabilityManifest;

  classifyGoal(goal: string): Promise<{
    intent: string;
    tier: string;
    domains: string[];
  }>;

  groundInReality(target: string): Promise<{
    context: Record<string, unknown>;
    summary: string;
  }>;

  extractPredicates(
    goal: string,
    grounding: Record<string, unknown>,
  ): Promise<Predicate[]>;

  validatePredicate(
    predicate: Predicate,
    evidence: Record<string, unknown>,
  ): Promise<{
    passed: boolean;
    actual?: string | number | null;
    expected?: string | number;
    error?: string;
  }>;

  produceMutations(
    goal: string,
    predicates: Predicate[],
    constraints: GovernanceConstraint[],
    context: Record<string, unknown>,
  ): Promise<{
    mutations: Mutation[];
    explanation: string;
    toolCalls: number;
  }>;

  validateSyntax(mutations: Mutation[]): Promise<{
    passed: boolean;
    errors: Array<{ mutation: number; error: string }>;
  }>;

  attributeMutation(
    mutation: Mutation,
    predicates: Predicate[],
    evidence: Evidence[],
  ): MutationAttribution;

  checkIdentityBinding(
    mutations: Mutation[],
    evidence: Evidence[],
  ): IdentityMismatch[];

  stage(
    mutations: Mutation[],
    predicates: Predicate[],
  ): Promise<{
    passed: boolean;
    error?: string;
    logs?: string;
  }>;

  execute(mutations: Mutation[]): Promise<{
    success: boolean;
    error?: string;
  }>;

  verify(predicates: Predicate[]): Promise<Array<{
    predicateId: string;
    passed: boolean;
    actual?: string | number | null;
    expected?: string | number;
  }>>;

  captureState(target: string): Promise<{
    contentHashes: Record<string, string>;
  }>;

  restoreState(
    target: string,
    manifest: CheckpointManifest,
  ): Promise<{ success: boolean; error?: string }>;

  classifyRisk(mutations: Mutation[]): string;

  classifyAction(mutations: Mutation[]): string | undefined;
}

// =============================================================================
// GOVERNANCE KERNEL — What the kernel guarantees.
// =============================================================================

/**
 * The governance kernel interface.
 *
 * Owns the gate sequence. Calls the adapter at each gate.
 * Returns verdicts. Enforces constraints. Maintains authority.
 * Produces attestation receipts.
 */
export interface GovernanceKernel {
  registerAdapter(adapter: DomainAdapter): void;

  execute(
    goal: string,
    target: string,
    authority: AuthorityContext,
    policy: ApprovalPolicy,
    options?: {
      constraints?: GovernanceConstraint[];
      overrideConstraints?: string[];
      onApprovalRequired?: (context: {
        mutations: Mutation[];
        predicates: Predicate[];
        containment: ContainmentResult;
        riskClass: string;
        explanation: string;
      }) => Promise<{ approved: boolean; feedback?: string }>;
      onHumanMessage?: (message: string) => void;
    },
  ): Promise<ExecutionReceipt>;

  checkConstraints(
    mutations: Mutation[],
    riskClass: string,
    constraints: GovernanceConstraint[],
    overrides?: string[],
  ): GateVerdict;

  attributePlan(
    mutations: Mutation[],
    predicates: Predicate[],
    evidence: Evidence[],
    adapter: DomainAdapter,
  ): ContainmentResult;

  validateAuthority(authority: AuthorityContext): GateVerdict;

  seedConstraint(
    failure: FailureEvent,
    existingConstraints: GovernanceConstraint[],
  ): GovernanceConstraint | null;

  verifyChain(manifests: CheckpointManifest[]): {
    intact: boolean;
    brokenAt?: string;
    reason?: string;
  };
}
