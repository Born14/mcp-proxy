/**
 * Smart defaults tests — v0.7.0.
 * Schema validation defaults to 'warn' (catches hallucinated parameters).
 */
import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../src/index.js';

describe('smart defaults', () => {
  test('schema defaults to warn', () => {
    const config = parseArgs(['--upstream', 'echo test']);
    expect(config).not.toBeNull();
    expect(config!.schemaMode).toBe('warn');
  });

  test('schema can be explicitly set to off', () => {
    const config = parseArgs(['--upstream', 'echo test', '--schema', 'off']);
    expect(config).not.toBeNull();
    expect(config!.schemaMode).toBe('off');
  });

  test('schema can be explicitly set to strict', () => {
    const config = parseArgs(['--upstream', 'echo test', '--schema', 'strict']);
    expect(config).not.toBeNull();
    expect(config!.schemaMode).toBe('strict');
  });

  test('webhook URLs parsed from CLI', () => {
    const config = parseArgs([
      '--upstream', 'echo test',
      '--webhook', 'https://example.com/hook1',
      '--webhook', 'https://example.com/hook2',
    ]);
    expect(config).not.toBeNull();
    expect(config!.webhooks).toEqual([
      'https://example.com/hook1',
      'https://example.com/hook2',
    ]);
  });

  test('webhooks empty by default', () => {
    const config = parseArgs(['--upstream', 'echo test']);
    expect(config).not.toBeNull();
    expect(config!.webhooks).toEqual([]);
  });
});
