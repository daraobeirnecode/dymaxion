// Aggregate skill invocation stats — feeds skill selection (the planner
// prefers skills with better success rates) and the skill-archive meta skill.

import { eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export async function recordInvocationOutcome(
  skillSlug: string,
  ok: boolean,
  durationMs: number,
  costUsd: number,
): Promise<void> {
  await db
    .insert(schema.skillHistory)
    .values({
      skillSlug,
      totalInvocations: 1,
      successCount: ok ? 1 : 0,
      failureCount: ok ? 0 : 1,
      avgDurationMs: String(durationMs),
      avgCostUsd: costUsd.toFixed(4),
      lastInvokedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.skillHistory.skillSlug,
      set: {
        totalInvocations: dsql`${schema.skillHistory.totalInvocations} + 1`,
        successCount: dsql`${schema.skillHistory.successCount} + ${ok ? 1 : 0}`,
        failureCount: dsql`${schema.skillHistory.failureCount} + ${ok ? 0 : 1}`,
        // running average
        avgDurationMs: dsql`((COALESCE(${schema.skillHistory.avgDurationMs}, 0) * ${schema.skillHistory.totalInvocations}) + ${durationMs}) / (${schema.skillHistory.totalInvocations} + 1)`,
        avgCostUsd: dsql`((COALESCE(${schema.skillHistory.avgCostUsd}, 0) * ${schema.skillHistory.totalInvocations}) + ${costUsd.toFixed(4)}) / (${schema.skillHistory.totalInvocations} + 1)`,
        lastInvokedAt: new Date(),
      },
    });
}

export async function historyFor(skillSlug: string) {
  const [row] = await db
    .select()
    .from(schema.skillHistory)
    .where(eq(schema.skillHistory.skillSlug, skillSlug));
  return row ?? null;
}
