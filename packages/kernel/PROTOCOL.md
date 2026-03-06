# Sovereign Governance Protocol Stack

One-page reference for how the governance kernel relates to the agent harness, adapters, and the MCP proxy.

## Three Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  @sovereign-labs/kernel                                               │
│  Pure functions. Zero domain imports. Constitutional law.        │
│                                                                  │
│  11 Invariants:                                                  │
│    G1 Honesty          G6 Scope Boundedness                      │
│    G2 Non-Repetition   G7 Epistemic Grounding                    │
│    G3 Entropy          G8 Convergence Monotonicity                │
│    G4 Time Travel      G9 Deterministic Evidence                  │
│    G5 Containment      E-H7 Identity  E-H8 Temporal              │
│                                                                  │
│  16-Gate Execution Spine:                                        │
│    classify → grounding → ground → extract → plan → syntax →     │
│    constrain → scope → contain → approve →                       │
│    stage → execute → verify → evidence → converge → attest       │
│                                                                  │
│  Receipts: tamper-evident hash-chained audit trail               │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                    imports from (pure)
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Agent Harness                                                   │
│  OODA loop, tool calling, LLM routing, context management.       │
│                                                                  │
│  Responsibilities:                                               │
│    - Orchestrate the 16-gate sequence                            │
│    - Route LLM calls through brain router (jurisdiction)         │
│    - Manage operational memory (K5 constraints, patterns)        │
│    - Thread authority context through execution                  │
│    - Handle long-horizon feature decomposition (Phase J)         │
│    - Staging pipeline, deployment, verification loops            │
│                                                                  │
│  The harness calls kernel functions at gate boundaries.          │
│  It never reimplements governance logic.                         │
└──────────────────────────────────────────────────────────────────┘
                              ▲
              implements DomainAdapter
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Domain Adapter (e.g., sovereign-web)                            │
│  Domain vocabulary, predicates, mutations, verification.         │
│                                                                  │
│  Responsibilities:                                               │
│    - Classify goals (intent, tier, risk)                         │
│    - Ground claims in observable reality (CSS, HTML, DB, routes) │
│    - Extract testable predicates from goals                      │
│    - Produce mutations (tool loop, edit capture)                 │
│    - Validate syntax, stage, execute, verify                     │
│    - Attribute mutations to predicates (G5 delegate)             │
│    - Capture and restore state (snapshots)                       │
│                                                                  │
│  The adapter knows CSS, Docker, SSH, SQL.                        │
│  The kernel never does.                                          │
└──────────────────────────────────────────────────────────────────┘

## Gate Ownership

```
  Gate          Owner          Invariant
  ──────────    ─────────      ──────────
  classify      Adapter        —
  grounding     Kernel         G7
  ground        Adapter        —
  extract       Adapter        —
  plan          Adapter        —
  syntax        Adapter        —
  constrain     KERNEL         G2
  scope         KERNEL         G6
  contain       KERNEL         G5
  approve       KERNEL         E-H7, E-H8
  stage         Adapter        —
  execute       Adapter        —
  verify        Adapter        —
  evidence      KERNEL         G9
  converge      KERNEL         G8
  attest        Kernel         Receipt
```

## The GateVerdict Contract

Every kernel-owned gate returns:

```typescript
{ action: 'proceed' | 'block' | 'narrow' | 'escalate' | 'invalidate',
  gate: string,
  reason: string }
```

| Action | Meaning | Harness Response |
|--------|---------|-----------------|
| proceed | Gate passed | Continue to next gate |
| block | Hard rejection | Stop execution, record failure |
| narrow | Soft rejection with learning | Seed constraint, retry with smaller space |
| escalate | Needs human judgment | Surface to operator, pause |
| invalidate | Authority expired | Discard plan, re-drain messages, replan |

## Data Flow Through Gates

```
Goal string
  → [classify] → Intent + Tier + Risk
  → [grounding] → GroundingEvidence (coverage ratio)
  → [ground] → Domain evidence (CSS rules, HTML elements, DB schema, routes)
  → [extract] → Predicate[] (testable claims about end-state)
  → [plan] → Mutation[] (captured actions)
  → [syntax] → SyntaxResult (valid/invalid per mutation)
  → [constrain] → ConstraintCheckResult (pass/violate per constraint)
  → [scope] → ScopeAlignment (estimated vs observed blast radius)
  → [contain] → ContainmentResult (direct/scaffolding/unexplained per mutation)
  → [approve] → AuthorityVerdict (identity + temporal check)
  → [stage] → StagingResult (pre-deploy validation)
  → [execute] → ExecutionResult (deployment outcome)
  → [verify] → VerificationResult (post-deploy evidence)
  → [evidence] → EvidenceReliability[] (deterministic/eventual/non_deterministic)
  → [converge] → ConvergenceAnalysis (monotonicity, exhaustion, disagreement)
  → [attest] → ExecutionReceipt (hash-chained audit trail)
```

## MCP Surfaces

Two MCP servers expose governance:

| Server | What | Transport |
|--------|------|-----------|
| `@sovereign-labs/kernel` MCP (mcp-governance.ts) | 8 tools calling kernel pure functions directly | stdio |
| `@sovereign-labs/mcp-proxy` | Governed transport wrapping any upstream MCP server | stdio MITM |

The kernel MCP server proves governance is portable — no daemon, no adapter needed.

The MCP proxy adds structural invariants (G2, E-H7, E-H8, receipts) to any existing MCP tool server as a drop-in stdio wrapper.

## Package Map

```
packages/
  kernel/          @sovereign-labs/kernel       ← You are here
  mcp-proxy/       @sovereign-labs/mcp-proxy    ← Governed MCP transport

src/lib/governance/
  adapters/sovereign-web/                  ← Web deployment adapter (NOT in kernel)
  types.ts                                 ← Proxy re-exports from @sovereign-labs/kernel
  kernel/index.ts                          ← Proxy re-exports from @sovereign-labs/kernel
```

## The Rule

When writing new code, ask: **"Is this governance physics or domain execution?"**

- Governance physics → kernel. Must remain domain-free.
- Domain execution → adapter. Knows CSS, Docker, SSH, SQL, HTML.
- Orchestration → harness. Calls kernel at gate boundaries, delegates domain work to adapter.
