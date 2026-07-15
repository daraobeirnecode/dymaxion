// Skill → model routing per config/llm-routing.yaml.
// Resolution order: by_skill_slug > manifest llm_override > by_skill_class > default.
// Fallback chains apply when the primary call errors.

import { loadConfig } from '../config/loader.js';

export interface RouteResolution {
  primary: string; // provider-prefixed model ref
  fallbacks: string[];
  retries: number;
  retryAfterSeconds: number;
}

export function routeFor(skillSlug: string, skillClass: string, llmOverride?: string): RouteResolution {
  const routing = loadConfig().routing;
  const primary =
    routing.by_skill_slug?.[skillSlug] ??
    llmOverride ??
    routing.by_skill_class?.[skillClass] ??
    routing.default;
  return {
    primary,
    fallbacks: routing.fallbacks?.[primary] ?? [],
    retries: routing.retry_policy?.default_num_retries ?? 3,
    retryAfterSeconds: routing.retry_policy?.default_retry_after_seconds ?? 2,
  };
}
