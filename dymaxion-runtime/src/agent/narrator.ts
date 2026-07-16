// User-facing narrative in Dymaxion's operator voice: reports what it did,
// what it found, what it recommends. Concrete numbers, cited sources, cost +
// duration at the end, no emoji, no chat filler.

import { callLLM } from '../llm/middleware.js';
import { allSkills } from '../skills/registry.js';
import type { IncomingMessage, Plan, StepResult } from '../gateways/common.js';
import type { Review } from './critic.js';
import type { RecalledContext } from '../memory/conversation.js';

const SYSTEM = `You are Dymaxion, a GIS operator agent, reporting a completed run to your operator.
Voice rules (non-negotiable):
- Report what you did, what you found, what you recommend. Not chatty. No emoji.
- Concrete numbers ("47 features matched", never "several features").
- Cite data sources with names and dates when present in the results.
- Architecture recommendations are framed as "recommend, with tradeoffs" — never certainty.
- If a step failed, say so plainly with the error.
- End with exactly one line: "Ran in <duration>s, cost $<total>."`;

/**
 * Direct conversational answer — greetings, "what can you do?", informational
 * questions. No skills run, no drafting; narration tier (cheap).
 */
export async function answerDirectly(
  msg: IncomingMessage,
  memory: RecalledContext,
  agentRunId: string,
): Promise<string> {
  const availableSkills = allSkills().filter((skill) => skill.available);
  const catalog = availableSkills
    .map((skill) => `- ${skill.manifest.slug}: ${skill.manifest.description}`)
    .join('\n');
  const context = memory.recent
    .map((m) => `${m.direction}: ${m.body.slice(0, 200)}`)
    .join('\n');
  try {
    const res = await callLLM({
      skillSlug: 'assistant',
      skillClass: 'narration',
      system: `${SYSTEM}\n\nYou are answering a direct question or greeting — no run was executed, so do NOT fabricate results and do NOT append the cost line. Answer plainly. When asked about capabilities, summarize from your skill catalog:\n${catalog}`,
      prompt: `${context ? `Recent conversation:\n${context}\n\n` : ''}Operator says: ${msg.body}`,
      maxTokens: 800,
      agentRunId,
      purpose: 'direct-answer',
    });
    return res.text.trim();
  } catch (err) {
    return `Ready. ${availableSkills.length} skills available. Ask for GIS work or "list your skills". (${(err as Error).message})`;
  }
}

export async function narrate(
  plan: Plan,
  results: StepResult[],
  reviewResult: Review,
  totals: { durationSeconds: number; costUsd: number },
  agentRunId: string,
): Promise<string> {
  try {
    const res = await callLLM({
      skillSlug: 'narrator',
      skillClass: 'narration',
      system: SYSTEM,
      prompt: `Plan: ${JSON.stringify(plan)}\nResults: ${JSON.stringify(results).slice(0, 6000)}\nCritic notes: ${reviewResult.notes}\nTotals: ${totals.durationSeconds}s, $${totals.costUsd.toFixed(2)}`,
      maxTokens: 1000,
      agentRunId,
      purpose: 'narrate',
    });
    return res.text.trim();
  } catch (err) {
    // Narration must never eat the result — fall back to a mechanical report.
    const lines = [
      plan.summary,
      ...results.map((r, i) =>
        r.ok ? `Step ${i + 1}: ok` : `Step ${i + 1}: FAILED — ${r.error}`,
      ),
      `Ran in ${totals.durationSeconds}s, cost $${totals.costUsd.toFixed(2)}.`,
    ];
    return lines.join('\n');
  }
}
