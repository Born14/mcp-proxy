/**
 * Schema Validation — JSON Schema Argument Checking
 * ===================================================
 *
 * Validates tool call arguments against the upstream's declared inputSchema.
 * Uses the schema cache populated by tools/list interception (fingerprint.ts).
 *
 * Two modes:
 *   'warn'   (default): Forward with annotation on receipt. Never blocks.
 *   'strict': Block calls with invalid arguments.
 *
 * Lightweight validation — checks required fields and basic types.
 * No external JSON Schema library (zero dependencies).
 */

import { getCachedSchema } from './fingerprint.js';

export type SchemaMode = 'off' | 'warn' | 'strict';

export interface SchemaCheckResult {
  /** Whether the arguments are valid */
  valid: boolean;

  /** Validation errors (empty if valid) */
  errors: string[];
}

/**
 * Validate tool call arguments against the cached schema.
 *
 * Returns { valid: true } if no schema is cached (graceful degradation).
 * Only checks: required fields present, basic type matching (string, number, boolean, array, object).
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): SchemaCheckResult {
  const schema = getCachedSchema(toolName);
  if (!schema) return { valid: true, errors: [] };

  const errors: string[] = [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // Check required fields
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      errors.push(`missing required field: "${field}"`);
    }
  }

  // Check basic types for provided fields
  if (properties) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;

      const propSchema = properties[key];
      if (!propSchema || !propSchema.type) continue;

      const expectedType = propSchema.type as string;
      const actualType = getJsonType(value);

      if (expectedType && actualType && expectedType !== actualType) {
        // Allow number where integer is expected
        if (expectedType === 'integer' && actualType === 'number') continue;
        errors.push(`field "${key}": expected ${expectedType}, got ${actualType}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Map a JS value to its JSON Schema type name.
 */
function getJsonType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return null;
}
