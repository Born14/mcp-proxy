# @sovereign-labs/mcp-proxy

**Audit trail + guardrails for AI tool execution.**

A drop-in proxy that records and verifies everything an AI agent does through MCP.

## The Problem

[MCP](https://modelcontextprotocol.io) lets AI agents call tools — filesystems, databases, APIs. But nothing records what they did.

```
Agent runs:
  write_file("/app/config.json", content)    → Permission denied
  write_file("/app/config.json", content)    → Permission denied
  write_file("/app/config.json", content)    → Permission denied
  ...
  write_file("/app/config.json", content)    → Permission denied    x 37

No audit trail.  No failure memory.  No way to prove what happened.
```

After a session, you can't answer basic questions:

- What did the agent actually do?
- Did it repeat the same mistake?
- Who authorized that action?
- Was the audit trail modified after the fact?

## With This Proxy

```
  write_file("/app/config.json", content)    → Permission denied
  ↳ constraint learned: write_file + /app/config.json + permission_denied

  write_file("/app/config.json", content)    → BLOCKED (known failure)
  write_file("/app/data.json", content)      → success (different target, allowed)
```

```
  SESSION SUMMARY
  ═══════════════════════════════════════

  receipts:          47
  duration:          12.3m
  chain integrity:   ✓ verified

  mutations:         12
  readonly:          35
  blocked:           1
  errors:            3
  succeeded:         43

  constraints:       3 (2 active)

  tools:
    read_file                        18
    write_file                       9
    list_directory                   8
    ...

  last hash:         8c1a7d3b4e2f...
  state dir:         .governance/
```

Every call receipted. Failures remembered. Chain verifiable.

## Quick Start

```bash
npx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

That's it. The proxy wraps your MCP server. Your agent talks to the proxy, the proxy talks to the server.

After a session:

```bash
npx @sovereign-labs/mcp-proxy --receipts          # what happened
npx @sovereign-labs/mcp-proxy --verify            # was the audit trail tampered with
```

## What It Does

```
Agent (Claude, GPT, etc.)
  ↓ stdio
@sovereign-labs/mcp-proxy
  ├─ Record: tamper-evident receipt for every call
  ├─ Learn:  failures seed constraints (don't repeat mistakes)
  ├─ Guard:  block calls that match known failures
  ├─ Track:  controller identity + authority epoch
  ├─ Detect: convergence failures (agent stuck in loops)
  ↓ stdio
Your MCP Server (filesystem, database, anything)
```

No changes to your agent. No changes to your MCP server. Drop-in.

## Three Guarantees

1. **Receipts** — Every tool call produces a hash-chained record. Like git commits for tool execution. Tamper with one receipt and the chain breaks.

2. **Constraints** — When a tool call fails, the proxy fingerprints the failure and blocks identical calls within a TTL window. The agent can't repeat the same mistake.

3. **Authority** — A stable controller ID and monotonic epoch counter. You can prove which controller was active and whether authority was still valid when a call was made.

## Use with Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "governed-filesystem": {
      "command": "npx",
      "args": [
        "@sovereign-labs/mcp-proxy",
        "--upstream", "npx -y @modelcontextprotocol/server-filesystem /tmp"
      ]
    }
  }
}
```

## Enforcement Modes

| Mode | On violation | Receipts |
|------|-------------|----------|
| `strict` (default) | Block the call, return error | Always |
| `advisory` | Log + forward anyway | Always |

Start with advisory to see what the proxy catches without blocking anything:

```bash
npx @sovereign-labs/mcp-proxy --enforcement advisory --upstream "your-server"
```

## What Gets Recorded

Every receipt contains:

| Field | What it means |
|-------|---------------|
| `hash` / `previousHash` | SHA-256 chain — tamper-evident |
| `toolName` / `arguments` | What was called |
| `target` | Primary resource (file path, API endpoint, etc.) |
| `mutationType` | `mutating` or `readonly` (heuristic) |
| `outcome` | `success`, `error`, or `blocked` |
| `constraintCheck` | Did this match a known failure? |
| `authorityCheck` | Was the authority epoch valid? |
| `controllerId` | Which controller made this call |
| `convergenceSignal` | Is the agent stuck? (`none`, `warning`, `exhausted`, `loop`) |

## Governance Tools

The proxy injects 5 tools into the upstream's tool list (the agent can call them):

| Tool | What it does |
|------|-------------|
| `governance_status` | Inspect: controller ID, epoch, constraint count, receipt count |
| `governance_bump_authority` | Advance the authority epoch (invalidates stale sessions) |
| `governance_declare_intent` | Declare goal + predicates for containment attribution |
| `governance_clear_intent` | Clear declared intent |
| `governance_convergence_status` | Inspect failure signatures and loop detection state |

## State Directory

All state persists in `.governance/` (or `--state-dir <path>`):

| File | What it stores |
|------|---------------|
| `receipts.jsonl` | Append-only hash-chained audit trail |
| `constraints.json` | Failure fingerprints that block repeat calls |
| `controller.json` | Stable controller UUID |
| `authority.json` | Authority epoch + session binding |
| `intent.json` | Declared intent for containment attribution |

## CLI Reference

```bash
# Proxy mode — wrap an MCP server
npx @sovereign-labs/mcp-proxy --upstream "command"
npx @sovereign-labs/mcp-proxy --upstream "command" --enforcement advisory
npx @sovereign-labs/mcp-proxy --upstream "command" --state-dir ./my-state
npx @sovereign-labs/mcp-proxy --upstream "command" --timeout 60000

# Inspection — read governance state (offline, no proxy needed)
npx @sovereign-labs/mcp-proxy --receipts
npx @sovereign-labs/mcp-proxy --receipts --state-dir ./my-state
npx @sovereign-labs/mcp-proxy --verify
```

## Programmatic API

```typescript
import { createGovernedProxy, startProxy } from '@sovereign-labs/mcp-proxy';

// Quick start
await startProxy({
  upstream: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
  stateDir: '.governance',
  enforcement: 'strict',
});

// Or get a handle for lifecycle control
const proxy = createGovernedProxy({ upstream: '...', stateDir: '.governance' });
await proxy.start();
const state = proxy.getState(); // inspect live state
await proxy.stop();
```

## How Constraint Learning Works

```
1. Agent calls write_file({ path: "/app/config.json", content: "..." })
2. Upstream returns error: "Permission denied"
3. Proxy fingerprints: tool=write_file, target=/app/config.json, sig=permission_denied
4. Constraint stored with 1-hour TTL
5. Agent tries same call again → BLOCKED (strict mode) or annotated (advisory)
6. Agent tries write_file on a DIFFERENT path → allowed (constraint is target-specific)
```

Constraints are scoped to tool + target. A failure writing to `/app/config.json` doesn't block writing to `/app/data.json`.

## Requirements

- **Bun** >= 1.0 (for `bunx`) or **Node.js** >= 18 (for `npx`)
- Any MCP-compatible tool server as upstream

## License

MIT
