/**
 * Tool Call → Mutation Mapping + Failure Fingerprinting
 * =====================================================
 *
 * Maps MCP tool calls to kernel Mutation type and extracts failure
 * signatures from error text using kernel extractSignature().
 *
 * Three-layer classification strategy:
 *   1. Schema-based: Uses inputSchema from tools/list to detect write signals
 *   2. Verb heuristic: Tokenized tool name + action arg matching (fallback)
 *   3. Arg inspection: Content/data keys, SQL patterns (last resort)
 *
 * Target extraction recurses into nested objects and arrays to find
 * meaningful identifiers, avoiding the "toolName fallback" that makes
 * G2 constraints too broad.
 *
 * Error signatures are normalized before comparison to strip volatile
 * components (timestamps, IPs, UUIDs, PIDs, ports) that would defeat
 * G2 deduplication.
 */

import { extractSignature } from '@sovereign-labs/kernel';
import type { Mutation } from '@sovereign-labs/kernel/types';
import type { ConstraintEntry, McpToolDef } from './types.js';

// =============================================================================
// TOOL SCHEMA CACHE
// =============================================================================

/**
 * Cached tool schemas from the most recent tools/list response.
 * Populated by `cacheToolSchemas()`, consumed by `classifyMutationType()`.
 *
 * Key: tool name, Value: inputSchema object.
 */
const toolSchemaCache = new Map<string, Record<string, unknown>>();

/**
 * Cache tool schemas from a tools/list response.
 * Called by the proxy when it intercepts tools/list.
 */
export function cacheToolSchemas(tools: McpToolDef[]): void {
  toolSchemaCache.clear();
  for (const tool of tools) {
    if (tool.name && tool.inputSchema) {
      toolSchemaCache.set(tool.name, tool.inputSchema);
    }
  }
}

/**
 * Get the cached schema for a tool (if available).
 * Exported for testing.
 */
export function getCachedSchema(toolName: string): Record<string, unknown> | undefined {
  return toolSchemaCache.get(toolName);
}

/**
 * Clear the schema cache. Exported for testing.
 */
export function clearSchemaCache(): void {
  toolSchemaCache.clear();
}

// =============================================================================
// SCHEMA-BASED CLASSIFICATION
// =============================================================================

/**
 * Property names in inputSchema that indicate the tool accepts write payloads.
 * More reliable than verb heuristics because the schema is the tool's own
 * declaration of what it accepts.
 */
const SCHEMA_WRITE_PROPERTIES = new Set([
  'content', 'data', 'body', 'value', 'text', 'sql',
  'entities', 'relations', 'observations',  // Knowledge graph servers
  'code', 'script', 'command', 'commands',  // Execution servers
  'message', 'messages',                     // Chat/messaging servers
  'config', 'configuration', 'settings',     // Config servers
  'template', 'payload', 'input',            // Generic write payloads
  // Note: 'query' intentionally excluded — ambiguous (search filter vs SQL write).
  // SQL writes detected via SQL_WRITE_PATTERN on arg values instead.
]);

/**
 * Property names in inputSchema that indicate the tool is read-only.
 * Only counted as evidence — a single write property overrides all read signals.
 */
const SCHEMA_READ_PROPERTIES = new Set([
  'query', 'pattern', 'filter', 'limit', 'offset', 'cursor', 'page',
  'sort', 'order', 'fields', 'select', 'include', 'exclude',
]);

/**
 * Classify mutation type using the tool's inputSchema.
 *
 * Returns 'mutating', 'readonly', or null (schema unavailable/inconclusive).
 *
 * Strategy: if the schema has required properties that are write-typed,
 * it's mutating. If it only has filter/pagination properties, it's readonly.
 * If inconclusive, returns null to fall through to verb heuristics.
 */
export function classifyFromSchema(
  toolName: string,
): 'mutating' | 'readonly' | null {
  const schema = toolSchemaCache.get(toolName);
  if (!schema) return null;

  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return null;

  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  let writeSignals = 0;
  let readSignals = 0;

  for (const propName of Object.keys(properties)) {
    const lower = propName.toLowerCase();
    if (SCHEMA_WRITE_PROPERTIES.has(lower)) {
      writeSignals++;
    } else if (SCHEMA_READ_PROPERTIES.has(lower)) {
      readSignals++;
    }

    // Check if a required property has a complex type (object/array) —
    // complex required inputs usually mean write payloads
    if (required.has(propName)) {
      const prop = properties[propName] as Record<string, unknown> | undefined;
      if (prop) {
        const propType = prop.type as string | undefined;
        if (propType === 'object' || propType === 'array') {
          writeSignals++;
        }
      }
    }
  }

  // Any write signal is sufficient — a tool that accepts "content" is mutating
  if (writeSignals > 0) return 'mutating';

  // Only read signals with no write signals → readonly
  if (readSignals > 0 && writeSignals === 0) return 'readonly';

  // Inconclusive — fall through to verb heuristics
  return null;
}

