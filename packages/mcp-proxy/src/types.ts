/**
 * @sovereign-labs/mcp-proxy — Type Definitions
 * ========================================
 *
 * Proxy-specific types for governed MCP transport.
 * Kernel types (Mutation, AuthorityContext, GateVerdict) imported from @sovereign-labs/kernel.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Proxy configuration.
 *
 * Tells the proxy what upstream to wrap, where to store governance state,
 * and how strictly to enforce invariants.
 */
export interface ProxyConfig {
  /** Command to spawn upstream MCP server (e.g., 'npx -y @modelcontextprotocol/server-filesystem') */
  upstream: string;

  /** Args for upstream command (split from upstream string if not provided) */
  upstreamArgs?: string[];

  /** Path to .governance/ directory for persisted state */
  stateDir: string;

  /** Enforcement mode: 'strict' blocks violations, 'advisory' logs + forwards. Default: 'strict' */
  enforcement?: 'strict' | 'advisory';

  /** Upstream response timeout in milliseconds. Default: 300000 (5 minutes) */
  timeout?: number;
}

// =============================================================================
// PERSISTED STATE
// =============================================================================

/**
 * E-H7: Controller identity.
 * Created once per stateDir, never changes.
 * File: .governance/controller.json
 */
export interface ControllerState {
  /** UUID, generated once per stateDir */
  id: string;

  /** When this controller was established */
  establishedAt: number;
}

/**
 * E-H8: Authority epoch tracking.
 * Incremented by bump_authority meta-tool.
 * File: .governance/authority.json
 */
export interface AuthorityState {
  /** The controller this authority belongs to */
  controllerId: string;

  /** Current authority epoch — incremented on bump */
  epoch: number;

  /** When the epoch was last bumped */
  lastBumpedAt: number;

  /** Snapshot of epoch when current proxy session started */
  activeSessionEpoch?: number;

  /** When the current proxy session began */
  sessionStartedAt?: number;

  /** Genesis trust anchor: hash of the first receipt in the ledger.
   *  Pinned on first appendReceipt, verified by verifyReceiptChain.
   *  Prevents whole-ledger replacement attacks. */
  genesisHash?: string;
}

/**
 * G2: Constraint from a prior failure.
 * Blocks the same tool+target combination within TTL.
 * File: .governance/constraints.json
 */
export interface ConstraintEntry {
  /** Unique constraint ID */
  id: string;

  /** MCP tool name that failed */
  toolName: string;

  /** Primary target (file path, resource key, etc.) */
  target: string;

  /** Failure signature from kernel extractSignature() */
  failureSignature: string;

  /** First 200 chars of error text */
  errorSnippet: string;

  /** When this constraint was created */
  createdAt: number;

  /** TTL in milliseconds. Default: 1 hour (3,600,000ms). After TTL, constraint is inactive. */
  ttlMs?: number;

  /** Optional session scoping */
  sessionId?: string;
}

// =============================================================================
// RECEIPTS — Hash-chained audit trail
// =============================================================================

/**
 * Per-tool-call record forming a tamper-evident ledger.
 * Each record's hash includes the previous record's hash.
 * File: .governance/receipts.jsonl (one JSON per line, append-only)
 */
export interface ToolCallRecord {
  /** Receipt ID */
  id: string;

  /** Monotonic sequence number (0, 1, 2, ...) */
  seq: number;

  /** When this tool call occurred */
  timestamp: number;

  /** E-H7: Controller that owns this session */
  controllerId: string;

  /** E-H8: Authority epoch at time of call */
  authorityEpoch: number;

  /** Enforcement mode when this call was processed */
  enforcement: 'strict' | 'advisory';

  /** MCP tool name */
  toolName: string;

  /** Tool call arguments */
  arguments: Record<string, unknown>;

  /** Extracted primary target */
  target: string;

  // --- Governance checks ---

  /** G2: Constraint check result */
  constraintCheck: { passed: boolean; blockedBy?: string };

  /** E-H8: Authority check result */
  authorityCheck: { passed: boolean; reason?: string };

  // --- Outcome ---

  /** Result: 'success' (upstream returned result), 'error' (upstream returned error), 'blocked' (governance blocked) */
  outcome: 'success' | 'error' | 'blocked';

  /** Error text if outcome is 'error' */
  error?: string;

  /** Failure signature if outcome is 'error' */
  failureSignature?: string;

  /** Wall-clock duration in milliseconds */
  durationMs: number;

  // --- Hash chain ---

  /** SHA-256 of previous receipt ('genesis' for first) */
  previousHash: string;

  /** SHA-256 of previousHash + canonical payload */
  hash: string;

  // --- Kernel mutation ---

  /** Kernel Mutation representation of this tool call */
  mutation: { verb: string; target: string; capturedAt: number; args: Record<string, unknown> };

  /**
   * Best-effort classification of state effect.
   * Describes whether this tool call modifies state, not risk level.
   * `mutating` ≠ dangerous. `readonly` ≠ safe.
   */
  mutationType: 'mutating' | 'readonly';

  // --- Tier 3: Containment attribution ---

  /** Heuristic attribution class for this tool call */
  attribution?: AttributionClass;

  /** Which predicate/key/value triggered 'direct' attribution (debugging) */
  attributionMatch?: AttributionMatchDetail;

  // --- Tier 4: Grounding annotation ---

