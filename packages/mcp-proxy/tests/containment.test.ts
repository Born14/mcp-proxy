/**
 * Tier 3: Containment Attribution Tests
 * ======================================
 *
 * Proves:
 *   attributeToolCallHeuristic: direct/scaffolding/unexplained/no_intent classification
 *   computeToolTarget: canonical target extraction with priority chain
 *   Match hygiene: min token length, whitespace boundaries, structured values
 *   Meta-tool handlers: declare_intent, clear_intent lifecycle
 *   Receipt annotation: attribution + match detail on receipts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeToolTarget,
  attributeToolCallHeuristic,
} from '../src/governance.js';
import {
  handleDeclareIntent,
  handleClearIntent,
} from '../src/meta-tools.js';
import {
  ensureStateDir,
  loadIntent,
} from '../src/state.js';
import type { IntentContext, ProxyState, ConvergenceTracker } from '../src/types.js';
import type { Mutation } from '@sovereign-labs/kernel/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-contain-'));
  ensureStateDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMutation(verb: string, target: string, args?: Record<string, unknown>): Mutation {
  return { verb, target, capturedAt: Date.now(), args: args ?? {} };
}

function makeIntent(goal: string, predicates: Array<{ type: string; [k: string]: string }>): IntentContext {
  return {
    goal,
    predicates: predicates.map(p => {
      const { type, ...rest } = p;
      return { type, fields: rest };
    }),
    declaredAt: Date.now(),
    version: 1,
  };
}

function makeState(overrides?: Partial<ProxyState>): ProxyState {
  return {
    controller: { id: 'test-ctrl', establishedAt: Date.now() },
    authority: { controllerId: 'test-ctrl', epoch: 0, lastBumpedAt: Date.now(), activeSessionEpoch: 0 },
    constraints: [],
    receiptSeq: 0,
    lastReceiptHash: 'genesis',
    convergence: { failureSignatures: new Map(), toolTargetTimestamps: new Map() },
    ...overrides,
  };
}

// =============================================================================
// computeToolTarget
// =============================================================================

describe('computeToolTarget', () => {
  test('prefers args.path over args.file', () => {
    const target = computeToolTarget('edit', { path: '/a.js', file: '/b.js' });
    expect(target).toBe('/a.js');
  });

  test('falls back to args.file', () => {
    const target = computeToolTarget('edit', { file: '/b.js' });
    expect(target).toBe('/b.js');
  });

  test('uses args.url when no path/file', () => {
    const target = computeToolTarget('fetch', { url: 'https://example.com' });
    expect(target).toBe('https://example.com');
  });

  test('uses args.selector', () => {
    const target = computeToolTarget('query', { selector: '.roster-link' });
    expect(target).toBe('.roster-link');
  });

  test('uses args.table', () => {
    const target = computeToolTarget('sql', { table: 'players' });
    expect(target).toBe('players');
  });

  test('uses args.key', () => {
    const target = computeToolTarget('get', { key: 'session:abc' });
    expect(target).toBe('session:abc');
  });

  test('uses args.name', () => {
    const target = computeToolTarget('tool', { name: 'my-tool' });
    expect(target).toBe('my-tool');
  });

  test('falls back to JSON.stringify truncated to 200 chars', () => {
    const longArgs: Record<string, string> = {};
    for (let i = 0; i < 50; i++) longArgs[`key${i}`] = `value${i}`;
    const target = computeToolTarget('unknown', longArgs);
    expect(target.length).toBeLessThanOrEqual(200);
  });

  test('handles empty args', () => {
    const target = computeToolTarget('tool', {});
    expect(typeof target).toBe('string');
  });

  test('non-string values fall through to JSON fallback', () => {
    const target = computeToolTarget('tool', { path: 42 as unknown as string });
    // path: 42 is not a string, so it falls through priority chain to JSON.stringify
    expect(target).toBe('{"path":42}');
  });
});

// =============================================================================
// attributeToolCallHeuristic
// =============================================================================

describe('attributeToolCallHeuristic', () => {
  test('no intent → no_intent', () => {
    const result = attributeToolCallHeuristic(makeMutation('write_file', '/tmp/test.js'), undefined);
    expect(result.class).toBe('no_intent');
    expect(result.match).toBeUndefined();
  });

  test('direct match: predicate selector in mutation target', () => {
    const intent = makeIntent('Change link color', [
      { type: 'css', selector: '.roster-link', property: 'color', expected: 'green' },
    ]);
    const mutation = makeMutation('edit_file', '.roster-link', { path: '/styles.css' });
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
    expect(result.match?.predicateType).toBe('css');
    expect(result.match?.key).toBe('selector');
    expect(result.match?.value).toBe('.roster-link');
  });

  test('direct match: predicate path in mutation args', () => {
    const intent = makeIntent('Fix API', [
      { type: 'http', path: '/api/players', method: 'GET' },
    ]);
    const mutation = makeMutation('write_file', '/server.js', { path: '/api/players' });
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
    expect(result.match?.key).toBe('path');
    expect(result.match?.value).toBe('/api/players');
  });

  test('bidirectional: mutation target route in predicate path field', () => {
    const intent = makeIntent('Fix API', [
      { type: 'http', path: '/api/players' },
    ]);
    const mutation = makeMutation('edit_file', '/api/players/details');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('bidirectional NOT applied to generic words', () => {
    const intent = makeIntent('Change color', [
      { type: 'css', selector: 'body', property: 'color', expected: 'ordered' },
    ]);
    const mutation = makeMutation('write_file', '/tmp/reordered.js');
    const result = attributeToolCallHeuristic(mutation, intent);
    // "ordered" is generic word — not structured, no bidirectional
    expect(result.class).not.toBe('direct');
  });

  test('infrastructure verb → scaffolding', () => {
    const intent = makeIntent('Deploy app', [
      { type: 'http', path: '/health' },
    ]);
    const mutation = makeMutation('deploy', '/app');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('scaffolding');
  });

  test('restart → scaffolding', () => {
    const intent = makeIntent('Fix app', [
      { type: 'http', path: '/' },
    ]);
    const mutation = makeMutation('restart', 'containers');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('scaffolding');
  });

  test('build → scaffolding', () => {
    const intent = makeIntent('Build', [{ type: 'content', file: 'index.js' }]);
    const mutation = makeMutation('build', 'project');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('scaffolding');
  });

  test('no match → unexplained', () => {
    const intent = makeIntent('Change color', [
      { type: 'css', selector: '.roster-link', property: 'color' },
    ]);
    const mutation = makeMutation('write_file', '/tmp/unrelated.js', { path: '/tmp/unrelated.js' });
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });

  test('multiple predicates: first match wins', () => {
    const intent = makeIntent('Multiple changes', [
      { type: 'css', selector: '.header' },
      { type: 'css', selector: '.footer' },
    ]);
    const mutation = makeMutation('edit_file', '.footer { color: red }', { path: '/styles.css' });
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
    expect(result.match?.value).toBe('.footer');
  });

  test('case-insensitive matching', () => {
    const intent = makeIntent('Fix Body', [
      { type: 'css', selector: 'BODY' },
    ]);
    const mutation = makeMutation('edit_file', 'body { background: red }');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('empty predicate fields → unexplained', () => {
    const intent: IntentContext = {
      goal: 'Do something',
      predicates: [{ type: 'css', fields: {} }],
      declaredAt: Date.now(),
      version: 1,
    };
    const mutation = makeMutation('write_file', '/tmp/test.js');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });

  // --- Match hygiene ---

  test('short field "id" (3 chars, not structured) → unexplained', () => {
    const intent = makeIntent('Fix thing', [
      { type: 'db', column: 'id' },
    ]);
    const mutation = makeMutation('write_file', '/tmp/identity.js', { path: '/tmp/identity.js' });
    const result = attributeToolCallHeuristic(mutation, intent);
    // "id" is 2 chars, not structured — should be skipped
    expect(result.class).not.toBe('direct');
  });

  test('short structured "/x" (2 chars but starts with /) → CAN match', () => {
    const intent = makeIntent('Fix route', [
      { type: 'http', path: '/x' },
    ]);
    const mutation = makeMutation('edit_file', '/x');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('"color" does NOT match "background-color" (hyphen is not boundary)', () => {
    const intent = makeIntent('Change color', [
      { type: 'css', property: 'color' },
    ]);
    // Target contains "background-color" — "color" should NOT match via word boundary
    const mutation = makeMutation('edit_file', 'background-color: red', { path: '/style.css' });
    const result = attributeToolCallHeuristic(mutation, intent);
    // The property "color" is alphanumeric — uses whitespace boundary
    // "background-color" doesn't have whitespace before "color"
    // So this should NOT be direct (unless the target itself contains bare "color")
    // In this case the target IS "background-color: red" which contains "color" but
    // only after a hyphen, not whitespace/start. So it depends on implementation.
    // The plan says: `"color"` does NOT match `"background-color"`
    expect(result.class).not.toBe('direct');
  });

  test('"color" DOES match " color " (whitespace boundary)', () => {
    const intent = makeIntent('Change color', [
      { type: 'css', property: 'color' },
    ]);
    const mutation = makeMutation('edit_file', 'the color is red');
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });
});

// =============================================================================
// META-TOOLS: declare_intent, clear_intent
// =============================================================================

describe('governance_declare_intent', () => {
  test('stores intent and returns summary', () => {
    const state = makeState();
    const result = handleDeclareIntent({
      goal: 'Change roster link color',
      predicates: [
        { type: 'css', selector: '.roster-link', property: 'color', expected: 'green' },
      ],
    }, state, tmpDir);

    expect(state.intent).toBeDefined();
    expect(state.intent!.goal).toBe('Change roster link color');
    expect(state.intent!.predicates).toHaveLength(1);
    expect(state.intent!.predicates[0].type).toBe('css');
    expect(state.intent!.predicates[0].fields.selector).toBe('.roster-link');

    const content = JSON.parse(result.content[0].text);
    expect(content.predicateCount).toBe(1);
    expect(content.goal).toBe('Change roster link color');
    expect(content.previousAgeMs).toBeUndefined();
  });

  test('overwrites prior intent and returns previousAgeMs', () => {
    const state = makeState();
    // First intent
    handleDeclareIntent({ goal: 'First', predicates: [{ type: 'a' }] }, state, tmpDir);
    const firstDeclaredAt = state.intent!.declaredAt;

    // Small delay to ensure non-zero age
    const delay = 10;
    const startWait = Date.now();
    while (Date.now() - startWait < delay) { /* spin */ }

    // Second intent
    const result = handleDeclareIntent({ goal: 'Second', predicates: [{ type: 'b' }] }, state, tmpDir);
    const content = JSON.parse(result.content[0].text);

    expect(state.intent!.goal).toBe('Second');
    expect(content.previousAgeMs).toBeGreaterThanOrEqual(0);
    expect(content.predicateCount).toBe(1);
  });

  test('flattens predicate fields correctly (skips non-strings)', () => {
    const state = makeState();
    handleDeclareIntent({
      goal: 'Test',
      predicates: [
        { type: 'css', selector: '.foo', count: 42, nested: { a: 1 } },
      ],
    }, state, tmpDir);

    expect(state.intent!.predicates[0].fields.selector).toBe('.foo');
    // Non-string values should be skipped
    expect(state.intent!.predicates[0].fields).not.toHaveProperty('count');
    expect(state.intent!.predicates[0].fields).not.toHaveProperty('nested');
  });

  test('stores grounding context and returns summary', () => {
    const state = makeState();
    const now = Date.now();
    const result = handleDeclareIntent({
      goal: 'Grounded change',
      predicates: [{ type: 'css', selector: 'body' }],
      grounding: {
        facts: { cssRules: ['body { color: red }'], routes: ['/'] },
        observedAt: now,
      },
    }, state, tmpDir);

    expect(state.intent!.grounding).toBeDefined();
    expect(state.intent!.grounding!.facts).toHaveProperty('cssRules');
    expect(state.intent!.grounding!.observedAt).toBe(now);

    const content = JSON.parse(result.content[0].text);
    expect(content.grounding).not.toBeNull();
    expect(content.grounding.factCount).toBe(2);
  });

  test('persists intent to intent.json', () => {
    const state = makeState();
    handleDeclareIntent({
      goal: 'Persisted',
      predicates: [{ type: 'test' }],
    }, state, tmpDir);

    const loaded = loadIntent(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe('Persisted');
    expect(loaded!.version).toBe(1);
  });
});

