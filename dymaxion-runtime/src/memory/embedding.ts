// Voyage embedding client — voyage-3-large, 1024-dim. Used for message
// memory, knowledge-base retrieval, and similar-skill search.

import { computeCostUsd } from '../llm/cost.js';
import { auditEvent } from '../security/audit.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-large';

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RATE_LIMIT_WAIT_MS = 25_000; // keys without a payment method are capped at 3 RPM

export interface EmbedOptions {
  maxRetries?: number;
  timeoutMs?: number;
  maxWaitMs?: number;
}

export async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set — embeddings unavailable');
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) break;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`Voyage embeddings failed: HTTP ${res.status} ${await res.text()}`);
    }
    const retryAfterSeconds = Number(res.headers.get('retry-after') ?? '');
    const requestedWaitMs =
      res.status === 429
        ? Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_WAIT_MS
        : 2_000 * attempt;
    const waitMs = Math.min(requestedWaitMs, maxWaitMs);
    await res.text().catch(() => undefined); // drain body
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
    usage?: { total_tokens?: number };
  };
  const tokens = data.usage?.total_tokens ?? 0;
  await auditEvent('llm_call_post', {
    skill: 'embedding',
    model: `voyage:${MODEL}`,
    actual_tokens: { input: tokens, output: 0 },
    actual_cost_usd: computeCostUsd(`voyage:${MODEL}`, tokens, 0),
    status: 'ok',
  });
  return data.data.map((d) => d.embedding);
}

export async function embedOne(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const [v] = await embed([text], options);
  return v;
}
