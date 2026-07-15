import { revalidatePath } from 'next/cache';
import { asc, isNull } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtDate, prettyJson } from '@/lib/format';

export const dynamic = 'force-dynamic';

async function createDataset(formData: FormData) {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const sourceType = String(formData.get('sourceType') ?? '').trim();
  const sourceUri = String(formData.get('sourceUri') ?? '').trim();
  const spatialReference = String(formData.get('spatialReference') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();
  if (!name || !sourceType || !sourceUri) return;
  await db.insert(schema.datasets).values({
    name,
    sourceType,
    sourceUri,
    spatialReference: spatialReference ? parseInt(spatialReference, 10) : null,
    notes: notes || null,
  });
  revalidatePath('/datasets');
}

export default async function DatasetsPage() {
  const datasets = await db
    .select()
    .from(schema.datasets)
    .where(isNull(schema.datasets.deletedAt))
    .orderBy(asc(schema.datasets.name));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Datasets registry</h1>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">Register dataset</h2>
        <form action={createDataset} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Name
            <input name="name" required placeholder="parcels_2026" className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Source type
            <select name="sourceType" required className="input">
              <option value="feature_service">feature_service</option>
              <option value="postgis">postgis</option>
              <option value="file_gdb">file_gdb</option>
              <option value="geopackage">geopackage</option>
              <option value="shapefile">shapefile</option>
              <option value="geojson">geojson</option>
              <option value="raster">raster</option>
              <option value="other">other</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Source URI
            <input name="sourceUri" required placeholder="https://…/FeatureServer/0" className="input w-96" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            SRID
            <input name="spatialReference" type="number" placeholder="4326" className="input w-24" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Notes
            <input name="notes" placeholder="optional" className="input w-72" />
          </label>
          <button type="submit" className="btn">
            Register
          </button>
        </form>
      </section>

      <section className="card">
        <p className="mb-2 text-xs text-neutral-500">
          {datasets.length} dataset{datasets.length === 1 ? '' : 's'}.
        </p>
        <table className="table-dense">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Source URI</th>
              <th>SRID</th>
              <th>Last updated</th>
              <th>Schema</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td className="font-mono">{d.name}</td>
                <td>{d.sourceType}</td>
                <td className="max-w-sm truncate font-mono text-xs">{d.sourceUri}</td>
                <td className="font-mono">{d.spatialReference ?? '—'}</td>
                <td className="font-mono">{fmtDate(d.lastUpdated)}</td>
                <td>
                  {d.schemaJson ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-neutral-500">view</summary>
                      <pre className="code-block mt-1 max-w-md">{prettyJson(d.schemaJson)}</pre>
                    </details>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="max-w-xs truncate text-neutral-400">{d.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
