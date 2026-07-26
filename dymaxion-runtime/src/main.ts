// Dymaxion runtime entrypoint. Daemon mode (default) starts the enabled
// gateways + MCP servers + worker health loop and serves the runtime HTTP
// API. Subcommands back the operational scripts:
//   register-skills | load-knowledge-base [--refresh] | verify-mcp |
//   replay-run <id> | smoke-test

import { loadConfig } from './config/loader.js';
import { logger } from './observability/logger.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Gateway } from './gateways/common.js';
import { validateArcGisTokenBrokerSelector } from './security/arcgis-token-broker-selector.js';

const GATEWAY_NAMES = ['telegram', 'cli', 'web', 'teams', 'slack', 'email', 'arcgis-portal', 'sms'] as const;

async function buildGateways(): Promise<Map<string, Gateway>> {
  const [
    { TelegramGateway },
    { CliGateway },
    { WebGateway },
    { TeamsGateway },
    { SlackGateway },
    { EmailGateway },
    { ArcgisPortalGateway },
    { SmsGateway },
  ] = await Promise.all([
    import('./gateways/telegram/index.js'),
    import('./gateways/cli/index.js'),
    import('./gateways/web/index.js'),
    import('./gateways/teams/index.js'),
    import('./gateways/slack/index.js'),
    import('./gateways/email/index.js'),
    import('./gateways/arcgis-portal/index.js'),
    import('./gateways/sms/index.js'),
  ]);
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
  const [
    { loadSkills },
    { runAgent },
    { db, schema, closeDb },
    { startAllMcpServers, stopAllMcpServers },
    { startWorkerHealthLoop, stopWorkerHealthLoop, checkWorkerHealth },
  ] = await Promise.all([
    import('./skills/registry.js'),
    import('./agent/executor.js'),
    import('./db/client.js'),
    import('./mcp/manager.js'),
    import('./worker/client.js'),
  ]);

  // Runs left 'running'/'awaiting_approval' by a previous process are dead —
  // mark them failed so the dashboard reflects reality.
  const { inArray } = await import('drizzle-orm');
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

  const gateways = await buildGateways();
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

/** Boot check without external APIs or DB initialization: config, registry scan, gateway configuration. */
async function smokeTest(): Promise<void> {
  const cfg = loadConfig();
  console.log(`config: ${Object.keys(cfg.providers).length} providers, ${cfg.mcpServers.length} MCP servers`);
  const activeSkillsDir = join(process.env.SKILLS_DIR ?? '/workspace/skills', 'active');
  let skillFolderCount = 0;
  for (const category of existsSync(activeSkillsDir) ? readdirSync(activeSkillsDir) : []) {
    const categoryDir = join(activeSkillsDir, category);
    if (!statSync(categoryDir).isDirectory()) continue;
    skillFolderCount += readdirSync(categoryDir)
      .filter((slug) => statSync(join(categoryDir, slug)).isDirectory())
      .length;
  }
  console.log(`skills: ${skillFolderCount} folders discovered`);
  console.log(`gateways: ${GATEWAY_NAMES.length} configured (${
    GATEWAY_NAMES.filter((g) => cfg.gateways[g]?.enabled).join(', ')
  } enabled)`);
  console.log('smoke test: OK');
}

async function main(): Promise<void> {
  validateArcGisTokenBrokerSelector(process.env.DYMAXION_ARCGIS_TOKEN_BROKER);
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case 'daemon':
      await daemon();
      return; // daemon keeps the loop alive
    case 'register-skills': {
      const [
        { startAllMcpServers, stopAllMcpServers },
        { checkWorkerHealth },
      ] = await Promise.all([
        import('./mcp/manager.js'),
        import('./worker/client.js'),
      ]);
      await startAllMcpServers().catch(() => undefined);
      await checkWorkerHealth().catch(() => undefined);
      const { loadSkills } = await import('./skills/registry.js');
      const skills = await loadSkills(true);
      console.log(`registered ${skills.length} skills (${skills.filter((s) => s.available).length} available)`);
      const { closeDb } = await import('./db/client.js');
      await stopAllMcpServers().catch(() => undefined);
      await closeDb().catch(() => undefined);
      break;
    }
    case 'load-knowledge-base': {
      const { loadKnowledgeBase } = await import('./knowledge/loader.js');
      const result = await loadKnowledgeBase(args.includes('--refresh'));
      console.log(`embedded ${result.chunks} chunks from ${result.files} files`);
      const { closeDb } = await import('./db/client.js');
      await closeDb().catch(() => undefined);
      break;
    }
    case 'verify-mcp': {
      const { verifyMcpServers, stopAllMcpServers } = await import('./mcp/manager.js');
      const ok = await verifyMcpServers();
      process.exitCode = ok ? 0 : 1;
      await stopAllMcpServers().catch(() => undefined);
      break;
    }
    case 'replay-run': {
      if (!args[0]) throw new Error('usage: replay-run <agent-run-uuid>');
      const [{ loadSkills }, { replayRun }] = await Promise.all([
        import('./skills/registry.js'),
        import('./agent/executor.js'),
      ]);
      const { CliGateway } = await import('./gateways/cli/index.js');
      await loadSkills(false);
      await replayRun(args[0], new CliGateway());
      const { closeDb } = await import('./db/client.js');
      await closeDb().catch(() => undefined);
      break;
    }
    case 'smoke-test':
      await smokeTest();
      break;
    default:
      console.error(`unknown command '${command}'`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
