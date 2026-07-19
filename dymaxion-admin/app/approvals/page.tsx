import Link from 'next/link';
import { desc, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import DecisionButtons from '@/components/DecisionButtons';
import { fmtDate, prettyJson, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const [pending, decided] = await Promise.all([
    db
      .select()
      .from(schema.approvalRequests)
      .where(isNull(schema.approvalRequests.decision))
      .orderBy(desc(schema.approvalRequests.requestedAt)),
    db
      .select()
      .from(schema.approvalRequests)
      .where(isNotNull(schema.approvalRequests.decision))
      .orderBy(desc(schema.approvalRequests.respondedAt))
      .limit(25),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Approvals</h1>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-200">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="card text-sm text-neutral-500">No approval requests pending.</p>
        ) : (
          pending.map((req) => (
            <div key={req.id} className="card space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="badge-pending">pending</span>
                <span className="font-mono text-xs text-neutral-500">{shortId(req.id)}</span>
                <span className="font-mono text-xs text-neutral-500">
                  requested {fmtDate(req.requestedAt)}
                </span>
                <Link
                  href={`/runs/${req.agentRunId}`}
                  className="font-mono text-xs text-neutral-400 hover:underline"
                >
                  run {shortId(req.agentRunId)}
                </Link>
              </div>
              <p className="text-sm text-neutral-200">
                <span className="text-neutral-500">Model-authored description (untrusted): </span>
                {req.stepDescription}
              </p>
              <dl className="grid gap-1 text-xs text-neutral-400 md:grid-cols-2">
                <div><dt className="inline text-neutral-500">Target: </dt><dd className="inline font-mono break-all">{req.target}</dd></div>
                <div><dt className="inline text-neutral-500">Credential: </dt><dd className="inline font-mono">{req.credentialIdentity ?? 'invalid historical row'}</dd></div>
                <div><dt className="inline text-neutral-500">Expires: </dt><dd className="inline font-mono">{fmtDate(req.expiresAt)}</dd></div>
                <div><dt className="inline text-neutral-500">Payload hash: </dt><dd className="inline font-mono">{req.payloadHash}</dd></div>
              </dl>
              <details open>
                <summary className="cursor-pointer text-xs font-semibold text-neutral-300">
                  Exact payload to execute — review before deciding
                </summary>
                <pre className="code-block mt-2">{prettyJson(req.stepPayload)}</pre>
              </details>
              <DecisionButtons endpoint={`/api/approvals/${req.id}`} />
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">
          Recently decided (latest 25)
        </h2>
        {decided.length === 0 ? (
          <p className="text-sm text-neutral-500">No decided requests.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>Request</th>
                <th>Run</th>
                <th>Step</th>
                <th>Decision</th>
                <th>By</th>
                <th>Consumed</th>
                <th>Responded</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((req) => (
                <tr key={req.id}>
                  <td className="font-mono">{shortId(req.id)}</td>
                  <td className="font-mono">
                    <Link href={`/runs/${req.agentRunId}`} className="hover:underline">
                      {shortId(req.agentRunId)}
                    </Link>
                  </td>
                  <td className="max-w-md truncate">{req.stepDescription}</td>
                  <td>
                    <span className={statusBadgeClass(req.decision)}>{req.decision}</span>
                  </td>
                  <td className="font-mono text-xs">{req.decidedBy ?? '—'}</td>
                  <td className="font-mono">{req.consumedAt ? fmtDate(req.consumedAt) : '—'}</td>
                  <td className="font-mono">{fmtDate(req.respondedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
