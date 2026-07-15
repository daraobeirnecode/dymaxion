// Human-in-the-loop approvals. Destructive steps create a row in
// dymaxion.approval_requests, notify the originating gateway, and block
// until approved / rejected / expired (default timeout from preferences:
// approval_timeout_minutes, 30). Decisions can arrive from the gateway
// (inline keyboard) or the admin dashboard (POST /api/approvals/[id]).

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { auditEvent } from './audit.js';
import type { ApprovalRequest, ApprovalResponse } from '../gateways/common.js';

const POLL_MS = 2_000;

export async function createApprovalRequest(
  agentRunId: string,
  stepDescription: string,
  payload: Record<string, unknown>,
  timeoutMinutes: number,
): Promise<ApprovalRequest> {
  const [row] = await db
    .insert(schema.approvalRequests)
    .values({ agentRunId, stepDescription, stepPayload: payload })
    .returning();
  await auditEvent('approval_requested', { approvalId: row.id, stepDescription }, agentRunId);
  return {
    id: row.id,
    agent_run_id: agentRunId,
    step_description: stepDescription,
    payload,
    timeout_minutes: timeoutMinutes,
  };
}

/** Record a decision (from a gateway button or the admin dashboard). */
export async function decideApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
): Promise<void> {
  await db
    .update(schema.approvalRequests)
    .set({ decision, decidedBy, respondedAt: new Date() })
    .where(eq(schema.approvalRequests.id, approvalId));
  await auditEvent('approval_decided', { approvalId, decision, decidedBy });
}

/** Block until the request is decided or expires. */
export async function awaitDecision(req: ApprovalRequest): Promise<ApprovalResponse> {
  const deadline = Date.now() + req.timeout_minutes * 60_000;
  for (;;) {
    const [row] = await db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, req.id));
    if (row?.decision === 'approved' || row?.decision === 'rejected') {
      return {
        approved: row.decision === 'approved',
        decision: row.decision,
        decided_by: row.decidedBy ?? 'unknown',
      };
    }
    if (Date.now() > deadline) {
      await db
        .update(schema.approvalRequests)
        .set({ decision: 'expired', respondedAt: new Date() })
        .where(eq(schema.approvalRequests.id, req.id));
      await auditEvent('approval_decided', { approvalId: req.id, decision: 'expired' });
      return { approved: false, decision: 'expired', decided_by: 'timeout' };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
