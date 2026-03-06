# @sovereign-labs/kernel

Eleven domain-agnostic governance invariants for autonomous agents. Each invariant was discovered from a real production failure, proven by constitutional tests, and extracted as pure functions with zero domain imports. The kernel governs. The agent executes. The adapter translates.

## Quick Start

```typescript
import {
  buildHonestyVerdict,
  gateConstrain,
  gateContain,
  gateApprove,
  gateScope,
  gateGrounding,
  gateEvidence,
  gateConvergence,
  validateAuthority,
  computeManifestHash,
  verifyChain,
  GATE_ORDER,
} from '@sovereign-labs/kernel';
import { createMockAdapter, createMockState } from '@sovereign-labs/kernel/mock';

// G1: Honesty — cannot declare success when reality disagrees
const verdict = buildHonestyVerdict(
  [{ name: 'color check', passed: false, severity: 'critical', detail: 'expected blue, got red' }],
  0, 1,  // 0 passed, 1 total
);
console.log(verdict.passed);   // false — reality wins
console.log(verdict.category); // 'evidence_contradicts'

// G6: Scope Boundedness — blast radius must be estimable
const scopeVerdict = gateScope(
  [{ type: 'css', trust: 'browser', cardinality: 1, source: 'staging' }],
  [{ type: 'css', trust: 'browser', cardinality: 1, source: 'postdeploy' }],
);
console.log(scopeVerdict.action);  // 'proceed' — scope aligned

// G7: Epistemic Grounding — claims must reference observable reality
const groundingVerdict = gateGrounding(
  [{ type: 'css', grounded: true }, { type: 'html', grounded: false }],
  { minGroundedRatio: 0.5 },
);
console.log(groundingVerdict.action);  // 'proceed' — 50% grounded meets threshold

// G9: Deterministic Evidence — only reliable evidence can cause rollback
const evidenceVerdict = gateEvidence(
  [{ source: 'browser', stability: 'deterministic', timestamp: Date.now() }],
);
console.log(evidenceVerdict.action);  // 'proceed' — all evidence is deterministic

// E-H8: Temporal Sovereignty — stale plans invalidated
const authVerdict = validateAuthority({
  controllerId: 'ctrl-A',
  authorityEpoch: 5,   // Human sent new message
  planEpoch: 3,         // Plan was made at epoch 3
  isForeign: false,
});
console.log(authVerdict.action);  // 'invalidate' — PLAN_INVALIDATED
```

## The Eleven Invariants

| # | Invariant | What It Prevents | Key Functions |
|---|-----------|-----------------|---------------|
| G1 | Honesty | Declaring success when reality disagrees | `buildHonestyVerdict()`, `deriveFailureCategory()` |
| G2 | Non-Repetition | Repeating strategies that already failed | `extractSignature()`, `checkConstraint()`, `classifyActionClass()` |
| G3 | Entropy Resilience | Partial deploys hiding failures | Snapshot hash verification, contradiction detection |
| G4 | Time Travel | Incomplete rollback (code without data) | `computeManifestHash()`, `verifyChain()` |
| G5 | Containment | Mutations without predicate justification | `attributePlan()`, adapter-delegated attribution |
| G6 | Scope Boundedness | Unbounded blast radius | `gateScope()`, `computeAlignment()`, `evaluateScopeContract()` |
| G7 | Epistemic Grounding | Claims without observable evidence | `gateGrounding()`, `evaluateGroundingCoverage()` |
| G8 | Convergence Monotonicity | Retries that don't narrow the search space | `gateConvergence()`, `verifyMonotonicity()`, `detectExhaustion()` |
| G9 | Deterministic Evidence | Non-deterministic evidence causing rollbacks | `gateEvidence()`, `classifyEvidenceReliability()`, `filterReliableEvidence()` |
| E-H7 | Identity Sovereignty | Foreign controllers hijacking jobs | `assertMutable()`, `isForeignJob()`, `checkIdentity()` |
| E-H8 | Temporal Sovereignty | Stale plans overriding human authority | `validateAuthority()`, `capturePlanEpoch()`, `incrementAuthority()` |

## Stats

- **~2,700 LOC** of pure governance functions
- **360 package tests**, 966 assertions
- **650+ total tests** (with Sovereign integration), 12,500+ assertions
- **Zero domain imports** — no CSS, Docker, SSH, SQL, or filesystem references
- **One external dependency**: `node:crypto` (SHA-256 only)

## Architecture

```
@sovereign-labs/kernel (this package)
├── kernel/          11 invariants as pure functions
├── pure/            Shared heuristics (classification, attribution)
├── adapters/        Mock KV-store adapter (reference implementation)
└── types            Predicate, Mutation, Evidence, DomainAdapter, etc.
```

```
Your Project
├── @sovereign-labs/kernel        ← governance physics (immutable)
├── your-adapter/            ← domain vocabulary (you write this)
└── your-agent/              ← execution loop (your orchestration)
```

