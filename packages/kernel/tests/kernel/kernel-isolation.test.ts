/**
 * Kernel Isolation Guard — CI Test
 * ==================================
 *
 * Verifies the governance kernel has zero domain imports.
 * A kernel that imports domain code is a broken kernel — same as a failing test.
 *
 * This test reads every .ts file in the kernel's source directories and asserts
 * that no import statement references forbidden paths.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const KERNEL_DIR = join(__dirname, '../../src/kernel');

// Collect all .ts files in the kernel directory
const kernelFiles = readdirSync(KERNEL_DIR)
  .filter(f => f.endsWith('.ts'))
  .map(f => ({
    name: f,
    path: join(KERNEL_DIR, f),
    content: readFileSync(join(KERNEL_DIR, f), 'utf-8'),
  }));

// Extract actual import lines (not comments)
function getImportLines(content: string): string[] {
  return content.split('\n')
    .filter(line => /^\s*import\s/.test(line))
    .map(line => line.trim());
}

describe('Kernel Isolation Guard', () => {
  test('kernel directory contains files', () => {
    expect(kernelFiles.length).toBeGreaterThan(0);
  });

  test('zero imports from services/', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      const forbidden = imports.filter(line => /from.*services\//.test(line));
      expect(forbidden).toEqual([]);
    }
  });

  test('zero imports from tools', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      const forbidden = imports.filter(line => /from.*\/tools['"]/.test(line) || /from.*\/tools\./.test(line));
      expect(forbidden).toEqual([]);
    }
  });

  test('zero imports from ssh', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      const forbidden = imports.filter(line => /from.*\/ssh['"]/.test(line) || /from.*\/ssh\./.test(line));
      expect(forbidden).toEqual([]);
    }
  });

  test('zero imports from predicates', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      const forbidden = imports.filter(line => /from.*\/predicates\./.test(line));
      expect(forbidden).toEqual([]);
    }
  });

  test('zero imports from domain grounding (src/lib/grounding)', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      // Matches domain grounding imports (e.g., from '../../grounding', from '../lib/grounding')
      // Does NOT match kernel-internal sibling imports (from './grounding.js')
      const forbidden = imports.filter(line =>
        /from.*\/grounding/.test(line) && !line.includes("from './grounding"),
      );
      expect(forbidden).toEqual([]);
    }
  });

  test('only allowed external import is node:crypto', () => {
    for (const file of kernelFiles) {
      const imports = getImportLines(file.content);
      const external = imports.filter(line =>
        !line.includes("from '../types") &&
        !line.includes("from './") &&
        !line.includes("from 'crypto'") &&
        !line.includes('from "crypto"') &&
        !line.includes("type {") // type-only imports don't count
      );
      expect(external).toEqual([]);
    }
  });

  test('only allowed internal imports are from ../types.js and sibling kernel files', () => {
    for (const file of kernelFiles) {
      if (file.name === 'index.ts') continue; // index re-exports everything

      const imports = getImportLines(file.content);
      for (const line of imports) {
        const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/);
        if (!fromMatch) continue;
        const target = fromMatch[1];

        // Allowed: ../types.js, ./sibling.js, crypto
        const isAllowed =
          target === '../types.js' ||
          target.startsWith('./') ||
          target === 'crypto';

        expect(isAllowed).toBe(true);
      }
    }
  });
});

// =============================================================================
// PURE HEURISTICS ISOLATION GUARD
// =============================================================================

const PURE_DIR = join(__dirname, '../../src/pure');

// Collect all .ts files in the pure directory
const pureFiles = readdirSync(PURE_DIR)
  .filter(f => f.endsWith('.ts'))
  .map(f => ({
    name: f,
    path: join(PURE_DIR, f),
    content: readFileSync(join(PURE_DIR, f), 'utf-8'),
  }));

/**
 * Separate `import type` from runtime imports.
 * `import type { X }` is erased at compile time — zero TDZ risk.
 * `import { X }` creates a runtime dependency — forbidden in pure/.
 */
function getRuntimeImports(content: string): string[] {
  return content.split('\n')
    .filter(line => /^\s*import\s/.test(line))
    .filter(line => !/^\s*import\s+type\s/.test(line))
    .map(line => line.trim());
}

function getTypeImports(content: string): string[] {
  return content.split('\n')
    .filter(line => /^\s*import\s+type\s/.test(line))
    .map(line => line.trim());
}

describe('Pure Heuristics Isolation Guard', () => {
  test('pure/ directory contains files', () => {
    expect(pureFiles.length).toBeGreaterThan(0);
  });

  test('pure/ files have ZERO runtime imports', () => {
    for (const file of pureFiles) {
      const runtimeImports = getRuntimeImports(file.content);
      if (runtimeImports.length > 0) {
        throw new Error(
          `${file.name} has runtime imports (only 'import type' allowed):\n` +
          runtimeImports.map(l => `  ${l}`).join('\n')
        );
      }
      expect(runtimeImports).toEqual([]);
    }
  });

  test('pure/ type imports only reference allowed paths', () => {
    const FORBIDDEN_TYPE_TARGETS = [
      /\/ssh/,
      /\/ai/,
      /\/events/,
      /\/db/,
      /\/redis/,
      /\/config/,
      /\/daemon/,
    ];

    for (const file of pureFiles) {
      const typeImports = getTypeImports(file.content);
      for (const line of typeImports) {
        const fromMatch = line.match(/from\s+['"]([^'"]+)['"]/);
        if (!fromMatch) continue;
        const target = fromMatch[1];

        for (const forbidden of FORBIDDEN_TYPE_TARGETS) {
          if (forbidden.test(target)) {
            throw new Error(
              `${file.name} has type import from forbidden path:\n  ${line}`
            );
          }
        }
      }
    }
  });

  test('classification-heuristics.ts has ZERO imports of any kind', () => {
    const classFile = pureFiles.find(f => f.name === 'classification-heuristics.ts');
    expect(classFile).toBeDefined();

    const allImports = getImportLines(classFile!.content);
    expect(allImports).toEqual([]);
  });

  test('attribution-heuristics.ts has only import type statements', () => {
    const attrFile = pureFiles.find(f => f.name === 'attribution-heuristics.ts');
    expect(attrFile).toBeDefined();

    const runtimeImports = getRuntimeImports(attrFile!.content);
    expect(runtimeImports).toEqual([]);

    // Should have some type imports (AttributionPredicate, etc.)
    const typeImports = getTypeImports(attrFile!.content);
    expect(typeImports.length).toBeGreaterThan(0);
  });
});
