/**
 * Tool-Call Adapter — Domain translation for agent tool loops.
 *
 * The universal adapter. Every agent framework (LangChain, CrewAI, AutoGen,
 * Claude Code, Cursor, n8n) calls tools in a loop. This adapter classifies
 * tool calls, extracts failure signatures, and enables narrowing to prevent
 * agents from repeating the same failed tool invocation.
 *
 * The Kilo Code $8 burn: agent read the same file 1,000 times.
 * The VS Code 800GB incident: agent created 1,526 worktrees in a day.
 * The n8n 50% loop rate: agents stuck calling the same tool infinitely.
 *
 * This adapter would have blocked the second call.
 *
 * 12 failure signatures, 7 action classes, source-sensitive blame.
 */
import type { DomainAdapter } from '../types.js';
/**
 * Create a Tool-Call domain adapter.
 *
 * Usage:
 *   import { createToolCallAdapter } from '@sovereign-labs/narrowing/adapters/tool-call';
 *   const adapter = createToolCallAdapter();
 *   const loop = new NarrowingLoop({ adapter });
 *
 *   // In your agent loop:
 *   const check = loop.checkProposal({
 *     parameters: { tool: 'edit_file', file: 'server.js', old_string: 'foo', new_string: 'bar' },
 *     targets: ['server.js'],
 *   });
 *   if (!check.allowed) {
 *     // Feed back to LLM: "This approach already failed. Try something different."
 *   }
 */
export declare function createToolCallAdapter(): DomainAdapter;
/**
 * Helper: build a proposal from a tool call.
 *
 * Convenience function so users don't have to manually construct
 * the Proposal shape from their framework's tool call format.
 *
 * Usage:
 *   const proposal = toolCallToProposal('edit_file', {
 *     file: 'server.js',
 *     old_string: 'foo',
 *     new_string: 'bar',
 *   });
 *   const check = loop.checkProposal(proposal);
 */
export declare function toolCallToProposal(toolName: string, args: Record<string, unknown>): {
    parameters: Record<string, unknown>;
    targets: string[];
};
/**
 * Helper: build an outcome from a tool call result.
 *
 * Convenience function for recording tool call results back into the loop.
 *
 * Usage:
 *   const outcome = toolCallToOutcome('edit_file', args, {
 *     success: false,
 *     error: 'search string not found in file',
 *     durationMs: 45,
 *   });
 *   loop.recordOutcome(outcome);
 */
export declare function toolCallToOutcome(toolName: string, args: Record<string, unknown>, result: {
    success: boolean;
    error?: string;
    durationMs: number;
    metadata?: Record<string, unknown>;
}): {
    score: null;
    status: 'success' | 'failure';
    error?: string;
    parameters: Record<string, unknown>;
    targets: string[];
    durationMs: number;
    metadata?: Record<string, unknown>;
};
//# sourceMappingURL=tool-call.d.ts.map