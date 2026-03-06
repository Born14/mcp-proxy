/**
 * .governance/ Directory Persistence
 * ===================================
 *
 * Manages six files:
 *   .lock            — Single-writer enforcement (PID + timestamp, O_EXCL)
 *   controller.json  — E-H7 identity (created once, never changes)
 *   authority.json   — E-H8 epoch (incremented by bump_authority)
 *   constraints.json — G2 failure fingerprints (grows over time)
 *   receipts.jsonl   — Append-only tamper-evident audit trail
 *   intent.json      — Tier 3: declared intent for containment attribution
 *
 * Uses kernel sha256() for hash chaining. Each receipt's hash =
 * sha256(previousHash + canonicalPayload). This makes receipts.jsonl
 * a tamper-evident ledger — any modification breaks the chain downstream.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sha256 } from '@sovereign-labs/kernel';
import type { ControllerState, AuthorityState, ConstraintEntry, ToolCallRecord, IntentContext } from './types.js';

// =============================================================================
// DIRECTORY
// =============================================================================

/**
 * Ensure the .governance/ directory exists.
 */
export function ensureStateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// STATE DIRECTORY LOCK — Single-writer enforcement
// =============================================================================

const LOCK_FILE = '.lock';

/** Stale lock threshold: 30 seconds. MCP servers are spawned by the IDE on
 *  startup — if the previous process is gone, the lock is stale. Short
 *  threshold matches the stdio lifecycle: process dies → IDE restarts → new
 *  proxy spawns within seconds. */
const STALE_LOCK_MS = 30 * 1000;

/**
 * Check if a process is still alive. Uses `kill(pid, 0)` which sends no
 * signal but throws if the process doesn't exist.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class StateDirLockError extends Error {
  constructor(public readonly lockInfo: { pid: number; acquiredAt: number }) {
    super(`stateDir is locked by PID ${lockInfo.pid} (acquired ${new Date(lockInfo.acquiredAt).toISOString()})`);
    this.name = 'StateDirLockError';
  }
}

/** Max retries when lock is held. Each retry waits RETRY_DELAY_MS. */
const LOCK_MAX_RETRIES = 10;
const LOCK_RETRY_DELAY_MS = 200;

/**
 * Acquire exclusive lock on the .governance/ directory.
 *
 * Retry loop with dead-PID detection:
 *   - Dead PID → steal immediately (no wait)
 *   - Live PID → retry up to LOCK_MAX_RETRIES (2 seconds total)
 *   - Still held after retries → throw StateDirLockError
 *
 * This handles the IDE restart race: VS Code kills old proxy and spawns
 * new proxy nearly simultaneously. The old process may still be alive for
 * a few hundred milliseconds during shutdown.
 */
export function acquireLock(dir: string): void {
  const lockPath = join(dir, LOCK_FILE);

  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
    // Check for existing lock
    if (existsSync(lockPath)) {
      const existing = readLockFile(lockPath);
      if (existing) {
        if (!isPidAlive(existing.pid)) {
          // Dead PID → steal immediately
          try { unlinkSync(lockPath); } catch { /* race-safe */ }
        } else if (attempt < LOCK_MAX_RETRIES) {
          // Live PID → wait and retry (process may be shutting down)
          const end = Date.now() + LOCK_RETRY_DELAY_MS;
          while (Date.now() < end) { /* spin */ }
          continue;
        } else {
          // Exhausted retries — genuinely held by another live process
          throw new StateDirLockError(existing);
        }
      }
    }

    // Atomic create: 'wx' flag = O_WRONLY | O_CREAT | O_EXCL
    const lockContent = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      writeFileSync(lockPath, lockContent, { encoding: 'utf-8', flag: 'wx' });
      return; // Success
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Another process won the race — retry
        if (attempt < LOCK_MAX_RETRIES) continue;
        const existing = readLockFile(lockPath);
        throw new StateDirLockError(existing ?? { pid: 0, acquiredAt: Date.now() });
      }
      throw err;
    }
  }
}

/**
 * Release the lock. Only removes if we own it (PID match).
 * Safe to call multiple times (idempotent).
 */
