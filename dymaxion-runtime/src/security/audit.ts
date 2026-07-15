// Append-only audit log. Every consequential event lands here:
// llm_call | tool_call | file_write | data_query | boundary_block |
// approval | skill_invocation | incoming_message | outgoing_message | ...

import { db, schema } from '../db/client.js';
import { logger } from '../observability/logger.js';

export type AuditEventType =
  | 'incoming_message'
  | 'outgoing_message'
  | 'llm_call_pre'
  | 'llm_call_post'
  | 'tool_call'
  | 'file_write'
  | 'data_query'
  | 'boundary_block'
  | 'budget_block'
  | 'approval_requested'
  | 'approval_decided'
  | 'skill_invocation'
  | 'skill_proposed'
  | 'run_step'
  | 'worker_dispatch'
  | 'system';

export async function auditEvent(
  eventType: AuditEventType,
  payload: Record<string, unknown>,
  agentRunId?: string,
): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      eventType,
      payload,
      agentRunId: agentRunId ?? null,
    });
  } catch (err) {
    // The audit log must never take the runtime down, but a write failure
    // is itself a serious event — log loudly.
    logger.error({ err, eventType }, 'audit log write failed');
  }
}
