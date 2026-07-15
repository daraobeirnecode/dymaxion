// openid-client v6 configuration per provider, built from env.
// Mirrors config/llm-providers.yaml semantics:
//   openai  — OIDC discovery at auth.openai.com
//   google  — OIDC discovery at accounts.google.com
//   azure   — OIDC discovery at login.microsoftonline.com/{tenant}/v2.0
//   cohere  — manual authorization/token endpoints (no discovery document)

import * as oidc from 'openid-client';

export const OAUTH_PROVIDERS = ['openai', 'google', 'azure', 'cohere'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(p: string): p is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

interface ProviderEnv {
  clientId: string;
  clientSecret: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — cannot start OAuth flow`);
  return v;
}

function providerEnv(provider: OAuthProvider): ProviderEnv {
  switch (provider) {
    case 'openai':
      return {
        clientId: requireEnv('OPENAI_OAUTH_CLIENT_ID'),
        clientSecret: requireEnv('OPENAI_OAUTH_CLIENT_SECRET'),
      };
    case 'google':
      return {
        clientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      };
    case 'azure':
      return {
        clientId: requireEnv('AZURE_CLIENT_ID'),
        clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
      };
    case 'cohere':
      return {
        clientId: requireEnv('COHERE_OAUTH_CLIENT_ID'),
        clientSecret: requireEnv('COHERE_OAUTH_CLIENT_SECRET'),
      };
  }
}

/** Scopes per provider — from config/llm-providers.yaml. */
export function providerScopes(provider: OAuthProvider): string {
  switch (provider) {
    case 'openai':
      return 'model:read model:write usage:read';
    case 'google':
      return 'https://www.googleapis.com/auth/generative-language';
    case 'azure':
      return 'https://cognitiveservices.azure.com/.default offline_access';
    case 'cohere':
      return 'chat embed classify';
  }
}

/** Extra authorization-request params some providers need (refresh tokens etc.). */
export function extraAuthParams(provider: OAuthProvider): Record<string, string> {
  switch (provider) {
    case 'google':
      return { access_type: 'offline', prompt: 'consent' };
    default:
      return {};
  }
}

/** Build an openid-client Configuration for a provider. */
export async function providerConfiguration(
  provider: OAuthProvider
): Promise<oidc.Configuration> {
  const { clientId, clientSecret } = providerEnv(provider);

  switch (provider) {
    case 'openai':
      return oidc.discovery(
        new URL('https://auth.openai.com/.well-known/openid-configuration'),
        clientId,
        clientSecret
      );
    case 'google':
      return oidc.discovery(
        new URL('https://accounts.google.com/.well-known/openid-configuration'),
        clientId,
        clientSecret
      );
    case 'azure': {
      const tenant = requireEnv('AZURE_TENANT_ID');
      return oidc.discovery(
        new URL(
          `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`
        ),
        clientId,
        clientSecret
      );
    }
    case 'cohere':
      // No discovery document — manual endpoints from llm-providers.yaml.
      return new oidc.Configuration(
        {
          issuer: 'https://dashboard.cohere.com',
          authorization_endpoint: 'https://dashboard.cohere.com/oauth/authorize',
          token_endpoint: 'https://dashboard.cohere.com/oauth/token',
        },
        clientId,
        clientSecret
      );
  }
}

/** Redirect URI derived from the incoming request host (Tailscale IP or container name). */
export function redirectUri(requestUrl: URL, provider: OAuthProvider): string {
  return `${requestUrl.protocol}//${requestUrl.host}/api/oauth/${provider}/callback`;
}
