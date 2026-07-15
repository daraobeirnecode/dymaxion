import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import DecisionButtons from '@/components/DecisionButtons';
import { fmtDate, shortId, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ProposedSkillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [proposal] = await db
    .select()
    .from(schema.proposedSkills)
    .where(eq(schema.proposedSkills.id, id))
    .limit(1);
  if (!proposal) notFound();

  const scripts = (proposal.scripts ?? {}) as Record<string, string>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-lg font-semibold text-neutral-100">
          Proposed skill: {proposal.slug}
        </h1>
        <div className="mt-1 flex flex-wrap gap-3 text-sm text-neutral-400">
          <span className={statusBadgeClass(proposal.status)}>{proposal.status}</span>
          <span className="font-mono">proposed {fmtDate(proposal.proposedAt)}</span>
          {proposal.proposedForRun && (
            <span className="font-mono">for run {shortId(proposal.proposedForRun)}</span>
          )}
          {proposal.reviewedAt && (
            <span className="font-mono">reviewed {fmtDate(proposal.reviewedAt)}</span>
          )}
        </div>
        <p className="mt-2 text-xs text-amber-400">
          Self-authored skill — never invoke outside the sandbox before approval. Review SKILL.md,
          manifest, and every script below.
        </p>
      </div>

      {proposal.status === 'pending' && (
        <div className="card">
          <DecisionButtons
            endpoint={`/api/proposed-skills/${proposal.id}`}
            approveValue="approved"
            rejectValue="rejected"
          />
        </div>
      )}

      {proposal.reviewNotes && (
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold text-neutral-200">Review notes</h2>
          <p className="whitespace-pre-wrap text-sm text-neutral-300">{proposal.reviewNotes}</p>
        </section>
      )}

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">SKILL.md</h2>
        <pre className="code-block">{proposal.skillMd}</pre>
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">manifest.yaml</h2>
        <pre className="code-block">{proposal.manifestYaml}</pre>
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">
          Scripts ({Object.keys(scripts).length})
        </h2>
        {Object.keys(scripts).length === 0 ? (
          <p className="text-sm text-neutral-500">No scripts attached.</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(scripts).map(([name, body]) => (
              <div key={name}>
                <div className="mb-1 font-mono text-xs text-neutral-400">{name}</div>
                <pre className="code-block">
                  {typeof body === 'string' ? body : JSON.stringify(body, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
