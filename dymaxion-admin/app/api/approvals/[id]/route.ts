import { eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  let decision: string;
  try {
    const body = (await request.json()) as { decision?: string };
    decision = String(body.decision ?? '');
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!['approved', 'rejected'].includes(decision)) {
    return Response.json(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 }
    );
  }

  const updated = await db
    .update(schema.approvalRequests)
    .set({
      decision,
      decidedBy: 'admin-dashboard',
      respondedAt: new Date(),
    })
    .where(eq(schema.approvalRequests.id, id))
    .returning({ id: schema.approvalRequests.id });

  if (updated.length === 0) {
    return Response.json({ error: 'approval request not found' }, { status: 404 });
  }
  return Response.json({ ok: true, id, decision });
}
