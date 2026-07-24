// runAgent() — the six-step loop from Full Product Spec.md:
//   1 classify → 2 plan → 3 show plan → 4 execute step-by-step (approvals
//   for destructive) → 5 self-critique (one revision pass) → 6 deliver.
// Every step audited + traced in LangFuse. One dymaxion.agent_runs row per
// request; replayable by ID.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { classify } from './classifier.js';
import { plan as makePlan } from './planner.js';
import { review } from './critic.js';
import { narrate, answerDirectly } from './narrator.js';
import { runSkill } from '../skills/executor.js';

import { shouldAttemptAuthoring, draftSkill } from '../skills/author.js';
import { getSkill } from '../skills/registry.js';

import { getWorkflow } from '../workflows/registry.js';
import type { DeliveredAttachment } from '../workflows/contract.js';
import { persistIncoming, persistOutgoing, loadRelevant } from '../memory/conversation.js';
import { getPreference } from '../memory/preferences.js';
import {
  createApprovalRequest,
  awaitDecision,
} from '../security/approval.js';
import { auditEvent } from '../security/audit.js';

import { traceRun, flushLangfuse } from '../observability/langfuse.js';
import { logger } from '../observability/logger.js';
import { createReplayAfterKindValidation } from './replay-contract.js';
import { resolveStepApproval } from './step-approval.js';
import type {
  ApprovalRequest,
  Gateway,
  IncomingMessage,
  MessageTarget,
  OutgoingAttachment,
  StepResult,
} from '../gateways/common.js';


function outgoingAttachment(delivery: DeliveredAttachment): OutgoingAttachment {
  return {
    path: delivery.path,
    mime: delivery.media_type,
    original_name: delivery.original_name,
    sha256: delivery.sha256,
    bytes: delivery.bytes,
    handle: delivery.handle,
  };
}

