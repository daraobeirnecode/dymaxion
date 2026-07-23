// Versioned deterministic-workflow contract. Workflows are composed
// orchestrations over existing native capabilities — they are NOT native
// capabilities (the capability registry stays at exactly eight entries) and
// NOT historical skills. A workflow owns its own strict input/output schemas
// and deterministic orchestration; persistence inside a workflow happens only
// behind an exact, gateway-presented approval.

import { z } from 'zod';
import type { ApprovalRequest, ApprovalResponse } from '../gateways/common.js';
import type { RunSkillDependencies, SkillResult } from '../skills/executor.js';
import type { ApprovalDependencies } from '../security/approval.js';

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const WorkflowManifestSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1),
    description: z.string().min(1),
    version: SemverSchema,
    kind: z.literal('composed-workflow'),
    // Every GIS execution/export step must be one of these registered native
    // capabilities; validated against the capability registry at registration.
    capabilities_used: z.array(z.string().min(1)).min(1),
    // Deliverable persistence always requires a gateway-presented approval
    // bound to the exact canonical persist payload.
    requires_gateway_approval: z.literal(true),
    input_summary: z.array(z.string().min(1)).min(1),
    input_schema_version: SemverSchema,
    output_schema_version: SemverSchema,
  })
  .strict();

export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

/** One verified deliverable produced by a workflow after approval. The
 * serializable metadata (name/media type/hash/bytes/handle) may travel to any
 * gateway; `path` is the local verified location and must never be serialized
 * into Web SSE events or narratives. */
export interface DeliveredAttachment {
  name: string;
  original_name: string;
  media_type: string;
  sha256: string;
  bytes: number;
  handle: string;
  path: string;
}

export type RunSkillFn = (
  slug: string,
  input: Record<string, unknown>,
  agentRunId: string,
  dependencies?: Partial<RunSkillDependencies>,
) => Promise<SkillResult>;

export interface WorkflowGatewayApproval {
  /** Present the exact approval request on the originating gateway and wait
   * for a durable decision. The runtime never decides on the caller's behalf. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

export interface WorkflowExecutionContext {
  agentRunId: string;
  gateway: WorkflowGatewayApproval;
  runSkillFn?: RunSkillFn;
  runSkillDependencies?: Partial<RunSkillDependencies>;
  approvalDependencies?: ApprovalDependencies;
  approvalTimeoutMinutes?: number;
  now?: () => Date;
  /** Trusted deliverable/artifact root override for tests; production resolves
   * the operator-configured DYMAXION_ARTIFACT_ROOT / workspace default. */
  trustedRoot?: string;
}

export interface WorkflowExecutionResult<TOutput> {
  output: TOutput;
  deliveries: DeliveredAttachment[];
  /** Deterministic operator-voice summary lines built by the workflow itself —
   * never by an LLM — so counts, hashes, and deliverable identities in the
   * final narrative are exact. Contains no local filesystem paths. */
  summary: string;
}

export interface WorkflowDefinition<TInput, TOutput> {
  manifest: WorkflowManifest;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, context: WorkflowExecutionContext): Promise<WorkflowExecutionResult<TOutput>>;
}
