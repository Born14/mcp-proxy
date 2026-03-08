/**
 * Schema Validation — Unit Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { validateToolArgs } from '../src/schema-check.js';
import { cacheToolSchemas, clearSchemaCache } from '../src/fingerprint.js';

describe('Schema Validation', () => {

  beforeEach(() => {
    clearSchemaCache();
  });

  afterEach(() => {
    clearSchemaCache();
  });

  test('returns valid when no schema cached', () => {
    const result = validateToolArgs('unknown_tool', { anything: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('detects missing required fields', () => {
    cacheToolSchemas([{
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }]);

    const result = validateToolArgs('read_file', {});
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('path');
    expect(result.errors[0]).toContain('required');
  });

  test('passes when required fields present', () => {
    cacheToolSchemas([{
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }]);

    const result = validateToolArgs('read_file', { path: '/tmp/test.txt' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('detects type mismatch', () => {
    cacheToolSchemas([{
      name: 'write_file',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }]);

    const result = validateToolArgs('write_file', { path: '/tmp/test.txt', content: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('content') && e.includes('string'))).toBe(true);
  });

  test('allows integer where number expected', () => {
    cacheToolSchemas([{
      name: 'set_count',
      description: 'Set count',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
    }]);

    const result = validateToolArgs('set_count', { count: 5 });
    expect(result.valid).toBe(true);
  });

  test('validates array type', () => {
    cacheToolSchemas([{
      name: 'batch',
      description: 'Batch ops',
      inputSchema: {
        type: 'object',
        properties: { items: { type: 'array' } },
        required: ['items'],
      },
    }]);

    expect(validateToolArgs('batch', { items: [1, 2, 3] }).valid).toBe(true);
    expect(validateToolArgs('batch', { items: 'not-array' }).valid).toBe(false);
  });

  test('validates boolean type', () => {
    cacheToolSchemas([{
      name: 'toggle',
      description: 'Toggle',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
    }]);

    expect(validateToolArgs('toggle', { enabled: true }).valid).toBe(true);
    expect(validateToolArgs('toggle', { enabled: 'yes' }).valid).toBe(false);
  });

  test('allows extra fields not in schema', () => {
    cacheToolSchemas([{
      name: 'simple',
      description: 'Simple',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    }]);

    const result = validateToolArgs('simple', { name: 'test', extra: 42 });
    expect(result.valid).toBe(true);
  });

  test('handles schema without properties', () => {
    cacheToolSchemas([{
      name: 'no_props',
      description: 'No props',
      inputSchema: { type: 'object' },
    }]);

    const result = validateToolArgs('no_props', { anything: true });
    expect(result.valid).toBe(true);
  });

  test('handles schema without required array', () => {
    cacheToolSchemas([{
      name: 'optional_only',
      description: 'Optional',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    }]);

    const result = validateToolArgs('optional_only', {});
    expect(result.valid).toBe(true);
  });

  test('multiple errors reported together', () => {
    cacheToolSchemas([{
      name: 'multi',
      description: 'Multi',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name', 'count'],
      },
    }]);

    const result = validateToolArgs('multi', {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
