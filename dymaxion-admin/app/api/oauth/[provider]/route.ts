// GET /api/oauth/[provider] — start the OAuth 2.0 authorization-code + PKCE flow.
// Stores { state, provider, code_verifier } in dymaxion.oauth_flow_state and
// redirects the browser to the provider's authorization endpoint.

import * as oidc from 'openid-client';
import { db, schema } from '@/drizzle/client';
import {
  extraAuthParams,
  isOAuthProvider,
  providerConfiguration,
  providerScopes,
  redirectUri,
} from '@/lib/oauth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) {
    return Response.json({ error: `unknown OAuth provider '${provider}'` }, { status: 404 });
  }

  const requestUrl = new URL(request.url);

  let config: oidc.Configuration;
  try {
    config = await providerConfiguration(provider);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'provider configuration failed' },
      { status: 500 }
    );
  }

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();

  await db.insert(schema.oauthFlowState).values({
    state,
    provider,
    codeVerifier,
  });

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(requestUrl, provider),
    scope: providerScopes(provider),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...extraAuthParams(provider),
  });

  return Response.redirect(authorizationUrl.href, 302);
}