export async function runAgent(message: IncomingMessage, gateway: Gateway): Promise<void> {
  const started = Date.now();
  const target: MessageTarget = { gateway: message.gateway, source_id: message.source_id };

  await auditEvent('incoming_message', {
    gateway: message.gateway,
    source: message.source_id,
    body: message.body.slice(0, 500),
  });
  const messageId = await persistIncoming(message);

  // one agent_runs row per request; plan filled in after step 2
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ messageId, plan: {}, status: 'running' })
    .returning({ id: schema.agentRuns.id });
  const runId = run.id;
  traceRun(runId, 'agent-run', { gateway: message.gateway });

  try {
    // 1. Classify
    const intent = await classify(message, runId);
    await auditEvent('run_step', { step: 'classify', intent }, runId);

    // 2. Plan
    const memory = await loadRelevant(message);
    const plan = await makePlan(message, intent, memory, runId);
    await db.update(schema.agentRuns).set({ plan }).where(eq(schema.agentRuns.id, runId));
    await auditEvent('run_step', { step: 'plan', summary: plan.summary, steps: plan.steps.length }, runId);

    // Empty plan: either conversational (answer directly) or a genuine
    // capability gap on an actionable task (consider drafting a new skill).
    // Greetings/questions must NEVER trigger self-authoring.
    if (plan.steps.length === 0) {
      const genuineGap =
        plan.summary === 'no-skill-gap' && !intent.isQuestion && intent.complexity !== 'trivial';
      const reply = genuineGap
        ? (
            await draftSkill({
              agentRunId: runId,
              failureContext: message.body,
              desiredCapability: intent.summary,
            })
          ).detail
        : await answerDirectly(message, memory, runId);
      await finish(runId, 'completed', reply, 0);
      await gateway.sendFinal(target, reply);
      await persistOutgoing(message.gateway, message.source_id, reply);
      return;
    }

    // 3. Show plan (unless trivial)
    if (intent.complexity !== 'trivial' && plan.steps.length > 0) {
      await gateway.sendPlan(target, plan);
    }

    // 4. Execute step-by-step
    const timeoutMinutes = await getPreference<number>('approval_timeout_minutes', 30);
    const results: StepResult[] = [];
    const attachments: OutgoingAttachment[] = [];
    const workflowSummaries: string[] = [];
    let totalCost = 0;

    for (const step of plan.steps) {
      const workflow = getWorkflow(step.skill);
      if (
        (step.kind === 'workflow' && !workflow)
        || (workflow && step.kind !== 'workflow')
        || (workflow && Boolean(getSkill(step.skill)))
      ) {
        throw new Error('plan step registry kind mismatch or workflow slug collision');
      }
      let approvalRequest: ApprovalRequest | undefined;
      const approval = workflow ? undefined : await resolveStepApproval(step);
      if (approval) {
        const req = await createApprovalRequest(runId, step.description, approval.payload, {
          timeoutMinutes,
          target: approval.target,
          credentialIdentity: approval.credentialIdentity,
        });
        approvalRequest = req;
        await db.update(schema.agentRuns).set({ status: 'awaiting_approval' }).where(eq(schema.agentRuns.id, runId));
        const decision = await gateway
          .requestApproval(target, req)
          .catch(async () => awaitDecision(req)); // gateway without buttons → dashboard decides
        await db.update(schema.agentRuns).set({ status: 'running' }).where(eq(schema.agentRuns.id, runId));
        if (!decision.approved) {
          const note = `Stopped: '${step.description}' was ${decision.decision} by ${decision.decided_by}.`;
          await finish(runId, 'completed', note, totalCost);
          await gateway.sendFinal(target, note);
          await persistOutgoing(message.gateway, message.source_id, note);
          return;
        }
      }

      let stepResult: StepResult;
      if (workflow) {
        const stepStarted = Date.now();
        try {
          const input = workflow.inputSchema.parse(step.input);
          const execution = await workflow.execute(input, {
            agentRunId: runId,
            approvalTimeoutMinutes: timeoutMinutes,
            gateway: {
              requestApproval: async (req) => {
                await db
                  .update(schema.agentRuns)
                  .set({ status: 'awaiting_approval' })
                  .where(eq(schema.agentRuns.id, runId));
                try {
                  return await gateway.requestApproval(target, req).catch(async () => awaitDecision(req));
                } finally {
                  await db
                    .update(schema.agentRuns)
                    .set({ status: 'running' })
                    .where(eq(schema.agentRuns.id, runId));
                }
              },
            },
          });
          const output = workflow.outputSchema.parse(execution.output);
          stepResult = {
            ok: true,
            output,
            cost_usd: 0,
            duration_ms: Date.now() - stepStarted,
          };
          workflowSummaries.push(execution.summary);
          attachments.push(...execution.deliveries.map(outgoingAttachment));
        } catch {
          stepResult = {
            ok: false,
            error: 'workflow input or execution was rejected',
            cost_usd: 0,
            duration_ms: Date.now() - stepStarted,
          };
        }
      } else {
        const result = await runSkill(step.skill, step.input, runId, { approvalRequest });
        stepResult = {
          ok: result.ok,
          output: result.output,
          error: result.error,
          cost_usd: result.costUsd,
          duration_ms: result.durationMs,
        };
      }
      results.push(stepResult);
      totalCost += stepResult.cost_usd;
      await auditEvent(
        'run_step',
        { step: 'execute', skill: step.skill, kind: workflow ? 'workflow' : step.kind, ok: stepResult.ok },
        runId,
      );
      await gateway.sendProgress(target, step, stepResult);

      if (!stepResult.ok && !step.optional) {
        if (!workflow && stepResult.error && shouldAttemptAuthoring(stepResult.error)) {
          const outcome = await draftSkill({
            agentRunId: runId,
            failureContext: `Step '${step.description}' failed: ${stepResult.error}`,
            desiredCapability: step.description,
          });
          await auditEvent('run_step', { step: 'skill-author', outcome: outcome.action }, runId);
        }
        break;
      }
    }

    // 5. Self-critique. Deterministic workflows validate their own strict
    // outputs and must not be restated or second-guessed by an LLM.
    const workflowOnlyPlan = plan.steps.every((step) => Boolean(getWorkflow(step.skill)));
    const critique = workflowOnlyPlan
      ? { needsRevision: false, notes: 'deterministic workflow output validated by schema' }
      : await review(plan, results, runId);
    if (critique.needsRevision) {
      await auditEvent('run_step', { step: 'critique', notes: critique.notes }, runId);
      for (let i = 0; i < results.length; i++) {
        if (
          !results[i].ok &&
          !plan.steps[i].optional &&
          !plan.steps[i].destructive &&
          getSkill(plan.steps[i].skill)?.available
        ) {
          const retry = await runSkill(plan.steps[i].skill, plan.steps[i].input, runId);
          results[i] = {
            ok: retry.ok,
            output: retry.output,
            error: retry.error,
            cost_usd: retry.costUsd,
            duration_ms: retry.durationMs,
          };
          totalCost += retry.costUsd;
        }
      }
    }

    // 6. Deliver. A workflow's operator summary is deterministic and carries
    // exact counts/hashes; do not ask an LLM to restate it.
    const durationSeconds = Math.round((Date.now() - started) / 1000);
    const narrative = workflowOnlyPlan
      ? workflowSummaries.length
        ? workflowSummaries.join('\n\n')
        : `Workflow failed: ${results.find((result) => !result.ok)?.error ?? 'no validated output'}`
      : await narrate(plan, results, critique, { durationSeconds, costUsd: totalCost }, runId);
    await finish(runId, results.every((r) => r.ok) ? 'completed' : 'failed', narrative, totalCost);
    await gateway.sendFinal(target, narrative, attachments);
    await persistOutgoing(message.gateway, message.source_id, narrative);
  } catch (err) {
    logger.error({ err, runId }, 'agent run failed');
    const msg = `Run failed: ${(err as Error).message}`;
    await finish(runId, 'failed', msg, 0);
    await gateway.sendFinal(target, msg).catch(() => undefined);
  } finally {
    await flushLangfuse();
  }
}