## Subpath Exports

```typescript
import { ... } from '@sovereign-labs/kernel';             // All 11 invariants + gate sequence + receipts
import type { Predicate, Mutation, ... } from '@sovereign-labs/kernel/types';  // Boundary types
import { createMockAdapter } from '@sovereign-labs/kernel/mock';               // Reference adapter
import { classifyChangeType, ... } from '@sovereign-labs/kernel/pure';         // Classification heuristics
import { attributeMutationToPredicates, ... } from '@sovereign-labs/kernel/attribution'; // G5 helpers
```

## Gate Sequence

The 16-gate sequence is immutable. No adapter, no LLM, no configuration can change it:

```
classify → grounding → ground → extract → plan → syntax → constrain → scope → contain → approve → stage → execute → verify → evidence → converge → attest
```

| # | Gate | Owner | Purpose |
|---|------|-------|---------|
| 1 | classify | Adapter | Determine intent, tier, risk |
| 2 | grounding | Kernel (G7) | Verify claims reference observable reality |
| 3 | ground | Adapter | Gather domain evidence |
| 4 | extract | Adapter | Extract testable predicates |
| 5 | plan | Adapter | Produce mutations |
| 6 | syntax | Adapter | Validate syntax |
| 7 | constrain | **Kernel (G2)** | Enforce non-repetition constraints |
| 8 | scope | **Kernel (G6)** | Verify blast radius is bounded |
| 9 | contain | **Kernel (G5)** | Attribute mutations to predicates |
| 10 | approve | **Kernel (E-H7/8)** | Authority + trust check |
| 11 | stage | Adapter | Pre-deploy validation |
| 12 | execute | Adapter | Deploy mutations |
| 13 | verify | Adapter | Post-deploy verification |
| 14 | evidence | **Kernel (G9)** | Filter non-deterministic evidence |
| 15 | converge | **Kernel (G8)** | Verify search space narrowed |
| 16 | attest | Kernel | Build execution receipt |

Gates 7-10 and 14-15 are pure governance — the kernel owns them entirely.

## API Reference

### Gate Functions (Kernel-Owned)

```typescript
gateConstrain(surface, constraints, riskClass, overrides?)     // G2: constraint enforcement
gateScope(estimates, observed)                                  // G6: blast radius check
gateGrounding(evidence, config)                                 // G7: epistemic grounding
gateContain(mutations, predicates, evidence, adapter, mode)     // G5: mutation attribution
gateApprove(authority, riskClass, containment, policy)          // E-H7/8: authority check
gateEvidence(records)                                           // G9: evidence reliability
gateConvergence(state, config)                                  // G8: convergence check
```

Every gate returns a `GateVerdict`:
```typescript
type GateVerdict = {
  action: 'proceed' | 'block' | 'narrow' | 'escalate' | 'invalidate';
  gate: string;
  reason: string;
};
```

### G1: Honesty

```typescript
buildHonestyVerdict(signals, predicatesPassed, predicatesTotal)  // Derive pass/fail
deriveFailureCategory(error)                                      // Classify failure type
```

### G2: Non-Repetition

```typescript
extractSignature(error)                                    // Deterministic error signature
checkConstraint(constraint, surface, riskClass)            // Check single constraint
checkAllConstraints(constraints, surface, riskClass)       // Check all constraints
seedConstraint(failure, existing, maxDepth?)                // Auto-seed from failure
extractPlanSurface(mutations, intents?, properties?)        // Plan surface extraction
classifyActionClass(mutations)                              // Strategy classification (heuristic)
buildEvidenceBlock(outcomes, patterns, constraints)         // Format evidence for context
```

### G3: Entropy Resilience

```typescript
scanForErrors(logLines)                      // Detect errors in log output
detectDrift(snapshotHashes, currentHashes)    // Find file-level drift
detectUnrollbackableChanges(changes)          // Flag irreversible mutations
verifyEvidenceChain(chain)                    // Chain completeness + contradiction detection
entropyVerdict(chain, logLines)               // Combined entropy assessment
```

### G4: Time Travel

```typescript
sha256(data)                           // Hash function (node:crypto)
computeManifestHash(manifest)          // Deterministic content hash
verifyChain(manifests)                 // Chain integrity verification
verifyCheckpointChain(manifests, startId?)  // Checkpoint-specific chain check
```

### G5: Containment

```typescript
attributePlan(mutations, predicates, evidence, adapter, mode)  // Full attribution
containmentVerdict(result, mode)                                // → GateVerdict
```

### G6: Scope Boundedness

```typescript
computeAlignment(estimate, observed)          // Compare pre/post scope
computeEffectAlignmentScore(evidence)         // 0.0–1.0 composite score
evaluateScopeContract(evidence, threshold)    // Binary: aligned/deviated/unknown
gateScope(estimates, observed)                // → GateVerdict
```

### G7: Epistemic Grounding

