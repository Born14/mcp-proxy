/**
 * Loop Detection — Frequency-based Error Loop Detector
 * =====================================================
 *
 * Complementary to Tier 5 convergence (which keys on tool:target repetition).
 * Loop detection keys on tool + target + errorCategory — detecting when the
 * agent repeatedly hits the SAME kind of error on the SAME target.
 *
 * Configurable threshold (default: 3 identical error patterns in 5 minutes).
 * Independent from G2 constraints (which block exact tool+target retries).
 *
 * The distinction:
 *   G2 says: "don't retry this exact tool+target within TTL"
 *   Loop says: "you've hit the same error category 3 times — something is structurally wrong"
 *   Convergence says: "you've called this tool 5 times in 2 minutes — you're spinning"
 */

import { normalizeErrorText } from './fingerprint.js';
import { extractSignature } from '@sovereign-labs/kernel';

export interface LoopDetectorConfig {
  /** Number of same-pattern errors before triggering. Default: 3 */
  threshold: number;

  /** Rolling window in ms. Default: 300000 (5 minutes) */
  windowMs: number;
}

export interface LoopEntry {
  /** When this error occurred */
  timestamp: number;

  /** Error category (from kernel extractSignature or normalized first line) */
  errorCategory: string;
}

export interface LoopDetector {
  /** tool:target:category → timestamps */
  entries: Map<string, number[]>;

  /** Config */
  config: LoopDetectorConfig;
}

export interface LoopCheckResult {
  /** Whether a loop was detected */
  loopDetected: boolean;

  /** If detected: the loop key and count */
  key?: string;
  count?: number;
  category?: string;

  /** Human-readable reason */
  reason?: string;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  threshold: 3,
  windowMs: 5 * 60 * 1000,
};

/**
 * Create a fresh loop detector.
 */
export function createLoopDetector(config?: Partial<LoopDetectorConfig>): LoopDetector {
  return {
    entries: new Map(),
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

/**
 * Classify an error into a category.
 * Uses kernel extractSignature() for known patterns, falls back to normalized first line.
 */
export function classifyError(errorText: string): string {
  if (!errorText) return 'unknown';

  // Try kernel signature first
  const sig = extractSignature(errorText);
  if (sig) return sig;

  // Fall back to normalized first line (stable across volatile components)
  const normalized = normalizeErrorText(errorText);
  const firstLine = normalized.split('\n')[0]?.trim();
  return firstLine ? firstLine.slice(0, 80) : 'unknown';
}

/**
 * Record an error and check for loop patterns.
 *
 * Call this AFTER an upstream error is received. Returns whether a loop
 * was detected (same tool + target + error category repeated >= threshold
 * times within the rolling window).
 */
export function recordAndCheck(
  detector: LoopDetector,
  toolName: string,
  target: string,
  errorText: string,
  now: number = Date.now(),
): LoopCheckResult {
  const category = classifyError(errorText);
  const key = `${toolName}:${target}:${category}`;
  const { threshold, windowMs } = detector.config;

  // Get or create entry
  const timestamps = detector.entries.get(key) ?? [];
  timestamps.push(now);

  // Prune entries outside the rolling window
  const cutoff = now - windowMs;
  const recent = timestamps.filter(t => t >= cutoff);
  detector.entries.set(key, recent);

  if (recent.length >= threshold) {
    return {
      loopDetected: true,
      key,
      count: recent.length,
      category,
      reason: `LOOP DETECTED: "${toolName}" on "${target}" failed with "${category}" ${recent.length} times in ${Math.round(windowMs / 60000)}min window`,
    };
  }

  return { loopDetected: false };
}

/**
 * Get loop statistics for the exit summary.
 */
export function getLoopStats(detector: LoopDetector): {
  activeLoops: number;
  totalTrackedPatterns: number;
} {
  let activeLoops = 0;
  const { threshold, windowMs } = detector.config;
  const now = Date.now();
  const cutoff = now - windowMs;

  for (const timestamps of detector.entries.values()) {
    const recent = timestamps.filter(t => t >= cutoff);
    if (recent.length >= threshold) activeLoops++;
  }

  return {
    activeLoops,
    totalTrackedPatterns: detector.entries.size,
  };
}
