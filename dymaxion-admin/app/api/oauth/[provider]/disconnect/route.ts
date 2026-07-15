import { eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { isOAuthProvider } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) {
    return Response.json({ error: `unknown OAuth provider '${provider}'` }, { status: 404 });
  }

  const deleted = await db
    .delete(schema.oauthTokens)
    .where(eq(schema.oauthTokens.provider, provider))
    .returning({ provider: schema.oauthTokens.provider });

  if (deleted.length === 0) {
    return Response.json({ error: `${provider} is not connected` }, { status: 404 });
  }
  return Response.json({ ok: true, provider, disconnected: true });
}
