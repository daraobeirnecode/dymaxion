// Runs a skill invocation: subprocess for approved skills (python via
// python3, node via tsx), Windows Worker dispatch for arcpy/Pro skills.
// Enforces the manifest's budget.max_duration_seconds hard timeout and
// records the invocation in dymaxion.skill_invocations + skill_history.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getSkill, type RegisteredSkill } from './registry.js';
import { recordInvocationOutcome } from '../memory/skill-history.js';
import { auditEvent } from '../security/audit.js';
import { runArcpy, runProCli } from '../worker/client.js';

export interface SkillRunResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  costUsd: number;
}

function validateInputs(skill: RegisteredSkill, input: Record<string, unknown>): string | null {
  for (const spec of skill.manifest.inputs ?? []) {
    const value = input[spec.name];
    if (spec.required && (value === undefined || value === null || value === '')) {
      return `missing required input '${spec.name}'`;
    }
    if (value !== undefined && spec.validation && typeof value === 'string') {
      if (!new RegExp(spec.validation).test(value)) {
        return `input '${spec.name}' failed validation ${spec.validation}`;
      }
    }
  }
  return null;
}

function runSubprocess(
  skill: RegisteredSkill,
  input: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = join(skill.dir, skill.manifest.executor.entrypoint);
  const [cmd, args] =
    skill.manifest.executor.type === 'python'
      ? ['python3', [entry]]
      : skill.manifest.executor.type === 'node'
        ? ['npx', ['-y', 'tsx', entry]]
        : ['bash', [entry]];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: skill.dir, env: process.env });
    const timeoutMs = (skill.manifest.budget.max_duration_seconds ?? 300) * 1000;
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`skill '${skill.manifest.slug}' exceeded ${timeoutMs / 1000}s hard timeout`));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

export async function runSkill(
  slug: string,
  input: Record<string, unknown>,
  agentRunId: string,
): Promise<SkillRunResult> {
  const started = Date.now();
  const skill = getSkill(slug);
  if (!skill) {
    return { ok: false, error: `unknown skill '${slug}'`, durationMs: 0, costUsd: 0 };
  }
  if (!skill.available) {
    return {
      ok: false,
      error: `skill '${slug}' unavailable: ${skill.unavailableReason}`,
      durationMs: 0,
      costUsd: 0,
    };
  }
  const inputError = validateInputs(skill, input);
  if (inputError) {
    return { ok: false, error: inputError, durationMs: 0, costUsd: 0 };
  }

  const [invocation] = await db
    .insert(schema.skillInvocations)
    .values({
      agentRunId,
      skillSlug: slug,
      skillVersion: skill.manifest.version,
      input,
    })
    .returning({ id: schema.skillInvocations.id });
  await auditEvent('skill_invocation', { slug, invocationId: invocation.id }, agentRunId);

  let result: SkillRunResult;
  try {
    if (skill.manifest.executor.runtime === 'windows-worker') {
      // arcpy-script-runner posts /arcpy/run; the Pro project editor posts /pro-cli/run.
      const workerResult =
        slug === 'arcgis-pro-project-editor'
          ? await runProCli({
              operation: String(input.operation ?? 'noop'),
              ...input,
              timeout_seconds: skill.manifest.budget.max_duration_seconds,
            })
          : await runArcpy({
              script: String(input.script ?? ''),
              inputs: input,
              timeout_seconds: skill.manifest.budget.max_duration_seconds,
              run_id: agentRunId,
            });
      result = {
        ok: workerResult.status === 'success',
        output: workerResult.outputs ?? { stdout: workerResult.stdout },
        error: workerResult.status === 'error' ? workerResult.stderr : undefined,
        durationMs: Date.now() - started,
        costUsd: 0,
      };
    } else {
      const { code, stdout, stderr } = await runSubprocess(skill, input);
      let output: unknown = stdout;
      try {
        output = JSON.parse(stdout);
      } catch {
        /* non-JSON output is passed through raw */
      }
      result = {
        ok: code === 0,
        output,
        error: code === 0 ? undefined : stderr || `exit code ${code}`,
        durationMs: Date.now() - started,
        costUsd: 0,
      };
    }
  } catch (err) {
    result = {
      ok: false,
      error: (err as Error).message,
      durationMs: Date.now() - started,
      costUsd: 0,
    };
  }

  await db
    .update(schema.skillInvocations)
    .set({
      completedAt: new Date(),
      output: result.ok ? (result.output as Record<string, unknown>) : null,
      error: result.error ? { message: result.error } : null,
      costUsd: result.costUsd.toFixed(4),
    })
    .where(eq(schema.skillInvocations.id, invocation.id));
  await recordInvocationOutcome(slug, result.ok, result.durationMs, result.costUsd);

  return result;
}
