// Per-project context: one row per engagement. context JSONB holds portal
// URLs, coordinate systems, key datasets, notification targets.

import { eq, isNull, and } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export type Project = typeof schema.projects.$inferSelect;

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.slug, slug), isNull(schema.projects.deletedAt)));
  return row ?? null;
}

export async function listProjects(): Promise<Project[]> {
  return db.select().from(schema.projects).where(isNull(schema.projects.deletedAt));
}

export async function upsertProject(params: {
  slug: string;
  name: string;
  client?: string;
  description?: string;
  context?: Record<string, unknown>;
}): Promise<Project> {
  const [row] = await db
    .insert(schema.projects)
    .values({
      slug: params.slug,
      name: params.name,
      client: params.client,
      description: params.description,
      context: params.context ?? {},
    })
    .onConflictDoUpdate({
      target: schema.projects.slug,
      set: {
        name: params.name,
        client: params.client,
        description: params.description,
        ...(params.context ? { context: params.context } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// Active project per gateway session (source_id → project). In-memory is
// fine: `dymaxion project switch` re-issues it cheaply after a restart.
const activeProjects = new Map<string, string>();

export function setActiveProject(sessionKey: string, projectId: string): void {
  activeProjects.set(sessionKey, projectId);
}

export function getActiveProject(sessionKey: string): string | undefined {
  return activeProjects.get(sessionKey);
}
