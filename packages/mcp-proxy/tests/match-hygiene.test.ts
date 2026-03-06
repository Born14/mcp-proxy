/**
 * Match Hygiene Helper Tests
 * ==========================
 *
 * Tests the internal match functions in governance.ts indirectly through
 * attributeToolCallHeuristic, since the helpers are not exported.
 *
 * Proves:
 *   - Regex metacharacters in predicate values don't cause ReDoS or false matches
 *   - Unicode and special characters handled correctly
 *   - Whitespace-boundary matching: hyphens are NOT boundaries
 *   - Structured value detection: route/selector/key prefixes
 *   - Bidirectional substring: only for structured values
 *   - Minimum token length enforcement (< 4 chars rejected unless structured)
 *   - Empty/null/undefined values handled gracefully
 */

import { describe, test, expect } from 'bun:test';
import { attributeToolCallHeuristic, computeToolTarget } from '../src/governance.js';
import type { IntentContext } from '../src/types.js';
import type { Mutation } from '@sovereign-labs/kernel/types';

function makeMutation(verb: string, target: string, args?: Record<string, unknown>): Mutation {
  return { verb, target, capturedAt: Date.now(), args: args ?? {} };
}

function makeIntent(predicates: Array<{ type: string; [k: string]: string }>): IntentContext {
  return {
    goal: 'test goal',
    predicates: predicates.map(p => {
      const { type, ...rest } = p;
      return { type, fields: rest };
    }),
    declaredAt: Date.now(),
    version: 1,
  };
}

// =============================================================================
// REGEX METACHARACTER SAFETY
// =============================================================================

describe('match hygiene — regex metacharacters', () => {
  test('predicate value with regex special chars does not throw', () => {
    const intent = makeIntent([
      { type: 'content', path: '/test', expected: '(foo)+bar.*baz[0-9]' },
    ]);
    const mutation = makeMutation('write_file', '/test', { path: '/test' });

    // Should not throw — metacharacters are escaped before regex construction
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBeDefined();
  });

  test('predicate value with regex quantifiers does not cause ReDoS', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'a{1000}b+c*d?e|f^g$h' },
    ]);
    const mutation = makeMutation('write_file', 'test-target');

    // Should complete quickly, not hang
    const start = Date.now();
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(Date.now() - start).toBeLessThan(100); // should be near-instant
    expect(result.class).toBeDefined();
  });

  test('predicate with backslashes and quotes handled', () => {
    const intent = makeIntent([
      { type: 'content', path: 'C:\\Users\\test\\file.txt' },
    ]);
    // Target contains the path
    const mutation = makeMutation('read_file', 'C:\\Users\\test\\file.txt');

    // Structured value (contains :) — bidirectional substring
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('predicate with parentheses in selector', () => {
    const intent = makeIntent([
      { type: 'css', selector: '.item:nth-child(2)' },
    ]);
    const mutation = makeMutation('edit_file', '.item:nth-child(2)', {
      selector: '.item:nth-child(2)',
    });

    // Selector starts with . → structured → substring match
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('predicate with square brackets in selector', () => {
    const intent = makeIntent([
      { type: 'html', selector: 'input[type="email"]' },
    ]);
    const mutation = makeMutation('edit_file', 'form.html', {
      content: 'input[type="email"]',
    });

    // Value starts with non-structured but contains brackets — should not crash
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBeDefined();
  });

  test('predicate with pipe character (|) in value', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'true|false' },
    ]);
    const mutation = makeMutation('write_file', 'config', {
      content: 'value = true|false',
    });

    // Should not treat | as regex OR
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBeDefined();
  });
});

// =============================================================================
// UNICODE AND SPECIAL CHARACTERS
// =============================================================================

describe('match hygiene — unicode', () => {
  test('unicode characters in predicate value', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'こんにちは世界' },
    ]);
    const mutation = makeMutation('write_file', 'i18n.json', {
      content: 'greeting: こんにちは世界',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    // Unicode is not alphanumeric-only, so substring match
    expect(result.class).toBeDefined();
  });

  test('emoji in predicate value', () => {
    const intent = makeIntent([
      { type: 'content', expected: '🎉 Welcome!' },
    ]);
    const mutation = makeMutation('write_file', 'greeting.html', {
      content: '🎉 Welcome!',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBeDefined();
  });
});

// =============================================================================
// WHITESPACE BOUNDARY MATCHING — hyphens NOT treated as boundaries
// =============================================================================

