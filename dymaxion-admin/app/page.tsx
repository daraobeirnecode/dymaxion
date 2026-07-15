import Link from 'next/link';
import { count, desc, eq, gte, isNull, sum } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtCost, fmtDate, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function currentMonthDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export default async function DashboardPage() {
  const [
    [todayRuns],
    [monthCost],
    latestRuns,
    [pendingApprovals],
    tokens,
    ledger,
  ] = await Promise.all([
    db
      .select({ n: count() })
      .from(schema.agentRuns)
      .where(gte(schema.agentRuns.startedAt, startOfToday())),
    db
      .select({ total: sum(schema.agentRuns.costUsd) })
      .from(schema.agentRuns)
      .where(gte(schema.agentRuns.startedAt, startOfMonth())),
    db
      .select({
        id: schema.agentRuns.id,
        startedAt: schema.agentRuns.startedAt,
        status: schema.agentRuns.status,
        costUsd: schema.agentRuns.costUsd,
      })
      .from(schema.agentRuns)
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(10),
    db
      .select({ n: count() })
      .from(schema.approvalRequests)
      .where(isNull(schema.approvalRequests.decision)),
    db
      .select({
        provider: schema.oauthTokens.provider,
        connectedAt: schema.oauthTokens.connectedAt,
        expiresAt: schema.oauthTokens.expiresAt,
      })
      .from(schema.oauthTokens),
    db
      .select()
      .from(schema.budgetLedger)
      .where(eq(schema.budgetLedger.month, currentMonthDateString())),
  ]);

  const anthropicSet = Boolean(process.env.ANTHROPIC_API_KEY);
  const oauthProviders = ['openai', 'google', 'azure', 'cohere'];
  const connected = new Map(tokens.map((t) => [t.provider, t]));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Runs today</div>
          <div className="mt-1 font-mono text-2xl text-neutral-100">{todayRuns?.n ?? 0}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Cost this month</div>
          <div className="mt-1 font-mono text-2xl text-neutral-100">
            {fmtCost(monthCost?.total ?? 0)}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Pending approvals</div>
          <div className="mt-1 font-mono text-2xl text-neutral-100">
            <Link href="/approvals" className="hover:underline">
              {pendingApprovals?.n ?? 0}
            </Link>
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Providers connected</div>
          <div className="mt-1 font-mono text-2xl text-neutral-100">
            {tokens.length + (anthropicSet ? 1 : 0)}
          </div>
        </div>
      </div>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">Latest 10 runs</h2>
        {latestRuns.length === 0 ? (
          <p className="text-sm text-neutral-500">No runs recorded.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>Run</th>
                <th>Started</th>
                <th>Status</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {latestRuns.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">
                    <Link href={`/runs/${r.id}`} className="hover:underline">
                      {shortId(r.id)}
                    </Link>
                  </td>
                  <td className="font-mono">{fmtDate(r.startedAt)}</td>
                  <td>
                    <span className={statusBadgeClass(r.status)}>{r.status}</span>
                  </td>
                  <td className="font-mono">{fmtCost(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 text-sm font-semibold text-neutral-200">Provider connection health</h2>
          <table className="table-dense">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Auth</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>anthropic</td>
                <td>API key</td>
                <td>
                  <span className={anthropicSet ? 'badge-ok' : 'badge-failed'}>
                    {anthropicSet ? 'key set' : 'key unset'}
                  </span>
                </td>
              </tr>
              {oauthProviders.map((p) => {
                const t = connected.get(p);
                return (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>OAuth 2.0</td>
                    <td>
                      {t ? (
                        <span className="badge-ok">connected {fmtDate(t.connectedAt)}</span>
                      ) : (
                        <span className="badge-neutral">not connected</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td>ollama</td>
                <td>none (local)</td>
                <td>
                  <span className="badge-ok">local</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2 className="mb-3 text-sm font-semibold text-neutral-200">
            Budget ledger — current month
          </h2>
          {ledger.length === 0 ? (
            <p className="text-sm text-neutral-500">No ledger rows for this month.</p>
          ) : (
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Spent</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.tier}>
                    <td className="font-mono">{row.tier}</td>
                    <td className="font-mono">{fmtCost(row.spentUsd)}</td>
                    <td>
                      <span className={row.frozen ? 'badge-failed' : 'badge-ok'}>
                        {row.frozen ? 'frozen' : 'open'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
