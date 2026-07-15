import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';

export const dynamic = 'force-dynamic';

function currentMonthDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ tier: string }> }
): Promise<Response> {
  const { tier } = await params;

  const updated = await db
    .update(schema.budgetLedger)
    .set({ frozen: false, updatedAt: new Date() })
    .where(
      and(
        eq(schema.budgetLedger.tier, tier),
        eq(schema.budgetLedger.month, currentMonthDateString())
      )
    )
    .returning({ tier: schema.budgetLedger.tier });

  if (updated.length === 0) {
    return Response.json(
      { error: `no budget ledger row for tier '${tier}' in the current month` },
      { status: 404 }
    );
  }
  return Response.json({ ok: true, tier, frozen: false });
}