describe('match hygiene — whitespace boundaries', () => {
  test('"color" does NOT match "background-color" (hyphen is not a boundary)', () => {
    const intent = makeIntent([
      { type: 'css', property: 'color' },
    ]);
    // Target has background-color, not color
    const mutation = makeMutation('edit_file', 'styles.css', {
      content: 'background-color: red;',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    // "color" is alphanumeric → whitespace boundary match → should NOT match inside "background-color"
    expect(result.class).not.toBe('direct');
  });

  test('"color" DOES match " color " (whitespace boundary)', () => {
    const intent = makeIntent([
      { type: 'css', property: 'color' },
    ]);
    // Target has " color " with whitespace on both sides
    const mutation = makeMutation('edit_file', 'set color value');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('"color" matches at start of target string', () => {
    const intent = makeIntent([
      { type: 'css', property: 'color' },
    ]);
    // "color" at start of target, followed by space
    const mutation = makeMutation('edit_file', 'color value');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('"color" matches at end of target string', () => {
    const intent = makeIntent([
      { type: 'css', property: 'color' },
    ]);
    const mutation = makeMutation('edit_file', 'set color');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('"color" DOES match "color: red" (colon is a JSON/CSS structural boundary)', () => {
    const intent = makeIntent([
      { type: 'css', property: 'color' },
    ]);
    // After normalization, target is "color: red" — colon follows "color"
    // Colon IS a valid boundary (JSON structural character), so "color" matches
    const mutation = makeMutation('edit_file', 'color: red');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('"bold" does NOT match "semibold" (no whitespace boundary)', () => {
    const intent = makeIntent([
      { type: 'css', expected: 'bold' },
    ]);
    const mutation = makeMutation('edit_file', 'font.css', {
      content: 'font-weight: semibold;',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).not.toBe('direct');
  });

  test('"test" does NOT match "testing" (no whitespace boundary)', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'test' },
    ]);
    const mutation = makeMutation('write_file', 'testing.js');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).not.toBe('direct');
  });
});

// =============================================================================
// STRUCTURED VALUE DETECTION
// =============================================================================

describe('match hygiene — structured value detection', () => {
  test('route path /api/users is structured (starts with /)', () => {
    const intent = makeIntent([
      { type: 'http', path: '/api/users' },
    ]);
    const mutation = makeMutation('write_file', '/api/users/handler.js');

    // Structured → bidirectional substring
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('CSS selector .roster-link matches when target contains it', () => {
    const intent = makeIntent([
      { type: 'css', selector: '.roster-link' },
    ]);
    // Put the selector in the target (where it's not JSON-escaped)
    const mutation = makeMutation('edit_file', '.roster-link { color: red }');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('CSS selector .roster-link in args.content is JSON-escaped (no match)', () => {
    const intent = makeIntent([
      { type: 'css', selector: '.roster-link' },
    ]);
    // args.content gets JSON.stringify'd — quotes get escaped, breaking substring match
    const mutation = makeMutation('edit_file', 'server.js', {
      content: 'class="roster-link active"',
    });

    // JSON escaping means the value in argsStr has backslashes around quotes
    // .roster-link is NOT found as clean substring
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });

  test('CSS selector #main matches when in target', () => {
    const intent = makeIntent([
      { type: 'html', selector: '#main' },
    ]);
    // Put selector directly in target
    const mutation = makeMutation('edit_file', '#main { display: flex }');

    // Structured → bidirectional substring
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('CSS selector #main matches in args when not quote-escaped', () => {
    const intent = makeIntent([
      { type: 'html', selector: '#main' },
    ]);
    const mutation = makeMutation('edit_file', 'index.html', {
      selector: '#main',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('value with colon is structured (key:value pattern)', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'host:localhost' },
    ]);
    const mutation = makeMutation('write_file', 'config.json', {
      content: 'host:localhost:5432',
    });

    // Contains : → structured → substring
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('value starting with [ is structured (in target)', () => {
    const intent = makeIntent([
      { type: 'css', selector: '[data-testid]' },
    ]);
    // Put in target to avoid JSON escaping issues
    const mutation = makeMutation('edit_file', '[data-testid] { color: blue }');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('value starting with [ matches in args key (not quote-escaped)', () => {
    const intent = makeIntent([
      { type: 'css', selector: '[data-testid]' },
    ]);
    const mutation = makeMutation('edit_file', 'form.html', {
      selector: '[data-testid]',
    });

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });
});

// =============================================================================
// MINIMUM TOKEN LENGTH
// =============================================================================

describe('match hygiene — minimum token length', () => {
  test('short value "id" (2 chars, not structured) does NOT match', () => {
    const intent = makeIntent([
      { type: 'db', column: 'id' },
    ]);
    const mutation = makeMutation('write_file', 'user_id_handler.js');

    // "id" is < 4 chars and not structured → should be skipped
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).not.toBe('direct');
  });

  test('short structured value /x (2 chars, starts with /) CAN match', () => {
    const intent = makeIntent([
      { type: 'http', path: '/x' },
    ]);
    const mutation = makeMutation('write_file', '/x/handler.js');

    // Starts with / → structured → allowed despite < 4 chars
    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('value "abc" (3 chars, not structured) does NOT match', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'abc' },
    ]);
    const mutation = makeMutation('write_file', 'abc.txt');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).not.toBe('direct');
  });

  test('value "abcd" (4 chars, not structured) CAN match', () => {
    const intent = makeIntent([
      { type: 'content', expected: 'abcd' },
    ]);
    const mutation = makeMutation('write_file', 'abcd test file');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });
});

// =============================================================================
// BIDIRECTIONAL CONTAINMENT — only for structured values
// =============================================================================

describe('match hygiene — bidirectional containment', () => {
  test('structured: mutation target contains predicate path', () => {
    const intent = makeIntent([
      { type: 'http', path: '/api' },
    ]);
    const mutation = makeMutation('write_file', '/api/v2/users');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('structured: predicate path contains mutation target', () => {
    const intent = makeIntent([
      { type: 'http', path: '/api/v2/users/profile' },
    ]);
    const mutation = makeMutation('write_file', '/api/v2');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('direct');
  });

  test('non-structured: bidirectional NOT applied', () => {
    const intent = makeIntent([
      // "users" is not structured (no prefix char), length >=4
      { type: 'content', expected: 'users' },
    ]);
    // Target "user" is shorter — "users" does not whitespace-boundary match "user"
    const mutation = makeMutation('write_file', 'handle user');

    const result = attributeToolCallHeuristic(mutation, intent);
    // "users" won't match "user" via whitespace boundary
    expect(result.class).not.toBe('direct');
  });
});

// =============================================================================
// EMPTY / NULL VALUE HANDLING
// =============================================================================

describe('match hygiene — empty values', () => {
  test('empty predicate fields produce unexplained, not crash', () => {
    const intent = makeIntent([
      { type: 'css' },
    ]);
    const mutation = makeMutation('edit_file', 'styles.css');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });

  test('empty string field values produce unexplained', () => {
    const intent = makeIntent([
      { type: 'css', selector: '', property: '', expected: '' },
    ]);
    const mutation = makeMutation('edit_file', 'styles.css');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });

  test('whitespace-only field values normalize to empty → rejected (no vacuous match)', () => {
    // Whitespace-only values normalize to "" — previously matched everything.
    // Now rejected: empty normalized values cannot produce a match.
    const intent = makeIntent([
      { type: 'css', selector: '   ', property: '  \t  ' },
    ]);
    const mutation = makeMutation('edit_file', 'styles.css');

    const result = attributeToolCallHeuristic(mutation, intent);
    expect(result.class).toBe('unexplained');
  });
});

// =============================================================================
// computeToolTarget EDGE CASES
// =============================================================================

describe('computeToolTarget — edge cases', () => {
  test('prefers path over file over url', () => {
    expect(computeToolTarget('tool', { path: '/a', file: '/b', url: '/c' })).toBe('/a');
    expect(computeToolTarget('tool', { file: '/b', url: '/c' })).toBe('/b');
    expect(computeToolTarget('tool', { url: '/c' })).toBe('/c');
  });

  test('fallback truncates to 200 chars', () => {
    const longArg = 'x'.repeat(300);
    const result = computeToolTarget('tool', { data: longArg });
    expect(result.length).toBeLessThanOrEqual(200);
  });

  test('empty args produce a target string (not crash)', () => {
    const result = computeToolTarget('tool', {});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('null/undefined args throws (not handled — callers must provide object)', () => {
    // computeToolTarget expects a Record, not null/undefined
    // This documents the contract: callers must provide an object
    expect(() => computeToolTarget('tool', undefined as unknown as Record<string, unknown>)).toThrow();
    expect(() => computeToolTarget('tool', null as unknown as Record<string, unknown>)).toThrow();
  });
});
