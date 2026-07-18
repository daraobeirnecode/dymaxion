// Approval binding and one-time atomic consumption.

import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { canonicalJson, sha256Canonical } from '../contracts/canonical.js';
import { db, schema } from '../db/client.js';
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalDecision,
} from '../gateways/common.js';
import { auditEvent, type AuditEventType } from './audit.js';

export interface ApprovalRecord {
  id: string;
  agentRunId: string;
  stepDescription: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  target: string;
  credentialIdentity: string | null;
  requestedAt: Date;
  expiresAt: Date;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  respondedAt: Date | null;
  consumedAt: Date | null;
}

interface ApprovalDraft {
  id: string;
  agentRunId: string;
  stepDescription: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  target: string;
  credentialIdentity: string | null;
  requestedAt: Date;
  expiresAt: Date;
}

interface ApprovalBinding {
  payloadHash: string;
  target: string;
  credentialIdentity: string | null;
}

export interface ApprovalStore {
  create(draft: ApprovalDraft): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  decideAtomic(
    id: string,
    decision: Exclude<ApprovalDecision, 'expired'>,
    decidedBy: string,
    now: Date,
  ): Promise<ApprovalRecord | null>;
  expireAtomic(id: string, now: Date): Promise<ApprovalRecord | null>;
  consumeAtomic(id: string, binding: ApprovalBinding, now: Date): Promise<ApprovalRecord | null>;
}

type AuditFn = (
  eventType: AuditEventType,
  payload: Record<string, unknown>,
  agentRunId?: string,
) => Promise<void>;

export interface ApprovalDependencies {
  store?: ApprovalStore;
  now?: () => Date;
  audit?: AuditFn;
  sleep?: (milliseconds: number) => Promise<void>;
}

function mapRow(row: typeof schema.approvalRequests.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    stepDescription: row.stepDescription,
    payload: row.stepPayload,
    payloadHash: row.payloadHash,
    target: row.target,
    credentialIdentity: row.credentialIdentity,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decision: row.decision as ApprovalDecision | null,
    decidedBy: row.decidedBy,
    respondedAt: row.respondedAt,
    consumedAt: row.consumedAt,
  };
}

