// Phase 1C native capability: deterministic, read-only ArcGIS Feature
// Service query. One approved anonymous/public HTTPS FeatureServer layer:
// layer metadata is inspected and validated first (queryability, an
// unambiguous object-ID field, requested fields against the metadata field
// list), object IDs are discovered with returnIdsOnly, canonicalized
// (sorted ascending, duplicates rejected) BEFORE the max_records ceiling
// selects the lowest survivors, and features are then retrieved in
// deterministic explicit object-ID POST batches. exceededTransferLimit
// splits the requested batch into deterministic halves; a singleton that
// still exceeds fails closed. Query dispatches are POST forms — the where
// predicate, object IDs, and field lists never appear in a URL — and
// evidence records the HTTP method plus a canonical request-body hash, never
// the body. Every remote value (metadata, attributes, geometry, warnings,
// error text) is untrusted data, redacted and bounded before serialization.
// Statistics, ordering, geometry filters, datum transformations,
// attachments, and related records are strictly rejected in this slice.

import { z } from 'zod';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema } from '../contracts/evidence.js';
import type { BoundaryOptions } from '../security/boundary.js';
import {
  ArcGisRequestFailure,
  containsCredentialMaterial,
  fetchArcGisTransport,
  redactSecrets,
  requestArcGisJson,
  type ArcGisRequestEvidence,
  type ArcGisRestTransport,
} from './arcgis-rest.js';

const CAPABILITY_VERSION = '1.0.0';

const DEFAULT_WHERE = '1=1';
const MAX_WHERE_CHARS = 2_048;
const MAX_OUT_FIELDS = 100;
const MAX_PAGE_SIZE = 2_000;
const DEFAULT_MAX_RECORDS = 1_000;
const MAX_RECORDS_CEILING = 10_000;
const DEFAULT_MAX_REQUESTS = 100;
const MAX_REQUESTS_CEILING = 200;
const MIN_RESPONSE_BYTES = 1_024;
const MAX_RESPONSE_BYTES_CEILING = 2_097_152;
const MAX_TOTAL_BYTES_CEILING = 16_777_216;
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS_CEILING = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Documented fallback when layer metadata reports no usable positive
// integer maxRecordCount: batches never exceed this bound.
const FALLBACK_MAX_RECORD_COUNT = 1_000;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FIELD_NAME_CHARS = 128;
// Exactly /FeatureServer/<layer-id> after at least one path segment; the
// segment charset excludes '=', ':', spaces, and '%' is rejected on the raw
// string, so no credential assignment can survive inside the path.
const FEATURE_LAYER_PATH = /^(?:\/[A-Za-z0-9_.-]+)+\/FeatureServer\/(0|[1-9][0-9]{0,5})$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CREDENTIAL_INPUT_KEY = /(?:token|api[_-]?key|password|secret|credential|authorization)/i;

/** A bare field name is credential-like when the shared reviewed
 * key-classification logic would treat `name=value` as credential material
 * (exact names like KEY/TOKEN, compound suffixes like ACCESS_KEY, and
 * camelCase compounds like accessToken). */
function isCredentialFieldName(name: string): boolean {
  return containsCredentialMaterial(`${name}=v`);
}

