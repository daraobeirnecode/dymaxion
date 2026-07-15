import Link from 'next/link';
import { asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtDate, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const [skills, pending] = await Promise.all([
    db.select().from(schema.skillRegistry).orderBy(asc(schema.skillRegistry.slug)),
    db
      .select()
      .from(schema.proposedSkills)
      .where(eq(schema.proposedSkills.status, 'pending'))
      .orderBy(desc(schema.proposedSkills.proposedAt)),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Skill catalog</h1>

      <section className="card">
        <p className="mb-2 text-xs text-neutral-500">
          {skills.length} registered skill{skills.length === 1 ? '' : 's'}.
        </p>
        <table className="table-dense">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Category</th>
              <th>Class</th>
              <th>Version</th>
              <th>Flags</th>
              <th>Authored by</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.slug}>
                <td className="font-mono">
                  <Link href={`/skills/${s.slug}`} className="hover:underline">
                    {s.slug}
                  </Link>
                </td>
                <td>{s.category}</td>
                <td>{s.skillClass}</td>
                <td className="font-mono">{s.version}</td>
                <td className="space-x-1">
                  {s.destructive && <span className="badge-failed">destructive</span>}
                  {s.requiresApproval && <span className="badge-pending">approval</span>}
                  {!s.destructive && !s.requiresApproval && (
                    <span className="badge-neutral">standard</span>
                  )}
                </td>
                <td className="font-mono text-xs">{s.authoredBy}</td>
                <td>
                  <span className={statusBadgeClass(s.status)}>{s.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">
          Proposed skills pending review ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-neutral-500">No proposed skills awaiting review.</p>
        ) : (
          <table className="table-dense">
            <thead>
              <tr>
                <th>Proposal</th>
                <th>Slug</th>
                <th>Proposed</th>
                <th>For run</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono">
                    <Link href={`/skills/proposed/${p.id}`} className="hover:underline">
                      {shortId(p.id)}
                    </Link>
                  </td>
                  <td className="font-mono">{p.slug}</td>
                  <td className="font-mono">{fmtDate(p.proposedAt)}</td>
                  <td className="font-mono">{shortId(p.proposedForRun)}</td>
                  <td>
                    <span className={statusBadgeClass(p.status)}>{p.status}</span>
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
