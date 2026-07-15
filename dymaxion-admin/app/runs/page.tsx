import Link from 'next/link';
import { and, desc, eq, gte, ilike, lt, type SQL } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtCost, fmtDate, fmtDuration, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

const STATUSES = ['running', 'succeeded', 'failed', 'awaiting_approval', 'cancelled'];

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; date?: string; q?: string }>;
}) {
  const { status, date, q } = await searchParams;

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(schema.agentRuns.status, status));
  if (date) {
    const day = new Date(`${date}T00:00:00Z`);
    if (!Number.isNaN(day.getTime())) {
      const next = new Date(day.getTime() + 24 * 3600 * 1000);
      conditions.push(gte(schema.agentRuns.startedAt, day));
      conditions.push(lt(schema.agentRuns.startedAt, next));
    }
  }
  if (q) conditions.push(ilike(schema.agentRuns.finalNarrative, `%${q}%`));

  const runs = await db
    .select()
    .from(schema.agentRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(200);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-neutral-100">Agent runs</h1>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Status
          <select name="status" defaultValue={status ?? ''} className="input">
            <option value="">any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Date (UTC)
          <input type="date" name="date" defaultValue={date ?? ''} className="input" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Narrative contains
          <input
            type="text"
            name="q"
            defaultValue={q ?? ''}
            placeholder="search text"
            className="input"
          />
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
        <Link href="/runs" className="text-xs text-neutral-500 hover:text-neutral-300">
          Reset
        </Link>
      </form>

      <div className="card">
        <p className="mb-2 text-xs text-neutral-500">
          {runs.length} run{runs.length === 1 ? '' : 's'} shown (limit 200, newest first).
        </p>
        <table className="table-dense">
          <thead>
            <tr>
              <th>Run</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Cost</th>
              <th>Narrative</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="font-mono">
                  <Link href={`/runs/${r.id}`} className="hover:underline">
                    {shortId(r.id)}
                  </Link>
                </td>
                <td className="font-mono">{fmtDate(r.startedAt)}</td>
                <td className="font-mono">{fmtDuration(r.startedAt, r.endedAt)}</td>
                <td>
                  <span className={statusBadgeClass(r.status)}>{r.status}</span>
                </td>
                <td className="font-mono">{fmtCost(r.costUsd)}</td>
                <td className="max-w-md truncate text-neutral-400">
                  {r.finalNarrative ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
