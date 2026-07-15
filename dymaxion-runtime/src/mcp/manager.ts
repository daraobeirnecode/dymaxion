// Spawns + supervises the MCP server subprocesses declared in
// config/mcp-servers.yaml. A server that fails to start degrades the skills
// that need it; it never blocks runtime startup.

import { loadConfig } from '../config/loader.js';
import { McpConnection } from './client.js';
import { logger } from '../observability/logger.js';
import { auditEvent } from '../security/audit.js';

const connections = new Map<string, McpConnection>();

export async function startAllMcpServers(): Promise<Map<string, boolean>> {
  const status = new Map<string, boolean>();
  for (const server of loadConfig().mcpServers) {
    const conn = new McpConnection(server);
    try {
      await conn.connect();
      connections.set(server.name, conn);
      status.set(server.name, true);
    } catch (err) {
      logger.error({ err, server: server.name }, 'mcp server failed to start — skills degraded');
      status.set(server.name, false);
    }
  }
  await auditEvent('system', { event: 'mcp_startup', status: Object.fromEntries(status) });
  return status;
}

export function mcpServer(name: string): McpConnection {
  const conn = connections.get(name);
  if (!conn) throw new Error(`MCP server '${name}' is not running`);
  return conn;
}

export function mcpAvailable(name: string): boolean {
  return connections.get(name)?.connected ?? false;
}

export async function stopAllMcpServers(): Promise<void> {
  for (const conn of connections.values()) await conn.close();
  connections.clear();
}

/** `verify-mcp` subcommand: connect each server, list tools, close. */
export async function verifyMcpServers(): Promise<boolean> {
  let allOk = true;
  for (const server of loadConfig().mcpServers) {
    const conn = new McpConnection(server);
    try {
      await conn.connect();
      const tools = await conn.listTools();
      // eslint-disable-next-line no-console
      console.log(`  ${server.name}: OK (${tools.length} tools)`);
      await conn.close();
    } catch (err) {
      console.log(`  ${server.name}: FAILED — ${(err as Error).message}`);
      allOk = false;
    }
  }
  return allOk;
}
