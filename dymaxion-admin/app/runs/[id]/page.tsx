import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import {
  fmtCost,
  fmtDate,
  fmtDuration,
  prettyJson,
  statusBadgeClass,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id))
    .limit(1);
  if (!run) notFound();

  const [invocations, auditEntries] = await Promise.all([
    db
      .select()
      .from(schema.skillInvocations)
      .where(eq(schema.skillInvocations.agentRunId, id))
      .orderBy(asc(schema.skillInvocations.invokedAt)),
    db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.agentRunId, id))
      .orderBy(asc(schema.auditLog.eventAt)),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-lg font-semibold text-neutral-100">Run {run.id}</h1>
        <div className="mt-1 flex flex-wrap gap-4 text-sm text-neutral-400">
          <span>
            <span className={statusBadgeClass(run.status)}>{run.status}</span>
          </span>
          <span className="font-mono">started {fmtDate(run.startedAt)}</span>
          <span className="font-mono">duration {fmtDuration(run.startedAt, run.endedAt)}</span>
          <span className="font-mono">cost {fmtCost(run.costUsd)}</span>
          {run.langfuseTraceId && (
            <span className="font-mono">langfuse trace {run.langfuseTraceId}</span>
          )}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Replay this run via <code className="font-mono">scripts/replay-run.sh {run.id}</code>
        </p>
      </div>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">Plan</h2>
        <pre className="code-block">{prettyJson(run.plan)}</pre>
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">
          Skill invocations ({invocations.length})
        </h2>
        {invocations.length === 0 ? (
          <p className="text-sm text-neutral-500">No skill invocations recorded.</p>
        ) : (
          <div className="space-y-4">
            {invocations.map((inv) => (
              <div key={inv.id} className="rounded border border-surface-border p-3">
                <div className="flex flex-wrap gap-4 text-sm">
                  <span className="font-mono text-neutral-100">
                    {inv.skillSlug}@{inv.skillVersion}
                  </span>
                  <span className="font-mono text-neutral-400">
                    invoked {fmtDate(inv.invokedAt)}
                  </span>
                  <span className="font-mono text-neutral-400">cost {fmtCost(inv.costUsd)}</span>
                  <span className="font-mono text-neutral-400">
                    {inv.llmCallsCount ?? 0} LLM / {inv.toolCallsCount ?? 0} tool calls
                  </span>
                  {inv.error ? (
                    <span className="badge-failed">error</span>
                  ) : inv.completedAt ? (
                    <span className="badge-ok">completed</span>
                  ) : (
                    <span className="badge-pending">in flight</span>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-neutral-500">
                    input / output
                  </summary>
                  <pre className="code-block mt-2">{prettyJson(inv.input)}</pre>
                  {inv.output != null && (
                    <pre className="code-block mt-2">{prettyJson(inv.output)}</pre>
                  )}
                  {inv.error != null && (
                    <pre className="code-block mt-2 text-red-400">{prettyJson(inv.error)}</pre>
                  )}
                </details>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">
          Audit log ({auditEntries.length})
        </h2>
        {auditEntries.length === 0 ? (
          <p className="text-sm text-neutral-500">No audit entries for this run.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>At</th>
                <th>Event</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {auditEntries.map((a) => (
                <tr key={a.id}>
                  <td className="font-mono whitespace-nowrap">{fmtDate(a.eventAt)}</td>
                  <td className="font-mono">{a.eventType}</td>
                  <td>
                    <pre className="max-w-xl overflow-x-auto font-mono text-xs text-neutral-400">
                      {prettyJson(a.payload)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">Final narrative</h2>
        {run.finalNarrative ? (
          <p className="whitespace-pre-wrap text-sm text-neutral-300">{run.finalNarrative}</p>
        ) : (
          <p className="text-sm text-neutral-500">No final narrative recorded.</p>
        )}
      </section>
    </div>
  );
}
