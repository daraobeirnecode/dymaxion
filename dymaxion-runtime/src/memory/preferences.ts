// User-level preferences — single row per key, JSONB values.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export async function getPreference<T = unknown>(key: string, fallback: T): Promise<T> {
  const [row] = await db
    .select()
    .from(schema.preferences)
    .where(eq(schema.preferences.key, key));
  return row ? (row.value as T) : fallback;
}

export async function setPreference(key: string, value: unknown): Promise<void> {
  await db
    .insert(schema.preferences)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.preferences.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function allPreferences(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(schema.preferences);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
