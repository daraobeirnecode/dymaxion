// Self-critique before delivery — narration tier, cheap. Flags obviously
// incomplete or contradictory results so the executor can revise once.

import { callLLM } from '../llm/middleware.js';
import type { Plan, StepResult } from '../gateways/common.js';

export interface Review {
  needsRevision: boolean;
  notes: string;
}

const SYSTEM = `You review a GIS agent run before delivery. Respond ONLY with minified JSON:
{"needsRevision":true|false,"notes":"<one sentence>"}
needsRevision=true only when a step failed silently, outputs contradict the plan, or a
required output is missing. Stub outputs (status:"stub") are expected in Sprint 1 — not a failure.`;

export async function review(
  plan: Plan,
  results: StepResult[],
  agentRunId: string,
): Promise<Review> {
  try {
    const res = await callLLM({
      skillSlug: 'critic',
      skillClass: 'narration',
      system: SYSTEM,
      prompt: `Plan: ${JSON.stringify(plan)}\n\nResults: ${JSON.stringify(results).slice(0, 6000)}`,
      maxTokens: 300,
      temperature: 0,
      agentRunId,
      purpose: 'critique',
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { needsRevision: false, notes: 'critic returned no verdict' };
    const parsed = JSON.parse(m[0]) as Partial<Review>;
    return { needsRevision: Boolean(parsed.needsRevision), notes: parsed.notes ?? '' };
  } catch {
    return { needsRevision: false, notes: 'critic unavailable' };
  }
}
