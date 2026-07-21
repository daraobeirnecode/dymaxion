import { z } from 'zod';
import type { BoundaryOptions } from '../security/boundary.js';

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

export interface CapabilityDefinition<TInput, TOutput> {
  manifest: CapabilityManifest;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  inputSummary: readonly string[];
  boundaryFields: readonly string[];
  execute(input: TInput, context: CapabilityExecutionContext): Promise<TOutput>;
}

export interface CapabilityExecutionContext {
  agentRunId?: string;
  signal?: AbortSignal;
  now?: () => Date;
  io?: Record<string, unknown>;
  /** Boundary enforcement options for capabilities that dispatch outbound
   * requests; capabilities must pass these to the shared URL checks so
   * audit/DNS behavior stays consistent with the executor preflight. */
  boundary?: BoundaryOptions;
}
