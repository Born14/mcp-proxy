/**
 * Core stdio MITM — Governed MCP Proxy
 * ======================================
 *
 * The proxy speaks MCP (JSON-RPC over stdio) on both sides:
 *   Agent ↔ Proxy ↔ Upstream MCP Server
 *
 * Message routing:
 *   initialize   → forward to upstream, merge meta-tools into response
 *   tools/list   → forward to upstream, append meta-tools to tool list
 *   tools/call   → governance gate → forward or block → receipt
 *   notifications → forward as-is (no response expected)
 *
 * Concurrency model: single-session-per-process. One proxy instance serves
 * one agent via one stdio pipe. One sessionEpoch, one authority state, one
 * constraint store.
 */

import { Subprocess } from 'bun';
import { createInterface } from 'readline';
import {
  ensureStateDir,
  acquireLock,
  releaseLock,
  loadOrCreateController,
  loadAuthority,
  saveAuthority,
  loadConstraints,
  appendReceipt,
  getLastReceiptHash,
  getReceiptCount,
  loadIntent,
  clearIntent as clearIntentFile,
  pinGenesisHash,
  computeIntentHash,
} from './state.js';
import { toolCallToMutation, classifyMutationType, cacheToolSchemas } from './fingerprint.js';
import {
  runGates,
  processFailure,
  computeToolTarget,
  annotateGrounding,
  checkConvergence,
  createConvergenceTracker,
  extractProxySignature,
} from './governance.js';
import { isMetaTool, handleMetaTool, META_TOOL_DEFS } from './meta-tools.js';
import { generateReceiptTitle, generateReceiptSummary } from './explain.js';
import type {
  ProxyConfig,
  ProxyState,
  GovernedProxy,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolCallRecord,
  ToolCallContext,
} from './types.js';
import type { MetaToolName } from './meta-tools.js';

// =============================================================================
// PROXY IMPLEMENTATION
// =============================================================================

