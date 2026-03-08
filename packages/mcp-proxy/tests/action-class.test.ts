/**
 * Action Class Classification — Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import { classifyActionClass } from '../src/action-class.js';

describe('Action Class Classification', () => {

  test('returns undefined for empty changes', () => {
    expect(classifyActionClass([])).toBeUndefined();
  });

  test('returns undefined for null/undefined', () => {
    expect(classifyActionClass(null as any)).toBeUndefined();
    expect(classifyActionClass(undefined as any)).toBeUndefined();
  });

  // --- schema_migration ---

  test('detects schema_migration from .sql file', () => {
    expect(classifyActionClass([
      { file: 'migrations/001_add_users.sql', content: 'CREATE TABLE users (id SERIAL)' },
    ])).toBe('schema_migration');
  });

  test('detects schema_migration from migration path', () => {
    expect(classifyActionClass([
      { file: 'src/migration/add-index.ts', content: 'db.exec("CREATE INDEX...")' },
    ])).toBe('schema_migration');
  });

  // --- global_replace ---

  test('detects global_replace: same pattern across 3+ files', () => {
    const search = 'const OLD_API = "v1"';
    expect(classifyActionClass([
      { file: 'a.js', search, replace: 'const NEW_API = "v2"' },
      { file: 'b.js', search, replace: 'const NEW_API = "v2"' },
      { file: 'c.js', search, replace: 'const NEW_API = "v2"' },
    ])).toBe('global_replace');
  });

  test('no global_replace with only 2 files', () => {
    const search = 'const OLD_API = "v1"';
    expect(classifyActionClass([
      { file: 'a.js', search, replace: 'const NEW_API = "v2"' },
      { file: 'b.js', search, replace: 'const NEW_API = "v2"' },
    ])).not.toBe('global_replace');
  });

  test('no global_replace with short search patterns', () => {
    expect(classifyActionClass([
      { file: 'a.js', search: 'x', replace: 'y' },
      { file: 'b.js', search: 'x', replace: 'y' },
      { file: 'c.js', search: 'x', replace: 'y' },
    ])).not.toBe('global_replace');
  });

  // --- rewrite_page ---

  test('detects rewrite_page: content without search (new file)', () => {
    expect(classifyActionClass([
      { file: 'new-page.html', content: '<html><body>New page</body></html>' },
    ])).toBe('rewrite_page');
  });

  test('detects rewrite_page: large replacement (>50% expansion)', () => {
    const search = 'x'.repeat(201);
    const replace = 'y'.repeat(302); // > 1.5x the search length
    expect(classifyActionClass([
      { file: 'big.js', search, replace },
    ])).toBe('rewrite_page');
  });

  test('no rewrite_page for small replacements', () => {
    expect(classifyActionClass([
      { file: 'small.js', search: 'color: red;', replace: 'color: blue;' },
    ])).not.toBe('rewrite_page');
  });

  // --- style_overhaul ---

  test('detects style_overhaul: >5 CSS properties', () => {
    expect(classifyActionClass([
      { file: 'styles.css', search: '/* old */', replace: `
        color: red;
        font-size: 14px;
        margin: 10px;
        padding: 5px;
        background: white;
        border: 1px solid black;
      `},
    ])).toBe('style_overhaul');
  });

  test('no style_overhaul with 5 or fewer CSS properties', () => {
    expect(classifyActionClass([
      { file: 'styles.css', search: '/* old */', replace: `
        color: red;
        font-size: 14px;
        margin: 10px;
      `},
    ])).not.toBe('style_overhaul');
  });

  // --- unrelated_edit ---

  test('detects unrelated_edit: >50% files not in predicate surface', () => {
    expect(classifyActionClass(
      [
        { file: 'utils.js', search: 'a', replace: 'b' },
        { file: 'helpers.js', search: 'c', replace: 'd' },
        { file: 'server.js', search: 'e', replace: 'f' },
      ],
      ['server.js'],  // only server.js is predicate-referenced
    )).toBe('unrelated_edit');
  });

  test('no unrelated_edit when most files are predicate-referenced', () => {
    expect(classifyActionClass(
      [
        { file: 'server.js', search: 'a', replace: 'b' },
        { file: 'routes.js', search: 'c', replace: 'd' },
      ],
      ['server.js', 'routes.js'],
    )).not.toBe('unrelated_edit');
  });

  test('no unrelated_edit without predicateFiles', () => {
    expect(classifyActionClass([
      { file: 'random.js', search: 'a', replace: 'b' },
    ])).not.toBe('unrelated_edit');
  });

  // --- PRIORITY ---

  test('schema_migration takes priority over rewrite_page', () => {
    expect(classifyActionClass([
      { file: 'migrations/001.sql', content: 'ALTER TABLE users ADD COLUMN age INTEGER' },
    ])).toBe('schema_migration');
  });

  test('returns undefined for ordinary edits', () => {
    expect(classifyActionClass([
      { file: 'server.js', search: 'port: 3000', replace: 'port: 4000' },
    ])).toBeUndefined();
  });
});
