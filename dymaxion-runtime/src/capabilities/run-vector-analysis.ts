// Phase 1F deterministic nearest-point vector analysis. Read-only local
// RFC 7946 CRS84 GeoJSON Point FeatureCollections only; no network and no
// persistent artifact writes. Produces a bounded canonical inline GeoJSON
// artifact with reproducible report and evidence.

import { extname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { containsCredentialMaterial } from './arcgis-rest.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema, GisMetadataSchema, type GisMetadata } from '../contracts/evidence.js';
import { assertPathAllowed, canonicalBoundaryPath } from '../security/boundary.js';

export const MAX_SOURCE_BYTES = 1_048_576;
export const MAX_COMBINED_SOURCE_BYTES = 2_097_152;
export const MAX_PRIMARY_FEATURES = 1_000;
export const MAX_CANDIDATE_FEATURES = 1_000;
export const MAX_PAIR_EVALUATIONS = 250_000;
export const MAX_OUTPUT_BYTES = 2_097_152;
export const MAX_DURATION_MS = 5_000;
export const MAX_COORDINATE_POSITIONS = 2_000;
export const MAX_COORDINATE_ORDINATES = MAX_COORDINATE_POSITIONS * 4;
export const AUTHALIC_RADIUS_METERS = 6_371_008.8;
// Maximum possible spherical great-circle distance under the fixed authalic
// radius used by this capability. max_distance_meters must be > 0 and <= this.
export const MAX_DISTANCE_METERS = Math.PI * AUTHALIC_RADIUS_METERS;

const MAX_SOURCE_URI_CHARS = 4_096;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 20_000;
const CHECKPOINT_INTERVAL = 64;
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const URL_AUTHORITY_FORM = /:\/\//;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/](?![\\/])/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const SHA256_RE = /^[a-f0-9]{64}$/;

type Role = 'primary' | 'candidate';

interface FileStat {
  size: number;
}

interface VectorIo {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
}

interface PointRecord {
  index: number;
  id?: string | number;
  lon: number;
  lat: number;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown> | null;
}

interface ParsedCollection {
  records: PointRecord[];
  featureCount: number;
  coordinatePositions: number;
  ordinateCount: number;
}

interface SourceRead {
  role: Role;
  path: string;
  uri: string;
  bytes: Uint8Array;
  text: string;
  sha256: string;
  byteLength: number;
  parsed: unknown;
  collection: ParsedCollection;
}

interface SourceStat {
  role: Role;
  path: string;
  uri: string;
  statSize: number;
}

interface SourceBytes extends SourceStat {
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SourceUriSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_URI_CHARS)
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: 'source path must not contain control characters',
  })
  .refine((value) => !URL_AUTHORITY_FORM.test(value), {
    message: 'source path must be a raw local filesystem path without URL authority syntax',
  })
  .refine((value) => WINDOWS_ABSOLUTE_PATH.test(value) || !URI_SCHEME_PREFIX.test(value), {
    message: 'source path must be a raw local filesystem path; URI/URL schemes are not accepted',
  })
  .refine((value) => !value.startsWith('//') && !value.startsWith('\\\\'), {
    message: 'source path must be a raw local filesystem path without URL authority syntax',
  })
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message: 'source path must not contain URL query or fragment delimiters',
  })
  .refine((value) => !value.includes('%'), {
    message: 'source path must use a raw local filesystem path without percent escapes',
  })
  .refine((value) => value.toLowerCase().endsWith('.geojson'), {
    message: 'unsupported dataset format: source path must be a bounded local .geojson filesystem path',
  })
  .refine((value) => !containsCredentialMaterial(value), {
    message: 'source path must not contain credential-shaped path text',
  })
  .transform((value) =>
    value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || WINDOWS_ABSOLUTE_PATH.test(value)
      ? value
      : `./${value}`,
  );

export const RunVectorAnalysisInputSchema = z
  .object({
    source_uri: SourceUriSchema,
    candidate_source_uri: SourceUriSchema,
    operation: z.literal('nearest_point').optional().default('nearest_point'),
    max_distance_meters: z
      .number()
      .finite()
      .positive()
      .max(MAX_DISTANCE_METERS)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (resolve(input.source_uri) === resolve(input.candidate_source_uri)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate_source_uri'],
        message: 'candidate_source_uri must be distinct from source_uri',
      });
    }
  });

const CountSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(SHA256_RE);
const SourceReportSchema = z
  .object({
    kind: z.literal('local-file'),
    role: z.enum(['primary_features', 'candidate_features']),
    source_uri: z.string().min(1),
    source_handle: z.string().min(1),
    source_attribution: z.string().min(1),
    sha256: Sha256Schema,
    bytes: CountSchema,
    row_count: CountSchema,
  })
  .strict();

const VectorReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    generated_at: z.string().datetime({ offset: true }),
    operation: z.literal('nearest_point'),
    source: SourceReportSchema.extend({ role: z.literal('primary_features') }).strict(),
    candidate: SourceReportSchema.extend({ role: z.literal('candidate_features') }).strict(),
    algorithm: z
      .object({
        name: z.literal('haversine_spherical_great_circle'),
        authalic_radius_meters: z.literal(AUTHALIC_RADIUS_METERS),
        distance_units: z.literal('meters'),
        rounding: z.literal('nearest millimetre'),
        tie_break: z.literal('rounded distance then candidate source index'),
        longitude_delta: z.literal('normalized across antimeridian to [-180,180]'),
      })
      .strict(),
    max_distance_meters: z.number().positive().nullable(),
    counts: z
      .object({
        input_features: CountSchema,
        candidate_features: CountSchema,
        output_features: CountSchema,
        matched: CountSchema,
        unmatched: CountSchema,
        pair_evaluations: CountSchema,
        primary_coordinate_positions: CountSchema,
        candidate_coordinate_positions: CountSchema,
        total_coordinate_positions: CountSchema,
        primary_ordinates: CountSchema,
        candidate_ordinates: CountSchema,
        total_ordinates: CountSchema,
      })
      .strict(),
    crs: z
      .object({
        effective: z.literal('OGC:CRS84'),
        axis_order: z.literal('longitude,latitude'),
        units: z.literal('degrees'),
      })
      .strict(),
    output: z
      .object({
        format: z.literal('geojson'),
        media_type: z.literal('application/geo+json; charset=utf-8'),
        bytes: CountSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    qa: z
      .object({
        checks: z.array(z.string().min(1)),
        warnings: z.array(z.string()),
        limitations: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

type VectorAlgorithmReport = z.infer<typeof VectorReportSchema>['algorithm'];

interface CanonicalParameterInput {
  operation: 'nearest_point';
  algorithm: VectorAlgorithmReport;
  maxDistanceMeters: number | null;
  sourceUri: string;
  sourceSha256: string;
  candidateSourceUri: string;
  candidateSha256: string;
}

export function buildCanonicalParameters(input: CanonicalParameterInput): Record<string, unknown> {
  return {
    algorithm: input.algorithm.name,
    authalic_radius_meters: input.algorithm.authalic_radius_meters,
    candidate_sha256: input.candidateSha256,
    candidate_source_uri: input.candidateSourceUri,
    constants: {
      max_candidate_features: MAX_CANDIDATE_FEATURES,
      max_combined_source_bytes: MAX_COMBINED_SOURCE_BYTES,
      max_coordinate_ordinates: MAX_COORDINATE_ORDINATES,
      max_coordinate_positions: MAX_COORDINATE_POSITIONS,
      max_distance_meters: MAX_DISTANCE_METERS,
      max_duration_ms: MAX_DURATION_MS,
      max_json_depth: MAX_JSON_DEPTH,
      max_json_nodes: MAX_JSON_NODES,
      max_output_bytes: MAX_OUTPUT_BYTES,
      max_pair_evaluations: MAX_PAIR_EVALUATIONS,
      max_primary_features: MAX_PRIMARY_FEATURES,
      max_source_bytes: MAX_SOURCE_BYTES,
    },
    max_distance_meters: input.maxDistanceMeters,
    operation: input.operation,
    rounding: 'nearest_millimetre',
    source_sha256: input.sourceSha256,
    source_uri: input.sourceUri,
    tie_break: 'candidate_source_index',
  };
}

function addOutputIntegrityIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function artifactFeatureCountFromContent(content: string, context: z.RefinementCtx): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    addOutputIntegrityIssue(context, ['artifact', 'content'], 'artifact content must be valid GeoJSON FeatureCollection JSON');
    return undefined;
  }
  if (!isObject(parsed)) {
    addOutputIntegrityIssue(context, ['artifact', 'content'], 'artifact content must be a GeoJSON FeatureCollection object');
    return undefined;
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'features' || keys[1] !== 'type') {
    addOutputIntegrityIssue(context, ['artifact', 'content'], 'artifact FeatureCollection root must contain only type and features');
    return undefined;
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    addOutputIntegrityIssue(context, ['artifact', 'content'], 'artifact content must be a GeoJSON FeatureCollection with a features array');
    return undefined;
  }
  return parsed.features.length;
}

export const RunVectorAnalysisOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    artifact: z
      .object({
        format: z.literal('geojson'),
        media_type: z.literal('application/geo+json; charset=utf-8'),
        content: z.string(),
        bytes: CountSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    report: VectorReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict()
  .superRefine((output, context) => {
    const artifactBytes = Buffer.byteLength(output.artifact.content, 'utf8');
    const artifactWithinByteLimit = artifactBytes <= MAX_OUTPUT_BYTES;
    const artifactFeatureCount = artifactWithinByteLimit
      ? artifactFeatureCountFromContent(output.artifact.content, context)
      : undefined;
    if (!artifactWithinByteLimit) {
      addOutputIntegrityIssue(
        context,
        ['artifact', 'content'],
        'artifact content exceeds maximum UTF-8 output byte limit',
      );
    }
    const artifactHash = sha256Text(output.artifact.content);
    if (output.artifact.bytes !== artifactBytes) {
      addOutputIntegrityIssue(context, ['artifact', 'bytes'], 'artifact byte count must match UTF-8 content');
    }
    if (output.artifact.sha256 !== artifactHash) {
      addOutputIntegrityIssue(context, ['artifact', 'sha256'], 'artifact hash must match content');
    }
    if (output.report.output.format !== output.artifact.format) {
      addOutputIntegrityIssue(context, ['report', 'output', 'format'], 'report output format must match artifact');
    }
    if (output.report.output.media_type !== output.artifact.media_type) {
      addOutputIntegrityIssue(context, ['report', 'output', 'media_type'], 'report output media type must match artifact');
    }
    if (output.report.output.bytes !== output.artifact.bytes) {
      addOutputIntegrityIssue(context, ['report', 'output', 'bytes'], 'report output bytes must match artifact');
    }
    if (output.report.output.sha256 !== output.artifact.sha256) {
      addOutputIntegrityIssue(context, ['report', 'output', 'sha256'], 'report output hash must match artifact');
    }

    const artifactOutputs = output.evidence.outputs
      .map((evidenceOutput, index) => ({ evidenceOutput, index }))
      .filter(({ evidenceOutput }) => evidenceOutput.name === 'nearest_point_geojson');
    if (artifactOutputs.length !== 1) {
      addOutputIntegrityIssue(context, ['evidence', 'outputs'], 'evidence must contain exactly one nearest_point_geojson output');
    } else {
      const { evidenceOutput, index } = artifactOutputs[0];
      if (evidenceOutput.bytes !== output.artifact.bytes) {
        addOutputIntegrityIssue(context, ['evidence', 'outputs', index, 'bytes'], 'evidence output bytes must match artifact');
      }
      if (evidenceOutput.sha256 !== output.artifact.sha256) {
        addOutputIntegrityIssue(context, ['evidence', 'outputs', index, 'sha256'], 'evidence output hash must match artifact');
      }
    }

    if (output.evidence.parameters.sha256 !== sha256Text(output.evidence.parameters.canonical_json)) {
      addOutputIntegrityIssue(context, ['evidence', 'parameters', 'sha256'], 'evidence parameter hash must match canonical JSON');
    }
    let parsedCanonicalParameters = true;
    try {
      JSON.parse(output.evidence.parameters.canonical_json);
    } catch {
      parsedCanonicalParameters = false;
      addOutputIntegrityIssue(
        context,
        ['evidence', 'parameters', 'canonical_json'],
        'evidence parameter canonical JSON must match executed parameters',
      );
    }
    if (output.evidence.execution.capability !== 'run_vector_analysis') {
      addOutputIntegrityIssue(context, ['evidence', 'execution', 'capability'], 'evidence execution capability must match capability');
    }
    if (output.evidence.execution.capability_version !== '1.0.0') {
      addOutputIntegrityIssue(context, ['evidence', 'execution', 'capability_version'], 'evidence execution capability version must match manifest');
    }

    if (output.report.source.source_uri !== output.evidence.source.uri) {
      addOutputIntegrityIssue(context, ['report', 'source', 'source_uri'], 'primary report source URI must match evidence source');
    }
    if (output.report.source.sha256 !== output.evidence.source.sha256) {
      addOutputIntegrityIssue(context, ['report', 'source', 'sha256'], 'primary report source hash must match evidence source');
    }
    if (output.evidence.source.bytes === undefined) {
      addOutputIntegrityIssue(context, ['evidence', 'source', 'bytes'], 'primary evidence source bytes are required');
    } else if (output.report.source.bytes !== output.evidence.source.bytes) {
      addOutputIntegrityIssue(context, ['report', 'source', 'bytes'], 'primary report source bytes must match evidence source bytes');
    }
    if (output.report.source.row_count !== output.report.counts.input_features) {
      addOutputIntegrityIssue(context, ['report', 'source', 'row_count'], 'primary report source row_count must match input feature count');
    }
    if (output.evidence.gis_metadata.row_count !== output.report.counts.input_features) {
      addOutputIntegrityIssue(context, ['evidence', 'gis_metadata', 'row_count'], 'primary evidence row_count must match input feature count');
    }
    const candidateSources = output.evidence.related_sources?.filter((source) => source.role === 'candidate_features') ?? [];
    let candidateSourceForParameters: (typeof candidateSources)[number] | undefined;
    if (candidateSources.length !== 1) {
      addOutputIntegrityIssue(context, ['evidence', 'related_sources'], 'evidence must contain exactly one candidate_features related source');
    } else {
      const candidateSource = candidateSources[0];
      candidateSourceForParameters = candidateSource;
      const candidateIndex = output.evidence.related_sources?.findIndex((source) => source.role === 'candidate_features') ?? 0;
      if (output.report.candidate.source_uri !== candidateSource.uri) {
        addOutputIntegrityIssue(context, ['report', 'candidate', 'source_uri'], 'candidate report source URI must match evidence related source');
      }
      if (output.report.candidate.sha256 !== candidateSource.sha256) {
        addOutputIntegrityIssue(context, ['report', 'candidate', 'sha256'], 'candidate report source hash must match evidence related source');
      }
      if (candidateSource.bytes === undefined) {
        addOutputIntegrityIssue(context, ['evidence', 'related_sources', candidateIndex, 'bytes'], 'candidate evidence source bytes are required');
      } else if (output.report.candidate.bytes !== candidateSource.bytes) {
        addOutputIntegrityIssue(context, ['report', 'candidate', 'bytes'], 'candidate report source bytes must match evidence related source bytes');
      }
      if (candidateSource.gis_metadata === undefined) {
        addOutputIntegrityIssue(context, ['evidence', 'related_sources', candidateIndex, 'gis_metadata'], 'candidate related source gis_metadata is required');
      } else if (candidateSource.gis_metadata.row_count !== output.report.counts.candidate_features) {
        addOutputIntegrityIssue(
          context,
          ['evidence', 'related_sources', candidateIndex, 'gis_metadata', 'row_count'],
          'candidate evidence row_count must match candidate feature count',
        );
      }
      if (candidateIndex < 0) {
        addOutputIntegrityIssue(context, ['evidence', 'related_sources'], 'evidence must contain candidate_features related source');
      }
    }
    if (output.report.candidate.row_count !== output.report.counts.candidate_features) {
      addOutputIntegrityIssue(context, ['report', 'candidate', 'row_count'], 'candidate report row_count must match candidate feature count');
    }
    if (output.report.counts.output_features !== output.report.counts.input_features) {
      addOutputIntegrityIssue(context, ['report', 'counts', 'output_features'], 'output feature count must match input feature count');
    }
    if (output.report.counts.matched + output.report.counts.unmatched !== output.report.counts.output_features) {
      addOutputIntegrityIssue(context, ['report', 'counts', 'matched'], 'matched and unmatched counts must sum to output feature count');
    }
    if (artifactFeatureCount !== undefined && artifactFeatureCount !== output.report.counts.output_features) {
      addOutputIntegrityIssue(context, ['artifact', 'content'], 'artifact feature count must match report output feature count');
    }
    if (output.evidence.bundle_id !== `run_vector_analysis:${output.artifact.sha256.slice(0, 16)}`) {
      addOutputIntegrityIssue(context, ['evidence', 'bundle_id'], 'evidence bundle id must match artifact hash fragment');
    }
    if (parsedCanonicalParameters && candidateSourceForParameters !== undefined) {
      const expectedCanonicalParameters = canonicalJson(
        buildCanonicalParameters({
          operation: output.report.operation,
          algorithm: output.report.algorithm,
          maxDistanceMeters: output.report.max_distance_meters,
          sourceUri: output.evidence.source.uri,
          sourceSha256: output.evidence.source.sha256,
          candidateSourceUri: candidateSourceForParameters.uri,
          candidateSha256: candidateSourceForParameters.sha256,
        }),
      );
      if (output.evidence.parameters.canonical_json !== expectedCanonicalParameters) {
        addOutputIntegrityIssue(
          context,
          ['evidence', 'parameters', 'canonical_json'],
          'evidence parameter canonical JSON must match executed parameters',
        );
      }
    }
  });

export type RunVectorAnalysisInput = z.infer<typeof RunVectorAnalysisInputSchema>;
export type RunVectorAnalysisOutput = z.infer<typeof RunVectorAnalysisOutputSchema>;

type Checkpoint = (stage: string) => void;

export function assertCombinedSourceBytes(primaryBytes: number, candidateBytes: number, phase: 'stat' | 'actual'): number {
  const combinedBytes = primaryBytes + candidateBytes;
  if (combinedBytes > MAX_COMBINED_SOURCE_BYTES) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: combined ${phase} source bytes ${combinedBytes} > ${MAX_COMBINED_SOURCE_BYTES}`,
    );
  }
  return combinedBytes;
}

export function assertOutputBytesWithinLimit(outputBytes: number): void {
  if (outputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: output GeoJSON ${outputBytes} bytes > ${MAX_OUTPUT_BYTES} bytes`,
    );
  }
}

function createCheckpoint(context: CapabilityExecutionContext): { checkpoint: Checkpoint; pacedCheckpoint: Checkpoint } {
  const monotonicNow = context.monotonicNow ?? ((): number => performance.now());
  const readMonotonicElapsed = (() => {
    const startedMs = monotonicNow();
    if (!Number.isFinite(startedMs)) {
      throw new Error(`run_vector_analysis resource limit exceeded: duration > ${MAX_DURATION_MS} ms during start`);
    }
    let lastMs = startedMs;
    return (stage: string): number => {
      const currentMs = monotonicNow();
      if (!Number.isFinite(currentMs)) {
        throw new Error(`run_vector_analysis resource limit exceeded: duration > ${MAX_DURATION_MS} ms during ${stage}`);
      }
      if (currentMs > lastMs) lastMs = currentMs;
      return lastMs - startedMs;
    };
  })();
  let counter = 0;
  const checkpoint = (stage: string): void => {
    if (context.signal?.aborted) throw new Error(`run_vector_analysis cancelled during ${stage}`);
    if (readMonotonicElapsed(stage) > MAX_DURATION_MS) {
      throw new Error(
        `run_vector_analysis resource limit exceeded: duration > ${MAX_DURATION_MS} ms during ${stage}`,
      );
    }
  };
  const pacedCheckpoint = (stage: string): void => {
    counter += 1;
    if (counter >= CHECKPOINT_INTERVAL) {
      counter = 0;
      checkpoint(stage);
    }
  };
  return { checkpoint, pacedCheckpoint };
}

function validateJsonShape(value: unknown, checkpoint: Checkpoint): void {
  let visited = 0;
  const visit = (node: unknown, depth: number): void => {
    checkpoint('json shape validation');
    visited += 1;
    if (depth > MAX_JSON_DEPTH || visited > MAX_JSON_NODES) {
      throw new Error('malformed GeoJSON: JSON structure exceeds supported depth or shape limits');
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const objectNode = node as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(objectNode, 'crs')) {
        throw new Error('run_vector_analysis rejected GeoJSON: legacy crs members are not RFC 7946 CRS84');
      }
      for (const item of Object.values(objectNode)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function assertFeatureId(id: unknown, role: Role, index: number): asserts id is string | number | undefined {
  if (id === undefined) return;
  if (typeof id === 'string') return;
  if (typeof id === 'number' && Number.isFinite(id)) return;
  throw new Error(`malformed GeoJSON: ${role} feature ${index} id must be a string or finite number`);
}

function validatePointPosition(
  coordinates: unknown,
  role: Role,
  index: number,
  counters: { positions: number; ordinates: number },
  checkpoint: Checkpoint,
): { lon: number; lat: number } {
  checkpoint('coordinate traversal');
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error(`malformed GeoJSON: ${role} feature ${index} Point position must contain at least longitude and latitude`);
  }
  counters.positions += 1;
  if (counters.positions > MAX_COORDINATE_POSITIONS) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: coordinate positions > ${MAX_COORDINATE_POSITIONS}`,
    );
  }
  for (let ordinateIndex = 0; ordinateIndex < coordinates.length; ordinateIndex += 1) {
    checkpoint('coordinate ordinate traversal');
    const value = coordinates[ordinateIndex];
    counters.ordinates += 1;
    if (counters.ordinates > MAX_COORDINATE_ORDINATES) {
      throw new Error(`run_vector_analysis resource limit exceeded: coordinate ordinates > ${MAX_COORDINATE_ORDINATES}`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`malformed GeoJSON: ${role} feature ${index} coordinates must be finite numeric ordinates`);
    }
  }
  const lon = coordinates[0] as number;
  const lat = coordinates[1] as number;
  if (lon < -180 || lon > 180) {
    throw new Error(`malformed GeoJSON: ${role} feature ${index} longitude must be within [-180,180]`);
  }
  if (lat < -90 || lat > 90) {
    throw new Error(`malformed GeoJSON: ${role} feature ${index} latitude must be within [-90,90]`);
  }
  return { lon, lat };
}

function parsePointCollection(parsed: unknown, role: Role, checkpoint: Checkpoint): ParsedCollection {
  checkpoint(`${role} root validation`);
  validateJsonShape(parsed, checkpoint);
  checkpoint(`${role} root validation`);
  if (!isObject(parsed) || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error('malformed GeoJSON: root must be a FeatureCollection with a features array');
  }
  const featureLimit = role === 'primary' ? MAX_PRIMARY_FEATURES : MAX_CANDIDATE_FEATURES;
  if (parsed.features.length > featureLimit) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: ${role} features ${parsed.features.length} > ${featureLimit}`,
    );
  }
  const counters = { positions: 0, ordinates: 0 };
  const records: PointRecord[] = [];
  parsed.features.forEach((feature, index) => {
    checkpoint('feature traversal');
    if (!isObject(feature) || feature.type !== 'Feature') {
      throw new Error(`malformed GeoJSON: ${role} feature ${index} is not a Feature`);
    }
    assertFeatureId(feature.id, role, index);
    if (!('geometry' in feature)) throw new Error(`malformed GeoJSON: ${role} feature ${index} has no geometry member`);
    if (feature.geometry === null) {
      throw new Error(`malformed GeoJSON: ${role} feature ${index} must have non-null Point geometry`);
    }
    if (!isObject(feature.geometry) || feature.geometry.type !== 'Point') {
      throw new Error(`malformed GeoJSON: ${role} feature ${index} must have Point geometry`);
    }
    if (!('properties' in feature) || (feature.properties !== null && !isObject(feature.properties))) {
      throw new Error(`malformed GeoJSON: ${role} feature ${index} properties must be an object or null`);
    }
    if (role === 'primary' && feature.properties !== null && '_dymaxion' in feature.properties) {
      throw new Error('run_vector_analysis rejected primary properties containing reserved _dymaxion');
    }
    const { lon, lat } = validatePointPosition(feature.geometry.coordinates, role, index, counters, checkpoint);
    records.push({
      index,
      ...(feature.id === undefined ? {} : { id: feature.id }),
      lon,
      lat,
      geometry: feature.geometry,
      properties: feature.properties,
    });
  });
  checkpoint(`${role} feature validation`);
  return {
    records,
    featureCount: parsed.features.length,
    coordinatePositions: counters.positions,
    ordinateCount: counters.ordinates,
  };
}

async function statLocalGeojson(
  role: Role,
  rawPath: string,
  io: VectorIo,
  context: CapabilityExecutionContext,
  checkpoint: Checkpoint,
): Promise<SourceStat> {
  checkpoint(`${role} before stat`);
  const path = canonicalBoundaryPath(rawPath);
  if (extname(path).toLowerCase() !== '.geojson') {
    throw new Error('unsupported dataset format: canonical source path must end in .geojson');
  }
  await assertPathAllowed(path, context.boundary);
  checkpoint(`${role} before stat`);
  let fileStat: FileStat;
  try {
    fileStat = await io.stat(path);
  } catch {
    throw new Error(`run_vector_analysis file stat failed for the requested ${role} dataset`);
  }
  checkpoint(`${role} after stat`);
  if (!Number.isFinite(fileStat.size) || fileStat.size < 0) {
    throw new Error(`run_vector_analysis file stat failed for the requested ${role} dataset`);
  }
  if (fileStat.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: ${role} source ${fileStat.size} bytes > ${MAX_SOURCE_BYTES} bytes`,
    );
  }
  return { role, path, uri: pathToFileURL(path).href, statSize: fileStat.size };
}

async function readLocalGeojsonBytes(
  source: SourceStat,
  io: VectorIo,
  context: CapabilityExecutionContext,
  checkpoint: Checkpoint,
): Promise<SourceBytes> {
  await assertPathAllowed(source.path, context.boundary);
  checkpoint(`${source.role} before read`);
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(source.path);
  } catch {
    throw new Error(`run_vector_analysis file read failed for the requested ${source.role} dataset`);
  }
  checkpoint(`${source.role} after read`);
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `run_vector_analysis resource limit exceeded while reading ${source.role}: ${bytes.byteLength} bytes > ${MAX_SOURCE_BYTES} bytes`,
    );
  }
  return { ...source, bytes, sha256: sha256Text(bytes), byteLength: bytes.byteLength };
}

function parseLocalGeojsonBytes(source: SourceBytes, checkpoint: Checkpoint): Omit<SourceRead, 'collection'> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
  } catch {
    throw new Error(`malformed GeoJSON: ${source.role} source is not valid UTF-8`);
  }
  checkpoint(`${source.role} UTF-8 decode`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('malformed GeoJSON: invalid JSON syntax');
  }
  checkpoint(`${source.role} JSON parse`);
  return {
    role: source.role,
    path: source.path,
    uri: source.uri,
    bytes: source.bytes,
    text,
    sha256: source.sha256,
    byteLength: source.byteLength,
    parsed,
  };
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizedDeltaLonRadians(fromLon: number, toLon: number): number {
  const delta = ((((toLon - fromLon) + 540) % 360) - 180);
  return radians(delta);
}

function roundedHaversineMeters(a: PointRecord, b: PointRecord): number {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = normalizedDeltaLonRadians(a.lon, b.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const centralAngle = 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
  return Math.round(AUTHALIC_RADIUS_METERS * centralAngle * 1_000) / 1_000;
}

export function createFeatureCollectionOutputBudget(limitBytes = MAX_OUTPUT_BYTES): {
  addFeature(canonicalFeatureJson: string): void;
  observedBytes(): number;
} {
  const prefixBytes = Buffer.byteLength('{"features":[', 'utf8');
  const suffixBytes = Buffer.byteLength('],"type":"FeatureCollection"}', 'utf8');
  let featureBytes = 0;
  let featureCount = 0;
  const projectedBytes = (nextFeatureJson?: string): number =>
    prefixBytes +
    suffixBytes +
    featureBytes +
    (nextFeatureJson === undefined
      ? 0
      : Buffer.byteLength(nextFeatureJson, 'utf8') + (featureCount > 0 ? 1 : 0));
  if (projectedBytes() > limitBytes) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: output GeoJSON > ${limitBytes} bytes`,
    );
  }
  return {
    addFeature(canonicalFeatureJson: string): void {
      if (projectedBytes(canonicalFeatureJson) > limitBytes) {
        throw new Error(
          `run_vector_analysis resource limit exceeded: output GeoJSON > ${limitBytes} bytes`,
        );
      }
      featureBytes += Buffer.byteLength(canonicalFeatureJson, 'utf8') + (featureCount > 0 ? 1 : 0);
      featureCount += 1;
    },
    observedBytes(): number {
      return projectedBytes();
    },
  };
}

export function deriveArtifact(
  primary: PointRecord[],
  candidates: PointRecord[],
  maxDistanceMeters: number | undefined,
  checkpoint: Checkpoint,
  outputByteLimit = MAX_OUTPUT_BYTES,
): { artifact: Record<string, unknown>; matched: number; unmatched: number; pairEvaluations: number } {
  const pairCeiling = primary.length * candidates.length;
  if (pairCeiling > MAX_PAIR_EVALUATIONS) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: pair evaluations ${pairCeiling} > ${MAX_PAIR_EVALUATIONS}`,
    );
  }
  let pairEvaluations = 0;
  let matched = 0;
  let unmatched = 0;
  const outputBudget = createFeatureCollectionOutputBudget(outputByteLimit);
  const features: Array<Record<string, unknown>> = [];
  for (const feature of primary) {
    checkpoint('primary output traversal');
    let best: { index: number; id: string | number | null; distance: number } | null = null;
    for (const candidate of candidates) {
      checkpoint('pair evaluation');
      pairEvaluations += 1;
      if (pairEvaluations > MAX_PAIR_EVALUATIONS) {
        throw new Error(
          `run_vector_analysis resource limit exceeded: pair evaluations > ${MAX_PAIR_EVALUATIONS}`,
        );
      }
      const distance = roundedHaversineMeters(feature, candidate);
      if (
        best === null ||
        distance < best.distance ||
        (distance === best.distance && candidate.index < best.index)
      ) {
        best = { index: candidate.index, id: candidate.id ?? null, distance };
      }
    }
    let dymaxion: {
      operation: 'nearest_point';
      candidate_index: number | null;
      candidate_id: string | number | null;
      distance_meters: number | null;
      matched: boolean;
    };
    if (best !== null && (maxDistanceMeters === undefined || best.distance <= maxDistanceMeters)) {
      dymaxion = {
        operation: 'nearest_point',
        candidate_index: best.index,
        candidate_id: best.id,
        distance_meters: best.distance,
        matched: true,
      };
      matched += 1;
    } else {
      dymaxion = {
        operation: 'nearest_point',
        candidate_index: null,
        candidate_id: null,
        distance_meters: null,
        matched: false,
      };
      unmatched += 1;
    }
    const properties = { ...(feature.properties ?? {}), _dymaxion: dymaxion };
    const outputFeature = {
      type: 'Feature',
      ...(feature.id === undefined ? {} : { id: feature.id }),
      properties,
      geometry: feature.geometry,
    };
    outputBudget.addFeature(canonicalJson(outputFeature));
    features.push(outputFeature);
  }
  return { artifact: { type: 'FeatureCollection', features }, matched, unmatched, pairEvaluations };
}

function gisMetadata(rowCount: number): GisMetadata {
  return GisMetadataSchema.parse({
    format: 'GeoJSON',
    crs: 'OGC:CRS84',
    axis_order: 'longitude,latitude',
    units: 'degrees',
    extent: null,
    schema: [],
    row_count: rowCount,
    geometry_types: rowCount > 0 ? ['Point'] : [],
    temporal_fields: [],
  });
}

function sourceReport(source: SourceRead, role: 'primary_features' | 'candidate_features'): z.infer<typeof SourceReportSchema> {
  const attribution = `local GeoJSON ${role}; sha256 ${source.sha256.slice(0, 12)}`;
  return SourceReportSchema.parse({
    kind: 'local-file',
    role,
    source_uri: source.uri,
    source_handle: source.path,
    source_attribution: attribution,
    sha256: source.sha256,
    bytes: source.byteLength,
    row_count: source.collection.featureCount,
  });
}

async function preflightRunVectorAnalysis(input: RunVectorAnalysisInput): Promise<void> {
  let sourcePath: string;
  let candidatePath: string;
  try {
    sourcePath = canonicalBoundaryPath(input.source_uri);
    candidatePath = canonicalBoundaryPath(input.candidate_source_uri);
  } catch {
    throw new Error('run_vector_analysis source paths must be supported local filesystem paths');
  }
  if (sourcePath === candidatePath) {
    throw new Error('candidate_source_uri must resolve to a distinct local filesystem path');
  }
}

function assertDistinctCanonicalSources(input: RunVectorAnalysisInput): void {
  const sourcePath = canonicalBoundaryPath(input.source_uri);
  const candidatePath = canonicalBoundaryPath(input.candidate_source_uri);
  if (sourcePath === candidatePath) {
    throw new Error('candidate_source_uri must resolve to a distinct local filesystem path');
  }
}

async function executeRunVectorAnalysis(
  input: RunVectorAnalysisInput,
  context: CapabilityExecutionContext,
): Promise<RunVectorAnalysisOutput> {
  const io = context.io as VectorIo | undefined;
  if (!io?.stat || !io.readFile) throw new Error('run_vector_analysis filesystem adapter unavailable');
  const nowFn = context.now ?? ((): Date => new Date());
  const timestamp = nowFn().toISOString();
  assertDistinctCanonicalSources(input);
  const { checkpoint } = createCheckpoint(context);
  checkpoint('start');

  const primaryStat = await statLocalGeojson('primary', input.source_uri, io, context, checkpoint);
  const candidateStat = await statLocalGeojson('candidate', input.candidate_source_uri, io, context, checkpoint);
  assertCombinedSourceBytes(primaryStat.statSize, candidateStat.statSize, 'stat');
  const primaryBytes = await readLocalGeojsonBytes(primaryStat, io, context, checkpoint);
  const candidateBytes = await readLocalGeojsonBytes(candidateStat, io, context, checkpoint);
  assertCombinedSourceBytes(primaryBytes.byteLength, candidateBytes.byteLength, 'actual');
  const primaryBase = parseLocalGeojsonBytes(primaryBytes, checkpoint);
  const candidateBase = parseLocalGeojsonBytes(candidateBytes, checkpoint);

  const primaryCollection = parsePointCollection(primaryBase.parsed, 'primary', checkpoint);
  const candidateCollection = parsePointCollection(candidateBase.parsed, 'candidate', checkpoint);
  if (primaryCollection.coordinatePositions + candidateCollection.coordinatePositions > MAX_COORDINATE_POSITIONS) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: total coordinate positions > ${MAX_COORDINATE_POSITIONS}`,
    );
  }
  if (primaryCollection.ordinateCount + candidateCollection.ordinateCount > MAX_COORDINATE_ORDINATES) {
    throw new Error(
      `run_vector_analysis resource limit exceeded: total coordinate ordinates > ${MAX_COORDINATE_ORDINATES}`,
    );
  }
  const primary: SourceRead = { ...primaryBase, collection: primaryCollection };
  const candidate: SourceRead = { ...candidateBase, collection: candidateCollection };

  const derived = deriveArtifact(primary.collection.records, candidate.collection.records, input.max_distance_meters, checkpoint, MAX_OUTPUT_BYTES);
  checkpoint('artifact derivation');
  const content = canonicalJson(derived.artifact);
  const outputBytes = Buffer.byteLength(content, 'utf8');
  assertOutputBytesWithinLimit(outputBytes);
  const outputHash = sha256Text(content);
  const primaryReport = sourceReport(primary, 'primary_features');
  const candidateReport = sourceReport(candidate, 'candidate_features');

  const warnings: string[] = [];
  if (candidate.collection.featureCount === 0 && primary.collection.featureCount > 0) {
    warnings.push('Candidate FeatureCollection is empty; every primary feature is unmatched.');
  }
  if (primary.collection.featureCount === 0) {
    warnings.push('Primary FeatureCollection is empty; output artifact is an empty FeatureCollection.');
  }
  if (input.max_distance_meters !== undefined) {
    warnings.push('max_distance_meters was applied to rounded millimetre distances.');
  }

  const report = VectorReportSchema.parse({
    schema_version: '1.0.0',
    generated_at: timestamp,
    operation: 'nearest_point',
    source: primaryReport,
    candidate: candidateReport,
    algorithm: {
      name: 'haversine_spherical_great_circle',
      authalic_radius_meters: AUTHALIC_RADIUS_METERS,
      distance_units: 'meters',
      rounding: 'nearest millimetre',
      tie_break: 'rounded distance then candidate source index',
      longitude_delta: 'normalized across antimeridian to [-180,180]',
    },
    max_distance_meters: input.max_distance_meters ?? null,
    counts: {
      input_features: primary.collection.featureCount,
      candidate_features: candidate.collection.featureCount,
      output_features: primary.collection.featureCount,
      matched: derived.matched,
      unmatched: derived.unmatched,
      pair_evaluations: derived.pairEvaluations,
      primary_coordinate_positions: primary.collection.coordinatePositions,
      candidate_coordinate_positions: candidate.collection.coordinatePositions,
      total_coordinate_positions: primary.collection.coordinatePositions + candidate.collection.coordinatePositions,
      primary_ordinates: primary.collection.ordinateCount,
      candidate_ordinates: candidate.collection.ordinateCount,
      total_ordinates: primary.collection.ordinateCount + candidate.collection.ordinateCount,
    },
    crs: { effective: 'OGC:CRS84', axis_order: 'longitude,latitude', units: 'degrees' },
    output: {
      format: 'geojson',
      media_type: 'application/geo+json; charset=utf-8',
      bytes: outputBytes,
      sha256: outputHash,
    },
    qa: {
      checks: [
        'input_schema_strict',
        'raw_local_paths_no_percent_or_credentials',
        'filesystem_boundary_before_each_stat_and_read',
        'utf8_decode_fatal',
        'geojson_featurecollection_root',
        'rfc7946_no_legacy_crs',
        'point_only_non_null_geometry',
        'crs84_longitude_latitude_ranges',
        'haversine_authalic_radius_distance',
        'rounded_millimetre_tie_break_by_candidate_index',
        'exact_canonical_geojson_output_hash',
      ],
      warnings,
      limitations: [
        'Distances are spherical great-circle Haversine distances with a fixed authalic radius, not ellipsoidal geodesic or projected distances.',
        'Point-only RFC 7946 CRS84 GeoJSON FeatureCollections are supported; no topology validation, projection transform, or legacy CRS conversion is performed.',
        'Nearest-neighbor search is brute-force O(n*m) and bounded by a hard pair-evaluation ceiling.',
        'Inline artifact only; no filesystem, database, network, portal, or durable artifact write is performed.',
        'Primary source properties are copied except the reserved _dymaxion namespace is rejected; candidate properties are omitted from output.',
        'No topology, projection transform, spatial index, geocoding, buffering, or overlay analysis is performed.',
      ],
    },
  });

  const sourceMetadata = gisMetadata(primary.collection.featureCount);
  const candidateMetadata = gisMetadata(candidate.collection.featureCount);
  const parameters = buildCanonicalParameters({
    operation: report.operation,
    algorithm: report.algorithm,
    maxDistanceMeters: report.max_distance_meters,
    sourceUri: primary.uri,
    sourceSha256: primary.sha256,
    candidateSourceUri: candidate.uri,
    candidateSha256: candidate.sha256,
  });
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `run_vector_analysis:${outputHash.slice(0, 16)}`,
    generated_at: timestamp,
    source: {
      uri: primary.uri,
      identity: { kind: 'file', value: primary.path },
      version: {},
      retrieved_at: timestamp,
      sha256: primary.sha256,
      bytes: primary.byteLength,
    },
    related_sources: [
      {
        role: 'candidate_features',
        uri: candidate.uri,
        identity: { kind: 'file', value: candidate.path },
        version: {},
        retrieved_at: timestamp,
        sha256: candidate.sha256,
        bytes: candidate.byteLength,
        gis_metadata: candidateMetadata,
      },
    ],
    gis_metadata: sourceMetadata,
    parameters: { canonical_json: canonicalJson(parameters), sha256: sha256Canonical(parameters) },
    execution: {
      capability: 'run_vector_analysis',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'nearest_point_geojson',
        sha256: outputHash,
        bytes: outputBytes,
        validation: {
          valid: true,
          checks: ['input_schema', 'geojson_parse', 'point_only', 'exact_utf8_output_hash', 'output_schema'],
          warnings,
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });

  return RunVectorAnalysisOutputSchema.parse({
    schema_version: '1.0.0',
    artifact: {
      format: 'geojson',
      media_type: 'application/geo+json; charset=utf-8',
      content,
      bytes: outputBytes,
      sha256: outputHash,
    },
    report,
    evidence,
  });
}

