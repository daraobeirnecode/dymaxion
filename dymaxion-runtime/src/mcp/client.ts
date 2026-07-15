// Thin wrapper over the official MCP TypeScript SDK client for one
// stdio-transport server.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../config/loader.js';
import { logger } from '../observability/logger.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class McpConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(public readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
    });
    this.client = new Client(
      { name: 'dymaxion-runtime', version: '0.1.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
    logger.info({ server: this.config.name }, 'mcp server connected');
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new Error(`MCP '${this.config.name}' not connected`);
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error(`MCP '${this.config.name}' not connected`);
    const res = await this.client.callTool({ name, arguments: args });
    return res.content;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
  }

  get connected(): boolean {
    return this.client !== null;
  }
}