/** Validate a FeatureServer layer URL string; returns a problem or null. */
export function validateFeatureLayerUrl(raw: string): string | null {
  // Inspect the raw string before WHATWG URL normalization can silently
  // rewrite traversal segments, backslashes, or encoded characters.
  if (/\.\.|%|\\/.test(raw)) {
    return 'layer_url must not contain traversal, encoded, or backslash segments';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'layer_url must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'layer_url must use https';
  if (url.username || url.password) return 'layer_url must not embed credentials';
  if (url.search || url.hash) return 'layer_url must not contain a query string or fragment';
  if (!url.hostname) return 'layer_url must include a hostname';
  if (url.pathname.includes('//')) return 'layer_url path must not contain empty segments';
  if (!FEATURE_LAYER_PATH.test(url.pathname)) {
    return 'layer_url must end exactly in /FeatureServer/<layer-id>; MapServer, ImageServer, and service roots are not supported';
  }
  return null;
}

export const QueryFeatureServiceInputSchema = z
  .object({
    layer_url: z.string().min(1).max(2_048),
    where: z.string().min(1).max(MAX_WHERE_CHARS).optional(),
    out_fields: z
      .array(z.string().min(1).max(MAX_FIELD_NAME_CHARS).regex(FIELD_NAME))
      .min(1)
      .max(MAX_OUT_FIELDS),
    return_geometry: z.boolean().optional(),
    out_sr: z.number().int().positive().max(1_000_000_000).optional(),
    page_size: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
    max_records: z.number().int().positive().max(MAX_RECORDS_CEILING).optional(),
    max_requests: z.number().int().positive().max(MAX_REQUESTS_CEILING).optional(),
    max_response_bytes: z.number().int().min(MIN_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES_CEILING).optional(),
    max_total_response_bytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_BYTES)
      .max(MAX_TOTAL_BYTES_CEILING)
      .optional(),
    max_duration_ms: z.number().int().min(MIN_DURATION_MS).max(MAX_DURATION_MS_CEILING).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const problem = validateFeatureLayerUrl(input.layer_url);
    if (problem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['layer_url'], message: problem });
    }
    if (input.where !== undefined) {
      if (input.where.trim().length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['where'],
          message: 'where must contain a non-whitespace predicate',
        });
      }
      if (CONTROL_CHARS.test(input.where)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['where'],
          message: 'where must not contain control or NUL characters',
        });
      }
      if (containsCredentialMaterial(input.where)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['where'],
          message: 'where must not contain credential material',
        });
      }
    }
    const lowered = input.out_fields.map((field) => field.toLowerCase());
    if (new Set(lowered).size !== lowered.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['out_fields'],
        message: 'out_fields must be unique case-insensitively',
      });
    }
    for (const field of input.out_fields) {
      if (isCredentialFieldName(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['out_fields'],
          message: `requested field '${field}' has a credential-like name and is never queried`,
        });
      }
    }
    if (input.out_sr !== undefined && input.return_geometry !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['out_sr'],
        message: 'out_sr is accepted only when return_geometry is true',
      });
    }
    for (const key of Object.keys(input)) {
      if (CREDENTIAL_INPUT_KEY.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'credential-like input fields are never accepted',
        });
      }
    }
  });

const IsoDate = z.string().datetime({ offset: true });

const AttributeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const FeatureRecordSchema = z
  .object({
    object_id: z.number().int(),
    attributes: z.record(AttributeValueSchema),
    geometry: z.record(z.unknown()).nullable(),
  })
  .strict();

const FeatureQueryReportSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    service: z
      .object({
        url: z.string().url(),
        layer_id: z.number().int().nonnegative(),
        name: z.string().nullable(),
        type: z.enum(['Feature Layer', 'Table']),
        geometry_type: z.string().nullable(),
        object_id_field: z.string().min(1),
        source_spatial_reference: z.number().int().positive().nullable(),
        output_spatial_reference: z.number().int().positive().nullable(),
        max_record_count: z.number().int().positive(),
        requested_fields: z.array(z.string().min(1)).min(1),
        effective_fields: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    retrieved_at: IsoDate,
    parameters: z
      .object({
        where: z.string().min(1),
        return_geometry: z.boolean(),
        out_sr: z.number().int().positive().nullable(),
        page_size: z.number().int().positive(),
        max_records: z.number().int().positive(),
        max_requests: z.number().int().positive(),
        max_response_bytes: z.number().int().positive(),
        max_total_response_bytes: z.number().int().positive(),
        max_duration_ms: z.number().int().positive(),
      })
      .strict(),
    features: z.array(FeatureRecordSchema),
    totals: z
      .object({
        matched_object_ids: z.number().int().nonnegative(),
        selected_object_ids: z.number().int().nonnegative(),
        returned_records: z.number().int().nonnegative(),
        request_count: z.number().int().positive(),
        response_bytes: z.number().int().nonnegative(),
      })
      .strict(),
    truncation: z.object({ truncated: z.boolean(), reasons: z.array(z.string()) }).strict(),
    caveats: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export const QueryFeatureServiceOutputSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    report: FeatureQueryReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type QueryFeatureServiceInput = z.infer<typeof QueryFeatureServiceInputSchema>;
export type QueryFeatureServiceOutput = z.infer<typeof QueryFeatureServiceOutputSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const MAX_METADATA_CHARS = 300;

/** Untrusted metadata strings are redacted and length-capped before they can
 * reach output, evidence, warnings, or errors. */
function sanitizeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const redacted = redactSecrets(value);
  return redacted.length > MAX_METADATA_CHARS ? `${redacted.slice(0, MAX_METADATA_CHARS)}…` : redacted;
}

const MAX_SANITIZE_DEPTH = 32;
const MAX_SANITIZE_NODES = 10_000;

/** Recursively sanitize an untrusted JSON value (geometry payloads): every
 * string is redacted, credential-like object keys are removed entirely, and
 * depth/node bounds fail closed so hostile nesting cannot exhaust the run.
 * JSON.parse output contains only finite numbers and plain objects/arrays,
 * so the result stays canonical-JSON compatible. */
function sanitizeUntrustedJson(
  value: unknown,
  label: string,
  warn: (message: string) => void,
  state = { nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (depth > MAX_SANITIZE_DEPTH || state.nodes > MAX_SANITIZE_NODES) {
    throw new Error(`query_feature_service: ${label} exceeds the sanitizable structure limit`);
  }
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`query_feature_service: ${label} contains a non-finite number`);
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUntrustedJson(item, label, warn, state, depth + 1));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (isCredentialFieldName(key)) {
        warn(`${label}: a credential-like key was removed before serialization`);
        continue;
      }
      result[key] = sanitizeUntrustedJson(value[key], label, warn, state, depth + 1);
    }
    return result;
  }
  throw new Error(`query_feature_service: ${label} contains an unsupported value type`);
}