class PostgresApprovalStore implements ApprovalStore {
  async create(draft: ApprovalDraft): Promise<ApprovalRecord> {
    const [row] = await db
      .insert(schema.approvalRequests)
      .values({
        id: draft.id,
        agentRunId: draft.agentRunId,
        stepDescription: draft.stepDescription,
        stepPayload: draft.payload,
        payloadHash: draft.payloadHash,
        target: draft.target,
        credentialIdentity: draft.credentialIdentity,
        requestedAt: draft.requestedAt,
        expiresAt: draft.expiresAt,
      })
      .returning();
    return mapRow(row);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const [row] = await db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, id))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async decideAtomic(
    id: string,
    decision: Exclude<ApprovalDecision, 'expired'>,
    decidedBy: string,
    now: Date,
  ): Promise<ApprovalRecord | null> {
    const [row] = await db
      .update(schema.approvalRequests)
      .set({ decision, decidedBy, respondedAt: now })
      .where(
        and(
          eq(schema.approvalRequests.id, id),
          isNull(schema.approvalRequests.decision),
          gt(schema.approvalRequests.expiresAt, now),
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }

  async expireAtomic(id: string, now: Date): Promise<ApprovalRecord | null> {
    const [row] = await db
      .update(schema.approvalRequests)
      .set({ decision: 'expired', decidedBy: 'system', respondedAt: now })
      .where(
        and(
          eq(schema.approvalRequests.id, id),
          isNull(schema.approvalRequests.decision),
          lte(schema.approvalRequests.expiresAt, now),
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }

  async consumeAtomic(id: string, binding: ApprovalBinding, now: Date): Promise<ApprovalRecord | null> {
    const identityCondition =
      binding.credentialIdentity === null
        ? isNull(schema.approvalRequests.credentialIdentity)
        : eq(schema.approvalRequests.credentialIdentity, binding.credentialIdentity);
    const [row] = await db
      .update(schema.approvalRequests)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.approvalRequests.id, id),
          eq(schema.approvalRequests.decision, 'approved'),
          isNull(schema.approvalRequests.consumedAt),
          gt(schema.approvalRequests.expiresAt, now),
          eq(schema.approvalRequests.payloadHash, binding.payloadHash),
          eq(schema.approvalRequests.target, binding.target),
          identityCondition,
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }
}

/** Test double whose Map mutations are synchronous and therefore atomic per JS turn. */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async create(draft: ApprovalDraft): Promise<ApprovalRecord> {
    if (this.records.has(draft.id)) throw new Error(`approval already exists: ${draft.id}`);
    const record: ApprovalRecord = {
      ...draft,
      decision: null,
      decidedBy: null,
      respondedAt: null,
      consumedAt: null,
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async decideAtomic(
    id: string,
    decision: Exclude<ApprovalDecision, 'expired'>,
    decidedBy: string,
    now: Date,
  ): Promise<ApprovalRecord | null> {
    const record = this.records.get(id);
    if (!record || record.decision !== null || record.expiresAt <= now) return null;
    Object.assign(record, { decision, decidedBy, respondedAt: now });
    return structuredClone(record);
  }

  async expireAtomic(id: string, now: Date): Promise<ApprovalRecord | null> {
    const record = this.records.get(id);
    if (!record || record.decision !== null || record.expiresAt > now) return null;
    Object.assign(record, { decision: 'expired' as const, decidedBy: 'system', respondedAt: now });
    return structuredClone(record);
  }

  async consumeAtomic(id: string, binding: ApprovalBinding, now: Date): Promise<ApprovalRecord | null> {
    const record = this.records.get(id);
    if (
      !record ||
      record.decision !== 'approved' ||
      record.consumedAt !== null ||
      record.expiresAt <= now ||
      record.payloadHash !== binding.payloadHash ||
      record.target !== binding.target ||
      record.credentialIdentity !== binding.credentialIdentity
    ) {
      return null;
    }
    record.consumedAt = now;
    return structuredClone(record);
  }
}

const postgresStore = new PostgresApprovalStore();

function deps(supplied: ApprovalDependencies = {}) {
  return {
    store: supplied.store ?? postgresStore,
    now: supplied.now ?? (() => new Date()),
    audit: supplied.audit ?? auditEvent,
    sleep: supplied.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function publicRequest(record: ApprovalRecord): ApprovalRequest {
  return {
    id: record.id,
    agent_run_id: record.agentRunId,
    step_description: record.stepDescription,
    payload: record.payload,
    payload_hash: record.payloadHash,
    target: record.target,
    credential_identity: record.credentialIdentity,
    requested_at: record.requestedAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
  };
}

export function extractCredentialIdentity(payload: Record<string, unknown>): string | null {
  const keys = new Set([
    'credential_identity',
    'credentialIdentity',
    'account_id',
    'accountId',
    'connection_id',
    'connectionId',
    'portal_username',
  ]);
  const stack: unknown[] = [payload];
  const seen = new Set<object>();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key) && typeof item === 'string' && item.trim()) return item.trim();
      if (item && typeof item === 'object') stack.push(item);
    }
  }
  return null;
}

export function deriveApprovalTarget(skill: string, payload: Record<string, unknown>): string {
  const targetKeys =
    /(?:^|_)(?:target|destination|url|uri|endpoint|path|file|directory|service|service_name|layer|layer_id|table|schema|database|project|project_id|org|organization|item_id|dataset_id|group_id)(?:$|_)/i;
  const targets: Array<{ path: string; value: unknown }> = [];
  const seen = new Set<object>();
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (targetKeys.test(key) && item !== undefined) targets.push({ path: nextPath, value: item });
      if (item && typeof item === 'object') visit(item, nextPath);
    }
  };
  visit(payload, '$');
  if (!targets.length) {
    throw new Error(
      `approval target could not be derived for '${skill}'; destructive steps must declare an exact target`,
    );
  }
  return `skill:${skill}|${canonicalJson(targets)}`;
}

