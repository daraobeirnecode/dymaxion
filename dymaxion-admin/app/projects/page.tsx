import { revalidatePath } from 'next/cache';
import { desc, isNull } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtDate, prettyJson, statusBadgeClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

async function createProject(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const client = String(formData.get('client') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!slug || !name) return;
  await db.insert(schema.projects).values({
    slug,
    name,
    client: client || null,
    description: description || null,
  });
  revalidatePath('/projects');
}

export default async function ProjectsPage() {
  const projects = await db
    .select()
    .from(schema.projects)
    .where(isNull(schema.projects.deletedAt))
    .orderBy(desc(schema.projects.createdAt));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Projects</h1>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">Create project</h2>
        <form action={createProject} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Slug
            <input name="slug" required placeholder="sac-county-parcels" className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Name
            <input name="name" required placeholder="Sacramento County parcels" className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Client
            <input name="client" placeholder="optional" className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Description
            <input name="description" placeholder="optional" className="input w-72" />
          </label>
          <button type="submit" className="btn">
            Create
          </button>
        </form>
      </section>

      <section className="space-y-4">
        {projects.length === 0 ? (
          <p className="card text-sm text-neutral-500">No projects.</p>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="card space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-neutral-100">{p.slug}</span>
                <span className="text-sm text-neutral-300">{p.name}</span>
                <span className={statusBadgeClass(p.status)}>{p.status}</span>
                {p.client && <span className="text-xs text-neutral-500">client: {p.client}</span>}
                <span className="font-mono text-xs text-neutral-600">
                  created {fmtDate(p.createdAt)}
                </span>
              </div>
              {p.description && <p className="text-sm text-neutral-400">{p.description}</p>}
              <details>
                <summary className="cursor-pointer text-xs text-neutral-500">
                  context JSONB
                </summary>
                <pre className="code-block mt-2">{prettyJson(p.context)}</pre>
              </details>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
