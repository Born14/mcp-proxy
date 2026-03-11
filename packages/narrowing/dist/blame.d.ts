/**
 * Blame Classification — Who's at fault?
 *
 * The critical gate between "the agent tried something wrong" and
 * "the infrastructure broke." Infrastructure faults NEVER seed constraints.
 * Without this, the learning system poisons itself.
 *
 * The adapter provides domain-specific blame rules. This module provides
 * the classification engine and universal infrastructure patterns.
 *
 * Extracted from: src/lib/services/memory.ts (classifyFailureKind)
 */
import type { DomainAdapter, FailureKind } from './types.js';
/**
 * Classify a failure as infrastructure vs agent error.
 *
 * Resolution order:
 * 1. Adapter-specific classification (domain knowledge)
 * 2. Universal infrastructure patterns
 * 3. Universal agent patterns
 * 4. 'unknown' (can't tell)
 *
 * Pure function — deterministic, no side effects.
 */
export declare function classifyBlame(error: string, adapter?: DomainAdapter, context?: Record<string, unknown>): FailureKind;
//# sourceMappingURL=blame.d.ts.map