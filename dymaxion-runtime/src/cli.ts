#!/usr/bin/env node
// The `dymaxion` bin — interactive REPL + batch commands, run inside the
// container: `docker exec -it dymaxion-runtime dymaxion`
//
//   dymaxion                                  interactive REPL
//   dymaxion query "<text>"                   one-shot request
//   dymaxion run --skill <slug> --input <json> non-destructive batch invocation
//   dymaxion change-risk-packet ...            deterministic governed workflow
//   dymaxion project switch <slug>            set active project
//   dymaxion status                           runtime state + recent activity

import { desc, eq } from 'drizzle-orm';
import { db, schema, closeDb } from './db/client.js';
import { loadSkills, getSkill, allSkills } from './skills/registry.js';
import { runSkill } from './skills/executor.js';
import { runAgent } from './agent/executor.js';
import { CliGateway } from './gateways/cli/index.js';
import { getProjectBySlug, setActiveProject } from './memory/project.js';
import { startAllMcpServers, stopAllMcpServers } from './mcp/manager.js';
import { checkWorkerHealth, workerAvailable, workerConfigured } from './worker/client.js';
import { getWorkflow } from './workflows/registry.js';
import type { OutgoingAttachment } from './gateways/common.js';

async function bootstrap(): Promise<CliGateway> {
  await startAllMcpServers().catch(() => undefined);
  await checkWorkerHealth().catch(() => undefined);
  await loadSkills(false);
  const gateway = new CliGateway();
  gateway.onMessage((msg) => runAgent(msg, gateway));
  return gateway;
}

async function status(): Promise<void> {
  await loadSkills(false);
  const skills = allSkills();
  console.log(`skills: ${skills.length} registered, ${skills.filter((s) => s.available).length} available`);
  console.log(
    `windows worker: ${workerConfigured() ? (workerAvailable() ? 'available' : 'unreachable') : 'not configured'}`,
  );
  const runs = await db
    .select({
      id: schema.agentRuns.id,
      status: schema.agentRuns.status,
      startedAt: schema.agentRuns.startedAt,
      costUsd: schema.agentRuns.costUsd,
    })
    .from(schema.agentRuns)
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(5);
  console.log('recent runs:');
  for (const r of runs) {
    console.log(`  ${r.id}  ${r.status}  ${r.startedAt.toISOString()}  $${r.costUsd}`);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function strictFlagPairs(args: string[], allowed: ReadonlySet<string>): Record<string, string> {
  if (args.length % 2 !== 0) throw new Error('change-risk-packet arguments must be flag/value pairs');
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!allowed.has(flag) || !value || value.startsWith('--') || flag in values) {
      throw new Error('invalid or duplicate change-risk-packet argument');
    }
    values[flag] = value;
  }
  return values;
}

async function runChangeRiskPacket(args: string[]): Promise<void> {
  const usage =
    'usage: dymaxion change-risk-packet --portal-url <https://org.maps.arcgis.com> --root-item-id <32-hex> --project-id <uuid> --review-posture <retirement_cleanup|change_review> [--organization-name <label>]';
  const flags = strictFlagPairs(
    args,
    new Set(['--portal-url', '--root-item-id', '--project-id', '--review-posture', '--organization-name']),
  );
  const workflow = getWorkflow('arcgis_change_risk_packet');
  if (!workflow) throw new Error('change-risk workflow is not registered');
  const parsed = workflow.inputSchema.safeParse({
    portal_url: flags['--portal-url'],
    root_item_id: flags['--root-item-id'],
    project_id: flags['--project-id'],
    review_posture: flags['--review-posture'],
    ...(flags['--organization-name'] ? { organization_name: flags['--organization-name'] } : {}),
  });
  if (!parsed.success) throw new Error(`change-risk-packet input rejected; ${usage}`);

  const plan = {
    summary: 'deterministic ArcGIS change-risk packet',
    steps: [
      {
        index: 0,
        skill: workflow.manifest.slug,
        kind: 'workflow' as const,
        description: workflow.manifest.description,
        input: parsed.data as Record<string, unknown>,
        destructive: false,
        requiresApproval: false,
        timeoutSeconds: 300,
        optional: false,
      },
    ],
  };
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ plan, status: 'running' })
    .returning({ id: schema.agentRuns.id });
  if (!run) throw new Error('could not create workflow run');

  const gateway = new CliGateway();
  const target = { gateway: gateway.name, source_id: `workflow:${run.id}` };
  const timeoutRaw = Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30);
  const approvalTimeoutMinutes = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 24 * 60) : 30;

  try {
    const execution = await workflow.execute(parsed.data, {
      agentRunId: run.id,
      gateway: {
        requestApproval: async (request) => {
          await db.update(schema.agentRuns).set({ status: 'awaiting_approval' }).where(eq(schema.agentRuns.id, run.id));
          try {
            return await gateway.requestApproval(target, request);
          } finally {
            await db.update(schema.agentRuns).set({ status: 'running' }).where(eq(schema.agentRuns.id, run.id));
          }
        },
      },
      approvalTimeoutMinutes,
    });
    const attachments: OutgoingAttachment[] = execution.deliveries.map((delivery) => ({
      path: delivery.path,
      mime: delivery.media_type,
      original_name: delivery.original_name,
      sha256: delivery.sha256,
      bytes: delivery.bytes,
      handle: delivery.handle,
    }));
    await gateway.sendFinal(target, execution.summary, attachments);
    await db
      .update(schema.agentRuns)
      .set({ status: 'completed', finalNarrative: execution.summary, endedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
  } catch {
    await db
      .update(schema.agentRuns)
      .set({ status: 'failed', finalNarrative: 'workflow input or execution was rejected', endedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    throw new Error('change-risk-packet execution failed; inspect audited run evidence');
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case undefined: {
        const gateway = await bootstrap();
        await gateway.runREPL();
        break;
      }
      case 'query': {
        const gateway = await bootstrap();
        await gateway.runOnce(args.join(' '));
        break;
      }
      case 'run': {
        const slug = argValue(args, '--skill');
        const inputJson = argValue(args, '--input') ?? '{}';
        if (!slug) throw new Error('usage: dymaxion run --skill <slug> --input <json>');
        await startAllMcpServers().catch(() => undefined);
        await checkWorkerHealth().catch(() => undefined);
        await loadSkills(false);
        if (!getSkill(slug)) throw new Error(`unknown skill '${slug}'`);
        const [run] = await db
          .insert(schema.agentRuns)
          .values({ plan: { summary: `cli batch: ${slug}`, steps: [] }, status: 'running' })
          .returning({ id: schema.agentRuns.id });
        const result = await runSkill(slug, JSON.parse(inputJson), run.id);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
        break;
      }
      case 'change-risk-packet':
        await runChangeRiskPacket(args);
        break;
      case 'project': {
        if (args[0] !== 'switch' || !args[1]) throw new Error('usage: dymaxion project switch <slug>');
        const project = await getProjectBySlug(args[1]);
        if (!project) throw new Error(`project '${args[1]}' not found`);
        setActiveProject('cli', project.id);
        console.log(`active project: ${project.name} (${project.slug})`);
        break;
      }
      case 'status':
        await status();
        break;
      default:
        console.error(
          'usage: dymaxion [query "<text>" | run --skill <slug> --input <json> | change-risk-packet <flags> | project switch <slug> | status]',
        );
        process.exitCode = 2;
    }
  } finally {
    await stopAllMcpServers().catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
