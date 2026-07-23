// Approval binding and one-time atomic consumption.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { canonicalJson, sha256Canonical } from '../contracts/canonical.js';
import { db, schema } from '../db/client.js';
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalDecision,
} from '../gateways/common.js';

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
  credentialIdentity: string;
  requestedAt: Date;
  expiresAt: Date;
}

interface ApprovalBinding {
  agentRunId: string;
  payloadHash: string;
  target: string;
  credentialIdentity: string;
}

export interface ConsumedApprovalSnapshot {
  readonly approval_id: string;
  readonly decision: 'approved';
  readonly decided_by: string;
  readonly decided_at: string;
  readonly target: string;
  readonly payload_hash: string;
  readonly credential_identity: string;
  readonly agent_run_id: string;
}

declare const consumedApprovalReceiptBrand: unique symbol;
declare const consumedApprovalExecutionGrantBrand: unique symbol;

export interface ConsumedApprovalReceipt {
  readonly [consumedApprovalReceiptBrand]: never;
  readonly snapshot: ConsumedApprovalSnapshot;
}

export interface ConsumedApprovalExecutionGrant {
  readonly [consumedApprovalExecutionGrantBrand]: never;
}

const consumedApprovalReceipts = new WeakSet<object>();
const claimedApprovalReceipts = new WeakSet<object>();
const consumedApprovalExecutionGrants = new WeakSet<object>();
const approvalExecutionGrants = new WeakMap<object, ConsumedApprovalReceipt>();

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

export interface ApprovalDependencies {
  store?: ApprovalStore;
  now?: () => Date;
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
    return db.transaction(async (tx) => {
      const [row] = await tx
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
      await tx.insert(schema.auditLog).values({
        eventType: 'approval_requested',
        payload: {
          approval_id: row.id,
          step_description: row.stepDescription,
          payload_hash: row.payloadHash,
          target: row.target,
          credential_identity: row.credentialIdentity,
          expires_at: row.expiresAt.toISOString(),
        },
        agentRunId: row.agentRunId,
      });
      return mapRow(row);
    });
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
    return db.transaction(async (tx) => {
      const [row] = await tx
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
      if (!row) return null;
      await tx.insert(schema.auditLog).values({
        eventType: 'approval_decided',
        payload: {
          approval_id: id,
          decision,
          decided_by: decidedBy,
          payload_hash: row.payloadHash,
          target: row.target,
          credential_identity: row.credentialIdentity,
          expires_at: row.expiresAt.toISOString(),
        },
        agentRunId: row.agentRunId,
      });
      return mapRow(row);
    });
  }

  async expireAtomic(id: string, now: Date): Promise<ApprovalRecord | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx
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
      if (!row) return null;
      await tx.insert(schema.auditLog).values({
        eventType: 'approval_decided',
        payload: {
          approval_id: id,
          decision: 'expired',
          decided_by: 'system',
          payload_hash: row.payloadHash,
          target: row.target,
          credential_identity: row.credentialIdentity,
          expires_at: row.expiresAt.toISOString(),
        },
        agentRunId: row.agentRunId,
      });
      return mapRow(row);
    });
  }

  async consumeAtomic(id: string, binding: ApprovalBinding, now: Date): Promise<ApprovalRecord | null> {
    const identityCondition =
      binding.credentialIdentity === null
        ? isNull(schema.approvalRequests.credentialIdentity)
        : eq(schema.approvalRequests.credentialIdentity, binding.credentialIdentity);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.approvalRequests)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.approvalRequests.id, id),
            eq(schema.approvalRequests.agentRunId, binding.agentRunId),
            eq(schema.approvalRequests.decision, 'approved'),
            isNull(schema.approvalRequests.consumedAt),
            gt(schema.approvalRequests.expiresAt, now),
            eq(schema.approvalRequests.payloadHash, binding.payloadHash),
            eq(schema.approvalRequests.target, binding.target),
            identityCondition,
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(schema.auditLog).values({
        eventType: 'approval_consumed',
        payload: {
          approval_id: id,
          agent_run_id: binding.agentRunId,
          payload_hash: binding.payloadHash,
          target: binding.target,
          credential_identity: binding.credentialIdentity,
        },
        agentRunId: row.agentRunId,
      });
      return mapRow(row);
    });
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
      record.agentRunId !== binding.agentRunId ||
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
    sleep: supplied.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function publicRequest(record: ApprovalRecord): ApprovalRequest {
  const credentialIdentity = record.credentialIdentity;
  if (!credentialIdentity) {
    throw new Error('historical approval without a trusted credential identity cannot be dispatched');
  }
  return {
    id: record.id,
    agent_run_id: record.agentRunId,
    step_description: record.stepDescription,
    payload: record.payload,
    payload_hash: record.payloadHash,
    target: record.target,
    credential_identity: credentialIdentity,
    requested_at: record.requestedAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
  };
}

