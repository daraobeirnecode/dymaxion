// Drizzle + postgres-js client for the admin dashboard.
// Reads DATABASE_URL at runtime; the connection is lazy so `next build`
// never needs a live database (all DB pages are force-dynamic).

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://dymaxion:dymaxion@dymaxion-postgres:5432/dymaxion';

const globalForDb = globalThis as unknown as {
  __dymaxionSql?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__dymaxionSql ?? postgres(connectionString, { max: 5 });
globalForDb.__dymaxionSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
