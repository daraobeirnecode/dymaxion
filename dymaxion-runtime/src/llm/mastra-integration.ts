// Bridges Mastra agent calls into the Dymaxion middleware chain.
//
// Mastra is used for its agent/workflow/memory abstractions; its LLM calls
// must still respect the 6-step chain. We load Mastra dynamically and keep
// the surface minimal so quarterly Mastra upgrades don't ripple through the
// runtime (see Framework Decision.md — "pin + quarterly review").

import { callLLM, type LLMCallRequest, type LLMCallResult } from './middleware.js';
import { logger } from '../observability/logger.js';

type MastraModule = Record<string, unknown>;
let mastraModule: MastraModule | null = null;

/** Lazily import @mastra/core; returns null when unavailable (runtime degrades gracefully). */
export async function mastra(): Promise<MastraModule | null> {
  if (mastraModule) return mastraModule;
  try {
    mastraModule = (await import('@mastra/core')) as MastraModule;
    return mastraModule;
  } catch (err) {
    logger.warn({ err }, '@mastra/core unavailable — falling back to direct middleware calls');
    return null;
  }
}

/**
 * The adapter Mastra agents call instead of a raw provider: identical
 * signature to callLLM so every Mastra-originated generation is boundary-
 * checked, budgeted, audited, and traced like any other.
 */
export async function mastraLLMAdapter(req: LLMCallRequest): Promise<LLMCallResult> {
  return callLLM(req);
}
