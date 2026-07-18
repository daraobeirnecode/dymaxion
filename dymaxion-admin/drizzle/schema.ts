// Drizzle schema for the dymaxion.* Postgres schema.
// Mirrors migrations/001-003 — migrations are the source of truth; this file
// exists for typed access from the runtime (and is duplicated in
// dymaxion-admin/drizzle/schema.ts for the dashboard).

import {
  pgSchema,
  uuid,
  text,
  jsonb,
  timestamp,
  numeric,
  integer,
  boolean,
  bigserial,
  date,
  customType,
} from 'drizzle-orm/pg-core';

export const dymaxion = pgSchema('dymaxion');

/** pgvector column (1024-dim voyage-3-large embeddings). */
export const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1024)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

export const projects = dymaxion.table('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  client: text('client'),
  description: text('description'),
  status: text('status').notNull().default('active'),
  context: jsonb('context').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const messages = dymaxion.table('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  gateway: text('gateway').notNull(),
  sourceId: text('source_id').notNull(),
  direction: text('direction').notNull(),
  body: text('body').notNull(),
  attachments: jsonb('attachments'),
  intent: text('intent'),
  embedding: vector1024('embedding'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  projectId: uuid('project_id').references(() => projects.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const preferences = dymaxion.table('preferences', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const datasets = dymaxion.table('datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  sourceType: text('source_type').notNull(),
  sourceUri: text('source_uri').notNull(),
  schemaJson: jsonb('schema_json'),
  spatialReference: integer('spatial_reference'),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  projectIds: uuid('project_ids').array().default([]),
  notes: text('notes'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const agentRuns = dymaxion.table('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id),
  projectId: uuid('project_id').references(() => projects.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  status: text('status').notNull().default('running'),
  plan: jsonb('plan').notNull(),
  finalNarrative: text('final_narrative'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).default('0'),
  langfuseTraceId: text('langfuse_trace_id'),
});

export const skillInvocations = dymaxion.table('skill_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentRunId: uuid('agent_run_id')
    .notNull()
    .references(() => agentRuns.id),
  skillSlug: text('skill_slug').notNull(),
  skillVersion: text('skill_version').notNull(),
  invokedAt: timestamp('invoked_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  error: jsonb('error'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).default('0'),
  llmCallsCount: integer('llm_calls_count').default(0),
  toolCallsCount: integer('tool_calls_count').default(0),
});

export const skillHistory = dymaxion.table('skill_history', {
  skillSlug: text('skill_slug').primaryKey(),
  totalInvocations: integer('total_invocations').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  avgDurationMs: numeric('avg_duration_ms'),
  avgCostUsd: numeric('avg_cost_usd', { precision: 10, scale: 4 }),
  lastInvokedAt: timestamp('last_invoked_at', { withTimezone: true }),
});

export const skillRegistry = dymaxion.table('skill_registry', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  category: text('category').notNull(),
  skillClass: text('skill_class').notNull(),
  destructive: boolean('destructive').notNull().default(false),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  authoredBy: text('authored_by').notNull(),
  manifest: jsonb('manifest').notNull(),
  status: text('status').notNull().default('active'),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  embedding: vector1024('embedding'),
});

export const proposedSkills = dymaxion.table('proposed_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  proposedForRun: uuid('proposed_for_run').references(() => agentRuns.id),
  skillMd: text('skill_md').notNull(),
  manifestYaml: text('manifest_yaml').notNull(),
  scripts: jsonb('scripts').notNull(),
  status: text('status').notNull().default('pending'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNotes: text('review_notes'),
});

export const approvalRequests = dymaxion.table('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentRunId: uuid('agent_run_id')
    .notNull()
    .references(() => agentRuns.id),
  stepDescription: text('step_description').notNull(),
  stepPayload: jsonb('step_payload').notNull(),
  payloadHash: text('payload_hash').notNull(),
  target: text('target').notNull(),
  credentialIdentity: text('credential_identity'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  decision: text('decision'),
  decidedBy: text('decided_by'),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const budgetLedger = dymaxion.table('budget_ledger', {
  tier: text('tier').notNull(),
  month: date('month').notNull(),
  spentUsd: numeric('spent_usd', { precision: 10, scale: 4 }).notNull().default('0'),
  frozen: boolean('frozen').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = dymaxion.table('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventAt: timestamp('event_at', { withTimezone: true }).notNull().defaultNow(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
});

export const oauthTokens = dymaxion.table('oauth_tokens', {
  provider: text('provider').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  tokenType: text('token_type').notNull().default('Bearer'),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  connectedByUser: text('connected_by_user').notNull(),
});

export const oauthFlowState = dymaxion.table('oauth_flow_state', {
  state: text('state').primaryKey(),
  provider: text('provider').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