  /** Whether this tool call was made with grounded context */
  groundingAnnotation?: { grounded: boolean; stale: boolean };

  // --- Tier 5: Convergence ---

  /** Convergence signal at time of this tool call */
  convergenceSignal?: ConvergenceSignal;

  /** Age of current intent at time of this tool call (ms) */
  intentAgeMs?: number;

  /** SHA-256 of the intent context at receipt time.
   *  Prevents retroactive intent tampering — if intent.json is modified
   *  after the receipt was written, the hash won't match. */
  intentHash?: string;
}

// =============================================================================
// RUNTIME — Proxy lifecycle
// =============================================================================

/**
 * Live proxy state (in-memory).
 */
export interface ProxyState {
  controller: ControllerState;
  authority: AuthorityState;
  constraints: ConstraintEntry[];
  receiptSeq: number;
  lastReceiptHash: string;

  /** Tier 3: Current declared intent (set by governance_declare_intent) */
  intent?: IntentContext;

  /** Tier 5: Session-scoped convergence tracker */
  convergence: ConvergenceTracker;
}

/**
 * Governed proxy handle returned by createGovernedProxy().
 */
export interface GovernedProxy {
  /** Start the proxy (begins stdio interposition) */
  start(): Promise<void>;

  /** Stop the proxy (kills upstream, flushes state) */
  stop(): Promise<void>;

  /** Get current governance state snapshot */
  getState(): ProxyState;

  /** Get the proxy config */
  getConfig(): ProxyConfig;
}

// =============================================================================
// MCP PROTOCOL — Minimal subset for interposition
// =============================================================================

/**
 * JSON-RPC 2.0 request.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP tool definition (subset).
 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// =============================================================================
// TIER 3: CONTAINMENT ATTRIBUTION
// =============================================================================

/**
 * Declared predicate for containment attribution.
 * Agent calls `governance_declare_intent` before making mutations.
 * Fields are flattened key-value pairs for string matching.
 */
export interface DeclaredPredicate {
  /** Predicate type (e.g. "css", "http", "db") — opaque string */
  type: string;

  /** Flattened key-value pairs from predicate fields (string values only) */
  fields: Record<string, string>;
}

/**
 * Intent context declared by the agent.
 * Stored in-memory and persisted to intent.json for session resume.
 */
export interface IntentContext {
  /** What the agent is trying to achieve */
  goal: string;

  /** Predicates: testable claims about end-state */
  predicates: DeclaredPredicate[];

  /** When this intent was declared */
  declaredAt: number;

  /** Optional grounding context (Tier 4) */
  grounding?: GroundingContext;

  /** Schema version for forward compatibility */
  version: 1;
}

/** Attribution class for a tool call */
export type AttributionClass = 'direct' | 'scaffolding' | 'unexplained' | 'no_intent';

/**
 * Which predicate field matched and why.
 * Present on receipts when attribution is 'direct'.
 * Enables debugging: "why did it mark direct?"
 */
export interface AttributionMatchDetail {
  /** Predicate type that matched (e.g. "css", "http") */
  predicateType: string;

  /** Field key that matched (e.g. "selector", "path") */
  key: string;

  /** Field value that matched */
  value: string;
}

// =============================================================================
// TIER 4: GROUNDING ANNOTATION
// =============================================================================

/**
 * Grounding context attached to intent.
 * Opaque domain facts (CSS rules, routes, DB schema, etc.) the agent observed.
 * Used for staleness annotation, not interpretation.
 */
export interface GroundingContext {
  /** Domain facts — opaque to the proxy */
  facts: Record<string, unknown>;

  /** When these facts were observed */
  observedAt: number;
}

// =============================================================================
// TIER 5: CONVERGENCE ENFORCEMENT
// =============================================================================

/**
 * Session-scoped convergence tracker.
 * NOT persisted to disk — reset on session re-initialize.
 * Detects failure loops and tool spam.
 */
export interface ConvergenceTracker {
  /** Failure signature → count of failures with that signature */
  failureSignatures: Map<string, number>;

  /** tool:target → timestamps of recent calls (bounded, rolling 2-min window) */
  toolTargetTimestamps: Map<string, number[]>;
}

/** Convergence signal level */
export type ConvergenceSignal = 'none' | 'warning' | 'exhausted' | 'loop';

// =============================================================================
// TOOL CALL CONTEXT — Pipeline intermediate state
// =============================================================================

/**
 * Context bag for a single tool call flowing through the governance pipeline.
 *
 * Created once in handleToolsCall(), passed to handleBlocked(),
 * handleUpstreamResult(), handleUpstreamTimeout(), and enrichReceipt().
 */
export interface ToolCallContext {
  /** MCP tool name */
  toolName: string;

  /** Tool call arguments */
  toolArgs: Record<string, unknown>;

  /** Kernel Mutation representation */
  mutation: { verb: string; target: string; capturedAt: number; args: Record<string, unknown> };

  /** Heuristic mutation classification */
  mutationType: 'mutating' | 'readonly';

  /** Wall-clock start time (Date.now()) */
  startTime: number;

  /** Canonical target extracted from args */
  target: string;

  /** Convergence signal at gate check time */
  convergenceSignal: ConvergenceSignal;

  /** Combined result from all governance gates */
  gateResult: import('./governance.js').GateResult;
}
