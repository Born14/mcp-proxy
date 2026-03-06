#!/usr/bin/env node
/**
 * Inventory MCP Upstream — Warehouse server for clean-wrap testing
 * =================================================================
 *
 * Stateless server. 8 tools with verb-based and override classification paths.
 *
 * Tool inventory:
 *   - search_items:    readonly via verb 'search', target Layer 4 (first string)
 *   - count_stock:     readonly via verb 'count', target Layer 1 (id)
 *   - add_item:        mutating via verb 'add', target Layer 1 (name)
 *   - remove_item:     mutating via verb 'remove', target Layer 1 (id)
 *   - view_warehouse:  readonly via verb 'view', target Layer 1 (id)
 *   - set_quantity:    mutating via verb 'set', target Layer 1 (id)
 *   - find_location:   readonly via verb 'find', target Layer 1 (name)
 *   - print_label:     readonly via OVERRIDE (schema 'content' → mutating, but 'print' overrides)
 *
 * Error triggers:
 *   - remove_item({id: 'ghost_...'})               → isError
 *   - set_quantity({id: 'locked_...', quantity: n}) → isError
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'inventory-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'search_items',
    description: 'Search for items by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' },
      },
      required: ['query'],
    },
  },
  {
    name: 'count_stock',
    description: 'Count stock for an item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_item',
    description: 'Add a new item to the warehouse.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name' },
        category: { type: 'string', description: 'Category' },
        quantity: { type: 'number', description: 'Initial quantity' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_item',
    description: 'Remove an item from inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID to remove' },
      },
      required: ['id'],
    },
  },
  {
    name: 'view_warehouse',
    description: 'View warehouse details.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Warehouse ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_quantity',
    description: 'Set the quantity for an item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
        quantity: { type: 'number', description: 'New quantity' },
      },
      required: ['id', 'quantity'],
    },
  },
  {
    name: 'find_location',
    description: 'Find the warehouse location for an item.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name to locate' },
      },
      required: ['name'],
    },
  },
  {
    name: 'print_label',
    description: 'Print a label for an item.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name for the label' },
        content: { type: 'string', description: 'Label content text' },
      },
      required: ['name', 'content'],
    },
  },
];

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'search_items': {
      const query = args.query as string;
      const results = ['Widget A', 'Gadget B', 'Sprocket C']
        .filter(i => i.toLowerCase().includes(query.toLowerCase()));
      return {
        content: [{ type: 'text', text: JSON.stringify({ query, results, count: results.length }) }],
      };
    }

    case 'count_stock': {
      const id = args.id as string;
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, stock: 42, reserved: 5, available: 37 }) }],
      };
    }

    case 'add_item': {
      const itemName = args.name as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: `item_${Date.now()}`,
            name: itemName,
            category: args.category ?? 'general',
            quantity: args.quantity ?? 0,
          }),
        }],
      };
    }

    case 'remove_item': {
      const id = args.id as string;
      if (id.startsWith('ghost_')) {
        return {
          content: [{ type: 'text', text: `RemoveError: Item ${id} does not exist in inventory` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, removed: true }) }],
      };
    }

    case 'view_warehouse': {
      const id = args.id as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ id, capacity: 10000, used: 7500, zones: ['A', 'B', 'C'] }),
        }],
      };
    }

    case 'set_quantity': {
      const id = args.id as string;
      const quantity = args.quantity as number;
      if (id.startsWith('locked_')) {
        return {
          content: [{ type: 'text', text: `LockError: Item ${id} is locked for audit` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, quantity, updated: true }) }],
      };
    }

    case 'find_location': {
      const itemName = args.name as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ name: itemName, warehouse: 'WH-01', zone: 'A', shelf: 'A3-17' }),
        }],
      };
    }

    case 'print_label': {
      const itemName = args.name as string;
      const labelContent = args.content as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ name: itemName, label: labelContent, printed: true }),
        }],
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
    const toolCallName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const result = handleToolCall(toolCallName, toolArgs);
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
