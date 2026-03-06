#!/usr/bin/env node
/**
 * Pipeline MCP Upstream — CI/CD pipeline server for clean-wrap testing
 * =====================================================================
 *
 * Stateless server (no persistence, no cross-run contamination).
 * 8 tools with diverse classification paths.
 *
 * Tool inventory:
 *   - check_status:    readonly via verb 'check', target Layer 1 (id)
 *   - run_pipeline:    mutating via schema (config ∈ WRITE_PROPERTIES), target Layer 1 (name)
 *   - list_artifacts:  readonly via schema (filter ∈ READ_PROPERTIES), target Layer 4 or 5
 *   - inspect_logs:    readonly via verb 'inspect', target Layer 1 (id)
 *   - stop_pipeline:   mutating via verb 'stop', target Layer 1 (name)
 *   - show_metrics:    readonly via verb 'show', target Layer 1 (key)
 *   - trigger_deploy:  mutating via schema (payload ∈ WRITE_PROPERTIES), no verb match
 *   - lookup_version:  readonly via verb 'lookup', target Layer 1 (name)
 *
 * Error triggers:
 *   - check_status({id: 'err_...'})       → isError
 *   - stop_pipeline({name: 'missing_...'}) → isError
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'pipeline-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'check_status',
    description: 'Check the status of a pipeline run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pipeline run ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'run_pipeline',
    description: 'Run a named pipeline with configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pipeline name' },
        config: {
          type: 'object',
          description: 'Pipeline configuration',
          properties: {
            branch: { type: 'string' },
            parallel: { type: 'boolean' },
          },
        },
      },
      required: ['name', 'config'],
    },
  },
  {
    name: 'list_artifacts',
    description: 'List build artifacts with optional filter.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter pattern' },
        limit: { type: 'number', description: 'Max results' },
      },
    },
  },
  {
    name: 'inspect_logs',
    description: 'Inspect logs for a pipeline run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pipeline run ID' },
        tail: { type: 'number', description: 'Lines from the end' },
      },
      required: ['id'],
    },
  },
  {
    name: 'stop_pipeline',
    description: 'Stop a running pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pipeline name to stop' },
      },
      required: ['name'],
    },
  },
  {
    name: 'show_metrics',
    description: 'Show metrics for a given key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Metric key' },
        period: { type: 'string', description: 'Time period' },
      },
      required: ['key'],
    },
  },
  {
    name: 'trigger_deploy',
    description: 'Trigger a deployment with a payload.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment target name' },
        payload: {
          type: 'object',
          description: 'Deployment payload',
          properties: {
            version: { type: 'string' },
            environment: { type: 'string' },
          },
        },
      },
      required: ['name', 'payload'],
    },
  },
  {
    name: 'lookup_version',
    description: 'Lookup the current deployed version.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name' },
      },
      required: ['name'],
    },
  },
];

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'check_status': {
      const id = args.id as string;
      if (id.startsWith('err_')) {
        return {
          content: [{ type: 'text', text: `StatusError: Pipeline run ${id} not found` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, status: 'running', progress: 67 }) }],
      };
    }

    case 'run_pipeline': {
      const pName = args.name as string;
      const config = args.config as Record<string, unknown>;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: pName,
            runId: `run_${Date.now()}`,
            branch: config?.branch ?? 'main',
            parallel: config?.parallel ?? false,
          }),
        }],
      };
    }

    case 'list_artifacts': {
      const filter = (args.filter as string) ?? '';
      const limit = (args.limit as number) ?? 10;
      const items = ['build.tar.gz', 'test-report.xml', 'coverage.html', 'bundle.js', 'docker-image.tar'];
      const matched = filter ? items.filter(i => i.includes(filter)) : items;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ artifacts: matched.slice(0, limit), total: matched.length }),
        }],
      };
    }

    case 'inspect_logs': {
      const id = args.id as string;
      const tail = (args.tail as number) ?? 50;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id,
            lines: tail,
            log: `[${id}] Building... Step 1/5 complete`,
          }),
        }],
      };
    }

    case 'stop_pipeline': {
      const pName = args.name as string;
      if (pName.startsWith('missing_')) {
        return {
          content: [{ type: 'text', text: `StopError: Pipeline "${pName}" is not running` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ name: pName, stopped: true }) }],
      };
    }

    case 'show_metrics': {
      const metricKey = args.key as string;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ key: metricKey, value: 42, unit: 'ms', samples: 1000 }),
        }],
      };
    }

    case 'trigger_deploy': {
      const dName = args.name as string;
      const payload = args.payload as Record<string, unknown>;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: dName,
            deployId: `dep_${Date.now()}`,
            version: payload?.version ?? 'latest',
            environment: payload?.environment ?? 'staging',
          }),
        }],
      };
    }

    case 'lookup_version': {
      const sName = args.name as string;
      return {
        content: [{ type: 'text', text: JSON.stringify({ name: sName, version: '2.4.1', deployed: '2026-03-05' }) }],
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
