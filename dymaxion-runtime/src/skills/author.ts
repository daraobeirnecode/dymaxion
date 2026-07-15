// The self-authoring meta-capability (backs the skill-draft meta skill).
// Flow per Fable 5 Prompt §SKILL AUTHORING:
//   1. read failing run log  2. similar-skill search  3. fork recommendation
//   4. draft via reasoning-tier LLM  5. pre-flight lint  6. save to
//   skills/proposed/ + dymaxion.proposed_skills  7. notify operator
// Approval (dashboard or Telegram button) moves the folder to active/ and
// hot-reloads the registry.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { callLLM } from '../llm/middleware.js';
import { embedOne } from '../memory/embedding.js';
import { lintProposedExecutor, lintReport } from './validator.js';
import { loadSkills } from './registry.js';
import { auditEvent } from '../security/audit.js';
import { logger } from '../observability/logger.js';
import { sql as dsql } from 'drizzle-orm';

const DRAFT_SYSTEM_PROMPT = `You are Dymaxion's skill author. Draft a new GIS skill as three artifacts:
1. SKILL.md — contract with Purpose, When to use, When NOT to use, Inputs, Outputs, Tools required, Execution plan, LLM prompts, Failure modes, Cost + timeout
2. manifest.yaml — slug, name, version 0.1.0, description, skill_class, tools, executor (python/executor.py), budget, inputs, outputs, destructive, requires_approval, authored_by: dymaxion-agent
3. executor.py — implementation calling ONLY the runtime tool layer (MCP servers, worker client). Never raw shell, subprocess, SQL DDL, or file deletion.

Respond with three fenced blocks labeled SKILL.md, manifest.yaml, executor.py. Nothing else.`;

export interface DraftOutcome {
  action: 'forked-recommendation' | 'proposed' | 'rejected';
  detail: string;
  proposedId?: string;
}

export function shouldAttemptAuthoring(stepError: string): boolean {
  // Heuristic: capability gaps ("no skill", "unknown skill") warrant a draft;
  // transient failures (network, timeout) do not.
  return /no skill|unknown skill|not covered|unsupported operation/i.test(stepError);
}

export async function draftSkill(params: {
  agentRunId: string;
  failureContext: string;
  desiredCapability: string;
}): Promise<DraftOutcome> {
  // 2-3. similar-skill search on the registry embeddings
  try {
    const vector = await embedOne(params.desiredCapability);
    const vectorLiteral = `[${vector.join(',')}]`;
    const similar = (await db.execute(dsql`
      SELECT slug, 1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM dymaxion.skill_registry
      WHERE embedding IS NOT NULL AND status = 'active'
      ORDER BY embedding <=> ${vectorLiteral}::vector LIMIT 1
    `)) as unknown as Array<{ slug: string; similarity: number }>;
    if (similar[0] && Number(similar[0].similarity) > 0.85) {
      return {
        action: 'forked-recommendation',
        detail: `Existing skill '${similar[0].slug}' is ${Math.round(Number(similar[0].similarity) * 100)}% similar — recommend forking it instead of drafting from scratch.`,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'similar-skill search unavailable, drafting from scratch');
  }

  // 4. draft with the skill_authoring tier (reasoning model, $5 hard cap via budgets)
  const gen = await callLLM({
    skillSlug: 'skill-draft',
    skillClass: 'skill_authoring',
    system: DRAFT_SYSTEM_PROMPT,
    prompt: `Capability needed: ${params.desiredCapability}\n\nFailing run context:\n${params.failureContext}`,
    maxTokens: 8000,
    agentRunId: params.agentRunId,
    purpose: 'skill-draft',
  });

  const skillMd = extractBlock(gen.text, 'SKILL.md');
  const manifestYaml = extractBlock(gen.text, 'manifest.yaml');
  const executorPy = extractBlock(gen.text, 'executor.py');
  if (!skillMd || !manifestYaml || !executorPy) {
    return { action: 'rejected', detail: 'draft response missing one of the three artifacts' };
  }

  // 5. pre-flight lint
  const findings = lintProposedExecutor(executorPy);
  if (findings.length) {
    await auditEvent('skill_proposed', { outcome: 'lint-rejected', findings }, params.agentRunId);
    return { action: 'rejected', detail: lintReport(findings) };
  }

  // 6. save to skills/proposed/<slug>/ + DB row
  const slugMatch = manifestYaml.match(/^slug:\s*(\S+)/m);
  const slug = slugMatch?.[1] ?? `drafted-${Date.now()}`;
  const proposedDir = join(process.env.SKILLS_DIR ?? '/workspace/skills', 'proposed', slug);
  mkdirSync(proposedDir, { recursive: true });
  writeFileSync(join(proposedDir, 'SKILL.md'), skillMd);
  writeFileSync(join(proposedDir, 'manifest.yaml'), manifestYaml);
  writeFileSync(join(proposedDir, 'executor.py'), executorPy);

  const [row] = await db
    .insert(schema.proposedSkills)
    .values({
      slug,
      proposedForRun: params.agentRunId,
      skillMd,
      manifestYaml,
      scripts: { 'executor.py': executorPy },
    })
    .returning({ id: schema.proposedSkills.id });

  await auditEvent('skill_proposed', { slug, proposedId: row.id }, params.agentRunId);
  // 7. operator notification happens in the agent loop (originating gateway).
  return {
    action: 'proposed',
    detail: `Drafted new skill '${slug}'. Review in the admin dashboard (Skills → Proposed) and approve to register.`,
    proposedId: row.id,
  };
}

/** Approval hook — used by admin dashboard + Telegram button. */
export async function approveProposedSkill(proposedId: string, decidedBy: string): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.proposedSkills)
    .where(eq(schema.proposedSkills.id, proposedId))
    .orderBy(desc(schema.proposedSkills.proposedAt));
  if (!row) throw new Error(`proposed skill ${proposedId} not found`);

  // Move to active/ under the 'meta' category namespace for self-authored skills.
  const activeDir = join(process.env.SKILLS_DIR ?? '/workspace/skills', 'active', 'meta', row.slug);
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(join(activeDir, 'SKILL.md'), row.skillMd);
  writeFileSync(join(activeDir, 'manifest.yaml'), row.manifestYaml);
  for (const [file, contents] of Object.entries(row.scripts as Record<string, string>)) {
    writeFileSync(join(activeDir, file), contents);
  }
  await db
    .update(schema.proposedSkills)
    .set({ status: 'approved', reviewedAt: new Date(), reviewNotes: `approved by ${decidedBy}` })
    .where(eq(schema.proposedSkills.id, proposedId));
  await loadSkills(); // hot swap
  await auditEvent('skill_proposed', { proposedId, outcome: 'approved', decidedBy });
}

function extractBlock(text: string, label: string): string | null {
  // Matches: ```<lang or label line mentioning the label> ... ```
  const re = new RegExp(
    '```[^\\n]*' + label.replace('.', '\\.') + '[^\\n]*\\n([\\s\\S]*?)```',
    'i',
  );
  const m = text.match(re);
  return m ? m[1].trim() : null;
}
