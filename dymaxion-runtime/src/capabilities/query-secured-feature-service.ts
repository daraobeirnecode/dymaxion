import { z } from 'zod';
import type { CapabilityDefinition, CapabilityExecutionContext } from '../contracts/capability.js';
import { CapabilityManifestSchema } from '../contracts/capability.js';
import { consumeApprovalExecutionGrant } from '../security/approval.js';
import { containsCredentialMaterial } from './arcgis-rest.js';
import { sha256Canonical } from '../contracts/canonical.js';
import {
  resolveArcGisReadConnection,
  resolveArcGisTokenBroker,
  validateBearerAuthorization,
  type ResolvedArcGisReadConnection,
} from '../security/arcgis-connections.js';
import {
  executeFeatureServiceQuery,
  QueryFeatureServiceInputSchema,
  QueryFeatureServiceOutputSchema,
  type QueryFeatureServiceInput,
  type QueryFeatureServiceOutput,
} from './query-feature-service.js';

const CAPABILITY_VERSION = '1.0.0';
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;

export const QuerySecuredFeatureServiceInputSchema = z
  .object({
    target_slug: z.string().regex(IDENTIFIER),
    credential_alias: z.string().regex(IDENTIFIER),
    where: z.string().min(1).max(1_024).optional(),
    out_fields: z.array(z.string().min(1).max(128)).min(1).max(64),
    return_geometry: z.boolean().optional(),
    out_sr: z.number().int().positive().max(999_999).optional(),
    page_size: z.number().int().positive().max(2_000).optional(),
    max_records: z.number().int().positive().max(10_000).optional(),
    max_requests: z.number().int().positive().max(100).optional(),
    max_response_bytes: z.number().int().positive().max(10_000_000).optional(),
    max_total_response_bytes: z.number().int().positive().max(50_000_000).optional(),
    max_duration_ms: z.number().int().positive().max(120_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const values = [input.where, ...input.out_fields].filter(
      (value): value is string => value !== undefined,
    );
    if (values.some((value) => containsCredentialMaterial(value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query input must not contain credential material',
      });
    }
  });

const SecuredAccessSchema = z
  .object({
    target_slug: z.string().regex(IDENTIFIER),
    portal_kind: z.enum(['arcgis-online', 'arcgis-enterprise']),
    permission: z.literal('feature:query'),
  })
  .strict();

export const QuerySecuredFeatureServiceOutputSchema = QueryFeatureServiceOutputSchema.extend({
  access: SecuredAccessSchema,
}).strict();

export type QuerySecuredFeatureServiceInput = z.infer<
  typeof QuerySecuredFeatureServiceInputSchema
>;
export type QuerySecuredFeatureServiceOutput = z.infer<
  typeof QuerySecuredFeatureServiceOutputSchema
>;

function asPublicQueryInput(
  input: QuerySecuredFeatureServiceInput,
  connection: ResolvedArcGisReadConnection,
): QueryFeatureServiceInput {
  return QueryFeatureServiceInputSchema.parse({
    layer_url: connection.target.layer_url,
    where: input.where,
    out_fields: input.out_fields,
    return_geometry: input.return_geometry,
    ...(input.out_sr === undefined ? {} : { out_sr: input.out_sr }),
    page_size: input.page_size,
    max_records: input.max_records,
    max_requests: input.max_requests,
    max_response_bytes: input.max_response_bytes,
    max_total_response_bytes: input.max_total_response_bytes,
    max_duration_ms: input.max_duration_ms,
  });
}

function targetConfigDigest(connection: ResolvedArcGisReadConnection): string {
  return sha256Canonical({
    target_slug: connection.target.target_slug,
    portal_kind: connection.target.portal_kind,
    portal_root: connection.target.portal_root,
    service_root: connection.target.service_root,
    layer_url: connection.target.layer_url,
    allowed_credential_aliases: connection.target.allowed_credential_aliases,
    allowed_operations: connection.target.allowed_operations,
  });
}

function approvalTarget(connection: ResolvedArcGisReadConnection): string {
  return [
    `arcgis-target:${connection.target.target_slug}`,
    `config-sha256:${targetConfigDigest(connection)}`,
    'operation:feature-query',
  ].join('|');
}

function sanitizedAuthenticatedQueryError(
  error: unknown,
  connection: ResolvedArcGisReadConnection,
  authorization: string,
): Error {
  const logicalTarget = `arcgis-target://${connection.target.target_slug}`;
  let message = error instanceof Error ? error.message : 'authenticated ArcGIS query failed';
  const configuredUrls = [
    connection.target.portal_root,
    connection.target.service_root,
    connection.target.layer_url,
  ];
  const targetForms = configuredUrls.flatMap((raw) => {
    try {
      const parsed = new URL(raw);
      return [raw, `${parsed.host}${parsed.pathname}`, parsed.hostname];
    } catch {
      return [raw];
    }
  });
  for (const sensitive of [
    authorization,
    authorization.slice(7),
    connection.credential.credential_identity,
    ...targetForms,
  ]) {
    if (sensitive) message = message.split(sensitive).join(logicalTarget);
  }
  message = message.replace(/[\r\n\u0000]+/g, ' ').slice(0, 512);
  if (containsCredentialMaterial(message)) {
    return new Error('authenticated ArcGIS query failed');
  }
  return new Error(message || 'authenticated ArcGIS query failed');
}

function assertNoConnectionMaterial(
  output: QuerySecuredFeatureServiceOutput,
  connection: ResolvedArcGisReadConnection,
  authorization: string,
): void {
  const serialized = JSON.stringify(output);
  const configuredHosts = [
    connection.target.portal_root,
    connection.target.service_root,
    connection.target.layer_url,
  ].flatMap((raw) => {
    try {
      return [new URL(raw).hostname];
    } catch {
      return [];
    }
  });
  for (const sensitive of [
    authorization,
    authorization.slice(7),
    connection.credential.credential_identity,
    connection.target.portal_root,
    connection.target.service_root,
    connection.target.layer_url,
    ...configuredHosts,
  ]) {
    if (sensitive && serialized.includes(sensitive)) {
      throw new Error('authenticated ArcGIS response contained sensitive connection material');
    }
  }
}

async function preflight(
  input: QuerySecuredFeatureServiceInput,
  context: CapabilityExecutionContext,
): Promise<void> {
  const connection = await resolveArcGisReadConnection(
    input.target_slug,
    input.credential_alias,
    context,
  );
  asPublicQueryInput(input, connection);
}

async function execute(
  input: QuerySecuredFeatureServiceInput,
  context: CapabilityExecutionContext,
): Promise<QuerySecuredFeatureServiceOutput> {
  const before = await resolveArcGisReadConnection(
    input.target_slug,
    input.credential_alias,
    context,
  );
  const bindingTarget = approvalTarget(before);
  consumeApprovalExecutionGrant(context.approvalExecutionGrant, {
    agentRunId: context.agentRunId ?? '',
    skill: 'query_secured_feature_service',
    payload: input,
    credentialIdentity: before.credential.credential_identity,
    target: bindingTarget,
  });

  // Re-resolve after one-shot consumption. Configuration or identity drift fails
  // before any credential material is requested from the broker.
  const after = await resolveArcGisReadConnection(
    input.target_slug,
    input.credential_alias,
    context,
  );
  if (
    approvalTarget(after) !== bindingTarget ||
    after.credential.credential_identity !== before.credential.credential_identity
  ) {
    throw new Error('ArcGIS target or credential identity changed after approval consumption');
  }

  let authorization: string;
  try {
    authorization = validateBearerAuthorization(
      await resolveArcGisTokenBroker(context).getAuthorization(
        input.credential_alias,
        input.target_slug,
      ),
    );
  } catch {
    throw new Error('ArcGIS authorization materialization failed');
  }
  const query = asPublicQueryInput(input, after);
  const logicalTargetUri = `arcgis-target://${after.target.target_slug}`;
  let output: QueryFeatureServiceOutput;
  try {
    output = await executeFeatureServiceQuery(query, context, {
      capabilitySlug: 'query_secured_feature_service',
      capabilityVersion: CAPABILITY_VERSION,
      visibilityCaveat:
        'The query ran with one approved authenticated identity through a trusted ArcGIS connection. Results reflect only records visible to that identity and are not proof of a complete service-wide result set.',
      authorization,
      evidenceTargetUri: logicalTargetUri,
      auditTargetUri: logicalTargetUri,
      canonicalContext: {
        target_slug: after.target.target_slug,
        portal_kind: after.target.portal_kind,
        target_config_sha256: targetConfigDigest(after),
      },
    });
  } catch (error) {
    throw sanitizedAuthenticatedQueryError(error, after, authorization);
  }

  const securedOutput = QuerySecuredFeatureServiceOutputSchema.parse({
    ...output,
    access: {
      target_slug: after.target.target_slug,
      portal_kind: after.target.portal_kind,
      permission: 'feature:query',
    },
  });
  assertNoConnectionMaterial(securedOutput, after, authorization);
  return securedOutput;
}

export const querySecuredFeatureServiceCapability: CapabilityDefinition<
  QuerySecuredFeatureServiceInput,
  QuerySecuredFeatureServiceOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'query_secured_feature_service',
    name: 'Query secured Feature Service layer',
    description:
      'Approval-gated deterministic query against one exact configured ArcGIS Online or ArcGIS Enterprise FeatureServer layer using a trusted credential alias. URLs and tokens are never accepted from capability input; authenticated artifacts expose only a logical target identity.',
    version: CAPABILITY_VERSION,
    classification: 'read',
    identity: { required: true, permissions: ['feature:query'] },
    allowed_hosts: [],
    allowed_sources: ['configured_arcgis_target_registry'],
    resource_limits: {
      max_records: 10_000,
      max_bytes: 50_000_000,
      max_duration_ms: 120_000,
      max_cost_usd: 0,
    },
    idempotency: {
      mode: 'deterministic',
      key_fields: [
        'target_slug',
        'credential_alias',
        'where',
        'out_fields',
        'return_geometry',
        'out_sr',
        'page_size',
        'max_records',
        'max_requests',
        'max_response_bytes',
        'max_total_response_bytes',
        'max_duration_ms',
      ],
    },
    dry_run: { supported: false, reason: 'Authenticated read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_each_request' },
    artifacts: [{ name: 'arcgis_feature_query', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: {
      suite: 'gisbench',
      version: '0.1.0',
      supported_gis_versions: [
        'ArcGIS Online Feature Service REST',
        'ArcGIS Enterprise Feature Service REST 10.9+',
      ],
    },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: QuerySecuredFeatureServiceInputSchema,
  outputSchema: QuerySecuredFeatureServiceOutputSchema,
  requiresApproval: () => true,
  resolveApprovalBinding: async (input, context) => {
    const connection = await resolveArcGisReadConnection(
      input.target_slug,
      input.credential_alias,
      context,
    );
    return {
      target: approvalTarget(connection),
      credentialIdentity: connection.credential.credential_identity,
    };
  },
  inputSummary: [
    'target_slug',
    'credential_alias',
    'where',
    'out_fields',
    'return_geometry',
    'out_sr',
    'page_size',
    'max_records',
    'max_requests',
    'max_response_bytes',
    'max_total_response_bytes',
    'max_duration_ms',
  ],
  boundaryFields: [],
  preflight,
  execute,
};