interface MetadataField {
  name: string;
  type: string;
  nullable: boolean;
}

interface LayerMetadataSummary {
  name: string | null;
  type: 'Feature Layer' | 'Table';
  geometryType: string | null;
  objectIdField: string;
  /** Canonical metadata fields keyed by lowercase name. */
  fields: Map<string, MetadataField>;
  maxRecordCount: number;
  sourceWkid: number | null;
}

function spatialReferenceWkid(spatialReference: unknown): number | null {
  if (!isPlainObject(spatialReference)) return null;
  const latest = spatialReference.latestWkid;
  if (typeof latest === 'number' && Number.isInteger(latest) && latest > 0) {
    return latest;
  }
  const wkid = spatialReference.wkid;
  if (typeof wkid === 'number' && Number.isInteger(wkid) && wkid > 0) {
    return wkid;
  }
  return null;
}

function metadataWkid(metadata: Record<string, unknown>): number | null {
  const candidates = [metadata.sourceSpatialReference, metadata.extent];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const holder = 'spatialReference' in candidate ? candidate.spatialReference : candidate;
    const wkid = spatialReferenceWkid(holder);
    if (wkid !== null) return wkid;
  }
  return null;
}

/** Validate the layer metadata response into a strict summary; every
 * violation fails closed with a redacted message. */
function validateLayerMetadata(
  metadata: Record<string, unknown>,
  layerId: number,
  warn: (message: string) => void,
): LayerMetadataSummary {
  if (typeof metadata.id === 'number') {
    if (metadata.id !== layerId) {
      throw new Error(
        `arcgis layer identity mismatch: requested layer ${layerId} but the service reported layer ${Math.trunc(metadata.id)}`,
      );
    }
  } else {
    warn('layer metadata did not echo the layer id');
  }
  const type = metadata.type;
  if (type !== 'Feature Layer' && type !== 'Table') {
    throw new Error('layer metadata type must be Feature Layer or Table; other layer types are not supported');
  }
  const capabilities = metadata.capabilities;
  if (typeof capabilities !== 'string') {
    throw new Error('layer metadata is missing the capabilities string');
  }
  const tokens = capabilities.split(',').map((token) => token.trim().toLowerCase());
  if (!tokens.includes('query')) {
    throw new Error('layer does not advertise the Query capability');
  }
  const rawFields = metadata.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new Error('layer metadata is missing a non-empty fields array');
  }
  const fields = new Map<string, MetadataField>();
  for (const entry of rawFields) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string') {
      throw new Error('layer metadata fields array contains a malformed field entry');
    }
    if (!FIELD_NAME.test(entry.name) || entry.name.length > MAX_FIELD_NAME_CHARS) {
      throw new Error('layer metadata fields array contains an unsupported field name');
    }
    const key = entry.name.toLowerCase();
    if (fields.has(key)) {
      throw new Error('layer metadata fields array contains case-insensitive duplicate field names');
    }
    if (isCredentialFieldName(entry.name)) {
      // Never queryable through this capability: requesting it fails as an
      // unknown field rather than returning likely secrets.
      warn('layer metadata: a field with a credential-like name was excluded from the queryable field set');
      continue;
    }
    fields.set(key, {
      name: entry.name,
      type: typeof entry.type === 'string' ? redactSecrets(entry.type).slice(0, MAX_METADATA_CHARS) : 'unknown',
      nullable: entry.nullable === true,
    });
  }
  let objectIdField: string;
  const declared = metadata.objectIdField;
  if (typeof declared === 'string' && declared.length > 0) {
    const match = fields.get(declared.toLowerCase());
    if (!match) {
      throw new Error('layer metadata objectIdField does not name a usable metadata field');
    }
    if (match.type !== 'esriFieldTypeOID') {
      throw new Error('layer metadata objectIdField does not have type esriFieldTypeOID');
    }
    objectIdField = match.name;
  } else {
    const oidFields = [...fields.values()].filter((field) => field.type === 'esriFieldTypeOID');
    if (oidFields.length !== 1) {
      throw new Error(
        `layer metadata must declare exactly one unambiguous object-ID field; found ${oidFields.length}`,
      );
    }
    objectIdField = oidFields[0].name;
  }
  let maxRecordCount = FALLBACK_MAX_RECORD_COUNT;
  const declaredMax = metadata.maxRecordCount;
  if (typeof declaredMax === 'number' && Number.isInteger(declaredMax) && declaredMax > 0) {
    maxRecordCount = declaredMax;
  } else {
    warn(
      `layer metadata reports no usable positive maxRecordCount; the documented fallback of ${FALLBACK_MAX_RECORD_COUNT} was applied`,
    );
  }
  const geometryType =
    typeof metadata.geometryType === 'string' && metadata.geometryType.length > 0
      ? redactSecrets(metadata.geometryType).slice(0, MAX_METADATA_CHARS)
      : null;
  return {
    name: sanitizeMetadataString(metadata.name),
    type,
    geometryType,
    objectIdField,
    fields,
    maxRecordCount,
    sourceWkid: metadataWkid(metadata),
  };
}

