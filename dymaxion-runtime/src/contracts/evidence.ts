import { z } from 'zod';

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ExtentSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const RelatedSourceRoleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

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

export const EvidenceSourceSchema = z
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
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const RelatedSourceSchema = EvidenceSourceSchema.extend({
  role: RelatedSourceRoleSchema,
  gis_metadata: GisMetadataSchema.optional(),
}).strict();

const RelatedSourcesSchema = z
  .array(RelatedSourceSchema)
  .min(1)
  .superRefine((relatedSources, context) => {
    const seenRoles = new Set<string>();
    relatedSources.forEach((relatedSource, index) => {
      if (seenRoles.has(relatedSource.role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'role'],
          message: 'duplicate related source role',
        });
      }
      seenRoles.add(relatedSource.role);
    });
  });

// Optional per-request retrieval evidence for capabilities that assemble one
// bundle from several bounded remote reads (e.g. paginated ArcGIS REST calls).
// Additive since evidence schema 1.1.0; single-source capabilities omit it.
const RetrievalRequestSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    status: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    // Additive since evidence schema 1.2.0: POST-form dispatches record the
    // HTTP method and the canonical form-body hash. Bodies, query predicates,
    // and object-ID lists are never serialized into evidence.
    method: z.enum(['GET', 'POST']).optional(),
    request_sha256: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.method === 'POST' && request.request_sha256 === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request_sha256'],
        message: 'POST request evidence requires request_sha256',
      });
    }
    if (request.request_sha256 !== undefined && request.method !== 'POST') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method'],
        message: 'request_sha256 is only valid for POST request evidence',
      });
    }
  });

export const EvidenceBundleSchema = z
  .object({
    schema_version: SemverSchema,
    bundle_id: z.string().min(1),
    generated_at: IsoDateSchema,
    requests: z.array(RetrievalRequestSchema).optional(),
    source: EvidenceSourceSchema,
    related_sources: RelatedSourcesSchema.optional(),
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
          bytes: z.number().int().nonnegative().optional(),
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
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
