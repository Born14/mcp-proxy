#!/usr/bin/env node
/**
 * Analytics MCP Upstream — Diverse classification paths for clean-wrap testing
 * =============================================================================
 *
 * Purpose-built MCP server exercising verb, schema, and override classification
 * paths in the proxy. Every tool is designed for a specific classification route.
 *
 * Tool inventory (8 tools, diverse classification paths):
 *   - get_report:        readonly via verb 'get', target via Layer 1 (id)
 *   - list_dashboards:   readonly via schema (filter ∈ READ_PROPERTIES), target Layer 4/5
 *   - update_metric:     mutating via schema (value ∈ WRITE_PROPERTIES), target Layer 1 (name)
 *   - delete_report:     mutating via verb 'delete', target Layer 1 (id)
 *   - import_data:       mutating via schema (data ∈ WRITE_PROPERTIES), target Layer 1 (collection)
 *   - fetch_stats:       readonly via verb 'fetch', target Layer 1 (resource)
 *   - describe_entity:   readonly via OVERRIDE (schema says mutating but 'describe' is readonly verb)
 *   - purge_cache:       readonly via DEFAULT (no verb match, no schema signal → default readonly)
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'analytics-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'get_report',
    description: 'Get a report by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_dashboards',
    description: 'List available dashboards with optional filter.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter pattern' },
      },
    },
  },
  {
    name: 'update_metric',
    description: 'Update a metric value.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Metric name' },
        value: { type: 'number', description: 'New metric value' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'delete_report',
    description: 'Delete a report by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'import_data',
    description: 'Import data into a collection.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Target collection name' },
        data: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of records to import',
        },
      },
      required: ['collection', 'data'],
    },
  },
  {
    name: 'fetch_stats',
    description: 'Fetch statistics for a resource.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource identifier' },
        period: { type: 'string', description: 'Time period (e.g., "7d", "30d")' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'describe_entity',
    description: 'Describe an entity from the analytics catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Entity name or pattern to describe' },
      },
      required: ['input'],
    },
  },
  {
    name: 'purge_cache',
    description: 'Purge cached data for a region.',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'Cache region to purge' },
        ttl: { type: 'number', description: 'Only purge entries older than TTL seconds' },
      },
      required: ['region'],
    },
  },
];

// In-memory state
const metrics = new Map<string, number>([
  ['cpu_usage', 72.5],
  ['memory_mb', 4096],
  ['requests_per_sec', 1520],
  ['error_rate', 0.03],
]);

const reports = new Map<string, { title: string; created: string }>([
  ['rpt_001', { title: 'Weekly Summary', created: '2026-03-01' }],
  ['rpt_002', { title: 'Error Analysis', created: '2026-03-03' }],
  ['rpt_003', { title: 'Performance Trends', created: '2026-03-05' }],
]);

const dashboards = ['Operations', 'Sales', 'Engineering', 'Executive'];

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'get_report': {
      const id = args.id as string;
      const report = reports.get(id);
      if (!report) {
        return {
          content: [{ type: 'text', text: `Report not found: ${id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, ...report }) }],
      };
    }

    case 'list_dashboards': {
      const filter = (args.filter as string) ?? '';
      const matched = filter
        ? dashboards.filter(d => d.toLowerCase().includes(filter.toLowerCase()))
        : dashboards;
      return {
        content: [{ type: 'text', text: JSON.stringify({ dashboards: matched, total: matched.length }) }],
      };
    }

    case 'update_metric': {
      const metricName = args.name as string;
      const newValue = args.value as number;
      const oldValue = metrics.get(metricName);
      metrics.set(metricName, newValue);
      return {
        content: [{ type: 'text', text: JSON.stringify({ name: metricName, old: oldValue ?? null, new: newValue }) }],
      };
    }

    case 'delete_report': {
      const id = args.id as string;
      if (id.startsWith('missing_')) {
        return {
          content: [{ type: 'text', text: `DeleteError: Report ${id} does not exist` }],
          isError: true,
        };
      }
      const existed = reports.delete(id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: id, existed }) }],
      };
    }

    case 'import_data': {
      const collection = args.collection as string;
      const data = args.data as Array<Record<string, unknown>>;
      if (collection === '__invalid__') {
        return {
          content: [{ type: 'text', text: `ImportError: Collection "${collection}" is reserved` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ collection, imported: data.length }) }],
      };
    }

    case 'fetch_stats': {
      const resource = args.resource as string;
      const period = (args.period as string) ?? '7d';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            resource,
            period,
            avg: 42.7,
            min: 10,
            max: 95,
            samples: 168,
          }),
        }],
      };
    }

    case 'describe_entity': {
      const input = args.input as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            entity: input,
            type: 'metric',
            fields: ['timestamp', 'value', 'source'],
            records: 50000,
          }),
        }],
      };
    }

    case 'purge_cache': {
      const region = args.region as string;
      const ttl = (args.ttl as number) ?? 0;
      return {
        content: [{ type: 'text', text: JSON.stringify({ region, purged: 127, ttl }) }],
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
  if (id === undefined) return; // notification
  const resp: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}