/** Validate the returnIdsOnly response into a canonical ascending ID list. */
function validateObjectIds(
  json: Record<string, unknown>,
  objectIdField: string,
): number[] {
  const exceededFlag = json.exceededTransferLimit;
  if (exceededFlag !== undefined && typeof exceededFlag !== 'boolean') {
    throw new Error('object-ID discovery returned a non-boolean exceededTransferLimit flag');
  }
  if (exceededFlag === true) {
    throw new Error(
      'object-ID discovery reported exceededTransferLimit; the matched ID set is incomplete and cannot be queried safely',
    );
  }
  const declaredName = json.objectIdFieldName;
  if (declaredName !== undefined && declaredName !== null) {
    if (typeof declaredName !== 'string' || declaredName.toLowerCase() !== objectIdField.toLowerCase()) {
      throw new Error('object-ID discovery reported a different object-ID field than the layer metadata');
    }
  }
  const raw = json.objectIds;
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('object-ID discovery response is missing the objectIds array');
  }
  const seen = new Set<number>();
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error('object-ID discovery returned a non-safe-integer object ID');
    }
    if (seen.has(value)) {
      throw new Error('object-ID discovery returned duplicate object IDs');
    }
    seen.add(value);
  }
  return [...seen].sort((a, b) => a - b);
}

interface CollectedFeature {
  attributes: Record<string, string | number | boolean | null>;
  geometry: Record<string, unknown> | null;
}

interface FeaturePage {
  exceeded: boolean;
  features: Map<number, CollectedFeature>;
  spatialReferenceWkid: number | null;
}

/** Strict identity/completeness validation of one feature page against the
 * exact requested object-ID batch. */
