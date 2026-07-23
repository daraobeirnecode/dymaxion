import { authenticateAdminApprover } from '../../../../lib/approval-auth';

export const dynamic = 'force-dynamic';

const DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const authenticated = authenticateAdminApprover(
    request.headers,
    process.env.DYMAXION_ADMIN_IDENTITIES,
  );
  if (authenticated.ok === false) {
    return Response.json({ error: authenticated.error }, { status: authenticated.status });
  }

  const { token } = await params;
  if (!DOWNLOAD_TOKEN_RE.test(token)) {
    return Response.json({ error: 'artifact unavailable' }, { status: 404 });
  }

  const runtimeUrl = (process.env.RUNTIME_URL ?? 'http://dymaxion-runtime:8787').replace(/\/$/, '');
  const internalToken = process.env.RUNTIME_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    return Response.json({ error: 'artifact proxy is not configured' }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${runtimeUrl}/api/artifacts/${token}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${internalToken}`,
        'x-dymaxion-approver-identity': authenticated.identity,
      },
      cache: 'no-store',
    });
  } catch {
    return Response.json({ error: 'artifact service unavailable' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: upstream.status === 404 ? 'artifact unavailable' : 'artifact service unavailable' },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-length',
    'content-disposition',
    'cache-control',
    'x-content-type-options',
    'etag',
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');

  return new Response(upstream.body, { status: 200, headers });
}
