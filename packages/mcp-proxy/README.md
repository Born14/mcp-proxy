# @sovereign-labs/mcp-proxy

**See what your agent did. Verify nobody tampered with the record. Stop broken retries.**

A drop-in governance proxy for any MCP tool server. One command to add tamper-evident receipts, failure memory, and authority tracking.

## See It In Action (1 command)

```bash
npx @sovereign-labs/mcp-proxy --demo
```

No config. No server. Watch governance happen: receipts, failure memory, automatic blocking, hash chain verification — all in 5 seconds.

## The Trust Demo (4 commands)

```bash
# 1. Govern your filesystem server
npx @sovereign-labs/mcp-proxy --wrap filesystem

# 2. Use Claude Code normally — every tool call is now receipted

# 3. See what happened (plain English)
npx @sovereign-labs/mcp-proxy --explain --state-dir .governance-filesystem

# 4. Verify the record is intact
npx @sovereign-labs/mcp-proxy --verify --state-dir .governance-filesystem
```

That's it. Your agent doesn't know the proxy exists. Your MCP server doesn't know either. But now you have proof.

Step 3 gives you a plain-English summary of what the agent did. Use `--view` instead for the full per-receipt timeline.

## The Problem

[MCP](https://modelcontextprotocol.io) lets AI agents call tools — filesystems, databases, APIs. But nothing records what they did.

```
Agent runs:
  write_file("/app/config.json", content)    -> Permission denied
  write_file("/app/config.json", content)    -> Permission denied
  write_file("/app/config.json", content)    -> Permission denied
  ...
  write_file("/app/config.json", content)    -> Permission denied    x 37

No audit trail.  No failure memory.  No way to prove what happened.
```

After a session, you can't answer basic questions:

- What did the agent actually do?
- Did it repeat the same mistake?
- Who authorized that action?
- Was the audit trail modified after the fact?

## What You Get

```
Agent (Claude, GPT, etc.)
  | stdio
@sovereign-labs/mcp-proxy
  |-- Record: tamper-evident receipt for every call
  |-- Learn:  failures seed constraints (don't repeat mistakes)
  |-- Guard:  block calls that match known failures
  |-- Track:  controller identity + authority epoch
  | stdio
Your MCP Server (filesystem, database, anything)
```

No changes to your agent. No changes to your MCP server. Drop-in.

### Three Guarantees

1. **Receipts** — Every tool call produces a hash-chained record. Like git commits for tool execution. Tamper with one receipt and the chain breaks.

2. **Constraints** — When a tool call fails, the proxy fingerprints the failure and blocks identical calls within a TTL window. Your agent can't repeat the same mistake.

3. **Authority** — A stable controller ID and monotonic epoch counter. You can prove which controller was active and whether authority was still valid when a call was made.

## Quick Start

### Option A: Wrap an existing server (recommended)

If you already have MCP servers in `.mcp.json`:

```bash
npx @sovereign-labs/mcp-proxy --wrap filesystem
```

Done. Restart your MCP client. To remove governance later:

```bash
npx @sovereign-labs/mcp-proxy --unwrap filesystem
```

Receipts are preserved even after unwrapping.

### Option B: Direct proxy mode

```bash
npx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

### Option C: Manual .mcp.json

```json
{
  "mcpServers": {
    "governed-filesystem": {
      "command": "npx",
      "args": [
        "-y", "@sovereign-labs/mcp-proxy",
        "--upstream", "npx -y @modelcontextprotocol/server-filesystem /tmp"
      ]
    }
  }
}
```

## CLI Reference

```bash
# Setup
npx @sovereign-labs/mcp-proxy --wrap <server>     # Govern an existing MCP server
npx @sovereign-labs/mcp-proxy --unwrap <server>   # Restore original config

# Try it
npx @sovereign-labs/mcp-proxy --demo              # Interactive demo (no config needed)

# Inspection (offline, no proxy needed)
npx @sovereign-labs/mcp-proxy --view              # Per-receipt timeline
npx @sovereign-labs/mcp-proxy --view --tool write  # Filter by tool name
npx @sovereign-labs/mcp-proxy --view --outcome error  # Show only failures
npx @sovereign-labs/mcp-proxy --receipts          # Session summary
npx @sovereign-labs/mcp-proxy --verify            # Tamper detection
npx @sovereign-labs/mcp-proxy --explain           # Plain-English summary

# Explain with LLM enhancement (optional — any provider)
npx @sovereign-labs/mcp-proxy --explain --llm openai --api-key sk-...
npx @sovereign-labs/mcp-proxy --explain --llm anthropic --api-key sk-ant-...
npx @sovereign-labs/mcp-proxy --explain --llm gemini --api-key AIza...
npx @sovereign-labs/mcp-proxy --explain --llm ollama              # localhost
npx @sovereign-labs/mcp-proxy --explain --llm ollama --model llama3.2

# Proxy mode
npx @sovereign-labs/mcp-proxy --upstream "command"
npx @sovereign-labs/mcp-proxy --upstream "command" --enforcement advisory
npx @sovereign-labs/mcp-proxy --upstream "command" --state-dir ./my-state
```

## What --view Shows

```
  RECEIPT LEDGER
  ===============================================================
  controller:  311036af...
  integrity:   verified
  showing:     10 receipts
  ---------------------------------------------------------------

  ok #  1  2026-03-06 14:22:03    42ms  read_file
           target: /tmp/config.json
           hash: 8c1a7d3b4e2f9a01...

  ok #  2  2026-03-06 14:22:04   103ms  write_file [MUTATION]
           target: /tmp/config.json
           hash: 3f7b2c1d8e4a6509...

  !! #  3  2026-03-06 14:22:05    38ms  write_file [MUTATION]
           target: /tmp/secret.key
           error: Permission denied
           hash: 9d2e4f6a1b3c7508...

  -- #  4  2026-03-06 14:22:05     1ms  write_file [MUTATION]
           target: /tmp/secret.key
           blocked by: write_file+/tmp/secret.key (known failure)
           hash: 5a8b3c2d1e4f7609...

  ---------------------------------------------------------------
  4 receipts  |  3 mutations  |  1 blocked  |  1 errors
```

## What --verify Shows

```
  CHAIN VERIFICATION
  ===============================================================

  receipts:          47
  chain depth:       47
  integrity:         all hashes verified
  controller:        311036af...
  first hash:        a8ba7720...
  last hash:         e8aa80ef...
```

If anyone modifies a receipt after the fact:

```
  integrity:         TAMPERED at seq 23

  The receipt chain has been tampered with or corrupted.
  The break was detected at sequence number 23.
```

## What --explain Shows

A plain-English summary of what the agent did, generated from receipt data — no LLM required.

```
  WHAT HAPPENED
  ───────────────────────────────────────────────────────────────

  Purpose:      Attempt operation (with failure prevention)

  The agent examined several resources to understand the current
  state. It made changes across 3 resources, primarily the
  configuration file, the server code and a source file. It
  encountered errors accessing a sensitive file (was denied
  access). The proxy blocked 1 repeated operation to prevent
  wasted retries.

  Impact:       5 reads  ·  3 changes  ·  1 blocked  ·  1 error

  Bottom line:  One operation failed, and the proxy blocked 1
                retry to prevent repeating the same mistake.

  This summary was generated from verifiable execution receipts.
  Run --verify to confirm the record has not been altered.
```

For large sessions (hundreds of calls), it automatically switches to aggregate mode:

```
  Purpose:      Update configuration and apply changes

  The agent examined many resources to understand the current
  state. It made changes across 20 resources, primarily the
  football, the clear and the message. It restarted services
  so changes would take effect. It encountered 13 errors
  across 4 resources.

  Impact:       799 reads  ·  73 changes  ·  13 errors

  Bottom line:  859 operations succeeded, but 13 operations failed.
```

### LLM Enhancement (optional)

Pass `--llm` to get a richer narrative from your own LLM provider. The heuristic summary always works as a fallback.

```bash
npx @sovereign-labs/mcp-proxy --explain --llm openai --api-key sk-...
npx @sovereign-labs/mcp-proxy --explain --llm anthropic --api-key sk-ant-...
npx @sovereign-labs/mcp-proxy --explain --llm gemini --api-key AIza...
npx @sovereign-labs/mcp-proxy --explain --llm ollama
```

The LLM receives a compressed summary of receipts (not raw data) and produces a narrative. If the LLM call fails, the heuristic output is shown instead. No dependencies — just HTTP calls.

## Enforcement Modes

| Mode | On constraint violation | Receipts |
|------|----------------------|----------|
| `strict` (default) | Block the call | Always |
| `advisory` | Log + forward anyway | Always |

Start with advisory to see what the proxy catches without blocking:

```bash
npx @sovereign-labs/mcp-proxy --wrap filesystem --enforcement advisory
```

## How Constraint Learning Works

```
1. Agent calls write_file({ path: "/app/config.json", content: "..." })
2. Upstream returns error: "Permission denied"
3. Proxy fingerprints: tool=write_file, target=/app/config.json, sig=permission_denied
4. Constraint stored with 1-hour TTL
5. Agent tries same call again -> BLOCKED (strict) or annotated (advisory)
6. Agent tries write_file on a DIFFERENT path -> allowed (target-specific)
```

## Governance Meta-Tools

The proxy injects tools the agent can call:

| Tool | What it does |
|------|-------------|
| `governance_status` | Controller ID, epoch, constraint count, receipt count |
| `governance_bump_authority` | Advance epoch (invalidates stale sessions) |
| `governance_declare_intent` | Declare goal + predicates for containment |
| `governance_clear_intent` | Clear declared intent |
| `governance_convergence_status` | Loop detection state |

## State Directory

All state lives in `.governance/` (or `--state-dir`):

| File | Contents |
|------|----------|
| `receipts.jsonl` | Append-only hash-chained audit trail |
| `constraints.json` | Failure fingerprints (TTL-based) |
| `controller.json` | Stable controller UUID |
| `authority.json` | Authority epoch + session binding |

## Programmatic API

```typescript
import { startProxy, createGovernedProxy } from '@sovereign-labs/mcp-proxy';

await startProxy({
  upstream: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
  stateDir: '.governance',
  enforcement: 'strict',
});
```

## Built On

[@sovereign-labs/kernel](https://www.npmjs.com/package/@sovereign-labs/kernel) — 7 governance invariants as pure functions. The proxy uses the kernel for hash chaining, failure fingerprinting, constraint checking, and authority validation.

## Requirements

- **Node.js** >= 18 (for `npx`) or **Bun** >= 1.0 (for `bunx`)
- Any MCP-compatible tool server as upstream

## Questions or bugs?

Open an [issue](https://github.com/Born14/mcp-proxy/issues) or email vibestarter26@outlook.com.

## License

MIT