export function createGovernedProxy(config: ProxyConfig): GovernedProxy {
  const enforcement = config.enforcement ?? 'strict';
  const stateDir = config.stateDir;
  const upstreamTimeoutMs = config.timeout ?? 300_000; // 5 minutes default

  // Parse upstream command — split shell string into command + args
  const upstreamParts = config.upstreamArgs?.length
    ? [config.upstream, ...config.upstreamArgs]
    : config.upstream.split(/\s+/);
  const upstreamCmd = upstreamParts[0];
  const upstreamArgs = upstreamParts.slice(1);

  let state: ProxyState;
  let upstream: Subprocess | null = null;
  let upstreamReaderAbort: AbortController | null = null;

  // Pending upstream responses: id → resolve callback
  const pendingRequests = new Map<string | number, (response: JsonRpcResponse) => void>();

  // ==========================================================================
  // STATE INITIALIZATION
  // ==========================================================================

  function initState(): ProxyState {
    ensureStateDir(stateDir);
    acquireLock(stateDir);

    const controller = loadOrCreateController(stateDir);
    const authority = loadAuthority(stateDir, controller.id);

    // Snapshot current epoch as session epoch (E-H8)
    authority.activeSessionEpoch = authority.epoch;
    authority.sessionStartedAt = Date.now();
    saveAuthority(stateDir, authority);

    const constraints = loadConstraints(stateDir);
    const lastHash = getLastReceiptHash(stateDir);
    const seq = getReceiptCount(stateDir);

    // Tier 3: Load persisted intent (if any)
    const intent = loadIntent(stateDir) ?? undefined;

    // Tier 5: Fresh convergence tracker (session-scoped, not persisted)
    const convergence = createConvergenceTracker();

    return {
      controller,
      authority,
      constraints,
      receiptSeq: seq,
      lastReceiptHash: lastHash,
      intent,
      convergence,
    };
  }

  // ==========================================================================
  // UPSTREAM MANAGEMENT
  // ==========================================================================

  function spawnUpstream(): Subprocess {
    const proc = Bun.spawn([upstreamCmd, ...upstreamArgs], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    return proc;
  }

  function sendToUpstream(msg: JsonRpcRequest): void {
    if (!upstream?.stdin) throw new Error('Upstream not running');
    const writer = upstream.stdin as { write(data: string | Uint8Array): void };
    writer.write(JSON.stringify(msg) + '\n');
  }

  async function waitForUpstreamResponse(id: string | number): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Upstream timeout for request ${id} (${upstreamTimeoutMs}ms)`));
      }, upstreamTimeoutMs);

      pendingRequests.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  function handleUpstreamLine(line: string): void {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const resolve = pendingRequests.get(msg.id)!;
        pendingRequests.delete(msg.id);
        resolve(msg);
      } else {
        // Notification from upstream — forward to agent
        writeToAgent(msg);
      }
    } catch {
      // Non-JSON line from upstream — ignore
    }
  }

  /**
   * Read a Bun ReadableStream line by line.
   * Bun.spawn().stdout is a ReadableStream (Web API), not a Node Readable.
   */
  async function readStreamLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const parts = (partial + chunk).split('\n');
        partial = parts.pop() ?? '';
        for (const line of parts) {
          onLine(line);
        }
      }
      if (partial) onLine(partial);
    } catch {
      // Stream closed or aborted
    } finally {
      reader.releaseLock();
    }
  }

  // ==========================================================================
  // AGENT COMMUNICATION
  // ==========================================================================

  function writeToAgent(msg: JsonRpcResponse | Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  // ==========================================================================
  // MESSAGE ROUTING
  // ==========================================================================

  async function handleAgentMessage(line: string): Promise<void> {
    if (!line.trim()) return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return; // Malformed JSON — ignore
    }

    // Notifications (no id) — forward as-is
    if (msg.id === undefined) {
      sendToUpstream(msg);
      return;
    }

    const method = msg.method;

    // Route by method
    if (method === 'initialize') {
      await handleInitialize(msg);
    } else if (method === 'tools/list') {
      await handleToolsList(msg);
    } else if (method === 'tools/call') {
      await handleToolsCall(msg);
    } else {
      // Unknown method — forward transparently
      await forwardAndRelay(msg);
    }
  }

  // ==========================================================================
  // METHOD HANDLERS
  // ==========================================================================

  async function handleInitialize(msg: JsonRpcRequest): Promise<void> {
    // Forward to upstream
    sendToUpstream(msg);
    const response = await waitForUpstreamResponse(msg.id!);

    // Re-sync session epoch to current authority epoch (Model B re-handshake).
    // After a governance_bump_authority, the agent is blocked because
    // sessionEpoch < authorityEpoch.  A new initialize re-aligns them
    // without requiring a process restart.
    if (state.authority.activeSessionEpoch !== state.authority.epoch) {
      state.authority.activeSessionEpoch = state.authority.epoch;
      state.authority.sessionStartedAt = Date.now();
      saveAuthority(stateDir, state.authority);
      process.stderr.write(
        `[mcp-proxy] Session re-initialized: epoch synced to ${state.authority.epoch}\n`,
      );
    }

    // Tier 3+5: Clear intent and convergence on session re-initialize (clean slate)
    state.intent = undefined;
    clearIntentFile(stateDir);
    state.convergence = createConvergenceTracker();

    writeToAgent(response);
  }

  async function handleToolsList(msg: JsonRpcRequest): Promise<void> {
    // Forward to upstream
    sendToUpstream(msg);
    const response = await waitForUpstreamResponse(msg.id!);

    // Cache tool schemas for schema-based mutation classification
    if (response.result && typeof response.result === 'object') {
      const result = response.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
      if (Array.isArray(result.tools)) {
        cacheToolSchemas(result.tools.map(t => ({
          name: t.name ?? '',
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? {},
        })));

        // Append meta-tools to the tool list
        result.tools.push(...META_TOOL_DEFS);
      }
    }

    writeToAgent(response);
  }

  async function handleToolsCall(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = params?.name ?? '';
    const toolArgs = params?.arguments ?? {};

    // Meta-tool: handle locally (no governance, no receipt)
    if (isMetaTool(toolName)) {
      const result = handleMetaTool(toolName as MetaToolName, toolArgs, state, stateDir, enforcement);
      writeToAgent({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }

    // Build context
    const mutation = toolCallToMutation(toolName, toolArgs);
    const mutationType = classifyMutationType(mutation.verb, toolArgs);
    const target = computeToolTarget(toolName, toolArgs);
    const convergenceSignal = checkConvergence(state.convergence, toolName, target);
    const gateResult = runGates(mutation, state.constraints, state.authority,
      enforcement, convergenceSignal, state.intent, mutationType);

    const ctx: ToolCallContext = {
      toolName, toolArgs, mutation, mutationType,
      startTime: Date.now(), target, convergenceSignal, gateResult,
    };

    if (!gateResult.forward) {
      handleBlocked(msg, ctx);
      return;
    }

    sendToUpstream(msg);
    try {
      const response = await waitForUpstreamResponse(msg.id!);
      handleUpstreamResult(msg, ctx, response);
    } catch (err) {
      handleUpstreamTimeout(msg, ctx, err as Error);
    }
  }

  // ==========================================================================
  // TOOL CALL PATH HANDLERS (extracted from handleToolsCall)
  // ==========================================================================

  /**
   * Handle a governance-blocked tool call.
   * Builds receipt with full tier annotations and returns error to agent.
   */
  function handleBlocked(msg: JsonRpcRequest, ctx: ToolCallContext): void {
    const record = buildRecordBase(ctx.mutation, ctx.toolArgs,
      ctx.gateResult.constraintCheck, ctx.gateResult.authorityCheck, ctx.mutationType);
    record.outcome = 'blocked';
    record.error = ctx.gateResult.blockReason;
    record.durationMs = Date.now() - ctx.startTime;
    enrichReceipt(record, ctx);
    recordReceipt(record);

    writeToAgent({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `[GOVERNANCE] ${ctx.gateResult.blockReason}` }],
        isError: true,
      },
    });
  }

  /**
   * Handle upstream timeout or crash.
   * Builds receipt with full tier annotations and returns JSON-RPC error.
   */
  function handleUpstreamTimeout(msg: JsonRpcRequest, ctx: ToolCallContext, err: Error): void {
    const record = buildRecordBase(ctx.mutation, ctx.toolArgs,
      ctx.gateResult.constraintCheck, ctx.gateResult.authorityCheck, ctx.mutationType);
    record.outcome = 'error';
    record.error = err.message;
    record.durationMs = Date.now() - ctx.startTime;
    enrichReceipt(record, ctx);
    recordReceipt(record);

    writeToAgent({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: `Upstream error: ${err.message}` },
    });
  }

  /**
   * Handle upstream response (success or error).
   * Seeds constraints on failure, updates convergence, builds receipt.
   */
  function handleUpstreamResult(msg: JsonRpcRequest, ctx: ToolCallContext, response: JsonRpcResponse): void {
    const isError = !!response.error ||
      (response.result && typeof response.result === 'object' &&
        (response.result as Record<string, unknown>).isError === true);
    const errorText = isError ? extractErrorText(response) : undefined;

    // Seed constraint on failure
    if (isError && errorText) {
      processFailure(ctx.toolName, ctx.mutation.target, errorText, state.constraints, stateDir);
    }

    // Update convergence tracker on failure
    let failureSignature: string | undefined;
    if (isError) {
      failureSignature = extractProxySignature(response);
      checkConvergence(state.convergence, ctx.toolName, ctx.target, failureSignature);
    }

    const record = buildRecordBase(ctx.mutation, ctx.toolArgs,
      ctx.gateResult.constraintCheck, ctx.gateResult.authorityCheck, ctx.mutationType);
    record.outcome = isError ? 'error' : 'success';
    record.error = errorText;
    record.failureSignature = failureSignature;
    record.durationMs = Date.now() - ctx.startTime;
    enrichReceipt(record, ctx);
    recordReceipt(record);

    // Forward upstream response to agent (unmodified — proxy is transparent)
    writeToAgent(response);
  }

  async function forwardAndRelay(msg: JsonRpcRequest): Promise<void> {
    sendToUpstream(msg);
    const response = await waitForUpstreamResponse(msg.id!);
    writeToAgent(response);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  function buildRecordBase(
    mutation: ReturnType<typeof toolCallToMutation>,
    toolArgs: Record<string, unknown>,
    constraintCheck: { passed: boolean; blockedBy?: string },
    authorityCheck: { passed: boolean; reason?: string },
    mutationType: 'mutating' | 'readonly',
  ): Omit<ToolCallRecord, 'hash'> {
    return {
      id: `r_${state.receiptSeq}`,
      seq: state.receiptSeq,
      timestamp: Date.now(),
      controllerId: state.controller.id,
      authorityEpoch: state.authority.epoch,
      enforcement,
      toolName: mutation.verb,
      arguments: toolArgs,
      target: mutation.target,
      constraintCheck,
      authorityCheck,
      outcome: 'success', // Will be overwritten
      durationMs: 0, // Will be overwritten
      previousHash: state.lastReceiptHash,
      mutation: {
        verb: mutation.verb,
        target: mutation.target,
        capturedAt: mutation.capturedAt,
        args: mutation.args,
      },
      mutationType,
    };
  }

  /**
   * Append receipt to ledger, update state, and pin genesis hash on first receipt.
   */
  function recordReceipt(record: Omit<ToolCallRecord, 'hash'>): ToolCallRecord {
    // Generate human-readable title + summary before hashing
    record.title = generateReceiptTitle(record);
    record.summary = generateReceiptSummary(record);
    const receipt = appendReceipt(stateDir, record);
    state.lastReceiptHash = receipt.hash;
    // Pin genesis trust anchor on the very first receipt
    if (state.receiptSeq === 0) {
      pinGenesisHash(stateDir, state.authority, receipt.hash);
    }
    state.receiptSeq++;
    return receipt;
  }

  /**
   * Annotate a receipt base with ALL tier fields.
   * Single function ensures every path (blocked, timeout, success) gets
   * identical enrichment. Mutates in place, returns the record for chaining.
   */
  function enrichReceipt(
    record: Omit<ToolCallRecord, 'hash'>,
    ctx: ToolCallContext,
  ): Omit<ToolCallRecord, 'hash'> {
    // Tier 3: Attribution from G5 gate
    record.attribution = ctx.gateResult.containmentCheck.attribution;
    if (ctx.gateResult.containmentCheck.match) {
      record.attributionMatch = ctx.gateResult.containmentCheck.match;
    }
    // Tier 4: Grounding annotation
    record.groundingAnnotation = annotateGrounding(state.intent);
    // Tier 5: Convergence signal
    record.convergenceSignal = ctx.convergenceSignal;
    // Intent age + hash
    if (state.intent) {
      record.intentAgeMs = Date.now() - state.intent.declaredAt;
    }
    record.intentHash = computeIntentHash(state.intent);
    return record;
  }

  function extractErrorText(response: JsonRpcResponse): string {
    if (response.error) {
      return response.error.message || JSON.stringify(response.error);
    }
    if (response.result && typeof response.result === 'object') {
      const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean };
      if (result.isError && Array.isArray(result.content)) {
        return result.content.map(c => c.text || '').join('\n');
      }
    }
    return 'Unknown error';
  }

  // ==========================================================================
  // PROXY LIFECYCLE
  // ==========================================================================

  return {
    async start(): Promise<void> {
      state = initState();

      // Spawn upstream
      upstream = spawnUpstream();

      // Read upstream stdout line by line (Bun ReadableStream)
      if (upstream.stdout) {
        upstreamReaderAbort = new AbortController();
        readStreamLines(
          upstream.stdout as ReadableStream<Uint8Array>,
          handleUpstreamLine,
          upstreamReaderAbort.signal,
        ).catch(() => {});
      }

      // Read agent stdin line by line
      // process.stdin is a Node stream in Bun — createInterface works here
      const agentReader = createInterface({ input: process.stdin });
      agentReader.on('line', (line) => {
        handleAgentMessage(line).catch(err => {
          process.stderr.write(`[mcp-proxy] Error handling message: ${(err as Error).message}\n`);
        });
      });

      // Handle upstream exit
      upstream.exited.then((code) => {
        process.stderr.write(`[mcp-proxy] Upstream exited with code ${code}\n`);
        releaseLock(stateDir);
        process.exit(code ?? 1);
      });

      // Release lock on process exit (SIGTERM from IDE, SIGINT from Ctrl-C, etc.)
      const cleanup = () => {
        releaseLock(stateDir);
        process.exit(0);
      };
      process.on('SIGTERM', cleanup);
      process.on('SIGINT', cleanup);
      process.on('exit', () => releaseLock(stateDir));
    },

    async stop(): Promise<void> {
      releaseLock(stateDir);
      upstreamReaderAbort?.abort();
      upstreamReaderAbort = null;
      if (upstream) {
        upstream.kill();
        upstream = null;
      }
    },

    getState(): ProxyState {
      return state;
    },

    getConfig(): ProxyConfig {
      return { ...config, enforcement };
    },
  };
}
