/**
 * Attribution Heuristics — Shared Pure Functions
 * ===============================================
 *
 * G5 Containment: Every mutation traces to a predicate, or the human knows.
 *
 * Uses generic kernel types (AttributionPredicate, AttributionMutation,
 * AttributionObservation) instead of domain-specific types. Domain types
 * are structurally compatible via TypeScript duck typing.
 *
 * Structural invariant: this file has ZERO runtime imports.
 */

import type {
  AttributionPredicate,
  AttributionMutation,
  AttributionObservation,
} from '../types.js';

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Check if content contains a route path (e.g., '/roster' in a handler).
 */
export function contentServesRoute(content: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`]${escaped}['"\`]`).test(content);
}

/**
 * Check if a search/replace edit touches a specific CSS selector + property.
 * Conservative substring matching.
 */
export function editTouchesCSSProperty(
  search: string,
  replace: string,
  selector: string,
  property: string,
): boolean {
  const combined = search + replace;
  const selectorNormalized = selector.replace(/^\./, '').replace(/^#/, '');
  const hasSelector = combined.includes(selector) ||
    combined.includes(selectorNormalized);
  const hasProperty = combined.includes(property);
  return hasSelector && hasProperty;
}

// =============================================================================
// SQL parsing helpers
// =============================================================================

export const SQL_TABLE_RE = /(?:FROM|INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|INSERT\s+INTO|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|TRUNCATE(?:\s+TABLE)?)\s+(\w+)/i;
export const SQL_WHERE_ID_RE = /WHERE\s+(\w*id)\s*=\s*(\d+)/i;

export function extractSQLTable(sql: string): string | null {
  const match = sql.match(SQL_TABLE_RE);
  return match ? match[1].toLowerCase() : null;
}

export function extractSQLWhereId(sql: string): { column: string; value: string } | null {
  const match = sql.match(SQL_WHERE_ID_RE);
  return match ? { column: match[1], value: match[2] } : null;
}

// =============================================================================
// Observation evidence ID extraction (best-effort regex)
// =============================================================================

export function extractObservedIds(evidence: AttributionObservation[]): Map<string, string[]> {
  const observed = new Map<string, string[]>();

  for (const record of evidence) {
    if (record.tool !== 'query_db') continue;
    const text = record.resultSummary || '';

    const idPatterns = [
      /\bid\s*[:=|]\s*(\d+)/gi,
      /(?:highest|max|largest)\s+(?:\w+\s+)?(?:is|=|:)\s*(\d+)/gi,
      /id\s+(\d+)/gi,
    ];

    for (const pattern of idPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const existing = observed.get('id') || [];
        if (!existing.includes(match[1])) {
          existing.push(match[1]);
        }
        observed.set('id', existing);
      }
    }
  }

  return observed;
}

// =============================================================================
// Per-mutation-type attribution
// =============================================================================

/**
 * Attribution result type — uses string for attribution to avoid coupling to
 * either runtime MutationAttribution or governance Attribution type.
 */
export interface AttributionResult {
  attribution: string;
  predicateId?: string;
  reason: string;
}

export function attributeEditFile(
  mutation: AttributionMutation,
  predicates: AttributionPredicate[],
  allMutations: AttributionMutation[],
): AttributionResult {
  const filePath = (mutation.args?.path as string) || '';
  const search = (mutation.args?.search as string) || '';
  const replace = (mutation.args?.replace as string) || '';

  // 1. Direct CSS match
  for (const pred of predicates) {
    if (pred.type !== 'css') continue;
    const predFile = pred.file || '';
    if (predFile && predFile !== filePath) continue;
    if (pred.selector && pred.property &&
        editTouchesCSSProperty(search, replace, pred.selector, pred.property)) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `CSS ${pred.property} change matches ${pred.id}: ${pred.selector} ${pred.property}`,
      };
    }
    // Looser CSS match: replace contains expected value
    if (pred.value && replace.includes(String(pred.value))) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `Edit contains expected value "${pred.value}" for ${pred.id}`,
      };
    }
  }

  // 2. Direct HTML match
  for (const pred of predicates) {
    if (pred.type !== 'html') continue;
    const predFile = pred.file || '';
    if (predFile && predFile !== filePath) continue;
    if (pred.selector && replace.includes(`<${pred.selector.replace(/^\./, '').replace(/^#/, '')}`)) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `HTML element matches ${pred.id}: ${pred.selector}`,
      };
    }
    if (pred.value && replace.includes(String(pred.value))) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `HTML content matches ${pred.id}: "${pred.value}"`,
      };
    }
  }

  // 3. Direct content match
  for (const pred of predicates) {
    if (pred.type !== 'content') continue;
    if (pred.file && pred.file !== filePath) continue;
    if (!pred.file) continue;
    if (pred.value && replace.includes(String(pred.value))) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `Content matches ${pred.id}: "${pred.value}" in ${pred.file}`,
      };
    }
    if (pred.pattern && replace.includes(pred.pattern)) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `Content pattern matches ${pred.id}: "${pred.pattern}" in ${pred.file}`,
      };
    }
  }

  // 4. Scaffolding: file serves a route referenced by a predicate
  for (const pred of predicates) {
    if (!pred.path) continue;
    const editContent = search + replace;
    if (contentServesRoute(editContent, pred.path)) {
      return {
        attribution: 'scaffolding',
        predicateId: pred.id,
        reason: `Route handler for ${pred.path} (serves ${pred.id})`,
      };
    }
  }

  // 5. Scaffolding by proximity: same file as any direct-matched mutation
  const filesWithDirectMatch = new Set<string>();
  for (const other of allMutations) {
    if (other === mutation) continue;
    if (other.tool !== 'edit_file' && other.tool !== 'create_file') continue;
    const otherPath = (other.args?.path as string) || '';
    if (otherPath !== filePath) continue;
    for (const pred of predicates) {
      if (pred.file === otherPath || pred.path) {
        filesWithDirectMatch.add(otherPath);
        break;
      }
    }
  }
  if (filesWithDirectMatch.has(filePath)) {
    const nearestPred = predicates.find(p => p.file === filePath || p.path);
    return {
      attribution: 'scaffolding',
      predicateId: nearestPred?.id,
      reason: `Same file as predicate-targeted edit (${filePath})`,
    };
  }

  return { attribution: 'unexplained', reason: `No predicate explains edit to ${filePath}` };
}