function validateFeaturePage(
  json: Record<string, unknown>,
  batch: readonly number[],
  effectiveFields: readonly string[],
  objectIdField: string,
  returnGeometry: boolean,
  warn: (message: string) => void,
): FeaturePage {
  const exceededFlag = json.exceededTransferLimit;
  if (exceededFlag !== undefined && typeof exceededFlag !== 'boolean') {
    throw new Error('feature query returned a non-boolean exceededTransferLimit flag');
  }
  const responseWkid = returnGeometry ? spatialReferenceWkid(json.spatialReference) : null;
  if (returnGeometry && responseWkid === null) {
    throw new Error('feature query with requested geometry did not report a valid spatialReference WKID');
  }
  if (exceededFlag === true) {
    return { exceeded: true, features: new Map(), spatialReferenceWkid: responseWkid };
  }
  const rawFeatures = json.features;
  if (!Array.isArray(rawFeatures)) {
    throw new Error('feature query response is missing the features array');
  }
  const requested = new Set(batch);
  const collected = new Map<number, CollectedFeature>();
  const fieldByLower = new Map(effectiveFields.map((field) => [field.toLowerCase(), field]));
  for (const rawFeature of rawFeatures) {
    if (!isPlainObject(rawFeature) || !isPlainObject(rawFeature.attributes)) {
      throw new Error('feature query returned a feature without an attributes object');
    }
    const attributes = rawFeature.attributes;
    const oidKeys = Object.keys(attributes).filter(
      (key) => key.toLowerCase() === objectIdField.toLowerCase(),
    );
    if (oidKeys.length !== 1) {
      throw new Error(
        `feature query returned a feature with ${oidKeys.length} object-ID attributes; exactly one is required`,
      );
    }
    const oid = attributes[oidKeys[0]];
    if (typeof oid !== 'number' || !Number.isSafeInteger(oid)) {
      throw new Error('feature query returned a feature with a non-safe-integer object ID');
    }
    if (!requested.has(oid)) {
      throw new Error('feature query returned an object ID that was not requested in the batch');
    }
    if (collected.has(oid)) {
      throw new Error('feature query returned duplicate object IDs within a batch');
    }
    const canonicalAttributes: Record<string, string | number | boolean | null> = {};
    const matchedKeys = new Map<string, string>();
    for (const key of Object.keys(attributes)) {
      const canonical = fieldByLower.get(key.toLowerCase());
      if (canonical === undefined) {
        warn('feature attributes outside the effective field list were discarded');
        continue;
      }
      if (matchedKeys.has(canonical)) {
        throw new Error('feature query returned attributes with case-colliding keys for one field');
      }
      matchedKeys.set(canonical, key);
    }
    for (const field of effectiveFields) {
      const sourceKey = matchedKeys.get(field);
      if (sourceKey === undefined) {
        warn(`feature attributes missing requested field '${field}' were reported as null`);
        canonicalAttributes[field] = null;
        continue;
      }
      const value = attributes[sourceKey];
      if (value === null || typeof value === 'boolean') {
        canonicalAttributes[field] = value;
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`feature attribute '${field}' contains a non-finite number`);
        }
        canonicalAttributes[field] = value;
      } else if (typeof value === 'string') {
        canonicalAttributes[field] = redactSecrets(value);
      } else {
        throw new Error(`feature attribute '${field}' is not a supported primitive value`);
      }
    }
    let geometry: Record<string, unknown> | null = null;
    if (returnGeometry) {
      const rawGeometry = rawFeature.geometry;
      if (rawGeometry !== undefined && rawGeometry !== null) {
        if (!isPlainObject(rawGeometry)) {
          throw new Error('feature query returned a non-object geometry value');
        }
        geometry = sanitizeUntrustedJson(rawGeometry, 'feature geometry', warn) as Record<string, unknown>;
      } else {
        warn('a feature with requested geometry returned no geometry and was reported with geometry null');
      }
    } else if (rawFeature.geometry !== undefined) {
      warn('unrequested geometry in the feature response was discarded');
    }
    collected.set(oid, { attributes: canonicalAttributes, geometry });
  }
  for (const oid of batch) {
    if (!collected.has(oid)) {
      throw new Error(
        'feature query omitted requested object IDs without reporting exceededTransferLimit; the response is incomplete',
      );
    }
  }
  return { exceeded: false, features: collected, spatialReferenceWkid: responseWkid };
}

interface QueryBudget {
  deadline: number;
  bytesUsed: number;
  requestCount: number;
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxDurationMs: number;
}

function requestTimeoutMs(budget: QueryBudget): number {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`query_feature_service exceeded the ${budget.maxDurationMs}ms duration ceiling`);
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function requestMaxBytes(budget: QueryBudget): number {
  const remaining = budget.maxTotalBytes - budget.bytesUsed;
  if (remaining <= 0) {
    throw new Error(
      `query_feature_service exceeded the ${budget.maxTotalBytes}-byte total response ceiling`,
    );
  }
  return Math.min(budget.maxResponseBytes, remaining);
}