describe('governance_clear_intent', () => {
  test('clears intent and deletes intent.json', () => {
    const state = makeState();
    // First declare
    handleDeclareIntent({ goal: 'X', predicates: [] }, state, tmpDir);
    expect(state.intent).toBeDefined();

    // Then clear
    const result = handleClearIntent(state, tmpDir);
    expect(state.intent).toBeUndefined();

    const content = JSON.parse(result.content[0].text);
    expect(content.cleared).toBe(true);

    const loaded = loadIntent(tmpDir);
    expect(loaded).toBeNull();
  });

  test('clearing when no intent returns cleared: false', () => {
    const state = makeState();
    const result = handleClearIntent(state, tmpDir);
    const content = JSON.parse(result.content[0].text);
    expect(content.cleared).toBe(false);
  });
});

// =============================================================================
// RECEIPT ANNOTATION
// =============================================================================

describe('receipt attribution fields', () => {
  test('attribution + match detail present when direct', () => {
    const intent = makeIntent('Fix link', [
      { type: 'css', selector: '.roster-link' },
    ]);
    const mutation = makeMutation('edit_file', '.roster-link { }');
    const result = attributeToolCallHeuristic(mutation, intent);

    expect(result.class).toBe('direct');
    expect(result.match).toBeDefined();
    expect(result.match!.predicateType).toBe('css');
    expect(result.match!.key).toBe('selector');
    expect(result.match!.value).toBe('.roster-link');
  });

  test('no match detail when scaffolding', () => {
    // Use a predicate whose fields won't match the mutation target
    const intent = makeIntent('Deploy', [{ type: 'config', key: 'database_url' }]);
    const mutation = makeMutation('deploy', '/app');
    const result = attributeToolCallHeuristic(mutation, intent);

    expect(result.class).toBe('scaffolding');
    expect(result.match).toBeUndefined();
  });

  test('no match detail when unexplained', () => {
    const intent = makeIntent('Fix', [{ type: 'css', selector: '.header' }]);
    const mutation = makeMutation('write_file', '/unrelated.txt', { path: '/unrelated.txt' });
    const result = attributeToolCallHeuristic(mutation, intent);

    expect(result.class).toBe('unexplained');
    expect(result.match).toBeUndefined();
  });
});
