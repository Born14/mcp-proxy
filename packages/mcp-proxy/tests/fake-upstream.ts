#!/usr/bin/env bun
/**
 * Fake MCP Upstream Server
 * ========================
 *
 * Minimal MCP server that speaks JSON-RPC over stdio.
 * Used by e2e tests to prove the proxy transport works.
 *
 * Supports:
 *   initialize      → returns server info
 *   tools/list      → returns tool definitions
 *   tools/call      → dispatches to tool handlers
 *   notifications   → ignored (no response)
 *
 * Tool behaviors:
 *   echo          — returns arguments as-is (always succeeds)
 *   write_file    — succeeds or fails based on args.shouldFail
 *   read_file     — always succeeds with file content
 *   slow_tool     — waits args.delayMs before responding
 *   crash_tool    — exits the process (simulates upstream crash)
 *   error_syntax  — always returns SyntaxError (triggers constraint seeding)
 *   error_build   — always returns build failure (triggers constraint seeding)
 */

import { createInterface } from 'readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo arguments back',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  {
    name: 'write_file',
    description: 'Write a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, shouldFail: { type: 'boolean' } } },
  },
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'slow_tool',
    description: 'Responds after a delay',
    inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } },
  },
  {
    name: 'crash_tool',
    description: 'Crashes the server',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'error_syntax',
    description: 'Always returns SyntaxError',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'error_build',
    description: 'Always returns build failure',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(line: string): Promise<void> {
  if (!line.trim()) return;

  let msg: { jsonrpc: string; id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Notification — no response
  if (msg.id === undefined) return;

  const method = msg.method;

  if (method === 'initialize') {
    respond({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'fake-upstream', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    respond({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = params?.name ?? '';
    const args = params?.arguments ?? {};

    switch (toolName) {
      case 'echo':
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(args) }] },
        });
        break;

      case 'write_file':
        if (args.shouldFail) {
          respond({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `SyntaxError: Unexpected token } in ${args.path}` }],
              isError: true,
            },
          });
        } else {
          respond({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `Written to ${args.path}` }] },
          });
        }
        break;

      case 'read_file':
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Contents of ${args.path}` }] },
        });
        break;

      case 'slow_tool': {
        const delay = typeof args.delayMs === 'number' ? args.delayMs : 1000;
        await new Promise(r => setTimeout(r, delay));
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Completed after ${delay}ms` }] },
        });
        break;
      }

      case 'crash_tool':
        // Exit immediately — simulates upstream crash
        process.exit(42);
        break;

      case 'error_syntax':
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `SyntaxError: Unexpected token } in ${args.path || 'unknown'}` }],
            isError: true,
          },
        });
        break;

      case 'error_build':
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `build failed with exit code 1` }],
            isError: true,
          },
        });
        break;

      default:
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
    }
    return;
  }

  // Unknown method — return error
  respond({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

// Main: read stdin line by line
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  handleMessage(line).catch(err => {
    process.stderr.write(`[fake-upstream] Error: ${(err as Error).message}\n`);
  });
});