async function finish(runId: string, status: string, narrative: string, costUsd: number): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({ status, endedAt: new Date(), finalNarrative: narrative, costUsd: costUsd.toFixed(4) })
    .where(eq(schema.agentRuns.id, runId));
}

/** Replay a past run: re-execute the stored plan's skill sequence. */
export async function replayRun(runId: string, gateway: Gateway): Promise<void> {
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  if (!run) throw new Error(`agent run ${runId} not found`);
  const storedPlan = run.plan as {
    summary?: string;
    steps?: Array<{
      skill: string;
      kind?: unknown;
      input: Record<string, unknown>;
      description: string;
      destructive: boolean;
      optional?: boolean;
    }>;
  };
  if (!storedPlan.steps?.length) throw new Error(`agent run ${runId} has no replayable plan`);

  const replay = await createReplayAfterKindValidation({ steps: storedPlan.steps }, async () => {
    const [created] = await db
      .insert(schema.agentRuns)
      .values({ plan: { ...storedPlan, replay_of: runId }, status: 'running' })
      .returning({ id: schema.agentRuns.id });
    if (!created) throw new Error('replay run could not be created');
    return created;
  });

  let cost = 0;
  const results: StepResult[] = [];
  const attachments: OutgoingAttachment[] = [];
  const workflowSummaries: string[] = [];
  const timeoutMinutes = await getPreference<number>('approval_timeout_minutes', 30);
  const replayTarget: MessageTarget = { gateway: gateway.name, source_id: 'replay' };
  for (const step of storedPlan.steps) {
    const workflow = step.kind === 'workflow' ? getWorkflow(step.skill) : undefined;
    if (workflow) {
      const started = Date.now();
      try {
        const execution = await workflow.execute(workflow.inputSchema.parse(step.input), {
          agentRunId: replay.id,
          approvalTimeoutMinutes: timeoutMinutes,
          gateway: {
            requestApproval: async (request) => {
              await db
                .update(schema.agentRuns)
                .set({ status: 'awaiting_approval' })
                .where(eq(schema.agentRuns.id, replay.id));
              try {
                return await gateway.requestApproval(replayTarget, request).catch(async () => awaitDecision(request));
              } finally {
                await db
                  .update(schema.agentRuns)
                  .set({ status: 'running' })
                  .where(eq(schema.agentRuns.id, replay.id));
              }
            },
          },
        });
        const output = workflow.outputSchema.parse(execution.output);
        results.push({ ok: true, output, cost_usd: 0, duration_ms: Date.now() - started });
        workflowSummaries.push(execution.summary);
        attachments.push(...execution.deliveries.map(outgoingAttachment));
      } catch {
        results.push({
          ok: false,
          error: 'workflow replay input or execution was rejected',
          cost_usd: 0,
          duration_ms: Date.now() - started,
        });
        break;
      }
      continue;
    }

    let approvalRequest: ApprovalRequest | undefined;
    const approval = await resolveStepApproval(step);
    if (approval) {
      const request = await createApprovalRequest(replay.id, `Replay: ${step.description}`, approval.payload, {
        timeoutMinutes,
        target: approval.target,
        credentialIdentity: approval.credentialIdentity,
      });
      approvalRequest = request;
      await db
        .update(schema.agentRuns)
        .set({ status: 'awaiting_approval' })
        .where(eq(schema.agentRuns.id, replay.id));
      const decision = await gateway
        .requestApproval(replayTarget, request)
        .catch(async () => awaitDecision(request));
      await db.update(schema.agentRuns).set({ status: 'running' }).where(eq(schema.agentRuns.id, replay.id));
      if (!decision.approved) break;
    }
    const r = await runSkill(step.skill, step.input, replay.id, { approvalRequest });
    results.push({ ok: r.ok, output: r.output, error: r.error, cost_usd: r.costUsd, duration_ms: r.durationMs });
    cost += r.costUsd;
    if (!r.ok) break;
  }
  const summary = workflowSummaries.length
    ? workflowSummaries.join('\n\n')
    : `Replay of ${runId}: ${results.filter((result) => result.ok).length}/${storedPlan.steps.length} steps ok.`;
  await finish(replay.id, results.every((result) => result.ok) ? 'completed' : 'failed', summary, cost);
  await gateway.sendFinal(replayTarget, summary, attachments);
  // eslint-disable-next-line no-console
  console.log(summary);
}
