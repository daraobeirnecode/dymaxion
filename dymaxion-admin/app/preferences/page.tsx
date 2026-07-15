import { revalidatePath } from 'next/cache';
import { asc } from 'drizzle-orm';
import { db, schema } from '@/drizzle/client';
import { fmtDate, prettyJson } from '@/lib/format';

export const dynamic = 'force-dynamic';

async function upsertPreference(formData: FormData) {
  'use server';
  const key = String(formData.get('key') ?? '').trim();
  const rawValue = String(formData.get('value') ?? '').trim();
  if (!key || !rawValue) return;

  // Accept JSON; fall back to storing the raw string as a JSON string value.
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }

  await db
    .insert(schema.preferences)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.preferences.key,
      set: { value, updatedAt: new Date() },
    });
  revalidatePath('/preferences');
}

export default async function PreferencesPage() {
  const prefs = await db
    .select()
    .from(schema.preferences)
    .orderBy(asc(schema.preferences.key));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-neutral-100">Preferences</h1>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">Set preference</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Single row per key. Value is stored as JSONB — enter JSON (objects, arrays, numbers,
          booleans) or plain text (stored as a JSON string). Existing keys are overwritten.
        </p>
        <form action={upsertPreference} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Key
            <input name="key" required placeholder="default_crs" className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Value (JSON or text)
            <input name="value" required placeholder='"EPSG:2226"' className="input w-96 font-mono" />
          </label>
          <button type="submit" className="btn">
            Save
          </button>
        </form>
      </section>

      <section className="card">
        <p className="mb-2 text-xs text-neutral-500">
          {prefs.length} preference{prefs.length === 1 ? '' : 's'}.
        </p>
        <table className="table-dense">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => (
              <tr key={p.key}>
                <td className="font-mono">{p.key}</td>
                <td>
                  <pre className="max-w-xl overflow-x-auto font-mono text-xs text-neutral-300">
                    {prettyJson(p.value)}
                  </pre>
                </td>
                <td className="font-mono">{fmtDate(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
