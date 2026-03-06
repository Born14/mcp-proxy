# @sovereign-labs/mcp-proxy

Governed transport for MCP. Structural invariants for any tool server.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [@sovereign-labs/mcp-proxy](packages/mcp-proxy/) | Drop-in governance proxy for MCP tool servers | [![npm](https://img.shields.io/npm/v/@sovereign-labs/mcp-proxy)](https://www.npmjs.com/package/@sovereign-labs/mcp-proxy) |
| [@sovereign-labs/kernel](packages/kernel/) | Governance kernel — 7 structural invariants as pure functions | [![npm](https://img.shields.io/npm/v/@sovereign-labs/kernel)](https://www.npmjs.com/package/@sovereign-labs/kernel) |

## Quick Start

```bash
npx @sovereign-labs/mcp-proxy --upstream "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

Every tool call gets:
- **Receipted** — tamper-evident hash-chained audit trail
- **Fingerprinted** — mutation classification (mutating/readonly)
- **Constraint-tracked** — G2 non-repetition (don't repeat known failures)
- **Authority-bound** — E-H7 identity + E-H8 temporal sovereignty

See [packages/mcp-proxy/README.md](packages/mcp-proxy/README.md) for full documentation.

## License

MIT
