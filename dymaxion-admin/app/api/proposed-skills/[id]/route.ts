import { eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  let decision: string;
  let reviewNotes: string | undefined;
  try {
    const body = (await request.json()) as { decision?: string; review_notes?: string };
    decision = String(body.decision ?? '');
    reviewNotes = body.review_notes;
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
    .update(schema.proposedSkills)
    .set({
      status: decision,
      reviewedAt: new Date(),
      ...(reviewNotes !== undefined ? { reviewNotes } : {}),
    })
    .where(eq(schema.proposedSkills.id, id))
    .returning({ id: schema.proposedSkills.id });

  if (updated.length === 0) {
    return Response.json({ error: 'proposed skill not found' }, { status: 404 });
  }
  return Response.json({ ok: true, id, status: decision });
}
