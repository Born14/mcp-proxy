/**
 * Classification Heuristics — Shared Pure Functions
 * ==================================================
 *
 * ZERO imports. All regex + classifiers. Used by BOTH:
 *   - Runtime: classification.ts, checkpoint.ts, memory.ts
 *   - Adapter: sovereign-web/classify.ts
 *
 * Every function returns string (not branded types like IntentLevel, GoalTier,
 * ChangeType). Branded types belong to the domain layer. Each consumer casts
 * at its boundary.
 *
 * Structural invariant: this file has ZERO runtime imports. Only primitive
 * types. This prevents TDZ (Temporal Dead Zone) circular initialization.
 */

// =============================================================================
// INTENT CLASSIFICATION PATTERNS
// =============================================================================

export const OBSERVE_PATTERNS: RegExp[] = [
  /\bcheck\b/i, /\bstatus\b/i, /\bhealthy?\b/i, /\bhealth\s*check\b/i,
  /\brunning\b/i, /\bup\b/i, /\balive\b/i, /\breport\b/i, /\bshow\b/i,
  /\blist\b/i, /\bget\b/i, /\bread\b/i, /\bview\b/i, /\bmonitor\b/i,
  /\bwhat('s| is)\b/i, /\bhow('s| is)\b/i, /\bis it\b/i, /\bare they\b/i,
];

export const DIAGNOSE_PATTERNS: RegExp[] = [
  /\bdiagnos/i, /\bwhy\b/i, /\binvestigat/i, /\banalyze?\b/i, /\bdebug\b/i,
  /\btroubleshoot/i, /\broot cause\b/i, /\bfind.*(?:bug|error|issue|problem)/i,
  /\bwhat.*(?:wrong|broken|failing|crashed)/i, /\bexplain.*(?:error|failure)/i,
];

export const OPERATE_PATTERNS: RegExp[] = [
  /\bfix\b/i, /\brestart\b/i, /\bdeploy\b/i, /\brebuild\b/i, /\bstop\b/i,
  /\bupdate\b/i, /\bchange\b/i, /\bmodify\b/i, /\badd\b/i, /\bremove\b/i,
  /\bdelete\b/i, /\bcreate\b/i, /\bwrite\b/i, /\binstall\b/i, /\bupgrade\b/i,
  /\bmigrat/i, /\brollback\b/i, /\brevert\b/i, /\bscale\b/i, /\bpatch\b/i,
  /\bmake\b/i, /\bset\b/i, /\breplace\b/i, /\brename\b/i, /\bmove\b/i,
  /\bimplement\b/i, /\brefactor\b/i, /\benable\b/i, /\bdisable\b/i, /\bturn\b/i,
  /\bswitch\b/i, /\bput\b/i, /\binsert\b/i, /\bintegrat/i, /\bconfigur/i,
];

// =============================================================================
// DIRECT ACTION MATCHING
// =============================================================================

/**
 * Match simple infrastructure goals that don't need LLM planning.
 * "rebuild the app" → just rebuild. No AI, no approval gate, no OODA loop.
 *
 * Returns null if the goal is too complex (mentions code changes, fixes, etc.)
 */
export function matchDirectAction(goal: string): string | null {
  if (/\brebuild\b/i.test(goal) || /\bredeploy\b/i.test(goal)) return 'rebuild';
  if (/\bdeploy\b/i.test(goal)) return 'deploy';

  const needsLLM = /\b(fix|modify|change|update|add|create|write|delete|remove|refactor|implement|install|migrate|debug|investigate|make|set|replace|rename|move|enable|disable|insert|configure|put|turn|switch|integrate)\b/i;
  if (needsLLM.test(goal)) return null;

  if (/\brestart\b/i.test(goal)) return 'restart';
  if (/\bstop\b/i.test(goal) || /\bshut\s*down\b/i.test(goal)) return 'stop';

  return null;
}

/**
 * Detect trivial goals that skip the conversing phase.
 * Direct infrastructure operations or simple read-only queries.
 */
export function isTrivialGoal(goal: string): boolean {
  if (matchDirectAction(goal)) return true;

  const trivialPatterns = [
    /^(check|get|show|what('s| is)|how('s| is))\s+(status|health|state)\b/i,
    /^(read|show|get|view)\s+(logs?|schema|events?)\b/i,
    /^is\s+(it|the app)\s+(running|healthy|up|down)\b/i,
  ];
  return trivialPatterns.some(p => p.test(goal.trim()));
}

// =============================================================================
// INTENT LEVEL CLASSIFICATION (regex)
// =============================================================================

/**
 * Classify a goal into an intent level using deterministic pattern matching.
 * Used as fallback when LLM classification fails (timeout, API down, etc.).
 *
 * Priority: OPERATE > DIAGNOSE > OBSERVE (if ambiguous, escalate).
 * Default: OBSERVE (principle of least privilege).
 *
 * Returns string — caller casts to branded IntentLevel at domain boundary.
 */
