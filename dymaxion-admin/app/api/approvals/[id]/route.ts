import { authenticateAdminApprover } from '@/lib/approval-auth';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authenticated = authenticateAdminApprover(request.headers);
  if (!authenticated.ok) {
    return Response.json({ error: authenticated.error }, { status: authenticated.status });
  }

  const { id } = await params;
  let decision: 'approved' | 'rejected';
  try {
    const body = (await request.json()) as { decision?: string };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return Response.json(
        { error: "decision must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }
    decision = body.decision;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const internalToken = process.env.RUNTIME_INTERNAL_TOKEN;
  if (!internalToken) {
    return Response.json({ error: 'runtime approval channel is not configured' }, { status: 503 });
  }
  const runtimeUrl = process.env.RUNTIME_URL ?? 'http://dymaxion-runtime:8787';

  try {
    const upstream = await fetch(
      `${runtimeUrl}/api/approvals/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalToken}`,
          'Content-Type': 'application/json',
          'X-Dymaxion-Approver-Identity': authenticated.identity,
        },
        body: JSON.stringify({ decision }),
        cache: 'no-store',
      }
    );
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return Response.json({ error: 'runtime approval service unavailable' }, { status: 502 });
  }
}