// =============================================================================
// VERB-BASED CLASSIFICATION (FALLBACK)
// =============================================================================

/**
 * Verbs that typically modify state.
 * Matched against normalized tool name tokens.
 */
const MUTATING_VERBS = new Set([
  'write', 'create', 'delete', 'remove', 'update', 'set', 'put', 'patch',
  'insert', 'drop', 'alter', 'execute', 'run', 'apply', 'deploy', 'restart',
  'stop', 'kill', 'push', 'move', 'rename', 'append', 'truncate',
  'clear', 'reset', 'start', 'retry', 'approve', 'reject', 'skip',
  'edit', 'modify', 'add', 'commit', 'merge', 'checkout', 'send', 'post',
  'assign', 'close', 'archive', 'resolve', 'revoke', 'suspend', 'activate',
  'enable', 'disable', 'lock', 'unlock', 'promote', 'demote', 'transfer',
]);

/**
 * Verbs that typically do not modify state.
 * Matched against normalized tool name tokens.
 */
const READONLY_VERBS = new Set([
  'read', 'get', 'list', 'search', 'find', 'query', 'describe', 'show',
  'status', 'health', 'check', 'inspect', 'view', 'count', 'exists',
  'echo', 'print', 'fetch', 'retrieve', 'lookup', 'info', 'help',
]);

/**
 * Argument keys whose presence suggests a mutating call.
 */
const MUTATING_ARG_KEYS = new Set(['content', 'data', 'body', 'value']);

/**
 * SQL keywords that indicate a write operation.
 */
const SQL_WRITE_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i;

/**
 * Split a tool name into normalized tokens.
 * Handles snake_case, dash-case, and camelCase.
 */
function tokenizeToolName(toolName: string): string[] {
  return toolName
    // Split camelCase boundaries BEFORE lowering (e.g., writeFile → write File)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    // Split on _ and -
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Classify a tool call as mutating or readonly.
 *
 * This is a best-effort heuristic for ledger metadata, NOT a security boundary.
 * `mutating` describes state effect, not risk level. `readonly` describes
 * absence of state effect, not safety. The proxy does not gate on this field.
 *
 * **Deny-by-default:** Unknown tools are classified as `mutating`. Only tools
 * with explicit readonly signals (verb match, schema, governance prefix) earn
 * the `readonly` classification. This eliminates the open-vocabulary problem
 * where novel mutating verbs (assign, close, archive, etc.) slip through as
 * readonly because they aren't in a dictionary.
 *
 * Classification priority:
 *   1. governance_* meta-tools → always readonly
 *   2. Schema-based: inputSchema write property detection (strongest signal)
 *   3. Verb match against READONLY_VERBS → readonly
 *   4. Verb match against MUTATING_VERBS → mutating (confirms, not gates)
 *   5. Action arg inspection for compound tools
 *   6. Argument key inspection (content/data/body/value keys, SQL write keywords) → mutating
 *   7. Default → mutating (deny-by-default)
 */
export function classifyMutationType(
  toolName: string,
  args: Record<string, unknown>,
): 'mutating' | 'readonly' {
  // Governance meta-tools are always readonly
  if (toolName.toLowerCase().startsWith('governance_')) return 'readonly';

  // Verb heuristic — checked first for readonly verbs, which override schema
  const tokens = tokenizeToolName(toolName);
  const hasReadonlyVerb = tokens.some(t => READONLY_VERBS.has(t));
  const hasMutatingVerb = tokens.some(t => MUTATING_VERBS.has(t));

  // Schema-based classification (high confidence, but readonly verbs override)
  // Rationale: a tool named "get-*", "echo", "list-*" is explicitly declaring
  // read-only intent through its name. Schema property names like "message" or
  // "data" are ambiguous (echo takes "message" but doesn't send anything).
  const schemaResult = classifyFromSchema(toolName);
  if (schemaResult !== null) {
    if (schemaResult === 'mutating' && hasReadonlyVerb && !hasMutatingVerb) {
      // Readonly verb overrides schema write signal (e.g., echo with message param)
      return 'readonly';
    }
    return schemaResult;
  }

  // Readonly verbs are the allowlist — if a tool says "get", "list", "search"
  // without any mutating verb, it earns readonly. When both are present
  // (e.g., "run_query"), the mutating verb wins (conservative).
  if (hasReadonlyVerb && !hasMutatingVerb) return 'readonly';
  if (hasMutatingVerb) return 'mutating';

  // Check 'action' argument value for compound tools (e.g., sovereign_job_control({ action: 'delete' }))
  if (typeof args.action === 'string') {
    const actionTokens = tokenizeToolName(args.action);
    const actionHasReadonly = actionTokens.some(t => READONLY_VERBS.has(t));
    const actionHasMutating = actionTokens.some(t => MUTATING_VERBS.has(t));
    if (actionHasReadonly && !actionHasMutating) return 'readonly';
    if (actionHasMutating) return 'mutating';
  }

  // Arg-based signals (reinforcing, not gating — default is already mutating)
  // These checks exist for compound tools where the tool name has no verb tokens
  // but the args make the intent clear.
  for (const key of Object.keys(args)) {
    if (MUTATING_ARG_KEYS.has(key.toLowerCase())) return 'mutating';
  }

  // Check SQL content in string args
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && SQL_WRITE_PATTERN.test(val)) return 'mutating';
  }

  // Default: mutating (deny-by-default — unknown tools are presumed to modify state)
  return 'mutating';
}