export function attributeCreateFile(
  mutation: AttributionMutation,
  predicates: AttributionPredicate[],
): AttributionResult {
  const filePath = (mutation.args?.path as string) || '';
  const content = (mutation.args?.content as string) || '';

  // 1. Direct: content predicate targets this file
  for (const pred of predicates) {
    if (pred.type === 'content' && pred.file === filePath) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `Content predicate targets created file ${filePath}`,
      };
    }
  }

  // 2. Scaffolding: file serves a route referenced by a predicate
  for (const pred of predicates) {
    if (!pred.path) continue;
    if (contentServesRoute(content, pred.path)) {
      return {
        attribution: 'scaffolding',
        predicateId: pred.id,
        reason: `Created file serves route ${pred.path} for ${pred.id}`,
      };
    }
  }

  return { attribution: 'unexplained', reason: `No predicate explains creation of ${filePath}` };
}

export function attributeMigration(
  mutation: AttributionMutation,
  predicates: AttributionPredicate[],
): AttributionResult {
  const table = (mutation.args?.table as string)?.toLowerCase() || '';
  const column = (mutation.args?.column as string)?.toLowerCase() || '';
  const action = (mutation.args?.action as string) || '';

  for (const pred of predicates) {
    if (pred.type !== 'db') continue;
    const predTable = pred.table?.toLowerCase() || '';
    if (!predTable) continue;

    if (predTable === table) {
      if (pred.column && column && pred.column.toLowerCase() !== column) continue;
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `Migration ${action} on ${table}${column ? '.' + column : ''} matches ${pred.id}`,
      };
    }
  }

  return {
    attribution: 'unexplained',
    reason: `No DB predicate explains migration ${action} on ${table}${column ? '.' + column : ''}`,
  };
}

export function attributeSQLExec(
  mutation: AttributionMutation,
  predicates: AttributionPredicate[],
): AttributionResult {
  const sql = (mutation.args?.sql as string) || '';
  const table = extractSQLTable(sql);

  if (!table) {
    return { attribution: 'unexplained', reason: `Cannot extract table from SQL: ${sql.substring(0, 60)}` };
  }

  for (const pred of predicates) {
    if (pred.type !== 'db') continue;
    if (pred.table?.toLowerCase() === table) {
      return {
        attribution: 'direct',
        predicateId: pred.id,
        reason: `SQL targets table "${table}" matching ${pred.id}`,
      };
    }
  }

  return { attribution: 'unexplained', reason: `No DB predicate explains SQL on table "${table}"` };
}

// =============================================================================
// Identity binding check (G5.5)
// =============================================================================

export interface IdentityMismatchResult {
  index: number;
  observedValue: string;
  mutationValue: string;
  tool: string;
  detail: string;
}

export function checkIdentityBinding(
  mutations: AttributionMutation[],
  evidence: AttributionObservation[],
): IdentityMismatchResult[] {
  if (!evidence || evidence.length === 0) return [];

  const observedIds = extractObservedIds(evidence);
  if (observedIds.size === 0) return [];

  const mismatches: IdentityMismatchResult[] = [];

  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    if (mutation.tool !== 'sql_exec') continue;

    const sql = (mutation.args?.sql as string) || '';
    const whereId = extractSQLWhereId(sql);
    if (!whereId) continue;

    const observedValues = observedIds.get('id') || [];
    if (observedValues.length === 0) continue;

    if (!observedValues.includes(whereId.value) && observedValues.length > 0) {
      mismatches.push({
        index: i,
        observedValue: observedValues.join(', '),
        mutationValue: `${whereId.column}=${whereId.value}`,
        tool: mutation.tool,
        detail: `Observation found id=${observedValues.join('/')} but ${sql.substring(0, 60)} targets ${whereId.column}=${whereId.value}`,
      });
    }
  }

  return mismatches;
}
