import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtCost, fmtDate, prettyJson, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [skill] = await db
    .select()
    .from(schema.skillRegistry)
    .where(eq(schema.skillRegistry.slug, slug))
    .limit(1);
  if (!skill) notFound();

  const [[history], recent] = await Promise.all([
    db
      .select()
      .from(schema.skillHistory)
      .where(eq(schema.skillHistory.skillSlug, slug))
      .limit(1),
    db
      .select()
      .from(schema.skillInvocations)
      .where(eq(schema.skillInvocations.skillSlug, slug))
      .orderBy(desc(schema.skillInvocations.invokedAt))
      .limit(25),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-lg font-semibold text-neutral-100">
          {skill.slug}@{skill.version}
        </h1>
        <div className="mt-1 flex flex-wrap gap-3 text-sm text-neutral-400">
          <span>{skill.name}</span>
          <span className="badge-neutral">{skill.category}</span>
          <span className="badge-neutral">{skill.skillClass}</span>
          {skill.destructive && <span className="badge-failed">destructive</span>}
          {skill.requiresApproval && <span className="badge-pending">requires approval</span>}
          <span className={statusBadgeClass(skill.status)}>{skill.status}</span>
          <span className="font-mono text-xs">
            authored by {skill.authoredBy}, registered {fmtDate(skill.registeredAt)}
          </span>
        </div>
      </div>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">History</h2>
        {!history ? (
          <p className="text-sm text-neutral-500">Never invoked.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
            <div>
              <div className="text-xs text-neutral-500">Invocations</div>
              <div className="font-mono text-neutral-100">{history.totalInvocations ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Success / failure</div>
              <div className="font-mono text-neutral-100">
                {history.successCount ?? 0} / {history.failureCount ?? 0}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Avg duration</div>
              <div className="font-mono text-neutral-100">
                {history.avgDurationMs ? `${Number(history.avgDurationMs).toFixed(0)}ms` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Avg cost</div>
              <div className="font-mono text-neutral-100">{fmtCost(history.avgCostUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Last invoked</div>
              <div className="font-mono text-neutral-100">{fmtDate(history.lastInvokedAt)}</div>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">Manifest</h2>
        <pre className="code-block">{prettyJson(skill.manifest)}</pre>
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">
          Recent invocations ({recent.length}, latest 25)
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500">No invocations recorded.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>Run</th>
                <th>Invoked</th>
                <th>Completed</th>
                <th>Cost</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono">
                    <Link href={`/runs/${inv.agentRunId}`} className="hover:underline">
                      {shortId(inv.agentRunId)}
                    </Link>
                  </td>
                  <td className="font-mono">{fmtDate(inv.invokedAt)}</td>
                  <td className="font-mono">{fmtDate(inv.completedAt)}</td>
                  <td className="font-mono">{fmtCost(inv.costUsd)}</td>
                  <td>
                    {inv.error ? (
                      <span className="badge-failed">error</span>
                    ) : inv.completedAt ? (
                      <span className="badge-ok">ok</span>
                    ) : (
                      <span className="badge-pending">in flight</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
