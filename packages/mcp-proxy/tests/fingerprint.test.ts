/**
 * Fingerprint Tests
 * =================
 *
 * Proves:
 *   - Tool call with path arg → target extracted
 *   - Tool call with file arg → target extracted
 *   - Priority order respected (path > file > uri > ...)
 *   - Deep extraction into nested objects and arrays
 *   - Unknown args → falls back to tool name
 *   - Error text → kernel extractSignature() classification
 *   - Error normalization strips volatile components (timestamps, IPs, UUIDs)
 *   - Constraint seeding deduplication
 *   - Schema-based mutation classification (primary)
 *   - Verb heuristic fallback (secondary)
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  extractTarget,
  toolCallToMutation,
  seedFromFailure,
  classifyMutationType,
  classifyFromSchema,
  cacheToolSchemas,
  clearSchemaCache,
  normalizeErrorText,
} from '../src/fingerprint.js';
import type { ConstraintEntry } from '../src/types.js';

// =============================================================================
// TARGET EXTRACTION — Top-level keys
// =============================================================================

describe('extractTarget', () => {
  test('extracts path arg', () => {
    expect(extractTarget('write_file', { path: '/tmp/test.txt', content: 'hello' })).toBe('/tmp/test.txt');
  });

  test('extracts file arg', () => {
    expect(extractTarget('read_file', { file: '/home/user/data.json' })).toBe('/home/user/data.json');
  });

  test('extracts uri arg', () => {
    expect(extractTarget('fetch', { uri: 'https://example.com/api' })).toBe('https://example.com/api');
  });

  test('extracts url arg', () => {
    expect(extractTarget('fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  test('extracts name arg', () => {
    expect(extractTarget('create_db', { name: 'mydb' })).toBe('mydb');
  });

  test('extracts key arg', () => {
    expect(extractTarget('kv_set', { key: 'user:123', value: 'data' })).toBe('user:123');
  });

  test('extracts id arg', () => {
    expect(extractTarget('get_item', { id: 'item-42' })).toBe('item-42');
  });

  test('extracts resource arg', () => {
    expect(extractTarget('access', { resource: 'users/profile' })).toBe('users/profile');
  });

  test('extracts table arg', () => {
    expect(extractTarget('query_table', { table: 'orders', limit: 10 })).toBe('orders');
  });

  test('extracts collection arg', () => {
    expect(extractTarget('mongo_find', { collection: 'events' })).toBe('events');
  });

  test('priority: path over file', () => {
    expect(extractTarget('op', { file: 'b.txt', path: 'a.txt' })).toBe('a.txt');
  });

  // --- Deep extraction ---

  test('extracts from nested object', () => {
    expect(extractTarget('complex_op', {
      options: { path: '/nested/target.txt' },
    })).toBe('/nested/target.txt');
  });

  test('extracts from deeply nested object (depth 2)', () => {
    expect(extractTarget('deep_op', {
      config: { source: { file: '/deep/path.ts' } },
    })).toBe('/deep/path.ts');
  });

  test('stops recursion at depth 3', () => {
    // Depth 4 — should NOT reach the name
    expect(extractTarget('ultra_deep', {
      a: { b: { c: { d: { name: 'should-not-find' } } } },
    })).toBe('ultra_deep');
  });

  test('extracts from array of objects (first element)', () => {
    expect(extractTarget('batch_op', {
      entities: [
        { name: 'UserService' },
        { name: 'AuthService' },
      ],
    })).toBe('UserService');
  });

  test('extracts id from array of objects', () => {
    expect(extractTarget('batch_delete', {
      items: [
        { id: 'item-1' },
        { id: 'item-2' },
      ],
    })).toBe('item-1');
  });

  test('skips empty arrays', () => {
    expect(extractTarget('op', {
      items: [],
      fallback: 'got-it',
    })).toBe('got-it');
  });

  test('skips arrays of primitives', () => {
    expect(extractTarget('op', {
      tags: ['a', 'b', 'c'],
      name: 'the-target',
    })).toBe('the-target');
  });

  test('falls back to first string value', () => {
    expect(extractTarget('custom_tool', { query: 'SELECT * FROM users', limit: 10 })).toBe('SELECT * FROM users');
  });

  test('falls back to tool name when no string args', () => {
    expect(extractTarget('noop', { count: 42, flag: true })).toBe('noop');
  });

  test('falls back to tool name for empty args', () => {
    expect(extractTarget('status', {})).toBe('status');
  });

  test('skips empty string values in target keys', () => {
    expect(extractTarget('op', { name: '', key: 'actual-target' })).toBe('actual-target');
  });
});

// =============================================================================
// MUTATION MAPPING
// =============================================================================

describe('toolCallToMutation', () => {
  test('maps tool call to kernel Mutation type', () => {
    const mutation = toolCallToMutation('write_file', { path: '/tmp/test.txt', content: 'hello' });
    expect(mutation.verb).toBe('write_file');
    expect(mutation.target).toBe('/tmp/test.txt');
    expect(mutation.capturedAt).toBeGreaterThan(0);
    expect(mutation.args).toEqual({ path: '/tmp/test.txt', content: 'hello' });
  });
});

// =============================================================================
// ERROR SIGNATURE NORMALIZATION
// =============================================================================

describe('normalizeErrorText', () => {
  test('strips ISO timestamps', () => {
    const result = normalizeErrorText('Error at 2026-03-05T12:00:00.000Z: connection refused');
    expect(result).toBe('Error at <TIMESTAMP>: connection refused');
  });

  test('strips ISO timestamps with timezone offset', () => {
    const result = normalizeErrorText('Failed at 2026-01-15T08:30:00+05:30');
    expect(result).toBe('Failed at <TIMESTAMP>');
  });

  test('strips ISO timestamps with space separator', () => {
    const result = normalizeErrorText('Log entry 2026-03-05 12:00:00 error occurred');
    expect(result).toBe('Log entry <TIMESTAMP> error occurred');
  });

  test('strips UUIDs', () => {
    const result = normalizeErrorText('Request 550e8400-e29b-41d4-a716-446655440000 failed');
    expect(result).toBe('Request <UUID> failed');
  });

  test('strips IPv4 addresses', () => {
    const result = normalizeErrorText('Connection to 192.168.1.100 refused');
    expect(result).toBe('Connection to <IP> refused');
  });

  test('strips hex addresses', () => {
    const result = normalizeErrorText('Segfault at 0x7fff5fbff8c0');
    expect(result).toBe('Segfault at <ADDR>');
  });

  test('strips long hex IDs (request/trace IDs)', () => {
    const result = normalizeErrorText('Trace abc123def456abc123def456abc123 failed');
    expect(result).toBe('Trace <HEXID> failed');
  });

  test('strips PIDs', () => {
    const result = normalizeErrorText('Process crashed pid=12345');
    expect(result).toBe('Process crashed pid=<PID>');
  });

  test('strips multiple volatile components', () => {
    const result = normalizeErrorText(
      'Error at 2026-03-05T12:00:00Z on 192.168.1.1 req=550e8400-e29b-41d4-a716-446655440000 pid=999'
    );
    expect(result).toBe('Error at <TIMESTAMP> on <IP> req=<UUID> pid=<PID>');
  });

  test('preserves error messages without volatile components', () => {
    const result = normalizeErrorText('Entity with name NonExistent-Service not found');
    expect(result).toBe('Entity with name NonExistent-Service not found');
  });
});

// =============================================================================
// FAILURE SEEDING
// =============================================================================

describe('seedFromFailure', () => {
  test('seeds constraint from known error pattern (syntax_error)', () => {
    const constraint = seedFromFailure('write_file', '/tmp/test.js', 'SyntaxError: Unexpected token }', []);
    expect(constraint).not.toBeNull();
    expect(constraint!.toolName).toBe('write_file');
    expect(constraint!.target).toBe('/tmp/test.js');
    expect(constraint!.failureSignature).toBe('syntax_error');
    expect(constraint!.errorSnippet).toBe('SyntaxError: Unexpected token }');
  });

  test('seeds constraint from build_failure pattern', () => {
    const constraint = seedFromFailure('execute', 'npm run build', 'build failed with exit code 1', []);
    expect(constraint).not.toBeNull();
    expect(constraint!.failureSignature).toBe('build_failure');
  });

  test('seeds first-line constraint for unrecognized error text', () => {
    const constraint = seedFromFailure('custom', '/tmp', 'everything is fine', []);
    expect(constraint).not.toBeNull();
    expect(constraint!.failureSignature).toBe('everything is fine');
    expect(constraint!.ttlMs).toBe(60 * 60 * 1000);
  });

  test('returns null for empty error text', () => {
    const constraint = seedFromFailure('custom', '/tmp', '', []);
    expect(constraint).toBeNull();
  });

  test('normalizes timestamps in error signatures for dedup', () => {
    // Two errors with different timestamps should produce the same normalized signature
    const c1 = seedFromFailure('tool', '/t', 'Timeout at 2026-03-05T12:00:00Z on server', []);
    expect(c1).not.toBeNull();

    // Second error with different timestamp should dedup against first
    const c2 = seedFromFailure('tool', '/t', 'Timeout at 2026-03-05T13:00:00Z on server', [c1!]);
    expect(c2).toBeNull(); // Same normalized signature → dedup
  });

  test('normalizes UUIDs in error signatures for dedup', () => {
    const c1 = seedFromFailure('tool', '/t', 'Request 550e8400-e29b-41d4-a716-446655440000 failed', []);
    expect(c1).not.toBeNull();

    const c2 = seedFromFailure('tool', '/t', 'Request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed', [c1!]);
    expect(c2).toBeNull(); // Same normalized signature → dedup
  });

  test('deduplicates: same tool + target + signature', () => {
    const existing: ConstraintEntry[] = [{
      id: 'c_existing',
      toolName: 'write_file',
      target: '/tmp/test.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'SyntaxError',
      createdAt: Date.now(),
    }];

    const duplicate = seedFromFailure('write_file', '/tmp/test.js', 'SyntaxError: bad input', existing);
    expect(duplicate).toBeNull();
  });

  test('allows different target with same tool + signature', () => {
    const existing: ConstraintEntry[] = [{
      id: 'c_existing',
      toolName: 'write_file',
      target: '/tmp/a.js',
      failureSignature: 'syntax_error',
      errorSnippet: 'SyntaxError',
      createdAt: Date.now(),
    }];

    const different = seedFromFailure('write_file', '/tmp/b.js', 'SyntaxError: bad input', existing);
    expect(different).not.toBeNull();
    expect(different!.target).toBe('/tmp/b.js');
  });

  test('truncates error snippet to 200 chars', () => {
    const longError = 'SyntaxError: ' + 'x'.repeat(300);
    const constraint = seedFromFailure('write', '/test', longError, []);
    expect(constraint).not.toBeNull();
    expect(constraint!.errorSnippet.length).toBe(200);
  });
});

// =============================================================================
// SCHEMA-BASED MUTATION CLASSIFICATION
// =============================================================================

describe('classifyFromSchema', () => {
  beforeEach(() => {
    clearSchemaCache();
  });

  test('returns null when no schema cached', () => {
    expect(classifyFromSchema('unknown_tool')).toBeNull();
  });

  test('detects mutating from content property', () => {
    cacheToolSchemas([{
      name: 'write_doc',
      description: 'Write a document',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    }]);
    expect(classifyFromSchema('write_doc')).toBe('mutating');
  });

  test('detects mutating from entities property (knowledge graph)', () => {
    cacheToolSchemas([{
      name: 'create_entities',
      description: 'Create entities in the knowledge graph',
      inputSchema: {
        type: 'object',
        properties: { entities: { type: 'array', items: { type: 'object' } } },
        required: ['entities'],
      },
    }]);
    expect(classifyFromSchema('create_entities')).toBe('mutating');
  });

  test('detects mutating from data property', () => {
    cacheToolSchemas([{
      name: 'upload',
      description: 'Upload data',
      inputSchema: {
        type: 'object',
        properties: { data: { type: 'string' } },
        required: ['data'],
      },
    }]);
    expect(classifyFromSchema('upload')).toBe('mutating');
  });

  test('detects mutating from required complex object property', () => {
    cacheToolSchemas([{
      name: 'process_batch',
      description: 'Process a batch',
      inputSchema: {
        type: 'object',
        properties: {
          batch: { type: 'object', properties: { items: { type: 'array' } } },
        },
        required: ['batch'],
      },
    }]);
    expect(classifyFromSchema('process_batch')).toBe('mutating');
  });

  test('detects mutating from required array property', () => {
    cacheToolSchemas([{
      name: 'import_records',
      description: 'Import records',
      inputSchema: {
        type: 'object',
        properties: {
          records: { type: 'array', items: { type: 'object' } },
        },
        required: ['records'],
      },
    }]);
    expect(classifyFromSchema('import_records')).toBe('mutating');
  });

  test('detects readonly from filter/pagination only', () => {
    cacheToolSchemas([{
      name: 'search_items',
      description: 'Search items',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    }]);
    expect(classifyFromSchema('search_items')).toBe('readonly');
  });

  test('returns null for inconclusive schema (no recognized properties)', () => {
    cacheToolSchemas([{
      name: 'ambiguous',
      description: 'Could be anything',
      inputSchema: {
        type: 'object',
        properties: { foo: { type: 'string' }, bar: { type: 'number' } },
      },
    }]);
    expect(classifyFromSchema('ambiguous')).toBeNull();
  });

  test('write property overrides read properties', () => {
    cacheToolSchemas([{
      name: 'upsert',
      description: 'Upsert with filter',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string' },
          data: { type: 'object' },
          limit: { type: 'number' },
        },
      },
    }]);
    expect(classifyFromSchema('upsert')).toBe('mutating');
  });

  test('handles schema without properties field', () => {
    cacheToolSchemas([{
      name: 'bare_tool',
      description: 'No properties',
      inputSchema: { type: 'object' },
    }]);
    expect(classifyFromSchema('bare_tool')).toBeNull();
  });

  test('cacheToolSchemas clears previous cache', () => {
    cacheToolSchemas([{
      name: 'tool_a',
      description: 'A',
      inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    }]);
    expect(classifyFromSchema('tool_a')).toBe('mutating');

    // Re-cache with different tools
    cacheToolSchemas([{
      name: 'tool_b',
      description: 'B',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
    }]);
    expect(classifyFromSchema('tool_a')).toBeNull(); // Cleared
    expect(classifyFromSchema('tool_b')).toBe('readonly');
  });

  test('detects SQL/query/command properties as mutating', () => {
    cacheToolSchemas([{
      name: 'run_sql',
      description: 'Run SQL',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
    }]);
    expect(classifyFromSchema('run_sql')).toBe('mutating');
  });

  test('detects message property as mutating', () => {
    cacheToolSchemas([{
      name: 'send_notification',
      description: 'Send notification',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' }, channel: { type: 'string' } },
        required: ['message'],
      },
    }]);
    expect(classifyFromSchema('send_notification')).toBe('mutating');
  });
});

// =============================================================================
// MUTATION CLASSIFICATION (integrated — schema + verb + arg fallback)
// =============================================================================

describe('classifyMutationType', () => {
  beforeEach(() => {
    clearSchemaCache();
  });

  // --- Schema takes priority over verb ---

  test('schema overrides verb heuristic: read_graph with filter schema → readonly', () => {
    cacheToolSchemas([{
      name: 'read_graph',
      description: 'Read the knowledge graph',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    }]);
    // "read" verb would make it readonly anyway, but schema confirms
    expect(classifyMutationType('read_graph', {})).toBe('readonly');
  });

  test('schema overrides ambiguous verb: open_nodes with no write props → falls through to verb', () => {
    cacheToolSchemas([{
      name: 'open_nodes',
      description: 'Open specific nodes',
      inputSchema: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' } } },
        required: ['names'],
      },
    }]);
    // Schema: required array of strings → mutating (complex required type)
    expect(classifyMutationType('open_nodes', { names: ['A'] })).toBe('mutating');
  });

  // --- Mutating verbs (no schema) ---

  test('write_file → mutating', () => {
    expect(classifyMutationType('write_file', { path: '/tmp/test.txt', content: 'hello' })).toBe('mutating');
  });

  test('create_database → mutating', () => {
    expect(classifyMutationType('create_database', { name: 'mydb' })).toBe('mutating');
  });

  test('delete_resource → mutating', () => {
    expect(classifyMutationType('delete_resource', { id: '123' })).toBe('mutating');
  });

  test('remove_item → mutating', () => {
    expect(classifyMutationType('remove_item', { key: 'x' })).toBe('mutating');
  });

  test('execute_command → mutating', () => {
    expect(classifyMutationType('execute_command', { command: 'ls' })).toBe('mutating');
  });

  test('run_script → mutating', () => {
    expect(classifyMutationType('run_script', { script: 'build.sh' })).toBe('mutating');
  });

  test('update_config → mutating', () => {
    expect(classifyMutationType('update_config', { key: 'port', value: '3000' })).toBe('mutating');
  });

  test('deploy_app → mutating', () => {
    expect(classifyMutationType('deploy_app', { app: 'myapp' })).toBe('mutating');
  });

  // --- Readonly verbs ---

  test('read_file → readonly', () => {
    expect(classifyMutationType('read_file', { path: '/tmp/test.txt' })).toBe('readonly');
  });

  test('get_schema → readonly', () => {
    expect(classifyMutationType('get_schema', { table: 'users' })).toBe('readonly');
  });

  test('list_files → readonly', () => {
    expect(classifyMutationType('list_files', { directory: '/tmp' })).toBe('readonly');
  });

  test('search_code → readonly', () => {
    expect(classifyMutationType('search_code', { pattern: 'TODO' })).toBe('readonly');
  });

  test('describe_table → readonly', () => {
    expect(classifyMutationType('describe_table', { name: 'users' })).toBe('readonly');
  });

  test('health_check → readonly', () => {
    expect(classifyMutationType('health_check', {})).toBe('readonly');
  });

  test('inspect_container → readonly', () => {
    expect(classifyMutationType('inspect_container', { id: 'abc' })).toBe('readonly');
  });

  // --- Meta-tools ---

  test('governance_bump_authority → readonly', () => {
    expect(classifyMutationType('governance_bump_authority', { reason: 'test' })).toBe('readonly');
  });

  test('governance_status → readonly', () => {
    expect(classifyMutationType('governance_status', {})).toBe('readonly');
  });

  // --- Arg-based fallback ---

  test('unknown tool with content arg → mutating', () => {
    expect(classifyMutationType('custom_tool', { content: 'hello world' })).toBe('mutating');
  });

  test('unknown tool with sql DELETE → mutating', () => {
    expect(classifyMutationType('run_query', { sql: 'DELETE FROM users WHERE id = 1' })).toBe('mutating');
  });

  test('unknown tool with sql INSERT → mutating', () => {
    expect(classifyMutationType('custom_sql', { query: 'INSERT INTO logs VALUES (1)' })).toBe('mutating');
  });

  // --- Default fallback ---

  test('unknown tool with empty args → mutating (deny-by-default)', () => {
    expect(classifyMutationType('something_weird', {})).toBe('mutating');
  });

  test('unknown tool with numeric args → mutating (deny-by-default)', () => {
    expect(classifyMutationType('compute', { x: 42, y: 7, flag: true })).toBe('mutating');
  });

  // --- Normalization ---

  test('camelCase writeFile → mutating', () => {
    expect(classifyMutationType('writeFile', { path: '/tmp/a.txt' })).toBe('mutating');
  });

  test('dash-case delete-resource → mutating', () => {
    expect(classifyMutationType('delete-resource', { id: '5' })).toBe('mutating');
  });

  test('UPPERCASE WRITE_FILE → mutating', () => {
    expect(classifyMutationType('WRITE_FILE', { path: '/tmp/a.txt' })).toBe('mutating');
  });

  test('camelCase getStatus → readonly', () => {
    expect(classifyMutationType('getStatus', {})).toBe('readonly');
  });

  test('mixed case listFiles → readonly', () => {
    expect(classifyMutationType('listFiles', { dir: '/tmp' })).toBe('readonly');
  });

  // --- Real-world MCP server tools (schema-based) ---

  test('memory server: create_entities with entities schema → mutating', () => {
    cacheToolSchemas([{
      name: 'create_entities',
      description: 'Create multiple new entities in the knowledge graph',
      inputSchema: {
        type: 'object',
        properties: {
          entities: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, entityType: { type: 'string' }, observations: { type: 'array' } } } },
        },
        required: ['entities'],
      },
    }]);
    expect(classifyMutationType('create_entities', { entities: [] })).toBe('mutating');
  });

  test('memory server: search_nodes with query schema → readonly', () => {
    cacheToolSchemas([{
      name: 'search_nodes',
      description: 'Search for nodes',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }]);
    // No write properties, no recognized read properties → falls through to verb
    // "search" is a READONLY_VERB → readonly
    expect(classifyMutationType('search_nodes', { query: 'test' })).toBe('readonly');
  });

  test('memory server: add_observations with observations schema → mutating', () => {
    cacheToolSchemas([{
      name: 'add_observations',
      description: 'Add observations to entities',
      inputSchema: {
        type: 'object',
        properties: {
          observations: { type: 'array', items: { type: 'object' } },
        },
        required: ['observations'],
      },
    }]);
    expect(classifyMutationType('add_observations', { observations: [] })).toBe('mutating');
  });
});
