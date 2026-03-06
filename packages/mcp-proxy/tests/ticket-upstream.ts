#!/usr/bin/env node
/**
 * Ticket System MCP Server — upstream for clean wrap #12
 * ======================================================
 *
 * Raw readline/stdio implementation (no MCP SDK dependency).
 *
 * 8 tools across 3 categories:
 *   Readonly (3):  get_ticket, list_tickets, search_tickets
 *   CRUD (3):      create_ticket, update_ticket, delete_ticket
 *   Workflow (2):  assign_ticket, close_ticket
 *
 * In-memory state with realistic error paths:
 *   - get/update/delete/assign/close non-existent ticket → isError
 *   - close already-closed ticket → isError
 *   - assign with missing assignee → isError
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'ticket-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'get_ticket',
    description: 'Get a ticket by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_tickets',
    description: 'List all tickets, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
  },
  {
    name: 'search_tickets',
    description: 'Search tickets by keyword in title or description',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'create_ticket',
    description: 'Create a new support ticket',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      required: ['id', 'title'],
    },
  },
  {
    name: 'update_ticket',
    description: 'Update ticket fields (title, description, priority)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_ticket',
    description: 'Delete a ticket permanently',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'assign_ticket',
    description: 'Assign a ticket to a person and set status to in_progress',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        assignee: { type: 'string' },
      },
      required: ['id', 'assignee'],
    },
  },
  {
    name: 'close_ticket',
    description: 'Close a ticket with a resolution comment',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        resolution: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

// =============================================================================
// IN-MEMORY STATE
// =============================================================================

interface Ticket {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'closed';
  assignee: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  comments: Array<{ author: string; text: string; at: string }>;
}

const tickets = new Map<string, Ticket>();

// =============================================================================
// TOOL HANDLER
// =============================================================================

function handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const a = args as Record<string, string>;

  switch (name) {
    case 'get_ticket': {
      const t = tickets.get(a.id);
      if (!t) return { content: [{ type: 'text', text: `Error: Ticket ${a.id} not found` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(t) }] };
    }

    case 'list_tickets': {
      let list = [...tickets.values()];
      if (a.status) list = list.filter(t => t.status === a.status);
      return { content: [{ type: 'text', text: `Found ${list.length} tickets: ${list.map(t => t.id).join(', ')}` }] };
    }

    case 'search_tickets': {
      const q = (a.query ?? '').toLowerCase();
      const matches = [...tickets.values()].filter(
        t => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      );
      return { content: [{ type: 'text', text: `Search "${a.query}": ${matches.length} results (${matches.map(t => t.id).join(', ')})` }] };
    }

    case 'create_ticket': {
      if (tickets.has(a.id)) {
        return { content: [{ type: 'text', text: `Error: Ticket ${a.id} already exists` }], isError: true };
      }
      const ticket: Ticket = {
        id: a.id,
        title: a.title ?? 'Untitled',
        description: a.description ?? '',
        status: 'open',
        assignee: null,
        priority: (a.priority as Ticket['priority']) ?? 'medium',
        createdAt: new Date().toISOString(),
        comments: [],
      };
      tickets.set(a.id, ticket);
      return { content: [{ type: 'text', text: `Created ticket ${a.id}: ${ticket.title} [${ticket.priority}]` }] };
    }

    case 'update_ticket': {
      const t = tickets.get(a.id);
      if (!t) return { content: [{ type: 'text', text: `Error: Ticket ${a.id} not found` }], isError: true };
      if (a.title) t.title = a.title;
      if (a.description) t.description = a.description;
      if (a.priority) t.priority = a.priority as Ticket['priority'];
      return { content: [{ type: 'text', text: `Updated ticket ${a.id}: ${t.title}` }] };
    }

    case 'delete_ticket': {
      if (!tickets.has(a.id)) {
        return { content: [{ type: 'text', text: `Error: Ticket ${a.id} not found` }], isError: true };
      }
      tickets.delete(a.id);
      return { content: [{ type: 'text', text: `Deleted ticket ${a.id}` }] };
    }

    case 'assign_ticket': {
      const t = tickets.get(a.id);
      if (!t) return { content: [{ type: 'text', text: `Error: Ticket ${a.id} not found` }], isError: true };
      if (!a.assignee) return { content: [{ type: 'text', text: 'Error: assignee is required' }], isError: true };
      t.assignee = a.assignee;
      t.status = 'in_progress';
      return { content: [{ type: 'text', text: `Assigned ticket ${a.id} to ${a.assignee} (now in_progress)` }] };
    }

    case 'close_ticket': {
      const t = tickets.get(a.id);
      if (!t) return { content: [{ type: 'text', text: `Error: Ticket ${a.id} not found` }], isError: true };
      if (t.status === 'closed') {
        return { content: [{ type: 'text', text: `Error: Ticket ${a.id} is already closed` }], isError: true };
      }
      t.status = 'closed';
      if (a.resolution) {
        t.comments.push({ author: 'system', text: `Resolved: ${a.resolution}`, at: new Date().toISOString() });
      }
      return { content: [{ type: 'text', text: `Closed ticket ${a.id}` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
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
