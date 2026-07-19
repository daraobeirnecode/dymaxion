import { z } from 'zod';

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ExtentSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const FieldSchema = z
  .object({
    name: z.string().min(1),
    types: z.array(z.string().min(1)).min(1),
    nullable: z.boolean(),
  })
  .strict();

const TemporalFieldSchema = z
  .object({
    name: z.string().min(1),
    min: IsoDateSchema.optional(),
    max: IsoDateSchema.optional(),
    parsed_count: z.number().int().nonnegative(),
  })
  .strict();

export const GisMetadataSchema = z
  .object({
    format: z.string().min(1),
    crs: z.string().min(1).nullable(),
    axis_order: z.string().min(1).nullable(),
    units: z.string().min(1).nullable(),
    extent: ExtentSchema.nullable(),
    schema: z.array(FieldSchema),
    row_count: z.number().int().nonnegative(),
    geometry_types: z.array(z.string().min(1)),
    temporal_fields: z.array(TemporalFieldSchema),
  })
  .strict();

export const EvidenceBundleSchema = z
  .object({
    schema_version: SemverSchema,
    bundle_id: z.string().min(1),
    generated_at: IsoDateSchema,
    source: z
      .object({
        uri: z.string().min(1),
        identity: z
          .object({ kind: z.string().min(1), value: z.string().min(1) })
          .strict(),
        version: z
          .object({
            etag: z.string().min(1).optional(),
            modified_at: IsoDateSchema.optional(),
            version: z.string().min(1).optional(),
          })
          .strict(),
        retrieved_at: IsoDateSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    gis_metadata: GisMetadataSchema,
    parameters: z
      .object({ canonical_json: z.string().min(1), sha256: Sha256Schema })
      .strict(),
    execution: z
      .object({
        capability: z.string().min(1),
        capability_version: SemverSchema,
        mode: z.enum(['deterministic', 'model-planned']),
        model_planning: z.array(
          z
            .object({ provider: z.string().min(1), model: z.string().min(1), purpose: z.string().min(1) })
            .strict(),
        ),
      })
      .strict(),
    outputs: z.array(
      z
        .object({
          name: z.string().min(1),
          sha256: Sha256Schema,
          validation: z
            .object({ valid: z.boolean(), checks: z.array(z.string().min(1)), warnings: z.array(z.string()).optional() })
            .strict(),
        })
        .strict(),
    ),
    approvals: z.array(
      z
        .object({
          approval_id: z.string().min(1),
          payload_hash: Sha256Schema,
          target: z.string().min(1),
          credential_identity: z.string().min(1).nullable(),
          decision: z.enum(['approved', 'rejected', 'expired']),
          decided_by: z.string().min(1),
          decided_at: IsoDateSchema,
        })
        .strict(),
    ),
    rollback: z
      .object({
        required: z.boolean(),
        strategy: z.string().min(1),
        artifacts: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type GisMetadata = z.infer<typeof GisMetadataSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
