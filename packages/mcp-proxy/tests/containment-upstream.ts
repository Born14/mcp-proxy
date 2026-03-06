#!/usr/bin/env node
/**
 * Containment Upstream — 6-tool MCP server for G5 clean-wrap testing
 * ===================================================================
 *
 * Purpose-built to exercise G5 containment attribution:
 *   - 2 readonly tools (G5 exempt)
 *   - 4 mutating tools (G5 enforced when intent declared)
 *
 * Tool inventory:
 *   - read_items: readonly query (verb: read)
 *   - list_items: readonly listing (verb: list)
 *   - create_item: mutating create (verb: create, has content arg)
 *   - update_item: mutating update (verb: update, has content arg)
 *   - delete_item: mutating delete (verb: delete)
 *   - deploy_app: mutating deploy (infra verb → scaffolding attribution)
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'containment-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'read_items',
    description: 'Read items matching a query. Returns matching items.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_items',
    description: 'List all items in the store.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category' },
      },
    },
  },
  {
    name: 'create_item',
    description: 'Create a new item in the store.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
        name: { type: 'string', description: 'Item name' },
        content: { type: 'string', description: 'Item content' },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an existing item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID to update' },
        name: { type: 'string', description: 'New name' },
        content: { type: 'string', description: 'New content' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete an item from the store.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'deploy_app',
    description: 'Deploy the application to the specified target environment.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Deployment target (prod, staging)' },
        version: { type: 'string', description: 'Version to deploy' },
      },
      required: ['target'],
    },
  },
];

// In-memory item store
const items = new Map<string, { name: string; content: string }>();

function handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'read_items': {
      const query = args.query as string;
      const matches = Array.from(items.entries())
        .filter(([id, item]) => id.includes(query) || item.name.includes(query))
        .map(([id, item]) => ({ id, ...item }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ matches, count: matches.length }) }],
      };
    }

    case 'list_items': {
      const all = Array.from(items.entries()).map(([id, item]) => ({ id, ...item }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ items: all, count: all.length }) }],
      };
    }

    case 'create_item': {
      const id = args.id as string;
      const name = args.name as string;
      const content = (args.content as string) ?? '';
      items.set(id, { name, content });
      return {
        content: [{ type: 'text', text: `Created item ${id}: "${name}"` }],
      };
    }

    case 'update_item': {
      const id = args.id as string;
      const existing = items.get(id);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Item ${id} not found` }],
          isError: true,
        };
      }
      if (args.name) existing.name = args.name as string;
      if (args.content) existing.content = args.content as string;
      items.set(id, existing);
      return {
        content: [{ type: 'text', text: `Updated item ${id}` }],
      };
    }

    case 'delete_item': {
      const id = args.id as string;
      const existed = items.delete(id);
      return {
        content: [{ type: 'text', text: existed ? `Deleted item ${id}` : `Item ${id} not found` }],
        isError: !existed,
      };
    }

    case 'deploy_app': {
      const target = args.target as string;
      const version = args.version ?? 'latest';
      return {
        content: [{ type: 'text', text: `Deployed v${version} to ${target}` }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// =============================================================================
// STDIO JSON-RPC TRANSPORT
// =============================================================================

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  let msg: { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  } else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: TOOLS });
  } else if (msg.method === 'tools/call') {
    const params = msg.params ?? {};
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = handleToolCall(name, args);
    respond(msg.id, result);
  } else if (msg.method === 'notifications/initialized') {
    // Notification — no response needed
  } else {
    respond(msg.id, undefined, { code: -32601, message: `Method not found: ${msg.method}` });
  }
});

function respond(id: number | undefined, result?: unknown, error?: { code: number; message: string }): void {
  if (id === undefined) return;
  const resp: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}
