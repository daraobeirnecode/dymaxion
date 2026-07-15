import { desc } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import PostButton from '@/components/PostButton';
import { CONFIG_DIR, readConfigFile } from '@/lib/config';
import { fmtCost, fmtDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

const CONFIG_FILES = ['llm-routing.yaml', 'llm-budgets.yaml', 'employer-boundary.yaml'];

export default async function SettingsPage() {
  const [configs, ledger] = await Promise.all([
    Promise.all(CONFIG_FILES.map((f) => readConfigFile(f))),
    db
      .select()
      .from(schema.budgetLedger)
      .orderBy(desc(schema.budgetLedger.month), desc(schema.budgetLedger.spentUsd)),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Settings</h1>
      <p className="text-xs text-neutral-500">
        Config is read-only here — files live in <code className="font-mono">{CONFIG_DIR}</code>{' '}
        (CONFIG_DIR env). Edit on disk; the runtime reloads on restart.
      </p>

      {configs.map((cfg) => (
        <section key={cfg.name} className="card">
          <h2 className="mb-2 font-mono text-sm font-semibold text-neutral-200">{cfg.name}</h2>
          {cfg.raw === null ? (
            <p className="text-sm text-amber-400">
              config not mounted — expected at <code className="font-mono">{cfg.path}</code>
            </p>
          ) : (
            <>
              {cfg.error && <p className="mb-2 text-xs text-red-400">{cfg.error}</p>}
              <pre className="code-block max-h-96">{cfg.raw}</pre>
            </>
          )}
        </section>
      ))}

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">Budget ledger</h2>
        {ledger.length === 0 ? (
          <p className="text-sm text-neutral-500">No ledger rows.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Month</th>
                <th>Spent</th>
                <th>State</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr key={`${row.tier}-${row.month}`}>
                  <td className="font-mono">{row.tier}</td>
                  <td className="font-mono">{row.month}</td>
                  <td className="font-mono">{fmtCost(row.spentUsd)}</td>
                  <td>
                    <span className={row.frozen ? 'badge-failed' : 'badge-ok'}>
                      {row.frozen ? 'frozen' : 'open'}
                    </span>
                  </td>
                  <td className="font-mono">{fmtDate(row.updatedAt)}</td>
                  <td>
                    {row.frozen ? (
                      <PostButton
                        endpoint={`/api/budgets/${encodeURIComponent(row.tier)}/unfreeze`}
                        label="Unfreeze"
                        confirmText={`Unfreeze budget tier "${row.tier}" for the current month? Spending resumes immediately.`}
                      />
                    ) : (
                      '—'
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
