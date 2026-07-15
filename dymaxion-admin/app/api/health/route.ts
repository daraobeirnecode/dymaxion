import { sql } from '@/drizzle/client';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let dbStatus = 'ok';
  try {
    await sql`select 1`;
  } catch (e) {
    dbStatus = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return Response.json({ status: 'ok', db: dbStatus });
}