// =============================================================================
// TARGET EXTRACTION (deep)
// =============================================================================

/**
 * Keys that typically identify the primary target, in priority order.
 * Checked at top level first, then recursively in nested objects.
 */
const TARGET_KEYS = ['path', 'file', 'uri', 'url', 'name', 'key', 'id', 'resource', 'table', 'collection', 'database', 'topic', 'channel', 'queue'];

/**
 * Extract the primary target from tool call arguments.
 *
 * Deep extraction strategy:
 *   1. Check top-level args for known target keys (priority order)
 *   2. Recurse into nested objects (max depth 3) for target keys
 *   3. Extract identifiers from arrays of objects (e.g., entities[0].name)
 *   4. Fall back to first top-level string value
 *   5. Fall back to toolName only as last resort
 *
 * The deeper extraction avoids the "toolName fallback" problem where G2
 * constraints become overly broad (blocking ALL calls to a tool instead
 * of the specific target that failed).
 */
export function extractTarget(toolName: string, args: Record<string, unknown>): string {
  // Layer 1: Top-level known keys (fast path)
  for (const key of TARGET_KEYS) {
    if (typeof args[key] === 'string' && (args[key] as string).length > 0) {
      return args[key] as string;
    }
  }

  // Layer 2: Recurse into nested objects (max depth 3)
  const nested = extractTargetDeep(args, 0);
  if (nested) return nested;

  // Layer 3: Extract identifiers from arrays of objects
  //   e.g., { entities: [{ name: "UserService" }] } → "UserService"
  for (const val of Object.values(args)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      const first = val[0] as Record<string, unknown>;
      for (const key of TARGET_KEYS) {
        if (typeof first[key] === 'string' && (first[key] as string).length > 0) {
          return first[key] as string;
        }
      }
    }
  }

  // Layer 4: First top-level string value
  const firstString = Object.values(args).find(v => typeof v === 'string' && (v as string).length > 0);
  if (typeof firstString === 'string') return firstString;

  // Layer 5: toolName fallback (last resort)
  return toolName;
}

/**
 * Recursively search nested objects for target keys.
 * Max depth 3 to avoid pathological structures.
 */
function extractTargetDeep(obj: Record<string, unknown>, depth: number): string | null {
  if (depth >= 3) return null;

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      // Check target keys in this nested object
      for (const key of TARGET_KEYS) {
        if (typeof nested[key] === 'string' && (nested[key] as string).length > 0) {
          return nested[key] as string;
        }
      }
      // Recurse deeper
      const deeper = extractTargetDeep(nested, depth + 1);
      if (deeper) return deeper;
    }
  }

  return null;
}

/**
 * Map an MCP tool call to a kernel Mutation.
 */
