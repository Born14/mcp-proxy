#!/usr/bin/env node
/**
 * Custom MCP Upstream — Novel tool shapes for clean-wrap testing
 * ==============================================================
 *
 * This is a purpose-built MCP server with tool shapes designed to exercise
 * every proxy classification path. Unlike the fake-upstream (which is designed
 * for governance testing), this server returns real responses and has tool
 * schemas that don't match any previously tested server.
 *
 * Tool inventory (7 tools, diverse shapes):
 *   - analyze_sentiment: text input, returns structured analysis
 *   - translate: source/target/text, compound key extraction
 *   - calculate_hash: algorithm + input, crypto operation
 *   - store_document: id/title/content/tags — clearly mutating (content + data)
 *   - batch_process: items[] array input — complex schema
 *   - health_check: no args — empty schema
 *   - transform_image: url/width/height/format — mixed arg types
 */

import * as readline from 'readline';

const SERVER_INFO = {
  name: 'custom-upstream',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'analyze_sentiment',
    description: 'Analyze the sentiment of input text. Returns positive/negative/neutral classification.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to analyze' },
        language: { type: 'string', description: 'Language code (default: en)', default: 'en' },
      },
      required: ['text'],
    },
  },
  {
    name: 'translate',
    description: 'Translate text between languages.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source language code' },
        target: { type: 'string', description: 'Target language code' },
        text: { type: 'string', description: 'Text to translate' },
      },
      required: ['source', 'target', 'text'],
    },
  },
  {
    name: 'calculate_hash',
    description: 'Calculate a cryptographic hash of the input.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: ['sha256', 'sha512', 'md5'], description: 'Hash algorithm' },
        input: { type: 'string', description: 'Data to hash' },
      },
      required: ['algorithm', 'input'],
    },
  },
  {
    name: 'store_document',
    description: 'Store a document in the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Document body' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['id', 'title', 'content'],
    },
  },
  {
    name: 'batch_process',
    description: 'Process a batch of items.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              action: { type: 'string' },
              data: { type: 'object' },
            },
            required: ['id', 'action'],
          },
          description: 'Items to process',
        },
        dryRun: { type: 'boolean', description: 'If true, simulate without executing', default: false },
      },
      required: ['items'],
    },
  },
  {
    name: 'health_check',
    description: 'Check system health status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'transform_image',
    description: 'Transform an image with the specified parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Image URL' },
        width: { type: 'integer', description: 'Target width in pixels' },
        height: { type: 'integer', description: 'Target height in pixels' },
        format: { type: 'string', enum: ['png', 'jpg', 'webp'], description: 'Output format' },
      },
      required: ['url'],
    },
  },
];

// In-memory document store
const documents = new Map<string, { title: string; content: string; tags: string[] }>();

function handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'analyze_sentiment': {
      const text = args.text as string;
      const score = text.includes('good') || text.includes('great') || text.includes('love')
        ? 0.8
        : text.includes('bad') || text.includes('terrible') || text.includes('hate')
        ? -0.7
        : 0.1;
      const label = score > 0.3 ? 'positive' : score < -0.3 ? 'negative' : 'neutral';
      return {
        content: [{ type: 'text', text: JSON.stringify({ score, label, language: args.language ?? 'en' }) }],
      };
    }

    case 'translate': {
      // Fake translation — just wraps text with language codes
      const translated = `[${args.target}] ${args.text} (from ${args.source})`;
      return {
        content: [{ type: 'text', text: translated }],
      };
    }

    case 'calculate_hash': {
      const crypto = require('crypto');
      const hash = crypto.createHash(args.algorithm as string).update(args.input as string).digest('hex');
      return {
        content: [{ type: 'text', text: hash }],
      };
    }

    case 'store_document': {
      const id = args.id as string;
      const title = args.title as string;
      const content = args.content as string;
      const tags = (args.tags as string[]) ?? [];

      // Simulate failure for IDs starting with "fail_"
      if (id.startsWith('fail_')) {
        return {
          content: [{ type: 'text', text: `StorageError: Document ${id} rejected — validation failed at 2024-03-05T10:30:00Z` }],
          isError: true,
        };
      }

      documents.set(id, { title, content, tags });
      return {
        content: [{ type: 'text', text: `Stored document ${id}: "${title}" (${content.length} chars, ${tags.length} tags)` }],
      };
    }

    case 'batch_process': {
      const items = args.items as Array<{ id: string; action: string }>;
      const dryRun = args.dryRun as boolean ?? false;
      const results = items.map(item => ({
        id: item.id,
        status: dryRun ? 'simulated' : 'processed',
        action: item.action,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ processed: results.length, results, dryRun }) }],
      };
    }

    case 'health_check': {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'healthy', uptime: process.uptime(), documents: documents.size }) }],
      };
    }

    case 'transform_image': {
      const url = args.url as string;
      const width = args.width ?? 'auto';
      const height = args.height ?? 'auto';
      const format = args.format ?? 'png';
      return {
        content: [{ type: 'text', text: `Transformed ${url} → ${width}x${height} ${format}` }],
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
  if (id === undefined) return; // notification
  const resp: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}