function immutableReceipt(record: ApprovalRecord): ConsumedApprovalReceipt {
  if (record.decision !== 'approved') throw new Error('approval expired, already consumed, or not consumable');
  if (!record.credentialIdentity) throw new Error('approval expired, already consumed, or not consumable');
  const snapshot: ConsumedApprovalSnapshot = Object.freeze({
    approval_id: record.id,
    decision: 'approved',
    decided_by: record.decidedBy ?? 'unknown',
    decided_at: (record.respondedAt ?? record.consumedAt ?? record.requestedAt).toISOString(),
    target: record.target,
    payload_hash: record.payloadHash,
    credential_identity: record.credentialIdentity,
    agent_run_id: record.agentRunId,
  });
  const receipt = Object.freeze({ snapshot }) as ConsumedApprovalReceipt;
  consumedApprovalReceipts.add(receipt);
  return receipt;
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function verifyConsumedApprovalReceipt(
  receipt: unknown,
  binding: {
    agentRunId: string;
    skill: string;
    payload: Record<string, unknown>;
    credentialIdentity: string;
  },
): ConsumedApprovalSnapshot {
  if (!receipt || typeof receipt !== 'object' || !consumedApprovalReceipts.has(receipt)) {
    throw new Error('invalid consumed approval receipt');
  }
  const snapshot = (receipt as ConsumedApprovalReceipt).snapshot;
  const expectedPayloadHash = sha256Canonical(binding.payload);
  let expectedTarget: string;
  try {
    expectedTarget = deriveApprovalTarget(binding.skill, binding.payload);
  } catch {
    throw new Error('consumed approval receipt binding mismatch');
  }
  if (
    snapshot.decision !== 'approved' ||
    snapshot.agent_run_id !== binding.agentRunId ||
    snapshot.credential_identity !== binding.credentialIdentity ||
    !timingSafeHexEqual(snapshot.payload_hash, expectedPayloadHash) ||
    snapshot.target !== expectedTarget
  ) {
    throw new Error('consumed approval receipt binding mismatch');
  }
  return snapshot;
}

export function claimConsumedApprovalReceipt(
  receipt: unknown,
  binding: Parameters<typeof verifyConsumedApprovalReceipt>[1],
): ConsumedApprovalExecutionGrant {
  verifyConsumedApprovalReceipt(receipt, binding);
  const receiptObject = receipt as object;
  if (claimedApprovalReceipts.has(receiptObject)) {
    throw new Error('consumed approval receipt already claimed for execution');
  }
  claimedApprovalReceipts.add(receiptObject);
  const grant = Object.freeze({}) as ConsumedApprovalExecutionGrant;
  approvalExecutionGrants.set(grant as object, receipt as ConsumedApprovalReceipt);
  return grant;
}

export function consumeApprovalExecutionGrant(
  grant: unknown,
  binding: Parameters<typeof verifyConsumedApprovalReceipt>[1],
): ConsumedApprovalSnapshot {
  if (!grant || typeof grant !== 'object') throw new Error('invalid consumed approval execution grant');
  const receipt = approvalExecutionGrants.get(grant);
  if (!receipt) throw new Error('invalid consumed approval execution grant');
  if (consumedApprovalExecutionGrants.has(grant)) {
    throw new Error('consumed approval execution grant already used');
  }
  const snapshot = verifyConsumedApprovalReceipt(receipt, binding);
  consumedApprovalExecutionGrants.add(grant);
  return snapshot;
}

export function verifyConsumedApprovalExecutionGrant(
  grant: unknown,
  binding: Parameters<typeof verifyConsumedApprovalReceipt>[1],
): ConsumedApprovalSnapshot {
  if (!grant || typeof grant !== 'object') throw new Error('invalid consumed approval execution grant');
  const receipt = approvalExecutionGrants.get(grant);
  if (!receipt || !consumedApprovalExecutionGrants.has(grant)) {
    throw new Error('invalid consumed approval execution grant');
  }
  return verifyConsumedApprovalReceipt(receipt, binding);
}

export function deriveApprovalTarget(skill: string, payload: Record<string, unknown>): string {
  if (skill === 'export_evidence_bundle') {
    const projectId = payload.project_id;
    const bundleSha256 = payload.target_bundle_sha256;
    if (
      payload.operation !== 'persist' ||
      typeof projectId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId) ||
      typeof bundleSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(bundleSha256)
    ) {
      throw new Error("approval target could not be derived for 'export_evidence_bundle'");
    }
    return `capability:export_evidence_bundle|project:${projectId}|bundle:${bundleSha256}`;
  }

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
  options: { timeoutMinutes: number; target: string; credentialIdentity: string },
  supplied: ApprovalDependencies = {},
): Promise<ApprovalRequest> {
  const { store, now } = deps(supplied);
  if (!options.target.trim()) throw new Error('approval target is required');
  if (!options.credentialIdentity.trim()) throw new Error('trusted credential identity is required');
  const requestedAt = now();
  const expiresAt = new Date(requestedAt.getTime() + options.timeoutMinutes * 60_000);
  const record = await store.create({
    id: randomUUID(),
    agentRunId,
    stepDescription,
    payload,
    payloadHash: sha256Canonical(payload),
    target: options.target,
    credentialIdentity: options.credentialIdentity,
    requestedAt,
    expiresAt,
  });
  return publicRequest(record);
}

export async function decideApproval(
  approvalId: string,
  decision: Exclude<ApprovalDecision, 'expired'>,
  decidedBy: string,
  supplied: ApprovalDependencies = {},
): Promise<boolean> {
  const { store, now } = deps(supplied);
  const instant = now();
  const record = await store.decideAtomic(approvalId, decision, decidedBy, instant);
  if (!record) {
    await store.expireAtomic(approvalId, instant);
    return false;
  }
  return true;
}

export async function consumeApproval(
  request: ApprovalRequest,
  payload: Record<string, unknown>,
  target: string,
  credentialIdentity: string,
  supplied: ApprovalDependencies = {},
): Promise<ConsumedApprovalReceipt> {
  const { store, now } = deps(supplied);
  const binding: ApprovalBinding = {
    agentRunId: request.agent_run_id,
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
  return immutableReceipt(record);
}

/** Read-only durable approval lookup. Workflow persistence sinks use this to
 * re-verify the SAME consumed approval record (decision, consumption, payload
 * hash, target, credential identity, agent run) immediately before each
 * additional sink write. It grants nothing and mutates nothing. */
export async function getApprovalRecord(
  approvalId: string,
  supplied: ApprovalDependencies = {},
): Promise<ApprovalRecord | null> {
  const { store } = deps(supplied);
  return store.get(approvalId);
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
