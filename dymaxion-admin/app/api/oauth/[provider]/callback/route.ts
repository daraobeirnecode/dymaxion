// GET /api/oauth/[provider]/callback — completes the OAuth flow:
// looks up the PKCE state row, exchanges the code, encrypts the tokens
// (AES-256-GCM, iv.tag.ciphertext — same format as the runtime token-store),
// upserts dymaxion.oauth_tokens, deletes the state row, redirects to /providers.

import { eq } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { db, schema } from '@/drizzle/client';
import { encrypt } from '@/lib/crypto';
import { isOAuthProvider, providerConfiguration } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) {
    return Response.json({ error: `unknown OAuth provider '${provider}'` }, { status: 404 });
  }

  const currentUrl = new URL(request.url);
  const state = currentUrl.searchParams.get('state');
  if (!state) {
    return Response.json({ error: 'missing state parameter' }, { status: 400 });
  }

  const [flow] = await db
    .select()
    .from(schema.oauthFlowState)
    .where(eq(schema.oauthFlowState.state, state))
    .limit(1);
  if (!flow || flow.provider !== provider) {
    return Response.json({ error: 'unknown or expired OAuth state' }, { status: 400 });
  }

  try {
    const config = await providerConfiguration(provider);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: state,
    });

    const expiresIn = tokens.expiresIn();
    const expiresAt =
      typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null;
    const now = new Date();

    const values = {
      provider,
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenType: tokens.token_type ?? 'Bearer',
      scope: typeof tokens.scope === 'string' ? tokens.scope : null,
      expiresAt,
      refreshedAt: now,
      connectedAt: now,
      connectedByUser: 'admin-dashboard',
    };

    await db
      .insert(schema.oauthTokens)
      .values(values)
      .onConflictDoUpdate({
        target: schema.oauthTokens.provider,
        set: {
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          tokenType: values.tokenType,
          scope: values.scope,
          expiresAt: values.expiresAt,
          refreshedAt: values.refreshedAt,
          connectedAt: values.connectedAt,
          connectedByUser: values.connectedByUser,
        },
      });

    return Response.redirect(new URL('/providers', currentUrl), 302);
  } catch (e) {
    return Response.json(
      {
        error: `token exchange failed for ${provider}`,
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 }
    );
  } finally {
    // State is single-use — remove it whether the exchange succeeded or not.
    await db.delete(schema.oauthFlowState).where(eq(schema.oauthFlowState.state, state));
  }
}
