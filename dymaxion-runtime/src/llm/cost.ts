// Per-provider token → USD cost tables. Prices are USD per 1M tokens.
// Update quarterly alongside the provider version pin review.

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'anthropic:claude-opus-4-8': { inputPerM: 15, outputPerM: 75 },
  'anthropic:claude-sonnet-5': { inputPerM: 3, outputPerM: 15 },
  'anthropic:claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5 },
  // OpenAI
  'openai:gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'openai:gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'openai:gpt-4-turbo': { inputPerM: 10, outputPerM: 30 },
  // Google
  'google:gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  'google:gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  // Azure (mirrors OpenAI list pricing by default; adjust per contract)
  'azure:gpt-4o-azure': { inputPerM: 2.5, outputPerM: 10 },
  // Cohere
  'cohere:command-r-plus': { inputPerM: 2.5, outputPerM: 10 },
  'cohere:command-r': { inputPerM: 0.15, outputPerM: 0.6 },
  // Voyage embeddings (input only)
  'voyage:voyage-3-large': { inputPerM: 0.18, outputPerM: 0 },
};

/** Local models are free — any ollama:* ref costs $0. */
export function priceFor(modelRef: string): ModelPrice {
  if (modelRef.startsWith('ollama:')) return { inputPerM: 0, outputPerM: 0 };
  const price = PRICES[modelRef];
  if (!price) {
    // Unknown model: charge conservatively at Sonnet-tier rates rather than $0
    // so an unpriced model can never dodge the budget cap.
    return { inputPerM: 3, outputPerM: 15 };
  }
  return price;
}

export function computeCostUsd(
  modelRef: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = priceFor(modelRef);
  return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
}