export function releaseLock(dir: string): void {
  const lockPath = join(dir, LOCK_FILE);
  if (!existsSync(lockPath)) return;

  const info = readLockFile(lockPath);
  if (info && info.pid === process.pid) {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Check if a lock is currently held.
 * Returns lock info if held (and not stale), null otherwise.
 */
export function checkLock(dir: string): { pid: number; acquiredAt: number } | null {
  const lockPath = join(dir, LOCK_FILE);
  if (!existsSync(lockPath)) return null;

  const info = readLockFile(lockPath);
  if (!info) return null;

  const age = Date.now() - info.acquiredAt;
  if (age >= STALE_LOCK_MS) return null; // Stale by time
  if (!isPidAlive(info.pid)) return null; // Stale by dead PID

  return info;
}

function readLockFile(lockPath: string): { pid: number; acquiredAt: number } | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

// =============================================================================
// CONTROLLER (E-H7) — Created once, never changes
// =============================================================================

const CONTROLLER_FILE = 'controller.json';

/**
 * Load existing controller or create a new one.
 * The controller ID is a UUID generated once per stateDir.
 */
export function loadOrCreateController(dir: string): ControllerState {
  const path = join(dir, CONTROLLER_FILE);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ControllerState;
    } catch {
      // Corrupted file — delete and regenerate (new identity)
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  const controller: ControllerState = {
    id: randomUUID(),
    establishedAt: Date.now(),
  };

  writeAtomic(path, JSON.stringify(controller, null, 2));
  return controller;
}

// =============================================================================
// AUTHORITY (E-H8) — Epoch incremented by bump_authority
// =============================================================================

const AUTHORITY_FILE = 'authority.json';

/**
 * Load authority state. Returns epoch 0 if file doesn't exist.
 */
export function loadAuthority(dir: string, controllerId: string): AuthorityState {
  const path = join(dir, AUTHORITY_FILE);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as AuthorityState;
    } catch {
      // Corrupted file — delete and reset to epoch 0
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  return {
    controllerId,
    epoch: 0,
    lastBumpedAt: Date.now(),
  };
}

/**
 * Persist authority state atomically.
 */
export function saveAuthority(dir: string, state: AuthorityState): void {
  writeAtomic(join(dir, AUTHORITY_FILE), JSON.stringify(state, null, 2));
}

/**
 * Pin the genesis receipt hash into authority state.
 * Called once when the first receipt is appended to an empty ledger.
 * No-op if genesisHash is already set (idempotent).
 */
export function pinGenesisHash(dir: string, authority: AuthorityState, hash: string): void {
  if (authority.genesisHash) return; // already pinned
  authority.genesisHash = hash;
  saveAuthority(dir, authority);
}

// =============================================================================
// CONSTRAINTS (G2) — Failure fingerprints
// =============================================================================

const CONSTRAINTS_FILE = 'constraints.json';

/**
 * Load all constraints. Returns empty array if file doesn't exist.
 */
export function loadConstraints(dir: string): ConstraintEntry[] {
  const path = join(dir, CONSTRAINTS_FILE);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ConstraintEntry[];
    } catch {
      // Corrupted file — delete and start with empty constraints
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }
  return [];
}

/**
 * Persist constraints atomically.
 */
export function saveConstraints(dir: string, entries: ConstraintEntry[]): void {
  writeAtomic(join(dir, CONSTRAINTS_FILE), JSON.stringify(entries, null, 2));
}

// =============================================================================
// RECEIPTS — Append-only hash-chained JSONL
// =============================================================================

const RECEIPTS_FILE = 'receipts.jsonl';

/**
 * Deterministic JSON serialization with recursively sorted keys.
 * Ensures hash consistency across runtimes regardless of key insertion order.
 */
export function stableStringify(obj: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(obj));
}

/**
 * Recursively sort object keys for deterministic serialization.
 * Arrays are preserved in order (position-sensitive). Primitives pass through.
 */
function sortDeep(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  if (typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return val;
}

/**
 * Compute the hash for a receipt record.
 * hash = sha256(previousHash + canonical payload without the hash field)
 */
export function computeReceiptHash(record: Omit<ToolCallRecord, 'hash'>, previousHash: string): string {
  const payload = stableStringify(record as Record<string, unknown>);
  return sha256(previousHash + payload);
}

/**
 * Append a receipt to the JSONL ledger.
 * Computes the hash chain before appending.
 * Returns the complete record with hash.
 */
export function appendReceipt(dir: string, record: Omit<ToolCallRecord, 'hash'>): ToolCallRecord {
  const hash = computeReceiptHash(record, record.previousHash);
  const complete: ToolCallRecord = { ...record, hash };

  const path = join(dir, RECEIPTS_FILE);
  appendFileSync(path, JSON.stringify(complete) + '\n', 'utf-8');

  return complete;
}

/**
 * Get the hash of the last receipt in the ledger.
 * Returns 'genesis' for an empty file (or missing file).
 */
export function getLastReceiptHash(dir: string): string {
  const path = join(dir, RECEIPTS_FILE);
  if (!existsSync(path)) return 'genesis';

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return 'genesis';

  const lines = content.split('\n');
  // Walk backwards to find the last valid JSON line (handles crash-truncated trailing line)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const record = JSON.parse(lines[i]) as ToolCallRecord;
      return record.hash;
    } catch {
      // Partial/corrupt line from crash — skip and try previous
      continue;
    }
  }
  return 'genesis';
}

