#!/usr/bin/env node
// The `dymaxion` bin — interactive REPL + batch commands, run inside the
// container: `docker exec -it dymaxion-runtime dymaxion`
//
//   dymaxion                                  interactive REPL
//   dymaxion query "<text>"                   one-shot request
//   dymaxion run --skill <slug> --input <json> batch skill invocation
//   dymaxion project switch <slug>            set active project
//   dymaxion status                           runtime state + recent activity

import { desc } from 'drizzle-orm';
import { db, schema, closeDb } from './db/client.js';
import { loadSkills, getSkill, allSkills } from './skills/registry.js';
import { runSkill } from './skills/executor.js';
import { runAgent } from './agent/executor.js';
import { CliGateway } from './gateways/cli/index.js';
import { getProjectBySlug, setActiveProject } from './memory/project.js';
import { startAllMcpServers, stopAllMcpServers } from './mcp/manager.js';
import { checkWorkerHealth, workerAvailable, workerConfigured } from './worker/client.js';

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
          'usage: dymaxion [query "<text>" | run --skill <slug> --input <json> | project switch <slug> | status]',
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
