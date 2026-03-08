/**
 * Action Class Classification
 * ============================
 *
 * Classifies mutation strategy type from code changes.
 * Enriches receipt metadata — enables richer ledger analysis,
 * pattern detection, and constraint seeding.
 *
 * Zero dependencies. Pure function.
 *
 * Ported from: packages/kernel/src/pure/classification-heuristics.ts (classifyActionClass)
 */

// =============================================================================
// TYPES
// =============================================================================

export type ActionClass =
  | 'schema_migration'
  | 'global_replace'
  | 'rewrite_page'
  | 'style_overhaul'
  | 'unrelated_edit'
  | undefined;

export interface CodeChange {
  file: string;
  search?: string;
  replace?: string;
  content?: string;
}

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classify the action strategy from code changes.
 * Pure heuristics — zero dependencies.
 *
 * @param codeChanges Array of file edits with search/replace/content
 * @param predicateFiles Optional list of files referenced by predicates (for unrelated_edit check)
 * @returns Action class string or undefined if no pattern matches
 */
export function classifyActionClass(
  codeChanges: CodeChange[],
  predicateFiles?: string[],
): ActionClass {
  if (!codeChanges || codeChanges.length === 0) return undefined;

  // schema_migration: any SQL file changed
  if (codeChanges.some(c => c.file.endsWith('.sql') || c.file.includes('migration'))) {
    return 'schema_migration';
  }

  // global_replace: same search pattern across 3+ files
  if (codeChanges.length >= 3) {
    const searchPatterns = codeChanges
      .filter(c => c.search && c.search.length > 10)
      .map(c => c.search!);
    const patternCounts = new Map<string, number>();
    for (const p of searchPatterns) {
      patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
    }
    if ([...patternCounts.values()].some(count => count >= 3)) {
      return 'global_replace';
    }
  }

  // rewrite_page: full file creation or >50% content replacement
  for (const change of codeChanges) {
    if (change.content && !change.search) {
      return 'rewrite_page';
    }
    if (change.search && change.replace) {
      if (change.search.length > 200 && change.replace.length > change.search.length * 1.5) {
        return 'rewrite_page';
      }
    }
  }

  // style_overhaul: >5 CSS property changes
  let cssPropertyCount = 0;
  for (const change of codeChanges) {
    const content = change.replace || change.content || '';
    const cssMatches = content.match(/[\w-]+\s*:\s*[^;]+;/g);
    if (cssMatches) cssPropertyCount += cssMatches.length;
  }
  if (cssPropertyCount > 5) {
    return 'style_overhaul';
  }

  // unrelated_edit: touched files not referenced by any predicate
  if (predicateFiles && predicateFiles.length > 0) {
    const predFileSet = new Set(predicateFiles);
    const touchedFiles = codeChanges.map(c => c.file);
    const unrelatedCount = touchedFiles.filter(f => !predFileSet.has(f)).length;
    if (unrelatedCount > touchedFiles.length / 2) {
      return 'unrelated_edit';
    }
  }

  return undefined;
}
