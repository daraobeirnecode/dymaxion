// Plan — decompose a request into a sequence of skill invocations using the
// workhorse tier, grounded in: recalled memory, applicable skills (with
// availability + destructive flags), and knowledge-base context.

import { allCapabilities } from '../capabilities/registry.js';
import type { CapabilityDefinition } from '../contracts/capability.js';
import { capabilityRequiresApproval } from '../contracts/capability.js';
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
- Greetings, small talk, questions about Dymaxion itself ("what can you do?"), and
  informational questions answerable without running tools: return
  {"summary":"conversational","steps":[]} — the runtime answers directly.
- ONLY for an actionable GIS task that no catalog skill can perform, return
  {"summary":"no-skill-gap","steps":[]} — the runtime will consider drafting a new skill.
- Inputs must match each skill's declared input names.`;

export async function plan(
  msg: IncomingMessage,
  intent: Intent,
  memory: RecalledContext,
  agentRunId: string,
): Promise<Plan> {
  const skills = applicableSkills(intent.domain);
  const capabilities = allCapabilities();
  const catalog = [
    ...skills.map((skill) => ({
      slug: skill.manifest.slug,
      description: skill.manifest.description,
      inputs: (skill.manifest.inputs ?? []).map((input) => `${input.name}${input.required ? '*' : ''}`),
      destructive: skill.manifest.destructive,
      available: skill.available,
      kind: 'historical-skill',
    })),
    ...capabilities.map((capability) => ({
      slug: capability.manifest.slug,
      description: capability.manifest.description,
      inputs: capability.inputSummary,
      destructive: capability.manifest.classification !== 'read',
      available: true,
      kind: 'native-capability',
    })),
  ];

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

  const executable = new Map<
    string,
    {
      description: string;
      destructive: boolean;
      timeoutSeconds: number;
      capability?: CapabilityDefinition<unknown, unknown>;
    }
  >([
    ...skills.map(
      (skill) =>
        [
          skill.manifest.slug,
          {
            description: skill.manifest.description,
            destructive: skill.manifest.destructive || skill.manifest.requires_approval,
            timeoutSeconds: skill.manifest.budget.max_duration_seconds,
          },
        ] as const,
    ),
    ...capabilities.map(
      (capability) =>
        [
          capability.manifest.slug,
          {
            description: capability.manifest.description,
            destructive: capability.manifest.classification !== 'read',
            timeoutSeconds: Math.ceil(capability.manifest.resource_limits.max_duration_ms / 1_000),
            capability,
          },
        ] as const,
    ),
  ]);
  const steps: PlanStep[] = (parsed.steps ?? [])
    .filter((step) => step.skill && executable.has(step.skill))
    .map((step, index) => {
      const descriptor = executable.get(step.skill!)!;
      const input = (step.input as Record<string, unknown>) ?? {};
      let destructive = descriptor.destructive;
      if (descriptor.capability) {
        try {
          destructive = capabilityRequiresApproval(descriptor.capability, input);
        } catch {
          destructive = true;
        }
      }
      return {
        index,
        skill: step.skill!,
        description: step.description ?? descriptor.description,
        input,
        destructive,
        timeout_seconds: descriptor.timeoutSeconds,
      };
    });

  return { summary: parsed.summary ?? 'plan', complexity: intent.complexity, steps };
}
