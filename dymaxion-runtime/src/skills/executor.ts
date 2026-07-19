// Runs registered skills and native capabilities. Untrusted inputs are
// validated and boundary-preflighted before persistence, dispatch, or dataset
// content I/O. Invocation outcomes retain the existing Postgres/history shape.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { executeCapability, getCapability } from '../capabilities/registry.js';
import type { CapabilityExecutionContext } from '../contracts/capability.js';
import { db, schema } from '../db/client.js';
import type { ApprovalRequest } from '../gateways/common.js';
import { recordInvocationOutcome } from '../memory/skill-history.js';
import { logger } from '../observability/logger.js';
import { auditEvent, type AuditEventType } from '../security/audit.js';
import { consumeApproval, deriveApprovalTarget } from '../security/approval.js';
import { assertExecutionBoundary, type BoundaryOptions } from '../security/boundary.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';
import { runArcpy, runProCli } from '../worker/client.js';
import { getSkill, type RegisteredSkill } from './registry.js';

export interface SkillResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  costUsd: number;
}

interface InvocationStart {
  agentRunId: string;
  skillSlug: string;
  skillVersion: string;
  input: Record<string, unknown>;
}

interface InvocationFinish extends SkillResult {
  skillSlug: string;
}

export interface InvocationRecorder {
  begin(invocation: InvocationStart): Promise<string>;
  finish(invocationId: string, result: InvocationFinish): Promise<void>;
}

type AuditFn = (
  eventType: AuditEventType,
  payload: Record<string, unknown>,
  agentRunId?: string,
) => Promise<void>;

export interface RunSkillDependencies {
  recorder: InvocationRecorder;
  audit: AuditFn;
  boundaryOptions: BoundaryOptions;
  capabilityContext: CapabilityExecutionContext;
  approvalRequest?: ApprovalRequest;
}

const databaseRecorder: InvocationRecorder = {
  async begin(invocation): Promise<string> {
    const [row] = await db
      .insert(schema.skillInvocations)
      .values({
        agentRunId: invocation.agentRunId,
        skillSlug: invocation.skillSlug,
        skillVersion: invocation.skillVersion,
        input: invocation.input,
      })
      .returning({ id: schema.skillInvocations.id });
    return row.id;
  },
  async finish(invocationId, result): Promise<void> {
    await db
      .update(schema.skillInvocations)
      .set({
        completedAt: new Date(),
        output: result.ok ? result.output : null,
        error: result.error ? { message: result.error } : null,
        costUsd: result.costUsd.toFixed(4),
      })
      .where(eq(schema.skillInvocations.id, invocationId));
    await recordInvocationOutcome(
      result.skillSlug,
      result.ok,
      result.durationMs,
      result.costUsd,
    );
  },
};

