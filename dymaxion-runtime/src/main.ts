// Dymaxion runtime entrypoint. Daemon mode (default) starts the enabled
// gateways + MCP servers + worker health loop and serves the runtime HTTP
// API. Subcommands back the operational scripts:
//   register-skills | load-knowledge-base [--refresh] | verify-mcp |
//   replay-run <id> | smoke-test

import { loadConfig } from './config/loader.js';
import { logger } from './observability/logger.js';
import { closeDb } from './db/client.js';
import { loadSkills, allSkills } from './skills/registry.js';
import { startAllMcpServers, stopAllMcpServers, verifyMcpServers } from './mcp/manager.js';
import { startWorkerHealthLoop, stopWorkerHealthLoop, checkWorkerHealth } from './worker/client.js';
import { loadKnowledgeBase } from './knowledge/loader.js';
import { runAgent, replayRun } from './agent/executor.js';
import type { Gateway } from './gateways/common.js';
import { TelegramGateway } from './gateways/telegram/index.js';
import { CliGateway } from './gateways/cli/index.js';
import { WebGateway } from './gateways/web/index.js';
import { TeamsGateway } from './gateways/teams/index.js';
import { SlackGateway } from './gateways/slack/index.js';
import { EmailGateway } from './gateways/email/index.js';
import { ArcgisPortalGateway } from './gateways/arcgis-portal/index.js';
import { SmsGateway } from './gateways/sms/index.js';

function buildGateways(): Map<string, Gateway> {
  const cfg = loadConfig().gateways;
  const all = new Map<string, Gateway>();
  all.set(
    'telegram',
    new TelegramGateway(
      process.env.TELEGRAM_BOT_TOKEN ?? '',
      process.env.TELEGRAM_ADMIN_CHAT_ID ?? '',
      Number(cfg.telegram?.poll_interval_ms ?? 1000),
    ),
  );
  all.set('cli', new CliGateway());
  all.set('web', new WebGateway());
  all.set('teams', new TeamsGateway());
  all.set('slack', new SlackGateway());
  all.set('email', new EmailGateway());
  all.set('arcgis-portal', new ArcgisPortalGateway());
  all.set('sms', new SmsGateway());
  return all;
}

async function daemon(): Promise<void> {
  logger.info('dymaxion runtime starting');
  const cfg = loadConfig();

  // Runs left 'running'/'awaiting_approval' by a previous process are dead —
  // mark them failed so the dashboard reflects reality.
  const { inArray } = await import('drizzle-orm');
  const { db, schema } = await import('./db/client.js');
  const stale = await db
    .update(schema.agentRuns)
    .set({ status: 'failed', endedAt: new Date(), finalNarrative: 'interrupted by runtime restart' })
    .where(inArray(schema.agentRuns.status, ['running', 'awaiting_approval']))
    .returning({ id: schema.agentRuns.id });
  if (stale.length) logger.warn({ count: stale.length }, 'marked stale runs as failed');

  await startAllMcpServers();
  startWorkerHealthLoop();
  await checkWorkerHealth();
  const skills = await loadSkills();
  logger.info(
    { registered: skills.length, available: skills.filter((s) => s.available).length },
    'skill catalog ready',
  );

  const gateways = buildGateways();
  for (const [name, gateway] of gateways) {
    const enabled = cfg.gateways[name]?.enabled ?? false;
    if (!enabled) continue;
    gateway.onMessage((msg) => runAgent(msg, gateway));
    try {
      await gateway.start();
      logger.info({ gateway: name }, 'gateway started');
    } catch (err) {
      logger.error({ err, gateway: name }, 'gateway failed to start');
    }
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    for (const gateway of gateways.values()) await gateway.stop().catch(() => undefined);
    stopWorkerHealthLoop();
    await stopAllMcpServers();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('dymaxion runtime ready');
}

/** Boot check without external APIs: config, registry scan, gateway construction. */
async function smokeTest(): Promise<void> {
  const cfg = loadConfig();
  console.log(`config: ${Object.keys(cfg.providers).length} providers, ${cfg.mcpServers.length} MCP servers`);
  const skills = await loadSkills(false); // no DB persist in smoke mode
  console.log(`skills: ${skills.length} registered from filesystem`);
  for (const category of ['esri', 'oss', 'web-mobile', 'architecture', 'meta']) {
    console.log(`  ${category}: ${skills.filter((s) => s.category === category).length}`);
  }
  const gateways = buildGateways();
  console.log(`gateways: ${gateways.size} constructed (${
    [...gateways.keys()].filter((g) => cfg.gateways[g]?.enabled).join(', ')
  } enabled)`);
  console.log('smoke test: OK');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case 'daemon':
      await daemon();
      return; // daemon keeps the loop alive
    case 'register-skills': {
      await startAllMcpServers().catch(() => undefined);
      await checkWorkerHealth().catch(() => undefined);
      const skills = await loadSkills(true);
      console.log(`registered ${skills.length} skills (${skills.filter((s) => s.available).length} available)`);
      break;
    }
    case 'load-knowledge-base': {
      const result = await loadKnowledgeBase(args.includes('--refresh'));
      console.log(`embedded ${result.chunks} chunks from ${result.files} files`);
      break;
    }
    case 'verify-mcp': {
      const ok = await verifyMcpServers();
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'replay-run': {
      if (!args[0]) throw new Error('usage: replay-run <agent-run-uuid>');
      await loadSkills(false);
      await replayRun(args[0], new CliGateway());
      break;
    }
    case 'smoke-test':
      await smokeTest();
      break;
    default:
      console.error(`unknown command '${command}'`);
      process.exitCode = 2;
  }
  await stopAllMcpServers().catch(() => undefined);
  await closeDb().catch(() => undefined);
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
