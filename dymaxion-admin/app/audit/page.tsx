import Link from 'next/link';
import { and, desc, eq, sql as dsql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtDate, prettyJson, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ event_type?: string; q?: string }>;
}) {
  const { event_type, q } = await searchParams;

  const conditions: SQL[] = [];
  if (event_type) conditions.push(eq(schema.auditLog.eventType, event_type));
  if (q) {
    conditions.push(
      dsql`${schema.auditLog.payload}::text ILIKE ${'%' + q + '%'}`
    );
  }

  const [entries, eventTypes] = await Promise.all([
    db
      .select()
      .from(schema.auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.auditLog.eventAt))
      .limit(200),
    db
      .selectDistinct({ eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .orderBy(schema.auditLog.eventType),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-neutral-100">Audit log</h1>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Event type
          <select name="event_type" defaultValue={event_type ?? ''} className="input">
            <option value="">any</option>
            {eventTypes.map((t) => (
              <option key={t.eventType} value={t.eventType}>
                {t.eventType}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Payload contains
          <input name="q" defaultValue={q ?? ''} placeholder="free-text search" className="input w-72" />
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
        <Link href="/audit" className="text-xs text-neutral-500 hover:text-neutral-300">
          Reset
        </Link>
      </form>

      <div className="card">
        <p className="mb-2 text-xs text-neutral-500">
          {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} shown (latest 200).
        </p>
        <table className="table-dense">
          <thead>
            <tr>
              <th>ID</th>
              <th>At</th>
              <th>Event type</th>
              <th>Run</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="font-mono">{e.id}</td>
                <td className="font-mono whitespace-nowrap">{fmtDate(e.eventAt)}</td>
                <td className="font-mono">{e.eventType}</td>
                <td className="font-mono">
                  {e.agentRunId ? (
                    <Link href={`/runs/${e.agentRunId}`} className="hover:underline">
                      {shortId(e.agentRunId)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <pre className="max-w-2xl overflow-x-auto font-mono text-xs text-neutral-400">
                    {prettyJson(e.payload)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