async function executeQueryFeatureService(
  input: QueryFeatureServiceInput,
  context: CapabilityExecutionContext,
): Promise<QueryFeatureServiceOutput> {
  if (context.signal?.aborted) throw new Error('query_feature_service cancelled before retrieval');
  const now = context.now ?? (() => new Date());
  const retrievedAt = now().toISOString();

  const layerUrlObject = new URL(input.layer_url);
  const layerUrl = `${layerUrlObject.origin}${layerUrlObject.pathname}`;
  const layerId = Number(layerUrlObject.pathname.split('/').at(-1));
  const where = input.where ?? DEFAULT_WHERE;
  const returnGeometry = input.return_geometry ?? false;
  const maxRecords = input.max_records ?? DEFAULT_MAX_RECORDS;
  const budget: QueryBudget = {
    deadline: Date.now() + (input.max_duration_ms ?? MAX_DURATION_MS_CEILING),
    bytesUsed: 0,
    requestCount: 0,
    maxRequests: input.max_requests ?? DEFAULT_MAX_REQUESTS,
    maxResponseBytes: input.max_response_bytes ?? MAX_RESPONSE_BYTES_CEILING,
    maxTotalBytes: input.max_total_response_bytes ?? MAX_TOTAL_BYTES_CEILING,
    maxDurationMs: input.max_duration_ms ?? MAX_DURATION_MS_CEILING,
  };

  const transport = (context.io?.arcgisTransport as ArcGisRestTransport | undefined) ?? fetchArcGisTransport;
  const boundary: BoundaryOptions = context.boundary ?? {};

  const warnings = new Set<string>();
  const truncationReasons = new Set<string>();
  const requests: ArcGisRequestEvidence[] = [];
  const warn = (message: string): void => {
    warnings.add(message);
  };

  const dispatch = async (name: string, url: URL, form?: Record<string, string>) => {
    if (budget.requestCount >= budget.maxRequests) {
      throw new Error(
        `query_feature_service exceeded the ${budget.maxRequests}-request ceiling before completing the query`,
      );
    }
    budget.requestCount += 1; // every dispatched attempt counts
    try {
      const result = await requestArcGisJson({
        name,
        url,
        transport,
        boundary,
        timeoutMs: requestTimeoutMs(budget),
        maxBytes: requestMaxBytes(budget),
        signal: context.signal,
        ...(form === undefined ? {} : { form }),
      });
      budget.bytesUsed += result.evidence.bytes;
      requests.push(result.evidence);
      return result;
    } catch (error) {
      if (error instanceof ArcGisRequestFailure) {
        // A response WAS received: its bytes count against the total ceiling
        // and its sanitized evidence is recorded before the run fails closed.
        budget.bytesUsed += error.evidence.bytes;
        requests.push(error.evidence);
      }
      throw error;
    }
  };

  // 1. Layer metadata: bounded GET on the exact approved layer URL.
  const metadataUrl = new URL(layerUrl);
  metadataUrl.searchParams.set('f', 'json');
  const metadataResult = await dispatch('layer_metadata', metadataUrl);
  const metadata = validateLayerMetadata(metadataResult.json, layerId, warn);

  if (returnGeometry && metadata.geometryType === null) {
    throw new Error('return_geometry was requested but the layer reports no geometry type');
  }

  // Requested fields resolve case-insensitively to canonical metadata names.
  const requestedFields: string[] = [];
  for (const field of input.out_fields) {
    const match = metadata.fields.get(field.toLowerCase());
    if (!match) {
      throw new Error(`requested field '${field}' does not exist on the layer or is not queryable`);
    }
    requestedFields.push(match.name);
  }
  requestedFields.sort();
  const effectiveFields = [
    metadata.objectIdField,
    ...requestedFields.filter((field) => field !== metadata.objectIdField),
  ];
  const pageSize = Math.min(input.page_size ?? metadata.maxRecordCount, metadata.maxRecordCount, MAX_PAGE_SIZE);

  // The query endpoint is derived ONLY by appending /query to the validated
  // layer URL; no remote-returned URL is ever dispatched.
  const queryUrl = new URL(`${layerUrl}/query`);

  // 2. Object-ID discovery: POST form, canonical IDs before any ceiling.
  const idsResult = await dispatch('query_ids', queryUrl, {
    f: 'json',
    where,
    returnIdsOnly: 'true',
    returnGeometry: 'false',
  });
  const matchedIds = validateObjectIds(idsResult.json, metadata.objectIdField);
  const selectedIds = matchedIds.slice(0, maxRecords);
  if (selectedIds.length < matchedIds.length) {
    truncationReasons.add(
      `record ceiling: ${matchedIds.length} object IDs matched but only the ${selectedIds.length} lowest were selected (max_records ${maxRecords})`,
    );
  }

  // 3. Deterministic object-ID batches with bounded adaptive splitting.
  const collected = new Map<number, CollectedFeature>();
  const expectedOutputWkid = returnGeometry ? (input.out_sr ?? metadata.sourceWkid) : null;
  let verifiedOutputWkid: number | null = null;
  const pending: number[][] = [];
  for (let start = 0; start < selectedIds.length; start += pageSize) {
    pending.push(selectedIds.slice(start, start + pageSize));
  }
  let attempt = 0;
  while (pending.length > 0) {
    if (context.signal?.aborted) throw new Error('query_feature_service cancelled during retrieval');
    const batch = pending.shift()!;
    attempt += 1;
    const form: Record<string, string> = {
      f: 'json',
      objectIds: batch.join(','),
      outFields: effectiveFields.join(','),
      returnGeometry: returnGeometry ? 'true' : 'false',
    };
    if (input.out_sr !== undefined) form.outSR = String(input.out_sr);
    const pageResult = await dispatch(`query_features:${attempt}`, queryUrl, form);
    const page = validateFeaturePage(
      pageResult.json,
      batch,
      effectiveFields,
      metadata.objectIdField,
      returnGeometry,
      warn,
    );
    if (returnGeometry) {
      const responseWkid = page.spatialReferenceWkid!;
      if (expectedOutputWkid !== null && responseWkid !== expectedOutputWkid) {
        throw new Error(
          `feature query spatialReference WKID ${responseWkid} did not match expected output WKID ${expectedOutputWkid}`,
        );
      }
      if (verifiedOutputWkid !== null && responseWkid !== verifiedOutputWkid) {
        throw new Error(
          `feature query pages reported inconsistent spatialReference WKIDs ${verifiedOutputWkid} and ${responseWkid}`,
        );
      }
      verifiedOutputWkid = responseWkid;
    }
    if (page.exceeded) {
      if (batch.length === 1) {
        throw new Error(
          'feature query reported exceededTransferLimit for a single object ID; the layer cannot be paged safely',
        );
      }
      const half = Math.ceil(batch.length / 2);
      // Splits re-enter at the FRONT so retrieval stays in ascending ID order.
      pending.unshift(batch.slice(0, half), batch.slice(half));
      warn('a feature page reported exceededTransferLimit and was split into deterministic halves');
      continue;
    }
    for (const [oid, feature] of page.features) {
      if (collected.has(oid)) {
        throw new Error('feature query returned duplicate object IDs across batches');
      }
      collected.set(oid, feature);
    }
  }
  if (collected.size !== selectedIds.length) {
    throw new Error(
      `feature retrieval is incomplete: ${selectedIds.length} object IDs were selected but ${collected.size} records were returned`,
    );
  }

  // 4. Canonical output: features sorted by object ID.
  const features = selectedIds.map((oid) => {
    const record = collected.get(oid)!;
    return { object_id: oid, attributes: record.attributes, geometry: record.geometry };
  });

  const outputWkid = returnGeometry
    ? (verifiedOutputWkid ?? expectedOutputWkid)
    : null;
  const sortedWarnings = [...warnings].sort();
  const sortedTruncationReasons = [...truncationReasons].sort();
  const truncated = sortedTruncationReasons.length > 0;

  const caveats = [
    'The query ran with anonymous/public visibility only; records not visible to that identity are absent, and this is not proof of a complete result set.',
    'Only explicit attribute queries with optional geometry are supported in this slice; statistics, group-by, order-by, geometry filters, datum transformations, attachments, and related records are rejected by the input schema.',
  ];
  if (truncated) {
    caveats.push('The max_records ceiling bound the result; the report reflects the selected lowest object IDs only.');
  }

  const report = FeatureQueryReportSchema.parse({
    schema_version: CAPABILITY_VERSION,
    service: {
      url: layerUrl,
      layer_id: layerId,
      name: metadata.name,
      type: metadata.type,
      geometry_type: metadata.geometryType,
      object_id_field: metadata.objectIdField,
      source_spatial_reference: metadata.sourceWkid,
      output_spatial_reference: outputWkid,
      max_record_count: metadata.maxRecordCount,
      requested_fields: requestedFields,
      effective_fields: effectiveFields,
    },
    retrieved_at: retrievedAt,
    parameters: {
      where,
      return_geometry: returnGeometry,
      out_sr: input.out_sr ?? null,
      page_size: pageSize,
      max_records: maxRecords,
      max_requests: budget.maxRequests,
      max_response_bytes: budget.maxResponseBytes,
      max_total_response_bytes: budget.maxTotalBytes,
      max_duration_ms: budget.maxDurationMs,
    },
    features,
    totals: {
      matched_object_ids: matchedIds.length,
      selected_object_ids: selectedIds.length,
      returned_records: features.length,
      request_count: budget.requestCount,
      response_bytes: budget.bytesUsed,
    },
    truncation: { truncated, reasons: sortedTruncationReasons },
    caveats,
    warnings: sortedWarnings,
  });

  // The where predicate is deliberately part of canonical parameter
  // evidence: it is operator input, not remote data, and reproducibility
  // requires it. It never appears in a request URL.
  const canonicalParameters = {
    layer_url: layerUrl,
    where,
    out_fields: requestedFields,
    return_geometry: returnGeometry,
    out_sr: input.out_sr ?? null,
    page_size: pageSize,
    max_records: maxRecords,
    max_requests: budget.maxRequests,
    max_response_bytes: budget.maxResponseBytes,
    max_total_response_bytes: budget.maxTotalBytes,
    max_duration_ms: budget.maxDurationMs,
  };
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.2.0',
    bundle_id: `query_feature_service:${requests[0].sha256.slice(0, 16)}`,
    generated_at: retrievedAt,
    requests,
    source: {
      uri: requests[0].url,
      identity: { kind: 'arcgis_feature_layer', value: layerUrl },
      version: {},
      retrieved_at: retrievedAt,
      sha256: requests[0].sha256,
    },
    gis_metadata: {
      format: 'ArcGIS FeatureServer REST JSON',
      crs: outputWkid === null ? null : `WKID:${outputWkid}`,
      axis_order: null,
      units: null,
      extent: null,
      schema: effectiveFields.map((field) => {
        const meta = metadata.fields.get(field.toLowerCase())!;
        return { name: meta.name, types: [meta.type], nullable: meta.nullable };
      }),
      row_count: features.length,
      geometry_types: returnGeometry && metadata.geometryType !== null ? [metadata.geometryType] : [],
      temporal_fields: [],
    },
    parameters: {
      canonical_json: canonicalJson(canonicalParameters),
      sha256: sha256Canonical(canonicalParameters),
    },
    execution: {
      capability: 'query_feature_service',
      capability_version: CAPABILITY_VERSION,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'arcgis_feature_query',
        sha256: sha256Canonical(report),
        validation: {
          valid: true,
          checks: [
            'input_schema',
            'boundary_preflight',
            'layer_metadata_validation',
            'canonical_object_id_paging',
            'response_identity_checks',
            'query_ceilings',
            'output_schema',
          ],
          warnings: sortedWarnings,
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });

  return QueryFeatureServiceOutputSchema.parse({
    schema_version: CAPABILITY_VERSION,
    report,
    evidence,
  });
}

