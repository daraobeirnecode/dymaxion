// LangFuse tracing. Every agent run gets a trace; every LLM call through
// the middleware gets a generation on that trace. Fails open: if LangFuse
// is unreachable the runtime keeps working and logs a warning.

import { Langfuse } from 'langfuse';
import { logger } from './logger.js';

let client: Langfuse | null = null;

export function langfuse(): Langfuse | null {
  if (client) return client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    return null; // observability optional in dev
  }
  client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_URL ?? 'http://dymaxion-langfuse:3000',
  });
  return client;
}

export interface GenerationRecord {
  traceId: string;
  name: string;
  model: string;
  input: unknown;
  output: unknown;
  usage?: { input?: number; output?: number };
  costUsd?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

export function traceRun(runId: string, name: string, metadata?: Record<string, unknown>): string {
  const lf = langfuse();
  if (!lf) return runId;
  try {
    lf.trace({ id: runId, name, metadata });
  } catch (err) {
    logger.warn({ err }, 'langfuse trace failed');
  }
  return runId;
}

export function recordGeneration(rec: GenerationRecord): void {
  const lf = langfuse();
  if (!lf) return;
  try {
    lf.generation({
      traceId: rec.traceId,
      name: rec.name,
      model: rec.model,
      input: rec.input,
      output: rec.output,
      usage: { input: rec.usage?.input, output: rec.usage?.output },
      metadata: { ...rec.metadata, cost_usd: rec.costUsd, latency_ms: rec.latencyMs },
    });
  } catch (err) {
    logger.warn({ err }, 'langfuse generation failed');
  }
}

export async function flushLangfuse(): Promise<void> {
  try {
    await client?.flushAsync();
  } catch {
    /* fail open */
  }
}
