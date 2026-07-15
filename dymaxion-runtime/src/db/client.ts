import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://dymaxion:dymaxion@127.0.0.1:5434/dymaxion';

// max 10 — the runtime is a single long-lived daemon, not a request farm.
export const sql = postgres(connectionString, { max: 10, onnotice: () => undefined });
export const db = drizzle(sql, { schema });

export type Db = typeof db;
export { schema };

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