export const queryFeatureServiceCapability: CapabilityDefinition<
  QueryFeatureServiceInput,
  QueryFeatureServiceOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'query_feature_service',
    name: 'Query Feature Service layer',
    description:
      'Read-only deterministic attribute (and optional geometry) query against one approved anonymous/public ArcGIS FeatureServer layer: metadata-validated explicit fields, canonical object-ID discovery and batch paging with bounded exceededTransferLimit splitting, strict identity/completeness checks, honest truncation, and POST-form evidence hashes with no query values in URLs.',
    version: CAPABILITY_VERSION,
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: ['*.maps.arcgis.com', '*.arcgis.com'],
    allowed_sources: ['arcgis_feature_service'],
    resource_limits: {
      max_records: MAX_RECORDS_CEILING,
      max_bytes: MAX_TOTAL_BYTES_CEILING,
      max_duration_ms: MAX_DURATION_MS_CEILING,
      max_cost_usd: 0,
    },
    idempotency: {
      mode: 'deterministic',
      key_fields: [
        'layer_url',
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
    dry_run: { supported: false, reason: 'Read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_each_request' },
    artifacts: [{ name: 'arcgis_feature_query', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: {
      suite: 'gisbench',
      version: '0.1.0',
      supported_gis_versions: ['ArcGIS Online Feature Service REST', 'ArcGIS Enterprise Feature Service REST 10.9+'],
    },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: QueryFeatureServiceInputSchema,
  outputSchema: QueryFeatureServiceOutputSchema,
  inputSummary: [
    'layer_url*',
    'out_fields*',
    'where',
    'return_geometry',
    'out_sr',
    'page_size',
    'max_records',
    'max_requests',
    'max_response_bytes',
    'max_total_response_bytes',
    'max_duration_ms',
  ],
  boundaryFields: ['layer_url'],
  execute: executeQueryFeatureService,
};
