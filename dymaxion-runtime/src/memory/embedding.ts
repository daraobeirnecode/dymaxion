// Voyage embedding client — voyage-3-large, 1024-dim. Used for message
// memory, knowledge-base retrieval, and similar-skill search.

import { computeCostUsd } from '../llm/cost.js';
import { auditEvent } from '../security/audit.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-large';

const MAX_RETRIES = 8;
const RATE_LIMIT_WAIT_MS = 25_000; // keys without a payment method are capped at 3 RPM

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set — embeddings unavailable');
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: texts }),
    });
    if (res.ok) break;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Voyage embeddings failed: HTTP ${res.status} ${await res.text()}`);
    }
    const waitMs = res.status === 429 ? RATE_LIMIT_WAIT_MS : 2_000 * attempt;
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

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}