export async function createApprovalRequest(
  agentRunId: string,
  stepDescription: string,
  payload: Record<string, unknown>,
  options: { timeoutMinutes: number; target: string; credentialIdentity?: string | null },
  supplied: ApprovalDependencies = {},
): Promise<ApprovalRequest> {
  const { store, now, audit } = deps(supplied);
  if (!options.target.trim()) throw new Error('approval target is required');
  const requestedAt = now();
  const expiresAt = new Date(requestedAt.getTime() + options.timeoutMinutes * 60_000);
  const record = await store.create({
    id: randomUUID(),
    agentRunId,
    stepDescription,
    payload,
    payloadHash: sha256Canonical(payload),
    target: options.target,
    credentialIdentity: options.credentialIdentity ?? null,
    requestedAt,
    expiresAt,
  });
  await audit(
    'approval_requested',
    {
      approval_id: record.id,
      step_description: stepDescription,
      payload_hash: record.payloadHash,
      target: record.target,
      credential_identity: record.credentialIdentity,
      expires_at: record.expiresAt.toISOString(),
    },
    agentRunId,
  );
  return publicRequest(record);
}

export async function decideApproval(
  approvalId: string,
  decision: Exclude<ApprovalDecision, 'expired'>,
  decidedBy: string,
  supplied: ApprovalDependencies = {},
): Promise<boolean> {
  const { store, now, audit } = deps(supplied);
  const instant = now();
  const record = await store.decideAtomic(approvalId, decision, decidedBy, instant);
  if (!record) {
    await store.expireAtomic(approvalId, instant);
    return false;
  }
  await audit(
    'approval_decided',
    { approval_id: approvalId, decision, decided_by: decidedBy },
    record.agentRunId,
  );
  return true;
}

export async function consumeApproval(
  request: ApprovalRequest,
  payload: Record<string, unknown>,
  target: string,
  credentialIdentity: string | null,
  supplied: ApprovalDependencies = {},
): Promise<ApprovalRecord> {
  const { store, now, audit } = deps(supplied);
  const binding: ApprovalBinding = {
    payloadHash: sha256Canonical(payload),
    target,
    credentialIdentity,
  };
  if (
    binding.payloadHash !== request.payload_hash ||
    binding.target !== request.target ||
    binding.credentialIdentity !== request.credential_identity
  ) {
    throw new Error('approval binding mismatch: payload, target, or credential identity changed');
  }
  const instant = now();
  const record = await store.consumeAtomic(request.id, binding, instant);
  if (!record) {
    await store.expireAtomic(request.id, instant);
    throw new Error('approval expired, already consumed, or not consumable');
  }
  await audit(
    'approval_consumed',
    { approval_id: request.id, payload_hash: binding.payloadHash, target },
    request.agent_run_id,
  );
  return record;
}

/** Poll the durable decision; consumption remains a separate atomic operation. */
export async function awaitDecision(
  request: ApprovalRequest,
  supplied: ApprovalDependencies = {},
): Promise<ApprovalResponse> {
  const { store, now, sleep } = deps(supplied);
  for (;;) {
    const record = await store.get(request.id);
    if (record?.decision) {
      return {
        approval_id: request.id,
        approved: record.decision === 'approved',
        decision: record.decision,
        decided_by: record.decidedBy ?? 'unknown',
      };
    }
    if (now() >= new Date(request.expires_at)) {
      const expired = await store.expireAtomic(request.id, now());
      const finalRecord = expired ?? (await store.get(request.id));
      if (finalRecord?.decision) {
        return {
          approval_id: request.id,
          approved: finalRecord.decision === 'approved',
          decision: finalRecord.decision,
          decided_by: finalRecord.decidedBy ?? 'system',
        };
      }
    }
    await sleep(1_000);
  }
}
