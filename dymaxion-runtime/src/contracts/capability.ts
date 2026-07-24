import { z } from 'zod';
import type { BoundaryOptions } from '../security/boundary.js';
import type { ConsumedApprovalExecutionGrant, ConsumedApprovalReceipt } from '../security/approval.js';

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const CapabilityManifestSchema = z
  .object({
    schema_version: SemverSchema,
    slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1),
    description: z.string().min(1),
    version: SemverSchema,
    classification: z.enum(['read', 'write', 'copy-on-write']),
    identity: z
      .object({
        required: z.boolean(),
        permissions: z.array(z.string().min(1)),
        credential_kinds: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    allowed_hosts: z.array(z.string().min(1)),
    allowed_sources: z.array(z.string().min(1)),
    resource_limits: z
      .object({
        max_records: z.number().int().positive(),
        max_bytes: z.number().int().positive(),
        max_duration_ms: z.number().int().positive(),
        max_cost_usd: z.number().nonnegative(),
        // Optional additive ceilings (evidence schema-compatible): capabilities
        // with additional hard limits expose them here so manifests stay
        // traceable to enforced constants. Older manifests simply omit them.
        max_coordinate_positions: z.number().int().positive().optional(),
        max_returned_issues: z.number().int().positive().optional(),
        max_geometry_collection_depth: z.number().int().positive().optional(),
        max_self_intersection_segments: z.number().int().positive().optional(),
        max_svg_bytes: z.number().int().positive().optional(),
        max_width_px: z.number().int().positive().optional(),
        max_height_px: z.number().int().positive().optional(),
        max_title_chars: z.number().int().positive().optional(),
        max_purpose_chars: z.number().int().positive().optional(),
        max_audience_chars: z.number().int().positive().optional(),
        max_pair_evaluations: z.number().int().positive().optional(),
        max_output_bytes: z.number().int().positive().optional(),
        max_source_bytes: z.number().int().positive().optional(),
        max_primary_records: z.number().int().positive().optional(),
        max_candidate_records: z.number().int().positive().optional(),
        max_coordinate_ordinates: z.number().int().positive().optional(),
        max_json_depth: z.number().int().positive().optional(),
        max_json_nodes: z.number().int().positive().optional(),
        max_report_bytes: z.number().int().positive().optional(),
        max_evidence_bytes: z.number().int().positive().optional(),
        max_artifact_bytes: z.number().int().positive().optional(),
        max_archive_bytes: z.number().int().positive().optional(),
        max_archive_entries: z.number().int().positive().optional(),
        max_project_bytes: z.number().int().positive().optional(),
        max_project_bundles: z.number().int().positive().optional(),
      })
      .strict(),
    idempotency: z
      .object({
        mode: z.enum(['deterministic', 'idempotency-key', 'none']),
        key_fields: z.array(z.string().min(1)),
      })
      .strict(),
    dry_run: z
      .object({ supported: z.boolean(), reason: z.string().min(1).optional() })
      .strict(),
    cancellation: z
      .object({ supported: z.boolean(), checkpoint: z.string().min(1).optional() })
      .strict(),
    artifacts: z.array(
      z
        .object({
          name: z.string().min(1),
          media_type: z.string().min(1),
          required: z.boolean(),
        })
        .strict(),
    ),
    rollback: z
      .object({
        supported: z.boolean(),
        strategy: z.string().min(1),
        reason: z.string().min(1).optional(),
      })
      .strict(),
    validation: z
      .object({
        suite: z.string().min(1),
        version: SemverSchema,
        supported_gis_versions: z.array(z.string().min(1)),
      })
      .strict(),
    input_schema_version: SemverSchema,
    output_schema_version: SemverSchema,
  })
  .strict();

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export interface CapabilityApprovalBinding {
  target: string;
  credentialIdentity: string;
}

export interface CapabilityDefinition<TInput, TOutput> {
  manifest: CapabilityManifest;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  inputSummary: readonly string[];
  boundaryFields: readonly string[];
  /**
   * Trusted native-capability predicate for conditional reads and
   * copy-on-write/dry-run operations. Reads remain approval-free unless this
   * hook explicitly returns true; non-read manifests require approval unless
   * it explicitly returns false. Input is already schema-validated.
   */
  requiresApproval?(input: TInput): boolean;
  /** Resolve the exact trusted target and credential identity used to create,
   * consume, and verify approval. This must not materialize secret tokens. */
  resolveApprovalBinding?(
    input: TInput,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityApprovalBinding>;
  /**
   * Optional capability-specific preflight that runs after the shared execution
   * boundary accepts the validated input and before approval, invocation
   * recording, audit logging, or execution. Use only for checks that require
   * canonicalization or other capability-local context; never duplicate this in
   * the shared executor.
   */
  preflight?(input: TInput, context: CapabilityExecutionContext): Promise<void>;
  execute(input: TInput, context: CapabilityExecutionContext): Promise<TOutput>;
}

export interface CapabilityExecutionContext {
  agentRunId?: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Testable monotonic milliseconds clock for duration enforcement. Production defaults to performance.now(). */
  monotonicNow?: () => number;
  io?: Record<string, unknown>;
  /** Boundary enforcement options for capabilities that dispatch outbound
   * requests; capabilities must pass these to the shared URL checks so
   * audit/DNS behavior stays consistent with the executor preflight. */
  boundary?: BoundaryOptions;
  /** Opaque proof that the exact parsed native-capability input already passed
   * its generic preflight before invocation persistence. Only the capability
   * registry can mint or validate it; caller-supplied objects fail closed. */
  capabilityPreflightGrant?: unknown;
  /**
   * Opaque receipt minted only by security/approval.consumeApproval. It is
   * input authority only: the registry or direct capability claims it once
   * into approvalExecutionGrant and sinks must not fall back to this receipt.
   */
  approvalReceipt?: ConsumedApprovalReceipt;
  /**
   * Unforgeable one-execution grant. Capability entry consumes it once; durable
   * sinks repeatedly verify that same consumed grant immediately before each
   * externally visible mutation.
   */
  approvalExecutionGrant?: ConsumedApprovalExecutionGrant;
}

export interface ParsedCapabilityInput<TInput> {
  readonly alreadyParsed: true;
  readonly parsedInput: TInput;
}

function isParsedCapabilityInput<TInput>(value: unknown): value is ParsedCapabilityInput<TInput> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { alreadyParsed?: unknown }).alreadyParsed === true &&
      'parsedInput' in value,
  );
}

/**
 * Shared native approval policy. Raw input is schema-validated here; callers
 * that already validated at a trusted boundary may pass `{ alreadyParsed: true,
 * parsedInput }` to avoid double parsing. Invalid raw input throws so planners
 * can fail closed while runSkill can return the real validation error.
 */
export function capabilityRequiresApproval<TInput, TOutput>(
  definition: CapabilityDefinition<TInput, TOutput>,
  rawOrParsedInput: unknown,
): boolean {
  const parsedInput = isParsedCapabilityInput<TInput>(rawOrParsedInput)
    ? rawOrParsedInput.parsedInput
    : definition.inputSchema.parse(rawOrParsedInput);
  const explicit = definition.requiresApproval?.(parsedInput);
  if (definition.manifest.classification === 'read') return explicit === true;
  return explicit === false ? false : true;
}