/**
 * Get the current receipt count (sequence number for next receipt).
 * Returns 0 for empty/missing file.
 */
export function getReceiptCount(dir: string): number {
  const path = join(dir, RECEIPTS_FILE);
  if (!existsSync(path)) return 0;

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return 0;

  return content.split('\n').length;
}

/**
 * Load all receipts from the JSONL ledger.
 */
export function loadReceipts(dir: string): ToolCallRecord[] {
  const path = join(dir, RECEIPTS_FILE);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];

  const receipts: ToolCallRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      receipts.push(JSON.parse(line) as ToolCallRecord);
    } catch {
      // Partial/corrupt line from crash — skip (chain verification will detect the gap)
      continue;
    }
  }
  return receipts;
}

/**
 * Verify the hash chain integrity of the receipts ledger.
 * Returns { intact: true } or { intact: false, brokenAt: seq }.
 *
 * @param genesisHash - Optional external trust anchor. If provided, the first
 *   receipt's hash must match. This prevents whole-ledger replacement attacks
 *   where an attacker creates a fresh, internally-consistent forged ledger.
 */
export function verifyReceiptChain(
  dir: string,
  genesisHash?: string,
): { intact: boolean; brokenAt?: number; depth: number } {
  const receipts = loadReceipts(dir);
  if (receipts.length === 0) return { intact: true, depth: 0 };

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];

    // Check previousHash linkage
    if (i === 0) {
      if (receipt.previousHash !== 'genesis') {
        return { intact: false, brokenAt: receipt.seq, depth: i };
      }
      // Genesis trust anchor: if provided, first receipt hash must match
      if (genesisHash && receipt.hash !== genesisHash) {
        return { intact: false, brokenAt: receipt.seq, depth: i };
      }
    } else {
      if (receipt.previousHash !== receipts[i - 1].hash) {
        return { intact: false, brokenAt: receipt.seq, depth: i };
      }
    }

    // Recompute hash and verify
    const { hash: _stored, ...withoutHash } = receipt;
    const recomputed = computeReceiptHash(withoutHash as Omit<ToolCallRecord, 'hash'>, receipt.previousHash);
    if (recomputed !== receipt.hash) {
      return { intact: false, brokenAt: receipt.seq, depth: i };
    }
  }

  return { intact: true, depth: receipts.length };
}

// =============================================================================
// INTENT (Tier 3) — Declared intent for containment attribution
// =============================================================================

const INTENT_FILE = 'intent.json';

/** Current intent schema version. Load clears on mismatch. */
const INTENT_VERSION = 1;

/**
 * Save intent atomically to intent.json.
 * Overwrites any existing intent.
 */
export function saveIntent(dir: string, intent: IntentContext): void {
  writeAtomic(join(dir, INTENT_FILE), JSON.stringify(intent, null, 2));
}

/**
 * Load persisted intent from intent.json.
 * Returns null if file doesn't exist or version mismatch.
 * On version mismatch: deletes the stale file and returns null.
 */
export function loadIntent(dir: string): IntentContext | null {
  const path = join(dir, INTENT_FILE);
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data.version !== INTENT_VERSION) {
      // Schema mismatch — clear stale intent
      try { unlinkSync(path); } catch { /* already gone */ }
      return null;
    }
    return data as IntentContext;
  } catch {
    // Corrupted file — clear it
    try { unlinkSync(path); } catch { /* already gone */ }
    return null;
  }
}

/**
 * Delete intent.json. Idempotent.
 */
export function clearIntent(dir: string): void {
  const path = join(dir, INTENT_FILE);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Compute a hash of the current intent context for tamper detection.
 * Returns sha256(stableStringify(intent)) or undefined if no intent.
 *
 * Embedded in each receipt so that post-hoc modification of intent.json
 * can be detected — the hash in the receipt won't match the modified intent.
 */
export function computeIntentHash(intent: IntentContext | undefined | null): string | undefined {
  if (!intent) return undefined;
  return sha256(stableStringify(intent as unknown as Record<string, unknown>));
}

// =============================================================================
// ATOMIC WRITES
// =============================================================================

/**
 * Write file atomically via .tmp + rename.
 * Crash during write leaves no partial file.
 */
function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}