export function classifyGoalRegex(goal: string): string {
  const hasOperate = OPERATE_PATTERNS.some(p => p.test(goal));
  const hasDiagnose = DIAGNOSE_PATTERNS.some(p => p.test(goal));
  const hasObserve = OBSERVE_PATTERNS.some(p => p.test(goal));

  if (hasOperate) return 'operate';
  if (hasDiagnose) return 'diagnose';
  if (hasObserve) return 'observe';

  return 'observe';
}

// =============================================================================
// GOAL TIER CLASSIFICATION
// =============================================================================

/**
 * Classify a goal into a tier for determining conversing entry.
 *
 * - ATOMIC:       restart/logs/status/deploy → skip conversing entirely
 * - INCREMENTAL:  button/css/text/layout (no DB/auth/infra) → skip conversing, go to plan
 * - STRUCTURAL:   database/auth/secrets/config → enter conversing (air-gapped)
 *
 * Returns string — caller casts to branded GoalTier at domain boundary.
 */
export function classifyGoalTier(goal: string): string {
  const cleanGoal = goal.replace(/^!\s*/, '').trim();

  // Atomic: direct infrastructure commands
  if (isTrivialGoal(cleanGoal)) return 'atomic';

  // Structural: requires clarification (DB, auth, secrets, infra)
  const structuralPatterns = [
    /\b(database|migration|schema|table|column)\b/i,
    /\b(auth|login|password|secret|token|key|credential)\b/i,
    /\b(env|environment|config|port|domain|host)\b/i,
    /\b(docker|container|nginx|caddy|ssl|cert)\b/i,
    /\b(postgres|mysql|mongo|redis|queue)\b/i,
  ];
  if (structuralPatterns.some(p => p.test(cleanGoal))) return 'structural';

  // Incremental: UI/frontend work (safe to go straight to plan)
  const incrementalPatterns = [
    /\b(button|style|css|color|text|title|heading|layout|ui|ux)\b/i,
    /\b(add|change|update|make)\s+(a|the)?\s*(button|style|color|text|title|heading)/i,
    /\b(font|margin|padding|border|background|image|icon)\b/i,
    /\b(form|input|label|placeholder|modal|dialog|popup)\b/i,
    /\b(header|footer|navbar|sidebar|card|grid|flex)\b/i,
  ];
  if (incrementalPatterns.some(p => p.test(cleanGoal))) return 'incremental';

  // Default to structural (safe — requires clarification)
  return 'structural';
}

// =============================================================================
// CHANGE-TYPE CLASSIFICATION (risk classification)
// =============================================================================

type ChangeType = 'ui' | 'logic' | 'schema' | 'config' | 'infra' | 'mixed';

/**
 * Classify files by blast radius: ui, logic, schema, config, infra, mixed.
 * Pure regex on file paths. Zero dependencies.
 *
 * Returns string — caller casts to branded ChangeType at domain boundary.
 */
export function classifyChangeType(files?: string[]): string | undefined {
  if (!files || files.length === 0) return undefined;

  const categories = new Set<ChangeType>();

  for (const file of files) {
    const f = file.toLowerCase();

    // UI / style
    if (/\.(css|scss|less|svg|png|jpg|jpeg|gif|ico)$/.test(f) ||
        /styles?|theme|layout|template|\.html$/.test(f)) {
      categories.add('ui');
      continue;
    }

    // Schema / database
    if (/migrations?[/\\]/.test(f) || /init\.sql$/.test(f) ||
        /schema/.test(f) || /\.sql$/.test(f)) {
      categories.add('schema');
      continue;
    }

    // Infra / platform
    if (/caddy|nginx|\.conf$|ssl|cert|\.pem$/.test(f) ||
        /platform|proxy|network/.test(f)) {
      categories.add('infra');
      continue;
    }

    // Config / build
    if (/docker-compose|dockerfile|\.env|package\.json|tsconfig|\.yml$|\.yaml$/.test(f)) {
      categories.add('config');
      continue;
    }

    // Everything else is logic (server.js, route files, lib/, etc.)
    categories.add('logic');
  }

  if (categories.size === 0) return 'logic';
  if (categories.size === 1) return categories.values().next().value!;
  return 'mixed';
}

// =============================================================================
// ACTION CLASS CLASSIFICATION (K5 constraint seeding)
// =============================================================================

/**
 * Classify the action strategy from code changes for K5 constraint seeding.
 * Pure heuristics — zero dependencies.
 *
 * @param codeChanges Array of file edits with search/replace/content
 * @param predicateFiles Optional list of files referenced by predicates (for unrelated_edit check)
 * Returns string | undefined — caller casts to branded FailureActionClass at domain boundary.
 */
export function classifyActionClass(
  codeChanges: Array<{ file: string; search?: string; replace?: string; content?: string }>,
  predicateFiles?: string[],
): string | undefined {
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
