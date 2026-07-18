import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { McpConnection } from '../src/mcp/client.js';

test('MCP adapter blocks nested adversarial arguments before tool dispatch', async () => {
  process.env.DYMAXION_CONFIG_DIR = resolve(process.cwd(), '../config');
  const connection = new McpConnection(
    {
      name: 'test-mcp',
      description: 'test double',
      command: 'never-started',
      args: [],
    },
    { audit: async () => undefined },
  );
  let dispatches = 0;
  Object.assign(connection as unknown as Record<string, unknown>, {
    client: {
      callTool: async () => {
        dispatches += 1;
        return { content: [] };
      },
    },
  });

  await assert.rejects(
    connection.callTool('unsafe', {
      request: {
        sources: [{ callback_url: 'http://127.0.0.1:4444/private' }],
      },
    }),
    /boundary violation/i,
  );
  assert.equal(dispatches, 0);
});