function resolveDependencies(
  agentRunId: string,
  supplied: Partial<RunSkillDependencies>,
): RunSkillDependencies {
  const audit = supplied.audit ?? auditEvent;
  return {
    recorder: supplied.recorder ?? databaseRecorder,
    audit,
    boundaryOptions: {
      agentRunId,
      audit,
      ...(supplied.boundaryOptions ?? {}),
    },
    capabilityContext: {
      agentRunId,
      ...(supplied.capabilityContext ?? {}),
      // Outbound-request capabilities must enforce the same boundary policy
      // (audit sink, DNS resolution) the executor preflight uses.
      boundary: supplied.capabilityContext?.boundary ?? {
        agentRunId,
        audit,
        ...(supplied.boundaryOptions ?? {}),
      },
    },
    approvalRequest: supplied.approvalRequest,
  };
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

export async function runSkill(
  slug: string,
  input: Record<string, unknown>,
  agentRunId: string,
  supplied: Partial<RunSkillDependencies> = {},
): Promise<SkillResult> {
  const started = Date.now();
  const dependencies = resolveDependencies(agentRunId, supplied);
  const capability = getCapability(slug);
  const skill = capability ? undefined : getSkill(slug);

  if (!capability && !skill) {
    return { ok: false, error: `unknown skill or capability: ${slug}`, durationMs: 0, costUsd: 0 };
  }
  if (skill && !skill.available) {
    return {
      ok: false,
      error: `skill unavailable: ${slug} — ${skill.unavailableReason ?? 'unknown reason'}`,
      durationMs: 0,
      costUsd: 0,
    };
  }

  let validatedInput: Record<string, unknown>;
  try {
    if (capability) {
      validatedInput = capability.inputSchema.parse(input) as Record<string, unknown>;
    } else {
      const inputError = validateInputs(skill as RegisteredSkill, input);
      if (inputError) throw new Error(inputError);
      validatedInput = input;
    }
    // Must remain before invocation persistence and all execution adapters.
    await assertExecutionBoundary(validatedInput, dependencies.boundaryOptions);

    const requiresApproval = capability
      ? capability.manifest.classification !== 'read'
      : Boolean(skill?.manifest.destructive || skill?.manifest.requires_approval);
    if (requiresApproval) {
      const request = dependencies.approvalRequest;
      if (!request) throw new Error(`approval required before executing '${slug}'`);
      if (request.agent_run_id !== agentRunId) {
        throw new Error('approval binding mismatch: agent run changed');
      }
      // Re-resolve trusted bindings and atomically consume at the shared sink,
      // immediately before invocation persistence and dispatch.
      await consumeApproval(
        request,
        validatedInput,
        deriveApprovalTarget(slug, validatedInput),
        resolveExecutionCredentialIdentity(slug),
      );
    }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
      durationMs: Date.now() - started,
      costUsd: 0,
    };
  }

  const skillVersion = capability?.manifest.version ?? (skill as RegisteredSkill).manifest.version;
  const invocationId = await dependencies.recorder.begin({
    agentRunId,
    skillSlug: slug,
    skillVersion,
    input: validatedInput,
  });
  await dependencies.audit(
    'skill_invocation',
    { slug, version: skillVersion, invocation_id: invocationId },
    agentRunId,
  );

  let result: SkillResult;
  try {
    const output = capability
      ? await executeCapability(slug, validatedInput, dependencies.capabilityContext)
      : await executeRegisteredSkill(skill as RegisteredSkill, validatedInput, agentRunId);
    result = {
      ok: true,
      output,
      durationMs: Date.now() - started,
      costUsd: 0,
    };
  } catch (error) {
    const message = (error as Error).message;
    logger.error({ error, slug, agentRunId }, 'skill/capability execution failed');
    result = {
      ok: false,
      error: message,
      durationMs: Date.now() - started,
      costUsd: 0,
    };
  }

  await dependencies.recorder.finish(invocationId, { ...result, skillSlug: slug });
  return result;
}

async function executeRegisteredSkill(
  skill: RegisteredSkill,
  input: Record<string, unknown>,
  agentRunId: string,
): Promise<unknown> {
  const timeoutSeconds = skill.manifest.budget.max_duration_seconds ?? 300;
  if (skill.manifest.executor.runtime === 'windows-worker') {
    // The Phase 0 worker client rejects these calls before network dispatch.
    return skill.manifest.slug === 'arcgis-pro-project-editor'
      ? runProCli({
          operation: String(input.operation ?? 'noop'),
          ...input,
          timeout_seconds: timeoutSeconds,
        })
      : runArcpy({
          script: String(input.script ?? ''),
          inputs: input,
          timeout_seconds: timeoutSeconds,
          run_id: agentRunId,
        });
  }
  return runSubprocess(skill, input, timeoutSeconds * 1_000);
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

function runSubprocess(
  skill: RegisteredSkill,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const entry = join(skill.dir, skill.manifest.executor.entrypoint);
  const [command, args] =
    skill.manifest.executor.type === 'python'
      ? ['python3', [entry]]
      : skill.manifest.executor.type === 'node'
        ? ['npx', ['--no-install', 'tsx', entry]]
        : ['bash', [entry]];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: skill.dir,
      env: subprocessEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxOutputBytes = 10 * 1024 * 1024;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`skill '${skill.manifest.slug}' exceeded ${timeoutMs / 1000}s hard timeout`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxOutputBytes) {
        child.kill('SIGKILL');
        fail(new Error('skill stdout exceeded 10 MB limit'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > maxOutputBytes) {
        child.kill('SIGKILL');
        fail(new Error('skill stderr exceeded 10 MB limit'));
      }
    });
    child.on('error', (error) => {
      clearTimeout(killer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`skill exited ${code}: ${stderr.slice(-2_000) || `exit code ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
