// Loads every YAML in config/ once at boot, resolving `os.environ/VAR`
// references to environment values. Config lives at /workspace/config in
// the container (override with DYMAXION_CONFIG_DIR for local dev).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface ProviderOAuthConfig {
  discovery_url?: string;
  discovery_url_template?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  tenant_env?: string;
  client_id_env: string;
  client_secret_env: string;
  scopes: string[];
  redirect_uri: string;
}

export interface ProviderConfig {
  enabled: boolean;
  auth_mode: 'api_key' | 'oauth' | 'none';
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  endpoint_env?: string;
  deployment_env?: string;
  oauth?: ProviderOAuthConfig;
  models?: string[];
  embedding_models?: string[];
}

export interface RoutingConfig {
  default: string;
  by_skill_class: Record<string, string>;
  by_skill_slug: Record<string, string>;
  fallbacks: Record<string, string[]>;
  retry_policy: { default_num_retries: number; default_retry_after_seconds: number };
}

export interface BudgetTier {
  max_usd_per_month: number;
  allowed_providers: string[];
  allowed_models: string[];
}

export interface BudgetsConfig {
  budgets: Record<string, BudgetTier>;
  default_tier: string;
  tier_by_skill_class: Record<string, string>;
}

export interface BoundaryConfig {
  allowed_data_sources: Array<{
    type: string;
    url_pattern?: string;
    connection?: string;
    path_pattern?: string;
    root_env?: string;
  }>;
  denied_hostnames: string[];
  denied_paths: string[];
  audit_all_external_requests: boolean;
}

export interface McpServerConfig {
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DymaxionConfig {
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
  budgets: BudgetsConfig;
  boundary: BoundaryConfig;
  gateways: Record<string, Record<string, unknown> & { enabled: boolean }>;
  mcpServers: McpServerConfig[];
  /** Parsed by the ArcGIS connection boundary's strict versioned schema. */
  arcgisTargets: unknown;
  configDir: string;
}

/** Recursively resolve `os.environ/VAR` strings to env values. */
function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('os.environ/')) {
    return process.env[value.slice('os.environ/'.length)] ?? '';
  }
  if (Array.isArray(value)) return value.map(resolveEnvRefs);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvRefs(v)]),
    );
  }
  return value;
}

function loadYaml<T>(dir: string, file: string): T {
  const path = join(dir, file);
  if (!existsSync(path)) {
    throw new Error(`Missing config file: ${path}`);
  }
  return resolveEnvRefs(parse(readFileSync(path, 'utf8'))) as T;
}

let cached: DymaxionConfig | null = null;

export function loadConfig(): DymaxionConfig {
  if (cached) return cached;
  const dir = process.env.DYMAXION_CONFIG_DIR ?? '/workspace/config';

  const providers = loadYaml<{ providers: Record<string, ProviderConfig> }>(
    dir,
    'llm-providers.yaml',
  ).providers;
  const routing = loadYaml<RoutingConfig>(dir, 'llm-routing.yaml');
  const budgets = loadYaml<BudgetsConfig>(dir, 'llm-budgets.yaml');
  const boundary = loadYaml<BoundaryConfig>(dir, 'employer-boundary.yaml');
  const gateways = loadYaml<{ gateways: DymaxionConfig['gateways'] }>(dir, 'gateways.yaml').gateways;
  const mcpServers = loadYaml<{ servers: McpServerConfig[] }>(dir, 'mcp-servers.yaml').servers;
  const arcgisTargets = loadYaml<unknown>(dir, 'arcgis-targets.yaml');

  cached = { providers, routing, budgets, boundary, gateways, mcpServers, arcgisTargets, configDir: dir };
  return cached;
}
