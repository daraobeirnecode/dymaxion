// Vercel AI SDK provider factory — one function per provider. Model refs
// everywhere in Dymaxion are provider-prefixed: 'anthropic:claude-sonnet-5',
// 'openai:gpt-4o', 'ollama:llama3.3:70b'.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import type { LanguageModel } from 'ai';
import { loadConfig } from '../config/loader.js';
import { freshAccessToken } from './oauth.js';

export interface ResolvedModel {
  provider: string;
  modelId: string; // bare model id, no provider prefix
  ref: string; // full provider-prefixed ref
  model: LanguageModel;
}

export function splitModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf(':');
  if (idx < 0) throw new Error(`Model ref '${ref}' must be provider-prefixed (e.g. anthropic:...)`);
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Resolve a provider-prefixed model ref to a callable AI SDK model. */
export async function resolveModel(ref: string): Promise<ResolvedModel> {
  const { provider, modelId } = splitModelRef(ref);
  const cfg = loadConfig().providers[provider];
  if (!cfg) throw new Error(`Unknown provider '${provider}'`);
  if (!cfg.enabled) throw new Error(`Provider '${provider}' is disabled in llm-providers.yaml`);

  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env[cfg.api_key_env ?? 'ANTHROPIC_API_KEY'];
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
      const anthropic = createAnthropic({ apiKey });
      return { provider, modelId, ref, model: anthropic(modelId) };
    }
    case 'openai': {
      const token = await freshAccessToken('openai');
      const openai = createOpenAI({ apiKey: token });
      return { provider, modelId, ref, model: openai(modelId) };
    }
    case 'google': {
      const token = await freshAccessToken('google');
      const google = createGoogleGenerativeAI({
        apiKey: '',
        headers: { Authorization: `Bearer ${token}` },
      });
      return { provider, modelId, ref, model: google(modelId) };
    }
    case 'azure': {
      const token = await freshAccessToken('azure');
      const azure = createAzure({
        baseURL: process.env[cfg.endpoint_env ?? 'AZURE_OPENAI_ENDPOINT'],
        apiKey: token,
      });
      const deployment = process.env[cfg.deployment_env ?? 'AZURE_OPENAI_DEPLOYMENT'] ?? modelId;
      return { provider, modelId, ref, model: azure(deployment) };
    }
    case 'cohere': {
      const token = await freshAccessToken('cohere');
      const cohere = createCohere({ apiKey: token });
      return { provider, modelId, ref, model: cohere(modelId) };
    }
    case 'ollama': {
      // Ollama speaks the OpenAI-compatible API at /v1 — no extra provider dep.
      const baseURL = `${process.env[cfg.base_url_env ?? 'OLLAMA_BASE_URL'] ?? cfg.base_url ?? 'http://host.docker.internal:11434'}/v1`;
      const ollama = createOpenAI({ apiKey: 'ollama', baseURL });
      return { provider, modelId, ref, model: ollama(modelId) };
    }
    default:
      throw new Error(`No factory for provider '${provider}'`);
  }
}

/** Providers currently usable: enabled AND (key present / token stored / no auth). */
export function enabledProviders(): string[] {
  return Object.entries(loadConfig().providers)
    .filter(([, p]) => p.enabled)
    .map(([name]) => name);
}
