// The 6-step LLM call middleware chain. EVERY LLM call in Dymaxion goes
// through callLLM() — skills, planner, critic, narrator, self-authoring.
// Bypassing this file is prohibited (see CLAUDE.md).
//
//   1. Employer boundary check   (security/boundary.ts)
//   2. Budget check, pre-call    (llm/budget.ts)
//   3. OAuth token refresh       (llm/oauth.ts, via providers.ts)
//   4. Audit log pre-call        (security/audit.ts)
//   ── call provider via Vercel AI SDK ──
//   5. Cost accrual              (llm/cost.ts + llm/budget.ts)
//   6. Audit log post-call + LangFuse trace
//
// Each step is an exported function, testable in isolation.

import { generateText } from 'ai';
import { loadConfig } from '../config/loader.js';
import { resolveModel, splitModelRef } from './providers.js';
import { routeFor } from './routing.js';
import { checkBudget, accrueCost, tierForSkillClass } from './budget.js';
import { computeCostUsd } from './cost.js';
import { auditEvent } from '../security/audit.js';
import { isHostnameDenied } from '../security/boundary.js';
import { recordGeneration } from '../observability/langfuse.js';
import { logger } from '../observability/logger.js';

export interface LLMCallRequest {
  skillSlug: string;
  skillClass: string;
  llmOverride?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  agentRunId?: string;
  purpose?: string; // e.g. 'classify', 'plan', 'narrate'
}

export interface LLMCallResult {
  text: string;
  modelRef: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** Step 1 — the model provider's own host must not be on the denylist. */
export function boundaryCheck(modelRef: string): void {
  const { provider } = splitModelRef(modelRef);
  const cfg = loadConfig().providers[provider];
  const base = cfg?.base_url ?? '';
  if (base) {
    const host = new URL(base).hostname;
    if (isHostnameDenied(host)) {
      throw new Error(`Boundary: provider host '${host}' is denied`);
    }
  }
}

/** Step 2 re-exported for isolated testing. */
export { checkBudget as budgetCheck };

/** Step 4. */
export async function auditPreCall(req: LLMCallRequest, modelRef: string): Promise<void> {
  await auditEvent(
    'llm_call_pre',
    {
      skill: req.skillSlug,
      purpose: req.purpose ?? 'unspecified',
      model: modelRef,
      estimated_tokens: Math.ceil((req.system?.length ?? 0 + req.prompt.length) / 4),
    },
    req.agentRunId,
  );
}

/** Steps 5 + 6. */
export async function settleCall(
  req: LLMCallRequest,
  tier: string,
  modelRef: string,
  result: { text: string; inputTokens: number; outputTokens: number; latencyMs: number },
): Promise<number> {
  const costUsd = computeCostUsd(modelRef, result.inputTokens, result.outputTokens);
  const status = await accrueCost(tier, costUsd);
  await auditEvent(
    'llm_call_post',
    {
      skill: req.skillSlug,
      model: modelRef,
      actual_tokens: { input: result.inputTokens, output: result.outputTokens },
      actual_cost_usd: costUsd,
      latency_ms: result.latencyMs,
      tier_remaining_usd: status.remainingUsd,
      status: 'ok',
    },
    req.agentRunId,
  );
  recordGeneration({
    traceId: req.agentRunId ?? 'no-run',
    name: `${req.skillSlug}:${req.purpose ?? 'llm'}`,
    model: modelRef,
    input: { system: req.system, prompt: req.prompt },
    output: result.text,
    usage: { input: result.inputTokens, output: result.outputTokens },
    costUsd,
    latencyMs: result.latencyMs,
  });
  return costUsd;
}

/** The full chain, with routing fallbacks. */
export async function callLLM(req: LLMCallRequest): Promise<LLMCallResult> {
  const route = routeFor(req.skillSlug, req.skillClass, req.llmOverride);
  const tier = tierForSkillClass(req.skillClass);
  const chain = [route.primary, ...route.fallbacks];
  const totalTimeoutMs = Number(process.env.LLM_TOTAL_TIMEOUT_MS ?? 60_000);
  const attemptTimeoutMs = Number(process.env.LLM_ATTEMPT_TIMEOUT_MS ?? 30_000);
  const deadline = Date.now() + totalTimeoutMs;

  let lastError: unknown;
  for (const modelRef of chain) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      boundaryCheck(modelRef); // 1
      const { provider } = splitModelRef(modelRef);
      await checkBudget(tier, modelRef, provider); // 2
      const resolved = await resolveModel(modelRef); // 3 (OAuth refresh inside)
      await auditPreCall(req, modelRef); // 4

      const started = Date.now();
      const gen = await generateText({
        model: resolved.model,
        system: req.system,
        prompt: req.prompt,
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
        abortSignal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, attemptTimeoutMs))),
      });
      const latencyMs = Date.now() - started;
      const inputTokens = gen.usage?.inputTokens ?? 0;
      const outputTokens = gen.usage?.outputTokens ?? 0;

      const costUsd = await settleCall(req, tier, modelRef, {
        text: gen.text,
        inputTokens,
        outputTokens,
        latencyMs,
      }); // 5 + 6

      return { text: gen.text, modelRef, inputTokens, outputTokens, costUsd, latencyMs };
    } catch (err) {
      lastError = err;
      // Budget blocks are hard stops — falling back would dodge the cap.
      if ((err as Error).name === 'BudgetExceeded') throw err;
      logger.warn({ err, modelRef }, 'llm call failed, trying next in chain');
      await auditEvent(
        'llm_call_post',
        { skill: req.skillSlug, model: modelRef, status: 'error', error: String(err) },
        req.agentRunId,
      );
    }
  }
  throw new Error(`All models in chain failed for '${req.skillSlug}': ${String(lastError)}`);
}