export function toolCallToMutation(toolName: string, args: Record<string, unknown>): Mutation {
  return {
    verb: toolName,
    target: extractTarget(toolName, args),
    capturedAt: Date.now(),
    args,
  };
}

// =============================================================================
// ERROR SIGNATURE NORMALIZATION
// =============================================================================

/**
 * Patterns stripped from error text before signature comparison.
 * Each pattern is replaced with a stable placeholder so that
 * "Entity xyz not found at 2026-03-05T12:00:00Z" and
 * "Entity xyz not found at 2026-03-05T13:00:00Z" produce
 * the same normalized signature.
 */
const NORMALIZATION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // ISO timestamps: 2026-03-05T12:00:00.000Z, 2026-03-05 12:00:00
  { pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, replacement: '<TIMESTAMP>' },
  // Unix timestamps (ms): 1709654400000
  { pattern: /\b\d{13}\b/g, replacement: '<TS_MS>' },
  // Unix timestamps (s): 1709654400
  { pattern: /\b\d{10}\b/g, replacement: '<TS_S>' },
  // UUIDs: 550e8400-e29b-41d4-a716-446655440000
  { pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, replacement: '<UUID>' },
  // IPv4 addresses: 192.168.1.1
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '<IP>' },
  // IPv6 addresses (simplified): ::1, fe80::1
  { pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, replacement: '<IP6>' },
  // Port numbers in context: :3000, :8080, port 5432
  { pattern: /(?<=:)\d{2,5}(?=\b)/g, replacement: '<PORT>' },
  { pattern: /(?<=port\s)\d{2,5}/gi, replacement: '<PORT>' },
  // PIDs: pid=12345, PID 12345, process 12345
  { pattern: /(?<=(?:pid|PID|process)\s?[=: ]?)\d+/g, replacement: '<PID>' },
  // Hex addresses: 0x7fff5fbff8c0
  { pattern: /0x[0-9a-f]{6,16}/gi, replacement: '<ADDR>' },
  // Request IDs, trace IDs (long hex strings): abc123def456...
  { pattern: /\b[0-9a-f]{24,64}\b/gi, replacement: '<HEXID>' },
  // Connection IDs: connection #42, conn=17
  { pattern: /(?<=(?:connection|conn)\s?[#=]?)\d+/gi, replacement: '<CONNID>' },
];

/**
 * Normalize error text by stripping volatile components.
 *
 * "Entity xyz not found at 2026-03-05T12:00:00Z (pid=1234)"
 * → "Entity xyz not found at <TIMESTAMP> (pid=<PID>)"
 *
 * This ensures G2 deduplication matches semantically identical errors
 * that differ only in timestamps, IPs, PIDs, or request IDs.
 */
export function normalizeErrorText(errorText: string): string {
  let result = errorText;
  for (const { pattern, replacement } of NORMALIZATION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// =============================================================================
// FAILURE SEEDING
// =============================================================================

/**
 * Attempt to seed a constraint from a tool call failure.
 *
 * Uses kernel extractSignature() for classified patterns (syntax_error,
 * port_conflict, etc.). Falls back to normalized first-line signature
 * for unclassified errors — every upstream failure seeds a constraint.
 *
 * Error text is normalized before signature extraction to strip volatile
 * components (timestamps, IPs, UUIDs) that would defeat deduplication.
 *
 * Returns null only if an identical constraint already exists (dedup)
 * or the error text is empty.
 */
export function seedFromFailure(
  toolName: string,
  target: string,
  errorText: string,
  existingConstraints: ConstraintEntry[],
): ConstraintEntry | null {
  // Normalize error text to strip volatile components
  const normalized = normalizeErrorText(errorText);

  // Prefer kernel classification (uses raw text — patterns are stable)
  let signature = extractSignature(errorText);
  if (!signature) {
    // Fall back to first line of NORMALIZED text
    const firstLine = normalized.split('\n')[0]?.trim();
    signature = firstLine ? firstLine.slice(0, 100) : undefined;
  }
  if (!signature) return null;

  // Dedup: same tool + same target + same signature
  const exists = existingConstraints.some(
    c => c.toolName === toolName && c.target === target && c.failureSignature === signature,
  );
  if (exists) return null;

  return {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    target,
    failureSignature: signature,
    errorSnippet: errorText.slice(0, 200),
    createdAt: Date.now(),
    ttlMs: 60 * 60 * 1000, // Default: 1 hour
  };
}