export const runVectorAnalysisCapability: CapabilityDefinition<
  RunVectorAnalysisInput,
  RunVectorAnalysisOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'run_vector_analysis',
    name: 'Run vector analysis',
    description:
      'Read-only deterministic nearest-point analysis between two bounded local RFC 7946 CRS84 Point GeoJSON FeatureCollections, returning an inline canonical GeoJSON artifact with reproducible report and evidence.',
    version: '1.0.0',
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: [],
    allowed_sources: ['filesystem'],
    resource_limits: {
      max_records: MAX_PRIMARY_FEATURES + MAX_CANDIDATE_FEATURES,
      max_bytes: MAX_COMBINED_SOURCE_BYTES,
      max_duration_ms: MAX_DURATION_MS,
      max_cost_usd: 0,
      max_source_bytes: MAX_SOURCE_BYTES,
      max_primary_records: MAX_PRIMARY_FEATURES,
      max_candidate_records: MAX_CANDIDATE_FEATURES,
      max_coordinate_positions: MAX_COORDINATE_POSITIONS,
      max_coordinate_ordinates: MAX_COORDINATE_ORDINATES,
      max_json_depth: MAX_JSON_DEPTH,
      max_json_nodes: MAX_JSON_NODES,
      max_pair_evaluations: MAX_PAIR_EVALUATIONS,
      max_output_bytes: MAX_OUTPUT_BYTES,
    },
    idempotency: {
      mode: 'deterministic',
      key_fields: [
        'source_uri',
        'candidate_source_uri',
        'operation',
        'max_distance_meters',
        'source_sha256',
        'candidate_sha256',
      ],
    },
    dry_run: { supported: false, reason: 'Read-only capability returns the inline artifact without writes.' },
    cancellation: { supported: true, checkpoint: 'before_after_each_stat_read_parse_root_validation_and_pair_loop' },
    artifacts: [{ name: 'nearest_point_geojson', media_type: 'application/geo+json; charset=utf-8', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability; no writes to roll back.' },
    validation: { suite: 'gisbench', version: '0.1.0', supported_gis_versions: ['GeoJSON RFC 7946'] },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: RunVectorAnalysisInputSchema as unknown as z.ZodType<RunVectorAnalysisInput>,
  outputSchema: RunVectorAnalysisOutputSchema,
  inputSummary: ['source_uri*', 'candidate_source_uri*', 'operation=nearest_point', 'max_distance_meters'],
  boundaryFields: ['source_uri', 'candidate_source_uri'],
  preflight: preflightRunVectorAnalysis,
  execute: executeRunVectorAnalysis,
};
