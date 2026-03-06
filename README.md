# @sovereign-labs/mcp-proxy

**See what your agent did. Verify nobody tampered with the record. Stop broken retries.**

A drop-in governance proxy for any MCP tool server. One command to add tamper-evident receipts, failure memory, and authority tracking.

## The Trust Demo (4 commands)

```bash
# 1. Govern your filesystem server
npx @sovereign-labs/mcp-proxy --wrap filesystem

# 2. Use Claude Code normally — every tool call is now receipted

# 3. See what happened
npx @sovereign-labs/mcp-proxy --view --state-dir .governance-filesystem

# 4. Verify the record is intact
npx @sovereign-labs/mcp-proxy --verify --state-dir .governance-filesystem
```

Your agent doesn't know the proxy exists. Your MCP server doesn't know either. But now you have proof.

## What --view shows

```
  RECEIPT LEDGER
  ===============================================================
  controller:  a1b2c3d4...
  integrity:   verified
  showing:     10 receipts
  ---------------------------------------------------------------

  ok #  0  2026-03-06 14:22:00     42ms  read_file
           target: /tmp/config.json
           hash: c0a4271c5fd1df01...

  ok #  1  2026-03-06 14:22:01    103ms  write_file [MUTATION]
           target: /tmp/config.json
           hash: 1bc5e6ac12056651...

  ok #  2  2026-03-06 14:22:03     38ms  read_file
           target: /tmp/app/server.js
           hash: 32f85d3474b9d3a0...

  !! #  3  2026-03-06 14:22:04     12ms  write_file [MUTATION]
           target: /tmp/secret.key
           error: Permission denied
           hash: 5fc519e7c92658ef...

  -- #  4  2026-03-06 14:22:06      1ms  write_file [MUTATION]
           target: /tmp/secret.key
           blocked by: write_file+/tmp/secret.key (known failure)
           hash: abadd7890802c0ac...

  ok #  7  2026-03-06 14:22:10     87ms  write_file [MUTATION]
           target: /tmp/app/server.js
           hash: e20b2fd706abdeea...

  ---------------------------------------------------------------
  10 receipts  |  5 mutations  |  1 blocked  |  1 errors
```

Receipt #3 fails. Receipt #4 is the same call — the proxy blocks it automatically because it already failed. No wasted retries. No prompt engineering. Structural.

## What --verify shows

```
  CHAIN VERIFICATION
  ===============================================================

  receipts:          10
  chain depth:       10
  integrity:         all hashes verified
  controller:        a1b2c3d4...
  first hash:        c0a4271c...
  last hash:         66c88893...
```

If anyone modifies a receipt after the fact:

```
  integrity:         TAMPERED at seq 3
```

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [@sovereign-labs/mcp-proxy](packages/mcp-proxy/) | Drop-in governance proxy for MCP tool servers | [![npm](https://img.shields.io/npm/v/@sovereign-labs/mcp-proxy)](https://www.npmjs.com/package/@sovereign-labs/mcp-proxy) |
| [@sovereign-labs/kernel](packages/kernel/) | Governance kernel — 7 structural invariants as pure functions | [![npm](https://img.shields.io/npm/v/@sovereign-labs/kernel)](https://www.npmjs.com/package/@sovereign-labs/kernel) |

**mcp-proxy** is the thing you install. **kernel** is the governance math underneath it.

See [packages/mcp-proxy/README.md](packages/mcp-proxy/README.md) for full documentation — CLI reference, enforcement modes, constraint learning, programmatic API.

## Three Guarantees

1. **Receipts** — Every tool call produces a hash-chained record. Like git commits for tool execution. Tamper with one receipt and the chain breaks.

2. **Constraints** — When a tool call fails, the proxy fingerprints the failure and blocks identical calls within a TTL window. Your agent can't repeat the same mistake.

3. **Authority** — A stable controller ID and monotonic epoch counter. You can prove which controller was active and whether authority was still valid when a call was made.

## Status

Public beta. Tested cold-install path (`npx`) on Node >= 18.

```bash
npm install @sovereign-labs/mcp-proxy
```

## License

MIT