```typescript
evaluateGroundingCoverage(evidence, config)   // Coverage ratio + assessment
gateGrounding(evidence, config)               // → GateVerdict
```

### G8: Convergence Monotonicity

```typescript
createConvergenceState()                              // Initial zeroed state
recordIteration(state, evidence?, emptyPlan?)          // Track iteration
addConstraint(state, constraint)                       // Append constraint
detectExhaustion(state, config)                        // Check if exhausted
detectSemanticDisagreement(history, constraints)        // Divergent evidence
convergenceVerdict(analysis)                           // → proceed/escalate/block
verifyMonotonicity(prev, curr)                         // Single-step check
verifyMonotonicityChain(snapshots)                     // Full chain check
gateConvergence(state, config)                         // → GateVerdict
jaccardSimilarity(setA, setB)                          // Set comparison (0.0–1.0)
```

### G9: Deterministic Evidence

```typescript
classifyEvidenceReliability(record)    // → deterministic/eventual/non_deterministic
filterReliableEvidence(records)        // Drop non-deterministic records
gateEvidence(records)                  // → GateVerdict
```

### E-H7: Identity Sovereignty

```typescript
assertMutable(authority)                        // Boolean guard
isForeignJob(jobController, myController)       // Controller comparison
checkIdentity(authority)                        // → GateVerdict
```

### E-H8: Temporal Sovereignty

```typescript
validateAuthority(authority)        // Epoch comparison → verdict
capturePlanEpoch(authority)         // Snapshot authority at plan time
incrementAuthority(authority)       // Human message → epoch bump
```

### Receipts

```typescript
buildReceipt(jobId, gates, mutations, predicates, verification, authority, containment, start, end)
validateReceipt(receipt)            // Structural validation
summarizeReceipt(receipt, provenance?)  // Human-readable summary
computePolicyHash(policy)           // Deterministic SHA-256
generateReceiptId(jobId, timestamp) // Deterministic ID
```

## Write Your Own Adapter

Implement the `DomainAdapter` interface to bring governance to any domain:

```typescript
import type { DomainAdapter, Mutation, Predicate, Evidence } from '@sovereign-labs/kernel';

const myAdapter: DomainAdapter = {
  manifest: {
    name: 'my-domain',
    verbs: [
      { name: 'create_item', risk: 'mutate', description: 'Create an item' },
      { name: 'delete_item', risk: 'destroy', description: 'Delete an item' },
    ],
    predicateTypes: ['item_exists', 'item_value'],
    verificationMode: 'independent',
    approvalFloor: { read: 'auto', mutate: 'human', destroy: 'human' },
    ceilings: { maxMutationsPerPlan: 20, requiresPredicates: true },
  },

  async classifyGoal(goal) { /* ... */ },
  async groundInReality(target) { /* ... */ },
  async extractPredicates(goal, grounding) { /* ... */ },
  async validatePredicate(predicate, context) { /* ... */ },
  async produceMutations(goal, predicates, constraints, context) { /* ... */ },
  async validateSyntax(mutations) { /* ... */ },
  attributeMutation(mutation, predicates, evidence) { /* ... */ },
  checkIdentityBinding(mutations, evidence) { /* ... */ },
  async stage(mutations, predicates) { /* ... */ },
  async execute(mutations) { /* ... */ },
  async verify(predicates) { /* ... */ },
  async captureState(target) { /* ... */ },
  async restoreState(checkpoint) { /* ... */ },
  classifyRisk(mutations) { /* ... */ },
  classifyAction(mutations) { /* ... */ },
};
```

See `src/adapters/mock-adapter.ts` for a complete reference implementation (~200 LOC).

## Testing Your Adapter

The mock adapter passes the same conformance tests as any production adapter:

```bash
bun test packages/kernel/tests/
```

## Development

This package lives inside the Sovereign monorepo at `packages/kernel/`. The monorepo is the single source of truth.

### Kernel changes are constitutional amendments

Every invariant in this package was discovered from a real production failure. Changes require the same discipline:

1. **Start with "why."** Every change must trace to a real failure or a proven gap. If you can't point to a failing test or a production incident, the change isn't warranted.
2. **Tests travel with the change.** Every modification must include or update tests in `tests/`. A kernel change without a test is incomplete.
3. **Zero domain imports.** The kernel must never import CSS, Docker, SSH, SQL, HTML, or filesystem logic. If your change needs domain knowledge, it belongs in an adapter.
4. **Version on meaningful changes.** Bump `package.json` version to create a paper trail of when the kernel evolved and why — even before npm publishing.
5. **The kernel never bends to a domain's convenience.** If a specific domain needs something, it goes in that domain's adapter. The kernel stays portable.

### Running tests

```bash
# Kernel package tests (360 tests, 966 assertions)
bun test packages/kernel/tests/

# Full governance suite (from Sovereign monorepo root)
bun test packages/kernel/tests/ tests/constitutional/kernel/ tests/adapter-contract/
```

## License

MIT
