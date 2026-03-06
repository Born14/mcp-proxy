/**
 * Mock Adapter — Key-Value Store Domain
 * ======================================
 *
 * Deterministic test adapter implementing DomainAdapter for a simple
 * key-value store. Proves all seven governance invariants hold for a
 * non-web domain: no CSS, no Docker, no SSH, no SQL.
 *
 * Verbs: set_value (mutate), delete_key (destroy), read_key (read)
 * Predicates: { type: 'kv', fields: { key: 'x' }, operator: '==', value: 'y' }
 * Attribution: deterministic key matching
 * Verification: check if key has expected value
 */

import type {
  DomainAdapter,
  CapabilityManifest,
  Predicate,
  Mutation,
  Evidence,
  MutationAttribution,
  Attribution,
  IdentityMismatch,
  GovernanceConstraint,
  CheckpointManifest,
} from '../types.js';

// =============================================================================
// MOCK STATE — In-memory key-value store
// =============================================================================

/**
 * The mock adapter's internal state.
 * This simulates a real domain's state that gets mutated and verified.
 */
export interface MockState {
  /** The key-value store */
  store: Map<string, string>;

  /** History of operations for audit */
  history: Array<{
    verb: string;
    key: string;
    value?: string;
    timestamp: number;
  }>;

  /** Whether the "system" is "deployed" (analogous to container running) */
  deployed: boolean;
}

/**
 * Create a fresh mock state.
 */
export function createMockState(initial?: Record<string, string>): MockState {
  const store = new Map<string, string>();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      store.set(k, v);
    }
  }
  return { store, history: [], deployed: false };
}

// =============================================================================
// MOCK ADAPTER — Implements DomainAdapter
// =============================================================================

/**
 * Create a mock adapter backed by the given state.
 *
 * The adapter is deterministic: same inputs always produce same outputs.
 * The state parameter allows tests to control the "real system."
 */
