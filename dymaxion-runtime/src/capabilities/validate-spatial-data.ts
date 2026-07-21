// Phase 1D bounded spatial data validation: deterministic, read-only QA of one
// allowlisted local RFC 7946 GeoJSON FeatureCollection. Performs structural and
// bounded geometry checks only; every intentionally unsupported topology/domain
// check is reported in scope.checks_not_run. This capability never claims full
// OGC Simple Features / GEOS validity.

import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';
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

// Resource ceilings — mirrored exactly in the manifest resource_limits.
export const MAX_BYTES = 1_048_576;
export const MAX_FEATURES = 10_000;
// A minimal serialized position needs ~6 bytes, so 1 MiB cannot hold many more
// than ~174k positions; 100k keeps the ceiling reachable and bounds traversal.
export const MAX_COORDINATE_POSITIONS = 100_000;
export const DEFAULT_MAX_ISSUES = 200;
export const MAX_ISSUES = 1_000;
export const MAX_GEOMETRY_COLLECTION_DEPTH = 4;
// Rings with more segments than this skip the O(n^2) self-intersection check;
// the skip is reported as a warning finding, never silently.
export const MAX_SELF_INTERSECTION_SEGMENTS = 512;
export const MAX_DURATION_MS = 5_000;
const CHECKPOINT_INTERVAL = 128;
// Property field names longer than this are treated as unsafe and replaced by
// a deterministic surrogate, keeping report size defensible.
export const MAX_FIELD_NAME_CHARS = 64;
const FIELD_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// Reserved Dymaxion-owned surrogate namespace. Any raw field name beginning
// with this prefix is itself treated as unsafe and surrogated, so no raw
// source name can impersonate a generated display name: colliding with a
// surrogate would require an actual SHA-256 collision. Surrogates are
// collision-resistant and deterministic, not mathematically collision-free.
const SURROGATE_FIELD_PREFIX = 'field_sha256_';

/** Safe display field names: bounded length, no control characters, outside
 * the reserved surrogate namespace, and not credential-shaped either as
 * content (`token=abc`) or as a bare credential-like key (`client_secret`,
 * probed via the shared reviewed key-classification logic exactly like
 * query_feature_service). */
function isSafeFieldName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_FIELD_NAME_CHARS) return false;
  if (name.startsWith(SURROGATE_FIELD_PREFIX)) return false;
  if (FIELD_CONTROL_CHARS.test(name)) return false;
  return !containsCredentialMaterial(name) && !containsCredentialMaterial(`${name}=v`);
}

/** Deterministic non-reversible display surrogate carrying no raw source
 * text: the reserved prefix plus the full 64-hex SHA-256 of the raw name. */
function surrogateFieldName(name: string): string {
  return `${SURROGATE_FIELD_PREFIX}${sha256Text(name)}`;
}

const CRS84_ALIASES = new Set([
  'urn:ogc:def:crs:OGC:1.3:CRS84',
  'urn:ogc:def:crs:OGC::CRS84',
  'OGC:CRS84',
  'CRS84',
]);

const SUPPORTED_GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

const UNSUPPORTED_CHECKS: ReadonlyArray<{ id: string; reason: string }> = [
  {
    id: 'coded_value_domains',
    reason: 'GeoJSON defines no coded-value domains; domain validation is not applicable to this format.',
  },
  {
    id: 'cross_feature_topology',
    reason: 'Cross-feature topology (overlaps, gaps, shared boundaries) is not implemented in Phase 1D.',
  },
  {
    id: 'ogc_simple_features_validity',
    reason:
      'Full OGC Simple Features / GEOS-equivalent validity is not implemented; only the bounded checks listed in checks_run were performed.',
  },
  {
    id: 'polygon_hole_containment',
    reason: 'Polygon interior-ring containment and ring-overlap checks are not implemented in Phase 1D.',
  },
];

const CHECKS_RUN_BASE = [
  'bbox',
  'coordinate_dimensions',
  'duplicate_vertices',
  'feature_ids',
  'geometry_structure',
  'geometry_types',
  'json_structure',
  'linestring_cardinality',
  'null_geometry',
  'property_null_profile',
  'ring_cardinality',
  'ring_closure',
  'ring_self_intersection_bounded',
  'ring_zero_area',
] as const;

// source_uri accepts only a bounded local .geojson filesystem path. Every
// URI/URL scheme (http:, https:, file:, data:, ...) is rejected at the strict
// input schema — before boundary dispatch, invocation persistence, stat, or
// readFile — with fixed messages that never echo the untrusted value.
const MAX_SOURCE_URI_CHARS = 4_096;
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const SourceUriSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_URI_CHARS)
  .refine((value) => !FIELD_CONTROL_CHARS.test(value), {
    message: 'source_uri must not contain control characters',
  })
  .refine((value) => !URI_SCHEME_PREFIX.test(value), {
    message: 'source_uri must be a local filesystem path; URI/URL schemes are not accepted',
  })
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message: 'source_uri must not contain URL query or fragment delimiters',
  })
  .refine((value) => value.toLowerCase().endsWith('.geojson'), {
    message: 'unsupported dataset format: source_uri must be a bounded local .geojson filesystem path',
  })
  // Bare relative paths (x.geojson) are part of the advertised local-path
  // contract, but the shared executor boundary classifies bare strings in
  // *_uri fields as URL inputs. Normalizing to an explicit ./ prefix makes
  // the value classify as a filesystem input for the shared preflight without
  // weakening remote-URL rejection. Idempotent: prefixed paths pass through.
  .transform((value) =>
    value.startsWith('/') || value.startsWith('./') || value.startsWith('../') ? value : `./${value}`,
  );

export const ValidateSpatialDataInputSchema = z
  .object({
    source_uri: SourceUriSchema,
    max_bytes: z.number().int().positive().max(MAX_BYTES).optional(),
    max_features: z.number().int().positive().max(MAX_FEATURES).optional(),
    max_issues: z.number().int().positive().max(MAX_ISSUES).optional(),
  })
  .strict();

const CheckIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ExtentSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const CountSchema = z.number().int().nonnegative();

const IssueSchema = z
  .object({
    code: CheckIdSchema,
    severity: z.enum(['error', 'warning']),
    location: z
      .object({
        feature_index: z.number().int().nonnegative().nullable(),
        path: z.string().min(1),
      })
      .strict(),
    message: z.string().min(1).max(300),
  })
  .strict();

const ValidationReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    source_uri: z.string().min(1),
    source_handle: z.string().min(1),
    retrieved_at: z.string().datetime({ offset: true }),
    file_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    file_size_bytes: CountSchema,
    format: z.literal('GeoJSON'),
    crs: z
      .object({
        declared: z.string().min(1).nullable(),
        effective: z.string().min(1).nullable(),
        axis_order: z.string().min(1).nullable(),
        units: z.string().min(1).nullable(),
        crs84_range_checks: z.boolean(),
      })
      .strict(),
    scope: z
      .object({
        checks_run: z.array(CheckIdSchema).min(1),
        checks_not_run: z.array(z.object({ id: CheckIdSchema, reason: z.string().min(1) }).strict()),
      })
      .strict(),
    summary: z
      .object({
        feature_count: CountSchema,
        coordinate_position_count: CountSchema,
        error_count: CountSchema,
        warning_count: CountSchema,
        total_finding_count: CountSchema,
        returned_finding_count: CountSchema,
        findings_truncated: z.boolean(),
        valid: z.boolean(),
      })
      .strict(),
    issues: z.array(IssueSchema).max(MAX_ISSUES),
    metrics: z
      .object({
        null_geometry_count: CountSchema,
        missing_id_count: CountSchema,
        duplicate_id_count: CountSchema,
        geometry_type_counts: z.array(z.object({ type: z.string().min(1), count: CountSchema }).strict()),
        coordinate_dimension_counts: z.array(
          z.object({ dimensions: z.number().int().positive(), count: CountSchema }).strict(),
        ),
        out_of_range_position_count: CountSchema,
        unclosed_ring_count: CountSchema,
        zero_area_ring_count: CountSchema,
        duplicate_vertex_count: CountSchema,
        self_intersecting_ring_count: CountSchema,
        self_intersection_checks_skipped: CountSchema,
        bbox: z
          .object({
            declared_present: z.boolean(),
            declared_valid: z.boolean().nullable(),
            computed_extent: ExtentSchema.nullable(),
            encloses_computed: z.boolean().nullable(),
          })
          .strict(),
        property_null_profile: z.array(
          z.object({ name: z.string(), null_count: CountSchema, missing_count: CountSchema }).strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const ValidateSpatialDataOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    report: ValidationReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type ValidateSpatialDataInput = z.infer<typeof ValidateSpatialDataInputSchema>;
export type ValidateSpatialDataOutput = z.infer<typeof ValidateSpatialDataOutputSchema>;

// Only the size is consumed: filesystem mtime never enters this capability's
// report or evidence, so identical bytes yield byte-identical outputs.
type FileStat = { size: number };
type ValidateIo = {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
};

type JsonObject = Record<string, unknown>;
type Position2D = readonly [number, number];
type Severity = 'error' | 'warning';

// RFC 7946 permits a bbox of 2*n values on any GeoJSON object. Bboxes beyond
// this dimension bound are rejected structurally so bbox axis loops stay
// bounded regardless of input shape.
export const MAX_BBOX_DIMENSIONS = 16;

interface DeclaredBboxBounds {
  mins: number[];
  maxs: number[];
  crossing: boolean;
}

interface BboxScope extends DeclaredBboxBounds {
  featureIndex: number | null;
  path: string;
  positions: number;
  violations: number;
  dims: Set<number>;
}

interface IssueRecord {
  code: string;
  severity: Severity;
  location: { feature_index: number | null; path: string };
  message: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1 };

// Total deterministic order over findings; encounter order never contributes.
function compareIssues(a: IssueRecord, b: IssueRecord): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    compareStrings(a.code, b.code) ||
    (a.location.feature_index ?? -1) - (b.location.feature_index ?? -1) ||
    compareStrings(a.location.path, b.location.path) ||
    compareStrings(a.message, b.message)
  );
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function equalPositions(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function orientation(a: Position2D, b: Position2D, c: Position2D): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function onSegment(a: Position2D, b: Position2D, p: Position2D): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(p1: Position2D, p2: Position2D, p3: Position2D, p4: Position2D): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, p3)) return true;
  if (o2 === 0 && onSegment(p1, p2, p4)) return true;
  if (o3 === 0 && onSegment(p3, p4, p1)) return true;
  if (o4 === 0 && onSegment(p3, p4, p2)) return true;
  return false;
}

interface CrsResolution {
  declared: string | null;
  effective: string | null;
  axisOrder: string | null;
  units: string | null;
  rangeChecks: boolean;
  deprecatedMember: boolean;
}

function resolveCrs(collection: JsonObject): CrsResolution {
  if (!('crs' in collection)) {
    return {
      declared: null,
      effective: 'OGC:CRS84',
      axisOrder: 'longitude,latitude',
      units: 'degrees',
      rangeChecks: true,
      deprecatedMember: false,
    };
  }
  const crs = collection.crs;
  const properties = isObject(crs) && isObject(crs.properties) ? crs.properties : null;
  const rawName = properties && typeof properties.name === 'string' ? properties.name : null;
  if (rawName !== null && CRS84_ALIASES.has(rawName)) {
    // Exact known aliases are trusted constants and safe to serialize.
    return {
      declared: rawName,
      effective: 'OGC:CRS84',
      axisOrder: 'longitude,latitude',
      units: 'degrees',
      rangeChecks: true,
      deprecatedMember: true,
    };
  }
  // Unrecognized or malformed legacy CRS names are untrusted dataset content
  // and are never serialized — declared/effective stay null; the stable
  // crs_member_deprecated warning carries no raw content.
  return {
    declared: null,
    effective: null,
    axisOrder: null,
    units: null,
    rangeChecks: false,
    deprecatedMember: true,
  };
}

