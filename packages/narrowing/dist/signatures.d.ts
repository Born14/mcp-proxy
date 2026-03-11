/**
 * Signature Extraction — Deterministic failure classification.
 *
 * Every failure gets a canonical signature via regex matching.
 * The adapter provides domain-specific patterns. This module provides
 * the matching engine and a base set of universal patterns.
 *
 * Priority order: first match wins. Adapter patterns checked first,
 * then universal fallbacks.
 *
 * Extracted from: src/lib/services/memory.ts (extractSignature, SIGNATURE_PATTERNS)
 */
import type { DomainAdapter, SignaturePattern } from './types.js';
export declare const UNIVERSAL_PATTERNS: SignaturePattern[];
/**
 * Extract a failure signature from an error string.
 *
 * Resolution order:
 * 1. Adapter-specific patterns (first match wins)
 * 2. Universal patterns (infrastructure failures)
 * 3. undefined (unrecognized)
 *
 * Pure function — deterministic, no side effects.
 */
export declare function extractSignature(error: string, adapter?: DomainAdapter): string | undefined;
/**
 * Get all registered patterns (adapter + universal).
 * Useful for documentation, testing, and introspection.
 */
export declare function getAllPatterns(adapter?: DomainAdapter): SignaturePattern[];
//# sourceMappingURL=signatures.d.ts.map