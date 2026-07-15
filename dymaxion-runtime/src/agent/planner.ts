// Plan — decompose a request into a sequence of skill invocations using the
// workhorse tier, grounded in: recalled memory, applicable skills (with
// availability + destructive flags), and knowledge-base context.

import { callLLM } from '../llm/middleware.js';
import { applicableSkills } from '../skills/registry.js';
import type { IncomingMessage, Plan, PlanStep } from '../gateways/common.js';
import type { Intent } from './classifier.js';
import type { RecalledContext } from '../memory/conversation.js';

const SYSTEM = `You are Dymaxion's planner. Decompose the user's GIS request into an ordered
sequence of skill invocations from the catalog provided. Respond with ONLY minified JSON:
{"summary":"one-sentence plan","steps":[{"skill":"<slug>","description":"...","input":{...}}]}
Rules:
- Use ONLY skills from the catalog, and only ones marked available.
- Prefer fewer steps. A single-skill plan is normal.
- If nothing in the catalog fits, return {"summary":"no-skill-gap","steps":[]} — the
  runtime will consider drafting a new skill.
- Inputs must match each skill's declared input names.`;

export async function plan(
  msg: IncomingMessage,
  intent: Intent,
  memory: RecalledContext,
  agentRunId: string,
): Promise<Plan> {
  const skills = applicableSkills(intent.domain);
  const catalog = skills.map((s) => ({
    slug: s.manifest.slug,
    description: s.manifest.description,
    inputs: (s.manifest.inputs ?? []).map((i) => `${i.name}${i.required ? '*' : ''}`),
    destructive: s.manifest.destructive,
    available: s.available,
  }));

  const context = [
    memory.recent.length
      ? `Recent conversation:\n${memory.recent.map((m) => `${m.direction}: ${m.body.slice(0, 200)}`).join('\n')}`
      : '',
    memory.knowledge.length
      ? `Reference context:\n${memory.knowledge.map((k) => k.body.slice(0, 300)).join('\n---\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await callLLM({
    skillSlug: 'planner',
    skillClass: 'planning',
    system: SYSTEM,
    prompt: `Request: ${msg.body}\n\nIntent: ${JSON.stringify(intent)}\n\nSkill catalog:\n${JSON.stringify(catalog)}\n\n${context}`,
    maxTokens: 2000,
    temperature: 0,
    agentRunId,
    purpose: 'plan',
  });

  const jsonMatch = res.text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch
    ? (JSON.parse(jsonMatch[0]) as { summary: string; steps: Array<Partial<PlanStep>> })
    : { summary: 'no plan produced', steps: [] };

  const bySlug = new Map(skills.map((s) => [s.manifest.slug, s]));
  const steps: PlanStep[] = (parsed.steps ?? [])
    .filter((s) => s.skill && bySlug.has(s.skill))
    .map((s, i) => {
      const skill = bySlug.get(s.skill!)!;
      return {
        index: i,
        skill: s.skill!,
        description: s.description ?? skill.manifest.description,
        input: (s.input as Record<string, unknown>) ?? {},
        destructive: skill.manifest.destructive || skill.manifest.requires_approval,
        timeout_seconds: skill.manifest.budget.max_duration_seconds,
      };
    });

  return { summary: parsed.summary ?? 'plan', complexity: intent.complexity, steps };
}