export function createMockAdapter(state: MockState): DomainAdapter {
  const manifest: CapabilityManifest = {
    name: 'mock-kv-store',
    verbs: [
      { name: 'set_value', risk: 'mutate', description: 'Set a key to a value' },
      { name: 'delete_key', risk: 'destroy', description: 'Delete a key' },
      { name: 'read_key', risk: 'read', description: 'Read a key value' },
    ],
    approvalFloor: {
      read: 'auto',
      mutate: 'human',
      destroy: 'human',
    },
    ceilings: {
      maxMutationsPerPlan: 10,
      requiresPredicates: true,
    },
    verificationMode: 'independent',
  };

  return {
    manifest,

    // =========================================================================
    // Gate 1: CLASSIFY
    // =========================================================================
    async classifyGoal(goal: string) {
      const lower = goal.toLowerCase();
      const isRead = lower.includes('read') || lower.includes('get') || lower.includes('check');
      const isDelete = lower.includes('delete') || lower.includes('remove');

      return {
        intent: isRead ? 'observe' : isDelete ? 'operate' : 'operate',
        tier: isRead ? 'atomic' : 'incremental',
        domains: ['kv_store'],
      };
    },

    // =========================================================================
    // Gate 2: GROUND
    // =========================================================================
    async groundInReality(target: string) {
      const context: Record<string, unknown> = {
        keyCount: state.store.size,
        keys: Array.from(state.store.keys()),
        deployed: state.deployed,
      };

      const summary = `KV store has ${state.store.size} key(s): ${Array.from(state.store.keys()).join(', ') || '(empty)'}`;

      return { context, summary };
    },

    // =========================================================================
    // Gate 3: EXTRACT
    // =========================================================================
    async extractPredicates(goal: string, grounding: Record<string, unknown>) {
      // Simple extraction: look for "key = value" patterns in the goal
      const predicates: Predicate[] = [];
      const setPattern = /set\s+(\w+)\s*(?:to|=)\s*"?(\w+)"?/gi;
      let match;
      let idx = 0;

      while ((match = setPattern.exec(goal)) !== null) {
        predicates.push({
          id: `p${idx++}`,
          type: 'kv',
          description: `Key "${match[1]}" should equal "${match[2]}"`,
          fields: { key: match[1] },
          operator: '==',
          value: match[2],
        });
      }

      // Check for delete patterns
      const deletePattern = /delete\s+(\w+)/gi;
      while ((match = deletePattern.exec(goal)) !== null) {
        predicates.push({
          id: `p${idx++}`,
          type: 'kv',
          description: `Key "${match[1]}" should not exist`,
          fields: { key: match[1] },
          operator: 'not_exists',
        });
      }

      return predicates;
    },

    // =========================================================================
    // Gate 3: VALIDATE PREDICATE
    // =========================================================================
    async validatePredicate(predicate: Predicate, evidence: Record<string, unknown>) {
      const key = predicate.fields.key as string;
      const actual = state.store.get(key);

      switch (predicate.operator) {
        case '==':
          return {
            passed: actual === String(predicate.value),
            actual: actual ?? null,
            expected: predicate.value,
          };
        case '!=':
          return {
            passed: actual !== String(predicate.value),
            actual: actual ?? null,
            expected: predicate.value,
          };
        case 'exists':
          return {
            passed: state.store.has(key),
            actual: actual ?? null,
            expected: 'exists',
          };
        case 'not_exists':
          return {
            passed: !state.store.has(key),
            actual: actual ?? null,
            expected: 'not_exists',
          };
        default:
          return {
            passed: false,
            error: `Unsupported operator: ${predicate.operator}`,
          };
      }
    },

    // =========================================================================
    // Gate 4: PLAN (produce mutations)
    // =========================================================================
    async produceMutations(goal, predicates, constraints, context) {
      const mutations: Mutation[] = [];
      const now = Date.now();

      for (const p of predicates) {
        const key = p.fields.key as string;

        if (p.operator === '==' && p.value !== undefined) {
          mutations.push({
            verb: 'set_value',
            target: key,
            capturedAt: now,
            args: { key, value: String(p.value) },
          });
        } else if (p.operator === 'not_exists') {
          mutations.push({
            verb: 'delete_key',
            target: key,
            capturedAt: now,
            args: { key },
          });
        }
      }

      return {
        mutations,
        explanation: `Plan: ${mutations.length} mutation(s) to satisfy ${predicates.length} predicate(s)`,
        toolCalls: mutations.length,
      };
    },

    // =========================================================================
    // Gate 5: SYNTAX
    // =========================================================================
    async validateSyntax(mutations: Mutation[]) {
      const errors: Array<{ mutation: number; error: string }> = [];

      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        // Validate verb is known
        if (!['set_value', 'delete_key', 'read_key'].includes(m.verb)) {
          errors.push({ mutation: i, error: `Unknown verb: ${m.verb}` });
        }
        // Validate key is present and non-empty
        const key = m.args.key as string | undefined;
        if (!key || key.length === 0) {
          errors.push({ mutation: i, error: 'Missing or empty key' });
        }
        // Validate set_value has a value
        if (m.verb === 'set_value' && !m.args.value) {
          errors.push({ mutation: i, error: 'set_value requires a value' });
        }
      }

      return { passed: errors.length === 0, errors };
    },

    // =========================================================================
    // Gate 7: CONTAIN (attribution)
    // =========================================================================
    attributeMutation(
      mutation: Mutation,
      predicates: Predicate[],
      evidence: Evidence[],
    ): MutationAttribution {
      const key = mutation.args.key as string | undefined;

      // Fail-closed: if mutation has no key, it cannot be attributed in the KV domain
      if (key == null || key === '') {
        return {
          index: 0,
          verb: mutation.verb,
          target: mutation.target,
          attribution: 'unexplained' as Attribution,
          reason: `Mutation verb "${mutation.verb}" has no key — cannot attribute in KV domain`,
        };
      }

      // Find a predicate that references the same key
      for (const p of predicates) {
        const predicateKey = p.fields.key as string | undefined;
        // Both sides must have a non-empty key for a direct match
        if (predicateKey != null && predicateKey !== '' && predicateKey === key) {
          return {
            index: 0, // Will be set by kernel orchestration
            verb: mutation.verb,
            target: mutation.target,
            attribution: 'direct' as Attribution,
            predicateId: p.id,
            reason: `Mutation targets key "${key}" which matches predicate ${p.id}`,
          };
        }
      }

      // Check if this is scaffolding (e.g., reading a key before setting it)
      if (mutation.verb === 'read_key') {
        return {
          index: 0,
          verb: mutation.verb,
          target: mutation.target,
          attribution: 'scaffolding' as Attribution,
          reason: `Read operation supporting plan execution`,
        };
      }

      // Unexplained — no predicate covers this mutation
      return {
        index: 0,
        verb: mutation.verb,
        target: mutation.target,
        attribution: 'unexplained' as Attribution,
        reason: `No predicate references key "${key}"`,
      };
    },

    // =========================================================================
    // Gate 7: IDENTITY BINDING
    // =========================================================================
    checkIdentityBinding(mutations: Mutation[], evidence: Evidence[]): IdentityMismatch[] {
      const mismatches: IdentityMismatch[] = [];

      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.verb !== 'delete_key' && m.verb !== 'set_value') continue;

        const key = m.args.key as string;
        // Check if we observed this key in evidence
        const observed = evidence.find(e =>
          e.data.key === key || (e.data.keys as string[] || []).includes(key)
        );

        if (!observed && evidence.length > 0) {
          mismatches.push({
            index: i,
            observedValue: '(not observed)',
            mutationValue: key,
            verb: m.verb,
            detail: `Mutation targets key "${key}" but no evidence shows this key was observed`,
          });
        }
      }

      return mismatches;
    },

    // =========================================================================
    // Gate 9: STAGE
    // =========================================================================
    async stage(mutations: Mutation[], predicates: Predicate[]) {
      // Simulate staging by validating mutations against a copy of state
      const stagingStore = new Map(state.store);

      for (const m of mutations) {
        const key = m.args.key as string;
        if (m.verb === 'set_value') {
          stagingStore.set(key, m.args.value as string);
        } else if (m.verb === 'delete_key') {
          stagingStore.delete(key);
        }
      }

      // Verify predicates against staging state
      for (const p of predicates) {
        const key = p.fields.key as string;
        const actual = stagingStore.get(key);

        if (p.operator === '==' && actual !== String(p.value)) {
          return {
            passed: false,
            error: `Staging: key "${key}" = "${actual}", expected "${p.value}"`,
          };
        }
        if (p.operator === 'not_exists' && stagingStore.has(key)) {
          return {
            passed: false,
            error: `Staging: key "${key}" still exists, expected deletion`,
          };
        }
      }

      return { passed: true };
    },

    // =========================================================================
    // Gate 10: EXECUTE
    // =========================================================================
    async execute(mutations: Mutation[]) {
      try {
        for (const m of mutations) {
          const key = m.args.key as string;
          if (m.verb === 'set_value') {
            state.store.set(key, m.args.value as string);
            state.history.push({ verb: 'set_value', key, value: m.args.value as string, timestamp: Date.now() });
          } else if (m.verb === 'delete_key') {
            state.store.delete(key);
            state.history.push({ verb: 'delete_key', key, timestamp: Date.now() });
          }
        }
        state.deployed = true;
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // =========================================================================
    // Gate 11: VERIFY
    // =========================================================================
    async verify(predicates: Predicate[]) {
      const results: Array<{
        predicateId: string;
        passed: boolean;
        actual?: string | number | null;
        expected?: string | number;
      }> = [];

      for (const p of predicates) {
        const key = p.fields.key as string;
        const actual = state.store.get(key);

        switch (p.operator) {
          case '==':
            results.push({
              predicateId: p.id,
              passed: actual === String(p.value),
              actual: actual ?? null,
              expected: p.value,
            });
            break;
          case 'not_exists':
            results.push({
              predicateId: p.id,
              passed: !state.store.has(key),
              actual: actual ?? null,
              expected: undefined,
            });
            break;
          default:
            results.push({
              predicateId: p.id,
              passed: false,
              actual: actual ?? null,
              expected: p.value,
            });
        }
      }

      return results;
    },

    // =========================================================================
    // Gate 12: ATTEST (state capture)
    // =========================================================================
    async captureState(target: string) {
      // Hash the entire store deterministically
      const entries = Array.from(state.store.entries()).sort(([a], [b]) => a.localeCompare(b));
      const content = entries.map(([k, v]) => `${k}=${v}`).join('\n');

      // Simple hash using string length + content (real adapter would use SHA-256)
      const contentHashes: Record<string, string> = {
        'kv_store': `hash_${content.length}_${entries.length}`,
      };

      return { contentHashes };
    },

    // =========================================================================
    // TIME TRAVEL (state restore)
    // =========================================================================
    async restoreState(target: string, manifest: CheckpointManifest) {
      // Mock restore: clear state and mark as not deployed
      state.store.clear();
      state.deployed = false;
      state.history.push({ verb: 'restore', key: manifest.checkpointId, timestamp: Date.now() });
      return { success: true };
    },

    // =========================================================================
    // RISK CLASSIFICATION
    // =========================================================================
    classifyRisk(mutations: Mutation[]): string {
      const hasDestroy = mutations.some(m => m.verb === 'delete_key');
      const hasMutate = mutations.some(m => m.verb === 'set_value');

      if (hasDestroy) return 'schema'; // Destructive = high risk
      if (hasMutate) return 'logic';   // Mutative = medium risk
      return 'ui';                      // Read-only = low risk
    },

    // =========================================================================
    // ACTION CLASSIFICATION — Strategy classification for G2 constraint seeding
    // =========================================================================
    classifyAction(mutations: Mutation[]): string | undefined {
      if (mutations.length === 0) return undefined;

      // Bulk delete = destructive strategy
      const deleteCount = mutations.filter(m => m.verb === 'delete_key').length;
      if (deleteCount >= 3) return 'bulk_delete';

      // Bulk overwrite = rewrite strategy
      const setCount = mutations.filter(m => m.verb === 'set_value').length;
      if (setCount >= 5) return 'bulk_overwrite';

      // Single delete = targeted destruction
      if (deleteCount > 0) return 'targeted_delete';

      return undefined;
    },
  };
}
