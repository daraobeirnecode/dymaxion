// openid-client (v6) wrapper for the OAuth 2.0 providers: OpenAI, Google,
// Azure (Entra ID), Cohere. Anthropic is API-key only by design.
// The authorize/callback endpoints live in dymaxion-admin (Next.js routes);
// the runtime only needs refresh (middleware step 3), implemented here with
// a direct token-endpoint refresh_token grant so it has no browser context.

import * as oidc from 'openid-client';
import { loadConfig, type ProviderOAuthConfig } from '../config/loader.js';
import { getToken, saveToken, type StoredToken } from './token-store.js';
import { logger } from '../observability/logger.js';

const REFRESH_MARGIN_MS = 60_000; // refresh when < 60s to expiry

function oauthConfigFor(provider: string): ProviderOAuthConfig {
  const p = loadConfig().providers[provider];
  if (!p?.oauth) throw new Error(`Provider '${provider}' has no OAuth config`);
  return p.oauth;
}

async function discoverConfiguration(provider: string): Promise<oidc.Configuration> {
  const cfg = oauthConfigFor(provider);
  const clientId = process.env[cfg.client_id_env] ?? '';
  const clientSecret = process.env[cfg.client_secret_env] ?? '';
  if (!clientId) throw new Error(`Missing env ${cfg.client_id_env} for provider '${provider}'`);

  let discoveryUrl = cfg.discovery_url;
  if (!discoveryUrl && cfg.discovery_url_template && cfg.tenant_env) {
    const tenant = process.env[cfg.tenant_env] ?? '';
    discoveryUrl = cfg.discovery_url_template.replace('{tenant}', tenant);
  }

  if (discoveryUrl) {
    return oidc.discovery(new URL(discoveryUrl), clientId, clientSecret);
  }
  // Cohere: no published OIDC discovery — build the server metadata manually.
  if (!cfg.authorization_endpoint || !cfg.token_endpoint) {
    throw new Error(`Provider '${provider}' needs discovery_url or explicit endpoints`);
  }
  return new oidc.Configuration(
    {
      issuer: new URL(cfg.token_endpoint).origin,
      authorization_endpoint: cfg.authorization_endpoint,
      token_endpoint: cfg.token_endpoint,
    },
    clientId,
    clientSecret,
  );
}

/**
 * Middleware step 3 — return a valid access token for an OAuth provider,
 * refreshing first when it is inside the expiry margin.
 */
export async function freshAccessToken(provider: string): Promise<string> {
  const stored = await getToken(provider);
  if (!stored) {
    throw new Error(
      `Provider '${provider}' is not connected — connect it in the admin dashboard (Providers → Connect).`,
    );
  }
  const needsRefresh =
    stored.expiresAt !== undefined && stored.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!needsRefresh) return stored.accessToken;

  if (!stored.refreshToken) {
    throw new Error(`Provider '${provider}' token expired and no refresh token stored — reconnect.`);
  }
  return refresh(provider, stored);
}

async function refresh(provider: string, stored: StoredToken): Promise<string> {
  const configuration = await discoverConfiguration(provider);
  const tokens = await oidc.refreshTokenGrant(configuration, stored.refreshToken!);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : undefined;
  await saveToken({
    provider,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
    tokenType: tokens.token_type ?? 'Bearer',
    scope: typeof tokens.scope === 'string' ? tokens.scope : stored.scope,
    expiresAt,
    connectedByUser: 'auto-refresh',
  });
  logger.info({ provider }, 'oauth token refreshed');
  return tokens.access_token;
}