async function executeValidateSpatialData(
  input: ValidateSpatialDataInput,
  context: CapabilityExecutionContext,
): Promise<ValidateSpatialDataOutput> {
  if (context.signal?.aborted) throw new Error('validate_spatial_data cancelled before file read');
  const path = canonicalBoundaryPath(input.source_uri);
  if (extname(path).toLowerCase() !== '.geojson') {
    // Fixed message: the canonical path/extension is untrusted-adjacent and
    // is never echoed here (the input schema already rejects non-.geojson
    // source_uri values before dispatch; this guards the canonicalized form).
    throw new Error('unsupported dataset format: the canonical source path must end in .geojson');
  }
  const io = context.io as ValidateIo | undefined;
  if (!io?.stat || !io.readFile) throw new Error('validate_spatial_data filesystem adapter unavailable');

  const maxBytes = input.max_bytes ?? MAX_BYTES;
  const maxFeatures = input.max_features ?? MAX_FEATURES;
  const maxIssues = input.max_issues ?? DEFAULT_MAX_ISSUES;
  const nowFn = context.now ?? ((): Date => new Date());
  const startedMs = nowFn().getTime();

  let sinceCheckpoint = 0;
  const checkpoint = (stage: string): void => {
    if (context.signal?.aborted) throw new Error(`validate_spatial_data cancelled during ${stage}`);
    if (nowFn().getTime() - startedMs > MAX_DURATION_MS) {
      throw new Error(
        `validate_spatial_data resource limit exceeded: duration > ${MAX_DURATION_MS} ms during ${stage}`,
      );
    }
  };
  const pacedCheckpoint = (stage: string): void => {
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_INTERVAL) {
      sinceCheckpoint = 0;
      checkpoint(stage);
    }
  };

  // The shared filesystem boundary is re-asserted on the canonical path
  // immediately before each I/O sink (stat and readFile), so direct
  // capability execution and symlink/realpath swaps after executor preflight
  // are still blocked. A filesystem race between these checks and the
  // adapter's open remains possible (path-based adapter contract); that
  // residual TOCTOU window is documented rather than claimed away.
  await assertPathAllowed(path, context.boundary);
  let fileStat: FileStat;
  try {
    fileStat = await io.stat(path);
  } catch {
    // Adapter exceptions (ENOENT, EACCES, ...) embed raw paths and are never
    // propagated; the fixed stage-specific message carries no untrusted text.
    throw new Error('validate_spatial_data file stat failed for the requested local dataset');
  }
  checkpoint('file stat');
  if (fileStat.size > maxBytes) {
    throw new Error(`validate_spatial_data resource limit exceeded: ${fileStat.size} bytes > ${maxBytes} bytes`);
  }
  await assertPathAllowed(path, context.boundary);
  checkpoint('file read');
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch {
    throw new Error('validate_spatial_data file read failed for the requested local dataset');
  }
  checkpoint('file read');
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `validate_spatial_data resource limit exceeded while reading: ${bytes.byteLength} bytes > ${maxBytes} bytes`,
    );
  }

  let collection: unknown;
  let parseFailed = false;
  try {
    collection = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    parseFailed = true;
  }
  // Deadline/cancellation are checked before malformed/root-invalid errors so
  // slow parse paths cannot bypass the duration ceiling.
  checkpoint('json parse');
  if (parseFailed) throw new Error('malformed GeoJSON: invalid JSON syntax');
  if (!isObject(collection) || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('malformed GeoJSON: root must be a FeatureCollection with a features array');
  }
  // Feature ceiling before any geometry traversal.
  if (collection.features.length > maxFeatures) {
    throw new Error(
      `validate_spatial_data resource limit exceeded: ${collection.features.length} features > ${maxFeatures}`,
    );
  }

  const features = collection.features.map((feature, index) => {
    pacedCheckpoint('feature envelope validation');
    if (!isObject(feature) || feature.type !== 'Feature') {
      throw new Error(`malformed GeoJSON: feature ${index} is not a Feature`);
    }
    if (feature.properties !== null && !isObject(feature.properties)) {
      throw new Error(`malformed GeoJSON: feature ${index} properties must be an object or null`);
    }
    if (!('geometry' in feature)) throw new Error(`malformed GeoJSON: feature ${index} has no geometry member`);
    return feature;
  });

  // Bounded top-K finding retention: every finding is counted, but at most
  // 2*max_issues records are held in memory. Sorting and trimming at the
  // threshold keeps exactly the least elements under compareIssues, so the
  // survivors equal sorting the full logical finding set and taking the first
  // max_issues, independent of encounter order.
  const retainedIssues: IssueRecord[] = [];
  let totalFindingCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  const addIssue = (
    code: string,
    severity: Severity,
    featureIndex: number | null,
    issuePath: string,
    message: string,
  ): void => {
    totalFindingCount += 1;
    if (severity === 'error') errorCount += 1;
    else warningCount += 1;
    retainedIssues.push({ code, severity, location: { feature_index: featureIndex, path: issuePath }, message });
    if (retainedIssues.length >= maxIssues * 2) {
      retainedIssues.sort(compareIssues);
      retainedIssues.length = maxIssues;
    }
  };

  const crs = resolveCrs(collection);
  if (crs.deprecatedMember) {
    addIssue(
      'crs_member_deprecated',
      'warning',
      null,
      'crs',
      crs.rangeChecks
        ? 'legacy crs member is deprecated by RFC 7946; recognized as a CRS84 alias'
        : 'legacy crs member is deprecated by RFC 7946 and is not a recognized CRS84 alias; longitude/latitude range checks disabled',
    );
  }

  // Declared bboxes (root FeatureCollection, Feature, and any geometry object
  // per RFC 7946 §5) are validated structurally, for CRS84 ranges, and for
  // per-position enclosure across every represented dimension within their
  // own scope. Enclosure per position stays exact for antimeridian-crossing
  // CRS84 bboxes where a min/max extent comparison cannot decide containment.
  // metrics.bbox remains root-focused by contract; nested bbox findings carry
  // their own locations.
  const bboxMetrics: {
    declared_present: boolean;
    declared_valid: boolean | null;
    computed_extent: [number, number, number, number] | null;
    encloses_computed: boolean | null;
  } = { declared_present: false, declared_valid: null, computed_extent: null, encloses_computed: null };
  const activeBboxScopes: BboxScope[] = [];

  // Structure (2*n finite values, 2 <= n <= MAX_BBOX_DIMENSIONS), ordering on
  // every non-longitude axis (axis 0 may wrap the antimeridian), and CRS84
  // ranges for the longitude/latitude axes only. Fixed messages; the loops
  // are bounded by the dimension cap.
  const parseDeclaredBbox = (
    value: unknown,
    featureIndex: number | null,
    issuePath: string,
  ): DeclaredBboxBounds | null => {
    checkpoint('bbox validation');
    const structural =
      Array.isArray(value) &&
      value.length >= 4 &&
      value.length % 2 === 0 &&
      value.length <= MAX_BBOX_DIMENSIONS * 2 &&
      value.every((ordinate) => typeof ordinate === 'number' && Number.isFinite(ordinate));
    if (!structural) {
      addIssue(
        'bbox_invalid',
        'error',
        featureIndex,
        issuePath,
        `bbox must be an array of 2*n finite numbers (2 <= n <= ${MAX_BBOX_DIMENSIONS} dimensions)`,
      );
      return null;
    }
    const values = value as number[];
    const half = values.length / 2;
    const mins = values.slice(0, half);
    const maxs = values.slice(half);
    for (let axis = 1; axis < half; axis += 1) {
      if (mins[axis] > maxs[axis]) {
        addIssue(
          'bbox_invalid',
          'error',
          featureIndex,
          issuePath,
          'bbox must satisfy min <= max on every non-longitude axis',
        );
        return null;
      }
    }
    if (
      crs.rangeChecks &&
      (mins[0] < -180 || mins[0] > 180 || maxs[0] < -180 || maxs[0] > 180 ||
        mins[1] < -90 || mins[1] > 90 || maxs[1] < -90 || maxs[1] > 90)
    ) {
      addIssue(
        'bbox_out_of_range',
        'error',
        featureIndex,
        issuePath,
        'bbox longitude values must be within [-180, 180] and latitude values within [-90, 90] for CRS84',
      );
      return null;
    }
    return { mins, maxs, crossing: mins[0] > maxs[0] };
  };

  // Opens an enclosure scope for a declared bbox; positions validated while
  // the scope is active are checked against it in every represented
  // dimension. Non-CRS84 antimeridian-crossing bboxes cannot be verified and
  // are reported honestly instead of silently skipped.
  const openBboxScope = (value: unknown, featureIndex: number | null, issuePath: string): BboxScope | null => {
    const bounds = parseDeclaredBbox(value, featureIndex, issuePath);
    if (bounds === null) return null;
    if (bounds.crossing && !crs.rangeChecks) {
      addIssue(
        'bbox_enclosure_unverified',
        'warning',
        featureIndex,
        issuePath,
        'declared bbox crosses the antimeridian and the effective CRS is not CRS84; enclosure was not verified',
      );
      return null;
    }
    const scope: BboxScope = {
      ...bounds,
      featureIndex,
      path: issuePath,
      positions: 0,
      violations: 0,
      dims: new Set<number>(),
    };
    activeBboxScopes.push(scope);
    return scope;
  };

  const closeBboxScope = (scope: BboxScope): { declaredValid: boolean | null; encloses: boolean | null } => {
    activeBboxScopes.pop();
    if (scope.positions === 0) return { declaredValid: true, encloses: null };
    // Enclosure over the axes the bbox actually represents is decidable even
    // when position dimensions are mixed or incompatible, so a dimensionality
    // problem never suppresses an observed containment escape. One finding of
    // each kind per scope, deterministic and bounded.
    const violated = scope.violations > 0;
    if (violated) {
      addIssue(
        'bbox_not_enclosing',
        'error',
        scope.featureIndex,
        scope.path,
        'declared bbox does not enclose every validated position in its scope',
      );
    }
    if (scope.dims.size > 1) {
      addIssue(
        'bbox_dimension_mismatch',
        'error',
        scope.featureIndex,
        scope.path,
        'bbox dimensionality cannot be consistent with mixed coordinate dimensions in its scope',
      );
      // An observed escape is a sound false; full enclosure cannot be
      // confirmed across broken dimensionality, so the metric abstains
      // otherwise.
      return { declaredValid: false, encloses: violated ? false : null };
    }
    const observedDimensions = [...scope.dims][0];
    if (scope.mins.length !== observedDimensions) {
      addIssue(
        'bbox_dimension_mismatch',
        'error',
        scope.featureIndex,
        scope.path,
        'bbox length must be 2*n values for n-dimensional coordinates',
      );
      return { declaredValid: false, encloses: violated ? false : null };
    }
    return { declaredValid: true, encloses: !violated };
  };

  let rootBboxScope: BboxScope | null = null;
  if ('bbox' in collection) {
    bboxMetrics.declared_present = true;
    const bounds = parseDeclaredBbox(collection.bbox, null, 'bbox');
    if (bounds === null) {
      bboxMetrics.declared_valid = false;
    } else {
      bboxMetrics.declared_valid = true;
      if (bounds.crossing && !crs.rangeChecks) {
        addIssue(
          'bbox_enclosure_unverified',
          'warning',
          null,
          'bbox',
          'declared bbox crosses the antimeridian and the effective CRS is not CRS84; enclosure was not verified',
        );
      } else {
        rootBboxScope = {
          ...bounds,
          featureIndex: null,
          path: 'bbox',
          positions: 0,
          violations: 0,
          dims: new Set<number>(),
        };
        activeBboxScopes.push(rootBboxScope);
      }
    }
  }

  const metrics = {
    nullGeometryCount: 0,
    missingIdCount: 0,
    duplicateIdCount: 0,
    outOfRangeCount: 0,
    unclosedRingCount: 0,
    zeroAreaRingCount: 0,
    duplicateVertexCount: 0,
    selfIntersectingRingCount: 0,
    selfIntersectionChecksSkipped: 0,
  };
  const geometryTypeCounts = new Map<string, number>();
  const dimensionCounts = new Map<number, number>();
  let positionCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const validatePosition = (
    raw: unknown,
    featureIndex: number,
    issuePath: string,
    dimSet: Set<number>,
  ): Position2D | null => {
    positionCount += 1;
    if (positionCount > MAX_COORDINATE_POSITIONS) {
      throw new Error(
        `validate_spatial_data resource limit exceeded: coordinate positions > ${MAX_COORDINATE_POSITIONS}`,
      );
    }
    pacedCheckpoint('coordinate traversal');
    if (
      !Array.isArray(raw) ||
      raw.length < 2 ||
      raw.some((ordinate) => typeof ordinate !== 'number' || !Number.isFinite(ordinate))
    ) {
      addIssue(
        'position_invalid',
        'error',
        featureIndex,
        issuePath,
        'position must be an array of at least two finite numbers',
      );
      return null;
    }
    dimSet.add(raw.length);
    dimensionCounts.set(raw.length, (dimensionCounts.get(raw.length) ?? 0) + 1);
    const x = raw[0] as number;
    const y = raw[1] as number;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (crs.rangeChecks && (x < -180 || x > 180 || y < -90 || y > 90)) {
      addIssue(
        'coordinate_out_of_range',
        'error',
        featureIndex,
        issuePath,
        'position is outside CRS84 longitude [-180, 180] / latitude [-90, 90] range',
      );
      metrics.outOfRangeCount += 1;
    }
    // Enclosure across every represented dimension for each active bbox
    // scope (root, feature, geometry). Axis loops are bounded by
    // MAX_BBOX_DIMENSIONS and paced through the shared checkpoint.
    for (const scope of activeBboxScopes) {
      scope.positions += 1;
      scope.dims.add(raw.length);
      const axes = Math.min(scope.mins.length, raw.length);
      for (let axis = 0; axis < axes; axis += 1) {
        pacedCheckpoint('bbox enclosure check');
        const ordinate = raw[axis] as number;
        const inside =
          axis === 0 && scope.crossing
            ? ordinate >= scope.mins[0] || ordinate <= scope.maxs[0]
            : ordinate >= scope.mins[axis] && ordinate <= scope.maxs[axis];
        if (!inside) {
          scope.violations += 1;
          break;
        }
      }
    }
    return [x, y];
  };

  const checkConsecutiveDuplicates = (raw: unknown[], featureIndex: number, issuePath: string): void => {
    let duplicates = 0;
    for (let index = 0; index + 1 < raw.length; index += 1) {
      pacedCheckpoint('duplicate vertex scan');
      if (equalPositions(raw[index], raw[index + 1])) duplicates += 1;
    }
    if (duplicates > 0) {
      addIssue(
        'duplicate_consecutive_vertices',
        'warning',
        featureIndex,
        issuePath,
        `${duplicates} consecutive duplicate vertex pair(s) detected`,
      );
      metrics.duplicateVertexCount += duplicates;
    }
  };

  const validatePositionArray = (
    raw: unknown,
    featureIndex: number,
    issuePath: string,
    dimSet: Set<number>,
  ): Array<Position2D | null> | null => {
    if (!Array.isArray(raw)) {
      addIssue('geometry_malformed', 'error', featureIndex, issuePath, 'coordinates must be an array of positions');
      return null;
    }
    return raw.map((entry, index) => validatePosition(entry, featureIndex, `${issuePath}[${index}]`, dimSet));
  };

  const validateLine = (raw: unknown, featureIndex: number, issuePath: string, dimSet: Set<number>): void => {
    const positions = validatePositionArray(raw, featureIndex, issuePath, dimSet);
    if (positions === null) return;
    if (positions.length < 2) {
      addIssue(
        'linestring_too_short',
        'error',
        featureIndex,
        issuePath,
        `LineString has ${positions.length} position(s); at least 2 are required`,
      );
    }
    checkConsecutiveDuplicates(raw as unknown[], featureIndex, issuePath);
  };

  const validateRing = (raw: unknown, featureIndex: number, issuePath: string, dimSet: Set<number>): void => {
    checkpoint('ring validation');
    const positions = validatePositionArray(raw, featureIndex, issuePath, dimSet);
    if (positions === null) return;
    const ring = raw as unknown[];
    if (ring.length < 4) {
      addIssue(
        'ring_too_short',
        'error',
        featureIndex,
        issuePath,
        `polygon ring has ${ring.length} position(s); at least 4 are required`,
      );
    }
    let closed = false;
    if (ring.length >= 2) {
      closed = equalPositions(ring[0], ring[ring.length - 1]);
      if (!closed) {
        addIssue(
          'ring_not_closed',
          'error',
          featureIndex,
          issuePath,
          'polygon ring first and last positions are not identical',
        );
        metrics.unclosedRingCount += 1;
      }
    }
    checkConsecutiveDuplicates(ring, featureIndex, issuePath);
    if (positions.some((position) => position === null) || ring.length < 4) return;
    const points = positions as Position2D[];

    const vertices = closed ? points.slice(0, -1) : points;
    if (vertices.length >= 3) {
      let doubledArea = 0;
      for (let index = 0; index < vertices.length; index += 1) {
        pacedCheckpoint('ring area computation');
        const a = vertices[index];
        const b = vertices[(index + 1) % vertices.length];
        doubledArea += a[0] * b[1] - b[0] * a[1];
      }
      if (doubledArea === 0) {
        addIssue(
          'ring_zero_area',
          'error',
          featureIndex,
          issuePath,
          'polygon ring has zero signed area (degenerate ring)',
        );
        metrics.zeroAreaRingCount += 1;
      }
    }

    const segmentCount = points.length - 1;
    if (segmentCount > MAX_SELF_INTERSECTION_SEGMENTS) {
      addIssue(
        'ring_self_intersection_check_skipped',
        'warning',
        featureIndex,
        issuePath,
        `ring has ${segmentCount} segments > ${MAX_SELF_INTERSECTION_SEGMENTS}; bounded self-intersection check skipped`,
      );
      metrics.selfIntersectionChecksSkipped += 1;
      return;
    }
    for (let i = 0; i < segmentCount; i += 1) {
      let found = false;
      for (let j = i + 2; j < segmentCount; j += 1) {
        if (i === 0 && j === segmentCount - 1) continue;
        pacedCheckpoint('ring self-intersection check');
        if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1])) {
          addIssue(
            'ring_self_intersection',
            'error',
            featureIndex,
            issuePath,
            `ring segments ${i} and ${j} intersect (bounded 2D check, not full OGC validity)`,
          );
          metrics.selfIntersectingRingCount += 1;
          found = true;
          break;
        }
      }
      if (found) break;
    }
  };

  // Returns the geometry's dimension union so enclosing GeometryCollections
  // can enforce collection-wide consistency without duplicating findings.
  const validateGeometry = (
    geometry: unknown,
    featureIndex: number,
    issuePath: string,
    depth: number,
  ): Set<number> => {
    checkpoint('geometry validation');
    if (!isObject(geometry) || typeof geometry.type !== 'string') {
      addIssue('geometry_malformed', 'error', featureIndex, issuePath, 'geometry must be an object with a string type');
      return new Set<number>();
    }
    if (!SUPPORTED_GEOMETRY_TYPES.has(geometry.type)) {
      // The raw type string is untrusted dataset content and is never echoed.
      addIssue(
        'geometry_type_unsupported',
        'error',
        featureIndex,
        issuePath,
        'geometry type is not a supported RFC 7946 geometry type',
      );
      return new Set<number>();
    }
    geometryTypeCounts.set(geometry.type, (geometryTypeCounts.get(geometry.type) ?? 0) + 1);
    // RFC 7946 permits a bbox on any geometry object, including collection
    // members; enclosure is scoped to this geometry's own positions.
    const geometryBboxScope =
      'bbox' in geometry ? openBboxScope(geometry.bbox, featureIndex, `${issuePath}.bbox`) : null;
    const dims = validateGeometryBody(geometry, featureIndex, issuePath, depth);
    if (geometryBboxScope) closeBboxScope(geometryBboxScope);
    return dims;
  };

  const validateGeometryBody = (
    geometry: JsonObject,
    featureIndex: number,
    issuePath: string,
    depth: number,
  ): Set<number> => {
    const geometryType = geometry.type as string;
    if (geometryType === 'GeometryCollection') {
      if (depth > MAX_GEOMETRY_COLLECTION_DEPTH) {
        throw new Error(
          `validate_spatial_data resource limit exceeded: GeometryCollection depth ${depth} > ${MAX_GEOMETRY_COLLECTION_DEPTH}`,
        );
      }
      if (!Array.isArray(geometry.geometries)) {
        addIssue(
          'geometry_malformed',
          'error',
          featureIndex,
          `${issuePath}.geometries`,
          'GeometryCollection geometries must be an array',
        );
        return new Set<number>();
      }
      // Collection-wide dimension consistency: emit one mismatch at the
      // collection path only when individually-consistent children disagree.
      // A child that is internally mixed already carries its own finding, so
      // the collection does not duplicate it.
      const collectionDims = new Set<number>();
      let childAlreadyMixed = false;
      geometry.geometries.forEach((child, index) => {
        const childDims = validateGeometry(child, featureIndex, `${issuePath}.geometries[${index}]`, depth + 1);
        if (childDims.size > 1) childAlreadyMixed = true;
        for (const dimension of childDims) collectionDims.add(dimension);
      });
      if (collectionDims.size > 1 && !childAlreadyMixed) {
        addIssue(
          'coordinate_dimension_mismatch',
          'error',
          featureIndex,
          issuePath,
          'coordinate dimensions are not consistent across GeometryCollection members',
        );
      }
      return collectionDims;
    }
    const dimSet = new Set<number>();
    const coordinatesPath = `${issuePath}.coordinates`;
    const coordinates = geometry.coordinates;
    switch (geometryType) {
      case 'Point':
        validatePosition(coordinates, featureIndex, coordinatesPath, dimSet);
        break;
      case 'MultiPoint': {
        const positions = validatePositionArray(coordinates, featureIndex, coordinatesPath, dimSet);
        if (positions !== null && positions.length === 0) {
          addIssue('geometry_empty', 'error', featureIndex, coordinatesPath, 'MultiPoint coordinates array is empty');
        }
        break;
      }
      case 'LineString':
        validateLine(coordinates, featureIndex, coordinatesPath, dimSet);
        break;
      case 'MultiLineString':
        if (!Array.isArray(coordinates)) {
          addIssue('geometry_malformed', 'error', featureIndex, coordinatesPath, 'coordinates must be an array of lines');
          break;
        }
        if (coordinates.length === 0) {
          addIssue(
            'geometry_empty',
            'error',
            featureIndex,
            coordinatesPath,
            'MultiLineString coordinates array is empty',
          );
          break;
        }
        coordinates.forEach((line, index) =>
          validateLine(line, featureIndex, `${coordinatesPath}[${index}]`, dimSet),
        );
        break;
      case 'Polygon':
        if (!Array.isArray(coordinates)) {
          addIssue('geometry_malformed', 'error', featureIndex, coordinatesPath, 'coordinates must be an array of rings');
          break;
        }
        if (coordinates.length === 0) {
          addIssue('geometry_empty', 'error', featureIndex, coordinatesPath, 'Polygon has no rings');
          break;
        }
        coordinates.forEach((ring, index) =>
          validateRing(ring, featureIndex, `${coordinatesPath}[${index}]`, dimSet),
        );
        break;
      case 'MultiPolygon':
        if (!Array.isArray(coordinates)) {
          addIssue(
            'geometry_malformed',
            'error',
            featureIndex,
            coordinatesPath,
            'coordinates must be an array of polygons',
          );
          break;
        }
        if (coordinates.length === 0) {
          addIssue('geometry_empty', 'error', featureIndex, coordinatesPath, 'MultiPolygon coordinates array is empty');
          break;
        }
        coordinates.forEach((polygon, polygonIndex) => {
          if (!Array.isArray(polygon)) {
            addIssue(
              'geometry_malformed',
              'error',
              featureIndex,
              `${coordinatesPath}[${polygonIndex}]`,
              'polygon must be an array of rings',
            );
            return;
          }
          if (polygon.length === 0) {
            addIssue(
              'geometry_empty',
              'error',
              featureIndex,
              `${coordinatesPath}[${polygonIndex}]`,
              'polygon ring array is empty',
            );
            return;
          }
          polygon.forEach((ring, ringIndex) =>
            validateRing(ring, featureIndex, `${coordinatesPath}[${polygonIndex}][${ringIndex}]`, dimSet),
          );
        });
        break;
    }
    if (dimSet.size > 1) {
      addIssue(
        'coordinate_dimension_mismatch',
        'error',
        featureIndex,
        issuePath,
        'coordinate dimensions are not consistent within this geometry',
      );
    }
    return dimSet;
  };

  if (!features.length) {
    addIssue('collection_empty', 'warning', null, 'features', 'FeatureCollection contains no features');
  }

  const seenIds = new Map<string, number>();
  features.forEach((feature, index) => {
    checkpoint('feature validation');
    if (!('id' in feature)) {
      addIssue('feature_id_missing', 'warning', index, 'id', 'feature has no id member');
      metrics.missingIdCount += 1;
    } else {
      const id = feature.id;
      if (typeof id === 'string' || typeof id === 'number') {
        const key = typeof id === 'string' ? `s:${id}` : `n:${canonicalJson(id)}`;
        const firstIndex = seenIds.get(key);
        if (firstIndex === undefined) {
          seenIds.set(key, index);
        } else {
          // The raw id value is untrusted dataset content and is never echoed;
          // the first occurrence index is the stable pointer instead.
          addIssue(
            'feature_id_duplicate',
            'error',
            index,
            'id',
            `feature id duplicates the id of feature ${firstIndex}`,
          );
          metrics.duplicateIdCount += 1;
        }
      } else {
        addIssue('feature_id_invalid_type', 'error', index, 'id', 'feature id must be a JSON string or number');
      }
    }
    // RFC 7946 permits a bbox on a Feature; its enclosure scope is the
    // feature's own geometry positions.
    const featureBboxScope = 'bbox' in feature ? openBboxScope(feature.bbox, index, 'bbox') : null;
    if (feature.geometry === null) {
      addIssue('geometry_null', 'warning', index, 'geometry', 'feature geometry is null');
      metrics.nullGeometryCount += 1;
    } else {
      validateGeometry(feature.geometry, index, 'geometry', 1);
    }
    if (featureBboxScope) closeBboxScope(featureBboxScope);
  });

  const extent: [number, number, number, number] | null = Number.isFinite(minX)
    ? [minX, minY, maxX, maxY]
    : null;
  bboxMetrics.computed_extent = extent;
  // Root bbox closure: dimensionality compatibility (2*n against the single
  // observed dimension when determinable; mixed dimensions are already
  // reported per geometry and leave compatibility undecidable — never
  // claimed valid) and the multi-dimensional enclosure verdict.
  if (rootBboxScope) {
    const closure = closeBboxScope(rootBboxScope);
    if (closure.declaredValid !== true) bboxMetrics.declared_valid = closure.declaredValid;
    bboxMetrics.encloses_computed = closure.encloses;
  }

  // Property-null profile and field schema in one bounded pass.
  const fieldStats = new Map<string, { occurrences: number; nulls: number; types: Set<string> }>();
  for (const feature of features) {
    pacedCheckpoint('property profiling');
    const properties = isObject(feature.properties) ? feature.properties : {};
    for (const [name, value] of Object.entries(properties)) {
      pacedCheckpoint('property profiling');
      let stats = fieldStats.get(name);
      if (!stats) {
        stats = { occurrences: 0, nulls: 0, types: new Set<string>() };
        fieldStats.set(name, stats);
      }
      stats.occurrences += 1;
      if (value === null) stats.nulls += 1;
      else stats.types.add(valueType(value));
    }
  }
  // Unsafe raw field names (empty, overlong, control-bearing, or
  // credential-shaped) are displayed everywhere as deterministic
  // non-reversible surrogates; per-field metrics stay keyed by the raw name so
  // distinct raw fields never merge. One bounded warning per affected field.
  const rawFieldNames = [...fieldStats.keys()].sort(compareStrings);
  const displayFields: Array<{ raw: string; display: string }> = rawFieldNames.map((raw) => {
    pacedCheckpoint('property profiling');
    if (isSafeFieldName(raw)) return { raw, display: raw };
    const display = surrogateFieldName(raw);
    addIssue(
      'property_field_name_sanitized',
      'warning',
      null,
      `properties.${display}`,
      'property field name was empty, overlong, control-bearing, or credential-like and is displayed as a deterministic surrogate',
    );
    return { raw, display };
  });
  displayFields.sort((a, b) => compareStrings(a.display, b.display) || compareStrings(a.raw, b.raw));
  const propertyNullProfile = displayFields.map(({ raw, display }) => {
    const stats = fieldStats.get(raw) as { occurrences: number; nulls: number; types: Set<string> };
    return {
      name: display,
      null_count: stats.nulls,
      missing_count: features.length - stats.occurrences,
    };
  });
  const schemaFields: GisMetadata['schema'] = displayFields.map(({ raw, display }) => {
    const stats = fieldStats.get(raw) as { occurrences: number; nulls: number; types: Set<string> };
    const types = [...stats.types].sort(compareStrings);
    return {
      name: display,
      types: types.length ? types : ['null'],
      nullable: stats.nulls > 0 || stats.occurrences < features.length,
    };
  });

  const checksRun = [...CHECKS_RUN_BASE, ...(crs.rangeChecks ? ['coordinate_range_crs84'] : [])].sort(
    compareStrings,
  );
  const checksNotRun = [
    ...UNSUPPORTED_CHECKS,
    ...(crs.rangeChecks
      ? []
      : [
          {
            id: 'coordinate_range_crs84',
            reason:
              'A legacy crs member names an unrecognized CRS; CRS84 longitude/latitude range assumptions were disabled.',
          },
        ]),
  ].sort((a, b) => compareStrings(a.id, b.id));

  checkpoint('report finalization');
  retainedIssues.sort(compareIssues);
  const returnedIssues = retainedIssues.slice(0, maxIssues);

  const retrievedAt = nowFn().toISOString();
  const sha256 = sha256Text(bytes);
  const sourceUri = pathToFileURL(path).href;

  const report = ValidationReportSchema.parse({
    schema_version: '1.0.0',
    source_uri: sourceUri,
    source_handle: path,
    retrieved_at: retrievedAt,
    file_sha256: sha256,
    file_size_bytes: bytes.byteLength,
    format: 'GeoJSON',
    crs: {
      declared: crs.declared,
      effective: crs.effective,
      axis_order: crs.axisOrder,
      units: crs.units,
      crs84_range_checks: crs.rangeChecks,
    },
    scope: { checks_run: checksRun, checks_not_run: checksNotRun },
    summary: {
      feature_count: features.length,
      coordinate_position_count: positionCount,
      error_count: errorCount,
      warning_count: warningCount,
      total_finding_count: totalFindingCount,
      returned_finding_count: returnedIssues.length,
      findings_truncated: totalFindingCount > returnedIssues.length,
      valid: errorCount === 0,
    },
    issues: returnedIssues,
    metrics: {
      null_geometry_count: metrics.nullGeometryCount,
      missing_id_count: metrics.missingIdCount,
      duplicate_id_count: metrics.duplicateIdCount,
      geometry_type_counts: [...geometryTypeCounts.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([type, count]) => ({ type, count })),
      coordinate_dimension_counts: [...dimensionCounts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([dimensions, count]) => ({ dimensions, count })),
      out_of_range_position_count: metrics.outOfRangeCount,
      unclosed_ring_count: metrics.unclosedRingCount,
      zero_area_ring_count: metrics.zeroAreaRingCount,
      duplicate_vertex_count: metrics.duplicateVertexCount,
      self_intersecting_ring_count: metrics.selfIntersectingRingCount,
      self_intersection_checks_skipped: metrics.selfIntersectionChecksSkipped,
      bbox: bboxMetrics,
      property_null_profile: propertyNullProfile,
    },
  });

  const gisMetadata: GisMetadata = {
    format: 'GeoJSON',
    crs: crs.effective,
    axis_order: crs.axisOrder,
    units: crs.units,
    extent,
    schema: schemaFields,
    row_count: features.length,
    geometry_types: [...geometryTypeCounts.keys()].sort(compareStrings),
    temporal_fields: [],
  };
  const parameters = {
    source_uri: sourceUri,
    max_bytes: maxBytes,
    max_features: maxFeatures,
    max_issues: maxIssues,
  };
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `validate_spatial_data:${sha256.slice(0, 16)}`,
    generated_at: retrievedAt,
    source: {
      uri: sourceUri,
      identity: { kind: 'file', value: path },
      // Deliberately empty: mtime varies across identical-byte checkouts and
      // would break same-byte evidence determinism.
      version: {},
      retrieved_at: retrievedAt,
      sha256,
    },
    gis_metadata: gisMetadata,
    parameters: { canonical_json: canonicalJson(parameters), sha256: sha256Canonical(parameters) },
    execution: {
      capability: 'validate_spatial_data',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'validation_report',
        sha256: sha256Canonical(report),
        validation: {
          // Truthful semantics: for this validation-report artifact, evidence
          // validity mirrors the dataset validation result so downstream
          // evidence consumers cannot mistake an invalid dataset for valid.
          valid: report.summary.valid,
          checks: ['input_schema', 'geojson_structure', 'validation_checks', 'output_schema'],
          warnings: [],
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
  return ValidateSpatialDataOutputSchema.parse({ schema_version: '1.0.0', report, evidence });
}

export const validateSpatialDataCapability: CapabilityDefinition<
  ValidateSpatialDataInput,
  ValidateSpatialDataOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'validate_spatial_data',
    name: 'Validate spatial data',
    description:
      'Read-only deterministic bounded structural and geometry QA of one allowlisted local RFC 7946 GeoJSON FeatureCollection; unsupported topology/domain checks are reported honestly.',
    version: '1.0.0',
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: [],
    allowed_sources: ['filesystem'],
    resource_limits: {
      max_records: MAX_FEATURES,
      max_bytes: MAX_BYTES,
      max_duration_ms: MAX_DURATION_MS,
      max_cost_usd: 0,
      max_coordinate_positions: MAX_COORDINATE_POSITIONS,
      max_returned_issues: MAX_ISSUES,
      max_geometry_collection_depth: MAX_GEOMETRY_COLLECTION_DEPTH,
      max_self_intersection_segments: MAX_SELF_INTERSECTION_SEGMENTS,
    },
    idempotency: { mode: 'deterministic', key_fields: ['source_uri', 'sha256'] },
    dry_run: { supported: false, reason: 'Read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_file_read_and_per_feature' },
    artifacts: [{ name: 'validation_report', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: { suite: 'gisbench', version: '0.1.0', supported_gis_versions: ['GeoJSON RFC 7946'] },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: ValidateSpatialDataInputSchema,
  outputSchema: ValidateSpatialDataOutputSchema,
  inputSummary: ['source_uri*', 'max_bytes', 'max_features', 'max_issues'],
  boundaryFields: ['source_uri'],
  execute: executeValidateSpatialData,
};
