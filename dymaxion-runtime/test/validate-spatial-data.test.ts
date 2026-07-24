import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { allCapabilities } from '../src/capabilities/registry.js';
import {
  DEFAULT_MAX_ISSUES,
  MAX_BYTES,
  MAX_COORDINATE_POSITIONS,
  MAX_DURATION_MS,
  MAX_FEATURES,
  MAX_GEOMETRY_COLLECTION_DEPTH,
  MAX_ISSUES,
  MAX_SELF_INTERSECTION_SEGMENTS,
  validateSpatialDataCapability,
  type ValidateSpatialDataOutput,
} from '../src/capabilities/validate-spatial-data.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../src/contracts/canonical.js';
import { CapabilityManifestSchema } from '../src/contracts/capability.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const fixtures = join(repoRoot, 'gisbench', 'fixtures');
const spatialFixtures = join(fixtures, 'spatial-validation');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const AGENT_RUN_ID = '00000000-0000-0000-0000-000000000001';
const FIXED_NOW = new Date('2026-07-20T12:00:00.000Z');

function testDependencies(overrides: Partial<RunSkillDependencies> = {}): RunSkillDependencies {
  return {
    recorder: {
      begin: async () => 'invocation-test',
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => FIXED_NOW,
      io: { stat, readFile },
    },
    ...overrides,
  };
}

async function validate(
  input: Record<string, unknown>,
  overrides: Partial<RunSkillDependencies> = {},
): Promise<{ ok: boolean; error?: string; output: ValidateSpatialDataOutput }> {
  const result = await runSkill('validate_spatial_data', input, AGENT_RUN_ID, testDependencies(overrides));
  return { ok: result.ok, error: result.error, output: result.output as ValidateSpatialDataOutput };
}

test('validate_spatial_data is a strict read-only versioned capability', () => {
  const manifest = validateSpatialDataCapability.manifest;
  assert.equal(manifest.slug, 'validate_spatial_data');
  assert.equal(manifest.classification, 'read');
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.allowed_hosts, []);
  assert.deepEqual(manifest.allowed_sources, ['filesystem']);
  assert.equal(manifest.resource_limits.max_bytes, MAX_BYTES);
  assert.equal(manifest.resource_limits.max_records, MAX_FEATURES);
  assert.equal(manifest.resource_limits.max_duration_ms, MAX_DURATION_MS);
  assert.equal(manifest.resource_limits.max_cost_usd, 0);
  // Every Phase 1D hard ceiling is traceable in the strict manifest.
  assert.equal(manifest.resource_limits.max_coordinate_positions, MAX_COORDINATE_POSITIONS);
  assert.equal(manifest.resource_limits.max_returned_issues, MAX_ISSUES);
  assert.equal(manifest.resource_limits.max_geometry_collection_depth, MAX_GEOMETRY_COLLECTION_DEPTH);
  assert.equal(manifest.resource_limits.max_self_intersection_segments, MAX_SELF_INTERSECTION_SEGMENTS);
  assert.throws(
    () =>
      CapabilityManifestSchema.parse({
        ...manifest,
        resource_limits: { ...manifest.resource_limits, bogus_limit: 1 },
      }),
    /unrecognized/i,
  );

  const schema = validateSpatialDataCapability.inputSchema;
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', unknown: true }), /unrecognized/i);
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', token: 'secret' }), /unrecognized/i);
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', max_issues: 0 }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', max_issues: MAX_ISSUES + 1 }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', max_bytes: MAX_BYTES + 1 }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', max_features: MAX_FEATURES + 1 }));
  assert.doesNotThrow(() => schema.parse({ source_uri: 'x.geojson' }));
  // Local-path-only input contract: URI/URL schemes, query/fragment forms,
  // control characters, and non-.geojson targets are schema rejections.
  assert.throws(() => schema.parse({ source_uri: 'https://demo-org.maps.arcgis.com/f.geojson' }));
  assert.throws(() => schema.parse({ source_uri: 'file:///tmp/f.geojson' }));
  assert.throws(() => schema.parse({ source_uri: 'data:application/geo+json,{}' }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson?f=json' }));
  assert.throws(() => schema.parse({ source_uri: 'bad\u0000path.geojson' }));
  assert.throws(() => schema.parse({ source_uri: 'x.json' }));
  assert.throws(() => schema.parse({ source_uri: `${'a'.repeat(5000)}.geojson` }));
  assert.doesNotThrow(() => schema.parse({ source_uri: './relative/path.geojson' }));
  assert.doesNotThrow(() => schema.parse({ source_uri: '/absolute/path.GeoJSON' }));

  assert.ok(allCapabilities().some((c) => c.manifest.slug === 'validate_spatial_data'));
  assert.equal(allCapabilities().length, 9);
});

test('valid polygon collection produces a clean deterministic report end-to-end', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'valid-polygon.geojson') });
  assert.equal(result.ok, true, result.error);
  assert.doesNotThrow(() => validateSpatialDataCapability.outputSchema.parse(result.output));
  assert.throws(
    () => validateSpatialDataCapability.outputSchema.parse({ ...(result.output as object), unexpected: true }),
    /unrecognized|unknown/i,
  );

  const report = result.output.report;
  assert.equal(report.schema_version, '1.0.0');
  assert.equal(report.format, 'GeoJSON');
  assert.deepEqual(report.issues, []);
  assert.equal(report.summary.valid, true);
  assert.equal(report.summary.feature_count, 2);
  assert.equal(report.summary.coordinate_position_count, 6);
  assert.equal(report.summary.error_count, 0);
  assert.equal(report.summary.warning_count, 0);
  assert.equal(report.summary.total_finding_count, 0);
  assert.equal(report.summary.returned_finding_count, 0);
  assert.equal(report.summary.findings_truncated, false);

  assert.deepEqual(report.crs, {
    declared: null,
    effective: 'OGC:CRS84',
    axis_order: 'longitude,latitude',
    units: 'degrees',
    crs84_range_checks: true,
  });

  assert.ok(report.scope.checks_run.includes('coordinate_range_crs84'));
  assert.ok(report.scope.checks_run.includes('ring_self_intersection_bounded'));
  assert.deepEqual([...report.scope.checks_run].sort(), report.scope.checks_run);
  const notRunIds = report.scope.checks_not_run.map((c) => c.id);
  assert.deepEqual(notRunIds, [
    'coded_value_domains',
    'cross_feature_topology',
    'ogc_simple_features_validity',
    'polygon_hole_containment',
  ]);
  for (const check of report.scope.checks_not_run) assert.ok(check.reason.length > 0);

  assert.deepEqual(report.metrics.bbox, {
    declared_present: true,
    declared_valid: true,
    computed_extent: [-105.1, 39.6, -104.9, 39.7],
    encloses_computed: true,
  });
  assert.deepEqual(report.metrics.geometry_type_counts, [
    { type: 'Point', count: 1 },
    { type: 'Polygon', count: 1 },
  ]);
  assert.deepEqual(report.metrics.coordinate_dimension_counts, [{ dimensions: 2, count: 6 }]);
  assert.deepEqual(report.metrics.property_null_profile, [
    { name: 'name', null_count: 0, missing_count: 0 },
    { name: 'zone', null_count: 1, missing_count: 0 },
  ]);
  assert.equal(result.output.evidence.execution.mode, 'deterministic');
  assert.equal(result.output.evidence.execution.capability, 'validate_spatial_data');
  assert.equal(result.output.evidence.outputs[0].validation.valid, true);
});

test('geometry defects are reported as stable sorted findings with valid=false', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'geometry-findings.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.equal(report.summary.valid, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [
      'coordinate_dimension_mismatch',
      'coordinate_out_of_range',
      'linestring_too_short',
      'ring_not_closed',
      'ring_self_intersection',
      'ring_zero_area',
      'duplicate_consecutive_vertices',
    ],
  );
  assert.equal(report.summary.error_count, 6);
  assert.equal(report.summary.warning_count, 1);
  assert.equal(report.summary.coordinate_position_count, 28);
  assert.equal(report.metrics.unclosed_ring_count, 1);
  assert.equal(report.metrics.zero_area_ring_count, 1);
  assert.equal(report.metrics.duplicate_vertex_count, 1);
  assert.equal(report.metrics.self_intersecting_ring_count, 1);
  assert.equal(report.metrics.self_intersection_checks_skipped, 0);
  assert.equal(report.metrics.out_of_range_position_count, 1);
  assert.deepEqual(report.metrics.coordinate_dimension_counts, [
    { dimensions: 2, count: 27 },
    { dimensions: 3, count: 1 },
  ]);
  // the bow-tie is the only self-intersection; the control square stays clean
  const intersections = report.issues.filter((issue) => issue.code === 'ring_self_intersection');
  assert.equal(intersections.length, 1);
  assert.equal(intersections[0].location.feature_index, 1);
  // truthful evidence semantics: artifact validity mirrors dataset validity
  assert.equal(result.output.evidence.outputs[0].validation.valid, false);
});

test('identifier and null QA findings use typed canonical ids', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'identifier-findings.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.equal(report.summary.valid, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['feature_id_duplicate', 'feature_id_invalid_type', 'feature_id_missing', 'geometry_null'],
  );
  // string "7" and number 7 are distinct typed canonical ids
  assert.equal(report.metrics.duplicate_id_count, 1);
  assert.equal(report.metrics.missing_id_count, 1);
  assert.equal(report.metrics.null_geometry_count, 1);
  assert.deepEqual(report.metrics.property_null_profile, [
    { name: 'owner', null_count: 1, missing_count: 3 },
    { name: 'status', null_count: 1, missing_count: 3 },
  ]);
});

test('legacy crs member disables CRS84 range assumptions and is reported honestly', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'legacy-crs.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  // Unrecognized legacy names are untrusted content and are never serialized.
  assert.deepEqual(report.crs, {
    declared: null,
    effective: null,
    axis_order: null,
    units: null,
    crs84_range_checks: false,
  });
  assert.ok(!JSON.stringify(result.output).includes('EPSG:3857'));
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['crs_member_deprecated'],
  );
  assert.equal(report.summary.valid, true);
  assert.equal(report.metrics.out_of_range_position_count, 0);
  assert.ok(!report.scope.checks_run.includes('coordinate_range_crs84'));
  assert.ok(report.scope.checks_not_run.some((c) => c.id === 'coordinate_range_crs84'));
});

test('declared bbox is validated structurally and against the computed extent', async () => {
  const mismatch = await validate({ source_uri: join(spatialFixtures, 'bbox-mismatch.geojson') });
  assert.equal(mismatch.ok, true, mismatch.error);
  assert.ok(mismatch.output.report.issues.some((issue) => issue.code === 'bbox_not_enclosing'));
  assert.equal(mismatch.output.report.metrics.bbox.declared_valid, true);
  assert.equal(mismatch.output.report.metrics.bbox.encloses_computed, false);
  assert.equal(mismatch.output.report.summary.valid, false);

  const invalid = await validate({ source_uri: join(spatialFixtures, 'bbox-invalid.geojson') });
  assert.equal(invalid.ok, true, invalid.error);
  assert.ok(invalid.output.report.issues.some((issue) => issue.code === 'bbox_invalid'));
  assert.equal(invalid.output.report.metrics.bbox.declared_valid, false);
  assert.equal(invalid.output.report.metrics.bbox.encloses_computed, null);
});

test('issues are stably sorted by severity/code/location before max_issues truncation', async () => {
  const source = join(spatialFixtures, 'sort-truncation.geojson');
  // Encounter order is warning (feature 0 missing id) before error (feature 1
  // unclosed ring); the error must survive truncation because sorting happens
  // before max_issues is applied.
  const result = await validate({ source_uri: source, max_issues: 1 });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.equal(report.summary.total_finding_count, 2);
  assert.equal(report.summary.returned_finding_count, 1);
  assert.equal(report.summary.findings_truncated, true);
  assert.equal(report.summary.error_count, 1);
  assert.equal(report.summary.warning_count, 1);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].code, 'ring_not_closed');
  assert.equal(report.issues[0].severity, 'error');
  assert.equal(report.summary.valid, false);
});

test('same bytes, options and fixed clock produce byte-identical report and evidence', async () => {
  const source = join(spatialFixtures, 'geometry-findings.geojson');
  const first = await validate({ source_uri: source });
  const second = await validate({ source_uri: source });
  assert.equal(first.ok, true, first.error);
  assert.equal(canonicalJson(first.output as unknown), canonicalJson(second.output as unknown));

  const evidence = first.output.evidence;
  const rawBytes = await readFile(source);
  assert.equal(evidence.source.sha256, sha256Text(rawBytes));
  assert.equal(evidence.outputs[0].name, 'validation_report');
  assert.equal(evidence.outputs[0].sha256, sha256Canonical(first.output.report));
  assert.equal(evidence.parameters.sha256, sha256Text(evidence.parameters.canonical_json));
  const parameters = JSON.parse(evidence.parameters.canonical_json) as Record<string, unknown>;
  assert.equal(parameters.max_bytes, MAX_BYTES);
  assert.equal(parameters.max_features, MAX_FEATURES);
  assert.equal(parameters.max_issues, DEFAULT_MAX_ISSUES);
  assert.equal(parameters.source_uri, first.output.report.source_uri);
});

test('coordinate values and raw property values never leak into findings or evidence', async () => {
  const geometry = await validate({ source_uri: join(spatialFixtures, 'geometry-findings.geojson') });
  assert.equal(geometry.ok, true, geometry.error);
  // 55.5555 is an interior vertex — never an extent bound — so it must not
  // appear anywhere in the serialized output.
  assert.ok(!JSON.stringify(geometry.output).includes('55.5555'));

  const identifiers = await validate({ source_uri: join(spatialFixtures, 'identifier-findings.geojson') });
  assert.equal(identifiers.ok, true, identifiers.error);
  assert.ok(!JSON.stringify(identifiers.output).includes('SECRET_PROPERTY_VALUE'));
});

test('malformed envelopes and unsupported formats fail closed', async () => {
  const badJson = await validate({ source_uri: join(fixtures, 'malformed.geojson') });
  assert.equal(badJson.ok, false);
  assert.match(badJson.error ?? '', /malformed GeoJSON/i);

  const notCollection = await validate({ source_uri: join(spatialFixtures, 'not-a-collection.geojson') });
  assert.equal(notCollection.ok, false);
  assert.match(notCollection.error ?? '', /malformed GeoJSON/i);

  const badFeature = await validate({ source_uri: join(spatialFixtures, 'bad-feature.geojson') });
  assert.equal(badFeature.ok, false);
  assert.match(badFeature.error ?? '', /malformed GeoJSON/i);

  const unsupported = await validate({ source_uri: join(fixtures, 'unsupported.csv') });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error ?? '', /unsupported dataset format/i);
});

test('byte, feature, coordinate and depth ceilings are hard failures', async () => {
  const source = join(spatialFixtures, 'valid-polygon.geojson');
  const oversizedBytes = await validate({ source_uri: source, max_bytes: 64 });
  assert.equal(oversizedBytes.ok, false);
  assert.match(oversizedBytes.error ?? '', /resource limit/i);

  const tooManyFeatures = await validate({ source_uri: source, max_features: 1 });
  assert.equal(tooManyFeatures.ok, false);
  assert.match(tooManyFeatures.error ?? '', /resource limit/i);

  const virtualPath = join(spatialFixtures, 'virtual-oversized.geojson');
  const positions = `${'[0,0],'.repeat(MAX_COORDINATE_POSITIONS)}[0,0]`;
  const oversizedGeojson = Buffer.from(
    `{"type":"FeatureCollection","features":[{"type":"Feature","id":"big","properties":{},` +
      `"geometry":{"type":"MultiPoint","coordinates":[${positions}]}}]}`,
  );
  assert.ok(oversizedGeojson.byteLength <= MAX_BYTES, 'virtual fixture must stay under the byte cap');
  const tooManyCoordinates = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => ({ size: oversizedGeojson.byteLength, mtime: FIXED_NOW }),
          readFile: async () => oversizedGeojson,
        },
      },
    },
  );
  assert.equal(tooManyCoordinates.ok, false);
  assert.match(tooManyCoordinates.error ?? '', /resource limit/i);
  assert.match(tooManyCoordinates.error ?? '', /coordinate/i);

  const tooDeep = await validate({ source_uri: join(spatialFixtures, 'deep-collection.geojson') });
  assert.equal(tooDeep.ok, false);
  assert.match(tooDeep.error ?? '', /resource limit/i);
  assert.match(tooDeep.error ?? '', new RegExp(`depth \\d+ > ${MAX_GEOMETRY_COLLECTION_DEPTH}`));
});

test('cancellation and deadline are honored before, after and during validation', async () => {
  const source = join(spatialFixtures, 'valid-polygon.geojson');

  const preAborted = new AbortController();
  preAborted.abort();
  const cancelledBefore = await validate(
    { source_uri: source },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: { stat, readFile },
        signal: preAborted.signal,
      },
    },
  );
  assert.equal(cancelledBefore.ok, false);
  assert.match(cancelledBefore.error ?? '', /cancelled/i);

  const midAbort = new AbortController();
  const cancelledAfterRead = await validate(
    { source_uri: source },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        signal: midAbort.signal,
        io: {
          stat,
          readFile: async (path: string) => {
            const bytes = await readFile(path);
            midAbort.abort();
            return bytes;
          },
        },
      },
    },
  );
  assert.equal(cancelledAfterRead.ok, false);
  assert.match(cancelledAfterRead.error ?? '', /cancelled/i);

  let tick = 0;
  const advancingClock = (): Date => new Date(FIXED_NOW.getTime() + tick++ * (MAX_DURATION_MS + 5_000));
  const pastDeadline = await validate(
    { source_uri: source },
    { capabilityContext: { now: advancingClock, io: { stat, readFile } } },
  );
  assert.equal(pastDeadline.ok, false);
  assert.match(pastDeadline.error ?? '', /resource limit/i);
  assert.match(pastDeadline.error ?? '', /duration/i);
});

test('raw feature ids and geometry type values never survive into output or errors', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'value-canaries.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  const duplicate = report.issues.find((issue) => issue.code === 'feature_id_duplicate');
  const unsupported = report.issues.find((issue) => issue.code === 'geometry_type_unsupported');
  assert.ok(duplicate, 'duplicate id finding expected');
  assert.equal(duplicate?.location.feature_index, 1);
  assert.match(duplicate?.message ?? '', /duplicates the id of feature 0/);
  assert.ok(unsupported, 'unsupported geometry type finding expected');
  assert.equal(unsupported?.location.feature_index, 2);
  assert.equal(report.summary.valid, false);
  // The untrusted id and type values must not survive anywhere in the output.
  const serialized = JSON.stringify(result.output);
  assert.ok(!serialized.includes('ID_CANARY_ALPHA'));
  assert.ok(!serialized.includes('TYPE_CANARY_OMEGA'));
  assert.ok(!(result.error ?? '').includes('ID_CANARY_ALPHA'));
  assert.ok(!(result.error ?? '').includes('TYPE_CANARY_OMEGA'));
  // Unsupported types are never admitted into geometry type counts either.
  assert.deepEqual(report.metrics.geometry_type_counts, [{ type: 'Point', count: 2 }]);
});

test('bounded top-K retention equals full-sort-then-truncate at high finding counts', async () => {
  const WARNING_FEATURES = 1_500;
  const ERROR_FEATURES = 300;
  const warningFeatures = Array.from(
    { length: WARNING_FEATURES },
    (_, i) =>
      `{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[${i % 90},1]}}`,
  );
  const errorFeatures = Array.from(
    { length: ERROR_FEATURES },
    (_, i) =>
      `{"type":"Feature","id":"err-${i}","properties":{},` +
      `"geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}}`,
  );
  const bytes = Buffer.from(
    `{"type":"FeatureCollection","features":[${[...warningFeatures, ...errorFeatures].join(',')}]}`,
  );
  assert.ok(bytes.byteLength <= MAX_BYTES);
  const io = {
    stat: async () => ({ size: bytes.byteLength, mtime: FIXED_NOW }),
    readFile: async () => bytes,
  };
  const virtualPath = join(spatialFixtures, 'virtual-many-findings.geojson');

  // Warnings are all encountered before errors; the errors must still be the
  // exclusive survivors under the default ceiling because selection matches
  // sorting the full logical finding set before truncation.
  const truncated = await validate(
    { source_uri: virtualPath },
    { capabilityContext: { now: () => FIXED_NOW, io } },
  );
  assert.equal(truncated.ok, true, truncated.error);
  const report = truncated.output.report;
  assert.equal(report.summary.total_finding_count, WARNING_FEATURES + ERROR_FEATURES);
  assert.equal(report.summary.error_count, ERROR_FEATURES);
  assert.equal(report.summary.warning_count, WARNING_FEATURES);
  assert.equal(report.summary.returned_finding_count, DEFAULT_MAX_ISSUES);
  assert.equal(report.summary.findings_truncated, true);
  assert.equal(report.summary.valid, false);
  assert.equal(report.issues.length, DEFAULT_MAX_ISSUES);
  report.issues.forEach((issue, index) => {
    assert.equal(issue.code, 'ring_not_closed');
    assert.equal(issue.location.feature_index, WARNING_FEATURES + index);
  });

  // Stable-order control at a larger ceiling: all errors first (sorted by
  // feature index), then the earliest warnings, exactly as a full sort yields.
  const widened = await validate(
    { source_uri: virtualPath, max_issues: 1000 },
    { capabilityContext: { now: () => FIXED_NOW, io } },
  );
  assert.equal(widened.ok, true, widened.error);
  const widenedReport = widened.output.report;
  assert.equal(widenedReport.issues.length, 1000);
  assert.equal(widenedReport.issues[0].code, 'ring_not_closed');
  assert.equal(widenedReport.issues[0].location.feature_index, WARNING_FEATURES);
  assert.equal(widenedReport.issues[ERROR_FEATURES - 1].code, 'ring_not_closed');
  assert.equal(widenedReport.issues[ERROR_FEATURES - 1].location.feature_index, WARNING_FEATURES + ERROR_FEATURES - 1);
  assert.equal(widenedReport.issues[ERROR_FEATURES].code, 'feature_id_missing');
  assert.equal(widenedReport.issues[ERROR_FEATURES].location.feature_index, 0);
  assert.equal(widenedReport.issues[999].code, 'feature_id_missing');
  assert.equal(widenedReport.issues[999].location.feature_index, 1000 - ERROR_FEATURES - 1);
  assert.equal(widenedReport.summary.total_finding_count, WARNING_FEATURES + ERROR_FEATURES);
});

test('empty geometry coordinate containers are stable errors; null geometry stays a warning', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'empty-geometries.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.deepEqual(
    report.issues.map((issue) => [issue.code, issue.severity, issue.location.feature_index]),
    [
      ['geometry_empty', 'error', 0],
      ['geometry_empty', 'error', 1],
      ['geometry_empty', 'error', 2],
      ['geometry_empty', 'error', 3],
      ['geometry_empty', 'error', 4],
      ['geometry_null', 'warning', 5],
    ],
  );
  const emptyPolygonRingArray = report.issues[4];
  assert.equal(emptyPolygonRingArray.location.path, 'geometry.coordinates[0]');
  assert.equal(report.metrics.null_geometry_count, 1);
  assert.equal(report.summary.valid, false);
});

test('cancellation is honored during property profiling traversal', async () => {
  const propertyEntries = Array.from({ length: 300 }, (_, i) => `"k${String(i).padStart(3, '0')}":${i}`);
  const bytes = Buffer.from(
    `{"type":"FeatureCollection","features":[{"type":"Feature","id":"p1",` +
      `"properties":{${propertyEntries.join(',')}},"geometry":null}]}`,
  );
  // Signal reads before the property loop: execute start, file stat,
  // file read (before and after), json parse, and the first feature-loop
  // checkpoint — the seventh read lands inside property profiling. The
  // asserted stage name below catches any drift in this accounting.
  let aborted = 0;
  const lateSignal = {
    get aborted(): boolean {
      aborted += 1;
      return aborted > 6;
    },
  } as unknown as AbortSignal;
  const result = await validate(
    { source_uri: join(spatialFixtures, 'virtual-many-properties.geojson') },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        signal: lateSignal,
        io: {
          stat: async () => ({ size: bytes.byteLength, mtime: FIXED_NOW }),
          readFile: async () => bytes,
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /cancelled during property profiling/);
});

test('antimeridian-crossing bboxes are verified for CRS84 and reported honestly otherwise', async () => {
  const enclosing = await validate({ source_uri: join(spatialFixtures, 'antimeridian-enclosing.geojson') });
  assert.equal(enclosing.ok, true, enclosing.error);
  assert.deepEqual(enclosing.output.report.issues, []);
  assert.deepEqual(enclosing.output.report.metrics.bbox, {
    declared_present: true,
    declared_valid: true,
    computed_extent: [-178, 0, 175, 5],
    encloses_computed: true,
  });
  assert.equal(enclosing.output.report.summary.valid, true);

  const nonEnclosing = await validate({ source_uri: join(spatialFixtures, 'antimeridian-nonenclosing.geojson') });
  assert.equal(nonEnclosing.ok, true, nonEnclosing.error);
  assert.ok(nonEnclosing.output.report.issues.some((issue) => issue.code === 'bbox_not_enclosing'));
  assert.equal(nonEnclosing.output.report.metrics.bbox.encloses_computed, false);
  assert.equal(nonEnclosing.output.report.summary.valid, false);

  // Crossing bbox under a non-CRS84 legacy crs cannot be verified — that is a
  // warning finding, never a silent null.
  const unverified = await validate({ source_uri: join(spatialFixtures, 'antimeridian-unverified.geojson') });
  assert.equal(unverified.ok, true, unverified.error);
  assert.deepEqual(
    unverified.output.report.issues.map((issue) => issue.code),
    ['bbox_enclosure_unverified', 'crs_member_deprecated'],
  );
  assert.equal(unverified.output.report.metrics.bbox.encloses_computed, null);
  assert.equal(unverified.output.report.summary.valid, true);
});

test('identical bytes and options with different adapter mtimes are byte-identical in report AND evidence', async () => {
  const source = join(spatialFixtures, 'valid-polygon.geojson');
  const bytes = await readFile(source);
  const run = (mtime: Date) =>
    validate(
      { source_uri: source },
      {
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => ({ size: bytes.byteLength, mtime }),
            readFile: async () => bytes,
          },
        },
      },
    );
  const first = await run(new Date('2020-01-01T00:00:00.000Z'));
  const second = await run(new Date('2031-12-31T23:59:59.000Z'));
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(canonicalJson(first.output as unknown), canonicalJson(second.output as unknown));
  // mtime is deliberately absent from this capability's evidence.
  assert.deepEqual(first.output.evidence.source.version, {});
});

test('unrecognized legacy crs names are never serialized into output, evidence or errors', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'crs-canary.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.deepEqual(report.crs, {
    declared: null,
    effective: null,
    axis_order: null,
    units: null,
    crs84_range_checks: false,
  });
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['crs_member_deprecated'],
  );
  assert.ok(report.scope.checks_not_run.some((check) => check.id === 'coordinate_range_crs84'));
  assert.ok(!JSON.stringify(result.output).includes('CRSCANARY'));
  assert.ok(!(result.error ?? '').includes('CRSCANARY'));
  assert.equal(result.output.evidence.gis_metadata.crs, null);
});

test('unsafe property field names become deterministic surrogates without leaking raw content', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'property-canaries.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  const serialized = JSON.stringify(result.output);
  assert.ok(!serialized.includes('FIELDCANARY'));
  assert.ok(!serialized.includes('client_secret'));
  assert.ok(!serialized.includes('token='));
  assert.ok(!(result.error ?? '').includes('FIELDCANARY'));

  const profile = report.metrics.property_null_profile;
  assert.equal(profile.length, 5);
  const surrogateEntries = profile.filter((field) => /^field_sha256_[a-f0-9]{64}$/.test(field.name));
  assert.equal(surrogateEntries.length, 4);
  // distinct raw fields never merge
  assert.equal(new Set(surrogateEntries.map((field) => field.name)).size, 4);
  assert.ok(profile.some((field) => field.name === 'depth_m'));
  for (const entry of profile) {
    assert.equal(entry.null_count, 0);
    assert.equal(entry.missing_count, 0);
  }

  const warnings = report.issues.filter((issue) => issue.code === 'property_field_name_sanitized');
  assert.equal(warnings.length, 4);
  for (const warning of warnings) {
    assert.match(warning.location.path, /^properties\.field_sha256_[a-f0-9]{64}$/);
  }
  assert.equal(report.summary.valid, true);

  // evidence GIS metadata carries the same sanitized display names
  const schemaNames = result.output.evidence.gis_metadata.schema.map((field) => field.name);
  assert.deepEqual([...schemaNames].sort(), profile.map((field) => field.name).sort());
});

test('an empty property name validates successfully through the surrogate path', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'empty-property-name.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.equal(report.summary.valid, true);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['property_field_name_sanitized'],
  );
  assert.equal(report.metrics.property_null_profile.length, 1);
  const entry = report.metrics.property_null_profile[0];
  assert.match(entry.name, /^field_sha256_[a-f0-9]{64}$/);
  assert.equal(entry.null_count, 1);
  assert.equal(entry.missing_count, 0);
  assert.doesNotThrow(() => validateSpatialDataCapability.outputSchema.parse(result.output));
});

test('reserved surrogate namespace keeps display names unique without leaking raw content', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'surrogate-collision.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  const profile = report.metrics.property_null_profile;
  assert.equal(profile.length, 3);
  assert.equal(new Set(profile.map((field) => field.name)).size, 3);
  assert.ok(profile.some((field) => field.name === 'ok_name'));

  const emptySurrogate = `field_sha256_${sha256Text('')}`;
  const literalSurrogate = `field_sha256_${sha256Text('field_sha256_deadbeefdeadbeef')}`;
  assert.notEqual(emptySurrogate, literalSurrogate);
  const emptyEntry = profile.find((field) => field.name === emptySurrogate);
  const literalEntry = profile.find((field) => field.name === literalSurrogate);
  assert.ok(emptyEntry, 'empty raw field must surface under its full-digest surrogate');
  assert.ok(literalEntry, 'surrogate-shaped raw field must itself be surrogated');
  assert.equal(emptyEntry?.null_count, 1);
  assert.equal(emptyEntry?.missing_count, 0);
  assert.equal(literalEntry?.null_count, 0);

  // the raw surrogate-shaped name never survives serialization
  assert.ok(!JSON.stringify(result.output).includes('deadbeef'));
  const warnings = report.issues.filter((issue) => issue.code === 'property_field_name_sanitized');
  assert.equal(warnings.length, 2);
});

test('non-local source_uri forms are rejected before recorder or any I/O', async () => {
  const attempts = [
    'https://demo-org.maps.arcgis.com/file.geojson?token=URL_CANARY',
    'https://demo-org.maps.arcgis.com/file.geojson',
    `file://${join(spatialFixtures, 'valid-polygon.geojson')}`,
    'data:application/geo+json;base64,eyJ0eXBlIjoi',
  ];
  for (const source of attempts) {
    let began = 0;
    let ioCalls = 0;
    const result = await validate(
      { source_uri: source },
      {
        recorder: {
          begin: async () => {
            began += 1;
            return 'should-not-begin';
          },
          finish: async () => undefined,
        },
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => {
              ioCalls += 1;
              return { size: 1, mtime: FIXED_NOW };
            },
            readFile: async () => {
              ioCalls += 1;
              return Buffer.from('{}');
            },
          },
        },
      },
    );
    assert.equal(result.ok, false, `expected rejection for ${source.slice(0, 20)}...`);
    assert.ok(!(result.error ?? '').includes('URL_CANARY'));
    assert.ok(!(result.error ?? '').includes('arcgis.com'));
    assert.equal(began, 0);
    assert.equal(ioCalls, 0);
  }
  // ordinary local relative paths keep working end-to-end
  const relativeSource = relative(process.cwd(), join(spatialFixtures, 'valid-polygon.geojson'));
  const ok = await validate({ source_uri: relativeSource });
  assert.equal(ok.ok, true, ok.error);
});

test('credential-shaped local paths are rejected before audit, recorder, or I/O without echo', async () => {
  const attempts = [
    {
      source: '/private/tmp/access_token=BOUNDARYCANARY.geojson',
      canary: 'BOUNDARYCANARY',
    },
    {
      source: join(spatialFixtures, 'access_token=PATHCANARY.geojson'),
      canary: 'PATHCANARY',
    },
    {
      source: join(spatialFixtures, 'api_key%3DENCODEDCANARY.geojson'),
      canary: 'ENCODEDCANARY',
    },
    {
      source: join(spatialFixtures, 'client_secret%253DDOUBLECANARY.geojson'),
      canary: 'DOUBLECANARY',
    },
    {
      source: join(spatialFixtures, 'access_token%2525253DFOURCANARY.geojson'),
      canary: 'FOURCANARY',
    },
    {
      source: join(spatialFixtures, 'access_token%ZZ%253DINTERPOSECANARY.geojson'),
      canary: 'INTERPOSECANARY',
    },
    {
      source: join(spatialFixtures, 'Bearer%ZZ%2520INTERPOSEBEARER.geojson'),
      canary: 'INTERPOSEBEARER',
    },
    {
      source: join(spatialFixtures, 'access_token%C0%AE%3DUTF8CANARY.geojson'),
      canary: 'UTF8CANARY',
    },
    {
      source: join(spatialFixtures, 'access_token%C0%AE%253DUTF8NESTEDCANARY.geojson'),
      canary: 'UTF8NESTEDCANARY',
    },
    {
      source: join(spatialFixtures, 'Bearer%C0%AE%20UTF8BEARER.geojson'),
      canary: 'UTF8BEARER',
    },
    {
      source: join(spatialFixtures, 'Authorization%20Bearer%20AUTHCANARY.geojson'),
      canary: 'AUTHCANARY',
    },
  ];

  for (const { source, canary } of attempts) {
    let began = 0;
    let ioCalls = 0;
    const boundaryAudits: unknown[] = [];
    const result = await validate(
      { source_uri: source },
      {
        recorder: {
          begin: async () => {
            began += 1;
            return 'should-not-begin';
          },
          finish: async () => undefined,
        },
        boundaryOptions: {
          audit: async (...args: unknown[]) => {
            boundaryAudits.push(args);
          },
        },
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => {
              ioCalls += 1;
              return { size: 1, mtime: FIXED_NOW };
            },
            readFile: async () => {
              ioCalls += 1;
              return Buffer.from('{}');
            },
          },
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(
      result.error ?? '',
      /source_uri must (?:not contain credential-shaped path text|use a raw local filesystem path without percent escapes)/,
    );
    assert.equal(began, 0);
    assert.equal(ioCalls, 0);
    assert.deepEqual(boundaryAudits, []);

    const serialized = JSON.stringify({ result, boundaryAudits });
    assert.ok(!serialized.includes(canary), `rejection must not echo ${canary}`);
    assert.ok(!serialized.includes(source), 'rejection must not echo the source path');
  }
});

test('ordinary credential-ish filename words remain valid local paths', async () => {
  const benignNames = [
    'token-inventory.geojson',
    'password-reset-zones.geojson',
    'authorization-codebook.geojson',
    'key-signature-index.geojson',
    'district map.geojson',
    'café inventory.geojson',
  ];
  const bytes = Buffer.from(
    '{"type":"FeatureCollection","features":[{"type":"Feature","id":"ok","properties":{},' +
      '"geometry":{"type":"Point","coordinates":[1,1]}}]}',
  );

  for (const name of benignNames) {
    let began = 0;
    let statCalls = 0;
    let readCalls = 0;
    const result = await validate(
      { source_uri: join(spatialFixtures, name) },
      {
        recorder: {
          begin: async () => {
            began += 1;
            return 'benign-invocation';
          },
          finish: async () => undefined,
        },
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => {
              statCalls += 1;
              return { size: bytes.byteLength, mtime: FIXED_NOW };
            },
            readFile: async () => {
              readCalls += 1;
              return bytes;
            },
          },
        },
      },
    );

    assert.equal(result.ok, true, result.error);
    assert.equal(began, 1);
    assert.equal(statCalls, 1);
    assert.equal(readCalls, 1);
    assert.equal(result.output.report.summary.valid, true);
  }
});

test('direct capability execution re-asserts the filesystem boundary at each I/O sink', async () => {
  let ioCalls = 0;
  const countingIo = {
    stat: async () => {
      ioCalls += 1;
      return { size: 1, mtime: FIXED_NOW };
    },
    readFile: async () => {
      ioCalls += 1;
      return Buffer.from('{}');
    },
  };
  const directContext = {
    now: () => FIXED_NOW,
    io: countingIo,
    boundary: { audit: async () => undefined },
  };

  // Disallowed plain path, bypassing the executor preflight entirely.
  await assert.rejects(
    validateSpatialDataCapability.execute(
      { source_uri: '/private/tmp/dymaxion-disallowed.geojson' },
      directContext,
    ),
    /boundary violation/i,
  );
  assert.equal(ioCalls, 0);

  // Symlink inside the allowlisted root escaping to an outside .geojson file.
  const outsideDir = await mkdtemp(join(tmpdir(), 'dymaxion-escape-'));
  const outsideFile = join(outsideDir, 'outside.geojson');
  const linkPath = join(spatialFixtures, 'escape-link.geojson');
  try {
    await writeFile(outsideFile, '{"type":"FeatureCollection","features":[]}');
    await symlink(outsideFile, linkPath);
    await assert.rejects(
      validateSpatialDataCapability.execute({ source_uri: linkPath }, directContext),
      /boundary violation/i,
    );
    assert.equal(ioCalls, 0);
  } finally {
    await rm(linkPath, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('cancellation and deadline guard stat, read, parse and root-validation checkpoints', async () => {
  const source = join(spatialFixtures, 'valid-polygon.geojson');

  // abort during stat → zero reads
  let reads = 0;
  const statAbort = new AbortController();
  const cancelledAtStat = await validate(
    { source_uri: source },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        signal: statAbort.signal,
        io: {
          stat: async (path: string) => {
            const result = await stat(path);
            statAbort.abort();
            return result;
          },
          readFile: async (path: string) => {
            reads += 1;
            return readFile(path);
          },
        },
      },
    },
  );
  assert.equal(cancelledAtStat.ok, false);
  assert.match(cancelledAtStat.error ?? '', /cancelled during file stat/);
  assert.equal(reads, 0);

  // deadline elapsed by stat time → zero reads
  let slowStatReads = 0;
  let statTick = 0;
  const slowStatClock = (): Date => new Date(FIXED_NOW.getTime() + statTick++ * (MAX_DURATION_MS + 1_000));
  const deadlineAtStat = await validate(
    { source_uri: source },
    {
      capabilityContext: {
        now: slowStatClock,
        io: {
          stat,
          readFile: async (path: string) => {
            slowStatReads += 1;
            return readFile(path);
          },
        },
      },
    },
  );
  assert.equal(deadlineAtStat.ok, false);
  assert.match(deadlineAtStat.error ?? '', /resource limit/i);
  assert.match(deadlineAtStat.error ?? '', /file stat/);
  assert.equal(slowStatReads, 0);

  // deadline crossing before parse beats the malformed-JSON error
  let readTick = 0;
  const slowReadClock = (): Date => new Date(FIXED_NOW.getTime() + readTick++ * 3_000);
  const deadlineBeforeParse = await validate(
    { source_uri: join(fixtures, 'malformed.geojson') },
    { capabilityContext: { now: slowReadClock, io: { stat, readFile } } },
  );
  assert.equal(deadlineBeforeParse.ok, false);
  assert.match(deadlineBeforeParse.error ?? '', /duration/);
  assert.ok(!(deadlineBeforeParse.error ?? '').includes('malformed'));

  // deadline crossing after parse beats the root-invalid error
  let parseTick = 0;
  const slowParseClock = (): Date => new Date(FIXED_NOW.getTime() + parseTick++ * 1_300);
  const deadlineAfterParse = await validate(
    { source_uri: join(spatialFixtures, 'not-a-collection.geojson') },
    { capabilityContext: { now: slowParseClock, io: { stat, readFile } } },
  );
  assert.equal(deadlineAfterParse.ok, false);
  assert.match(deadlineAfterParse.error ?? '', /duration/);
  assert.match(deadlineAfterParse.error ?? '', /json parse/);
  assert.ok(!(deadlineAfterParse.error ?? '').includes('malformed'));
});

test('GeometryCollection dimension consistency is enforced without duplicate findings', async () => {
  const mixedChildren = await validate({ source_uri: join(spatialFixtures, 'gc-mixed-dimensions.geojson') });
  assert.equal(mixedChildren.ok, true, mixedChildren.error);
  const mixedReport = mixedChildren.output.report;
  const mixedFindings = mixedReport.issues.filter((issue) => issue.code === 'coordinate_dimension_mismatch');
  assert.equal(mixedFindings.length, 1);
  assert.equal(mixedFindings[0].location.path, 'geometry');
  assert.equal(mixedFindings[0].location.feature_index, 0);
  assert.equal(mixedReport.summary.valid, false);
  assert.deepEqual(mixedReport.metrics.coordinate_dimension_counts, [
    { dimensions: 2, count: 1 },
    { dimensions: 3, count: 1 },
  ]);

  // An internally mixed child carries its own finding; the collection does
  // not duplicate it.
  const mixedChild = await validate({ source_uri: join(spatialFixtures, 'gc-child-mixed-dimensions.geojson') });
  assert.equal(mixedChild.ok, true, mixedChild.error);
  const childFindings = mixedChild.output.report.issues.filter(
    (issue) => issue.code === 'coordinate_dimension_mismatch',
  );
  assert.equal(childFindings.length, 1);
  assert.equal(childFindings[0].location.path, 'geometry.geometries[0]');
  assert.equal(mixedChild.output.report.summary.valid, false);
});

test('bbox length must match observed coordinate dimensionality', async () => {
  const sixOn2d = await validate({ source_uri: join(spatialFixtures, 'bbox-dim-2d-6.geojson') });
  assert.equal(sixOn2d.ok, true, sixOn2d.error);
  assert.ok(sixOn2d.output.report.issues.some((issue) => issue.code === 'bbox_dimension_mismatch'));
  assert.equal(sixOn2d.output.report.metrics.bbox.declared_valid, false);
  assert.equal(sixOn2d.output.report.metrics.bbox.encloses_computed, null);
  assert.equal(sixOn2d.output.report.summary.valid, false);

  const fourOn3d = await validate({ source_uri: join(spatialFixtures, 'bbox-dim-3d-4.geojson') });
  assert.equal(fourOn3d.ok, true, fourOn3d.error);
  assert.ok(fourOn3d.output.report.issues.some((issue) => issue.code === 'bbox_dimension_mismatch'));
  assert.equal(fourOn3d.output.report.metrics.bbox.declared_valid, false);
  assert.equal(fourOn3d.output.report.summary.valid, false);
});

test('CRS84 bbox values must be within longitude/latitude ranges', async () => {
  const outOfRange = await validate({ source_uri: join(spatialFixtures, 'bbox-crs84-out-of-range.geojson') });
  assert.equal(outOfRange.ok, true, outOfRange.error);
  assert.deepEqual(
    outOfRange.output.report.issues.map((issue) => issue.code),
    ['bbox_out_of_range'],
  );
  assert.equal(outOfRange.output.report.metrics.bbox.declared_valid, false);
  assert.equal(outOfRange.output.report.metrics.bbox.encloses_computed, null);
  assert.equal(outOfRange.output.report.summary.valid, false);

  // valid antimeridian crossing (west > east, all values in range) still passes
  const crossing = await validate({ source_uri: join(spatialFixtures, 'antimeridian-enclosing.geojson') });
  assert.equal(crossing.ok, true, crossing.error);
  assert.deepEqual(crossing.output.report.issues, []);
  assert.equal(crossing.output.report.metrics.bbox.declared_valid, true);
});

test('adapter stat/read exceptions are replaced by fixed non-echoing messages', async () => {
  const virtualPath = join(spatialFixtures, 'virtual-missing.geojson');
  const statFailure = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => {
            throw new Error(
              "ENOENT: no such file or directory, stat '/secret/TOKEN_CANARY_PATH.geojson?token=STATCANARY'",
            );
          },
          readFile: async () => Buffer.from('{}'),
        },
      },
    },
  );
  assert.equal(statFailure.ok, false);
  assert.match(statFailure.error ?? '', /file stat failed/);
  for (const canary of ['TOKEN_CANARY_PATH', 'STATCANARY', 'ENOENT', '/secret/']) {
    assert.ok(!(statFailure.error ?? '').includes(canary), `stat error must not echo ${canary}`);
  }

  const readFailure = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => ({ size: 10, mtime: FIXED_NOW }),
          readFile: async () => {
            throw new Error("EACCES: permission denied, open '/secret/READ_CANARY.geojson' bearer READCANARY");
          },
        },
      },
    },
  );
  assert.equal(readFailure.ok, false);
  assert.match(readFailure.error ?? '', /file read failed/);
  for (const canary of ['READ_CANARY', 'READCANARY', 'EACCES', '/secret/']) {
    assert.ok(!(readFailure.error ?? '').includes(canary), `read error must not echo ${canary}`);
  }
});

test('bare relative .geojson paths pass boundary preflight and reach the I/O adapter', async () => {
  // A bare relative path (no ./ prefix) previously classified as a URL field
  // at the shared preflight and was rejected before recorder/I/O.
  let statCalls = 0;
  let readCalls = 0;
  const bytes = Buffer.from(
    '{"type":"FeatureCollection","features":[{"type":"Feature","id":"r1","properties":{},' +
      '"geometry":{"type":"Point","coordinates":[1,1]}}]}',
  );
  const result = await validate(
    { source_uri: 'virtual-bare-relative.geojson' },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => {
            statCalls += 1;
            return { size: bytes.byteLength, mtime: FIXED_NOW };
          },
          readFile: async () => {
            readCalls += 1;
            return bytes;
          },
        },
      },
    },
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(statCalls, 1);
  assert.equal(readCalls, 1);
  assert.equal(result.output.report.summary.feature_count, 1);
});

test('3D bbox enclosure is verified in every represented dimension', async () => {
  const enclosing = await validate({ source_uri: join(spatialFixtures, 'bbox-3d-enclosing.geojson') });
  assert.equal(enclosing.ok, true, enclosing.error);
  assert.deepEqual(enclosing.output.report.issues, []);
  assert.equal(enclosing.output.report.metrics.bbox.declared_valid, true);
  assert.equal(enclosing.output.report.metrics.bbox.encloses_computed, true);
  assert.equal(enclosing.output.report.summary.valid, true);

  // Horizontal containment holds but Z escapes the declared range — this
  // previously reported encloses_computed=true and valid=true.
  const nonEnclosing = await validate({ source_uri: join(spatialFixtures, 'bbox-3d-nonenclosing.geojson') });
  assert.equal(nonEnclosing.ok, true, nonEnclosing.error);
  assert.deepEqual(
    nonEnclosing.output.report.issues.map((issue) => issue.code),
    ['bbox_not_enclosing'],
  );
  assert.equal(nonEnclosing.output.report.metrics.bbox.declared_valid, true);
  assert.equal(nonEnclosing.output.report.metrics.bbox.encloses_computed, false);
  assert.equal(nonEnclosing.output.report.summary.valid, false);
});

test('Feature-level and geometry-level bboxes are validated in their own scopes', async () => {
  const result = await validate({ source_uri: join(spatialFixtures, 'nested-bboxes.geojson') });
  assert.equal(result.ok, true, result.error);
  const report = result.output.report;
  assert.deepEqual(
    report.issues.map((issue) => [issue.code, issue.location.feature_index, issue.location.path]),
    [
      ['bbox_invalid', 1, 'geometry.bbox'],
      ['bbox_not_enclosing', 0, 'bbox'],
      ['bbox_not_enclosing', 2, 'geometry.geometries[0].bbox'],
    ],
  );
  assert.equal(report.summary.valid, false);
  // report bbox metrics stay root-focused: no root bbox is declared here.
  assert.equal(report.metrics.bbox.declared_present, false);
  assert.equal(report.metrics.bbox.declared_valid, null);
  assert.equal(report.metrics.bbox.encloses_computed, null);
});

test('2*n bboxes support higher position dimensions with bounded deterministic checks', async () => {
  const valid4d = await validate({ source_uri: join(spatialFixtures, 'bbox-4d-enclosing.geojson') });
  assert.equal(valid4d.ok, true, valid4d.error);
  assert.deepEqual(valid4d.output.report.issues, []);
  assert.equal(valid4d.output.report.metrics.bbox.declared_valid, true);
  assert.equal(valid4d.output.report.metrics.bbox.encloses_computed, true);
  assert.equal(valid4d.output.report.summary.valid, true);
  assert.deepEqual(valid4d.output.report.metrics.coordinate_dimension_counts, [{ dimensions: 4, count: 1 }]);

  const io = (content: string) => {
    const bytes = Buffer.from(content);
    return {
      stat: async () => ({ size: bytes.byteLength, mtime: FIXED_NOW }),
      readFile: async () => bytes,
    };
  };
  const virtualPath = join(spatialFixtures, 'virtual-bbox-dimensions.geojson');

  // 8-value bbox over 2D data: dimensional mismatch, never claimed valid.
  const eightOn2d = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: io(
          '{"type":"FeatureCollection","bbox":[0,0,0,0,10,10,10,10],"features":[' +
            '{"type":"Feature","id":"w1","properties":{},"geometry":{"type":"Point","coordinates":[5,5]}}]}',
        ),
      },
    },
  );
  assert.equal(eightOn2d.ok, true, eightOn2d.error);
  assert.ok(eightOn2d.output.report.issues.some((issue) => issue.code === 'bbox_dimension_mismatch'));
  assert.equal(eightOn2d.output.report.metrics.bbox.declared_valid, false);
  assert.equal(eightOn2d.output.report.summary.valid, false);

  // 4D non-enclosing on the fourth axis.
  const fourthAxisEscape = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: io(
          '{"type":"FeatureCollection","bbox":[0,0,0,0,10,10,10,10],"features":[' +
            '{"type":"Feature","id":"w2","properties":{},"geometry":{"type":"Point","coordinates":[5,5,5,50]}}]}',
        ),
      },
    },
  );
  assert.equal(fourthAxisEscape.ok, true, fourthAxisEscape.error);
  assert.deepEqual(
    fourthAxisEscape.output.report.issues.map((issue) => issue.code),
    ['bbox_not_enclosing'],
  );
  assert.equal(fourthAxisEscape.output.report.summary.valid, false);

  // bbox dimension counts beyond the bound are rejected structurally, so
  // axis loops stay bounded.
  const oversizedBbox = await validate(
    { source_uri: virtualPath },
    {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: io(
          `{"type":"FeatureCollection","bbox":[${Array.from({ length: 40 }, (_, i) => i).join(',')}],"features":[` +
            '{"type":"Feature","id":"w3","properties":{},"geometry":{"type":"Point","coordinates":[5,5]}}]}',
        ),
      },
    },
  );
  assert.equal(oversizedBbox.ok, true, oversizedBbox.error);
  assert.ok(oversizedBbox.output.report.issues.some((issue) => issue.code === 'bbox_invalid'));
  assert.equal(oversizedBbox.output.report.metrics.bbox.declared_valid, false);
});

test('mixed coordinate dimensions never suppress declared bbox findings', async () => {
  const io = (content: string) => {
    const bytes = Buffer.from(content);
    return {
      stat: async () => ({ size: bytes.byteLength, mtime: FIXED_NOW }),
      readFile: async () => bytes,
    };
  };
  const virtualPath = join(spatialFixtures, 'virtual-mixed-dimension-bbox.geojson');
  const collection = (bbox: string, coordsA: string, coordsB: string): string =>
    `{"type":"FeatureCollection","bbox":${bbox},"features":[` +
    `{"type":"Feature","id":"m1","properties":{},"geometry":{"type":"Point","coordinates":${coordsA}}},` +
    `{"type":"Feature","id":"m2","properties":{},"geometry":{"type":"Point","coordinates":${coordsB}}}]}`;

  // Case 1 (reviewer repro): 2D root bbox over mixed 2D/3D points previously
  // closed silently with valid:true and no bbox finding.
  const silentMixed = await validate(
    { source_uri: virtualPath },
    { capabilityContext: { now: () => FIXED_NOW, io: io(collection('[0,0,10,10]', '[1,1]', '[2,2,999]')) } },
  );
  assert.equal(silentMixed.ok, true, silentMixed.error);
  assert.deepEqual(
    silentMixed.output.report.issues.map((issue) => issue.code),
    ['bbox_dimension_mismatch'],
  );
  assert.equal(silentMixed.output.report.metrics.bbox.declared_valid, false);
  assert.equal(silentMixed.output.report.metrics.bbox.encloses_computed, null);
  assert.equal(silentMixed.output.report.summary.valid, false);

  // Case 2: 3D bbox, mixed 2D/3D points, Z escape on the represented axis —
  // the escape must be reported alongside the dimensionality finding.
  const zEscape = await validate(
    { source_uri: virtualPath },
    { capabilityContext: { now: () => FIXED_NOW, io: io(collection('[0,0,0,10,10,10]', '[1,1]', '[2,2,50]')) } },
  );
  assert.equal(zEscape.ok, true, zEscape.error);
  assert.deepEqual(
    zEscape.output.report.issues.map((issue) => issue.code),
    ['bbox_dimension_mismatch', 'bbox_not_enclosing'],
  );
  assert.equal(zEscape.output.report.metrics.bbox.declared_valid, false);
  assert.equal(zEscape.output.report.metrics.bbox.encloses_computed, false);
  assert.equal(zEscape.output.report.summary.valid, false);

  // Case 3: 2D bbox, mixed dimensions, horizontal escape by the 2D point.
  const flatEscape = await validate(
    { source_uri: virtualPath },
    { capabilityContext: { now: () => FIXED_NOW, io: io(collection('[0,0,1,1]', '[5,5]', '[0.5,0.5,7]')) } },
  );
  assert.equal(flatEscape.ok, true, flatEscape.error);
  assert.deepEqual(
    flatEscape.output.report.issues.map((issue) => issue.code),
    ['bbox_dimension_mismatch', 'bbox_not_enclosing'],
  );
  assert.equal(flatEscape.output.report.metrics.bbox.declared_valid, false);
  assert.equal(flatEscape.output.report.metrics.bbox.encloses_computed, false);
  assert.equal(flatEscape.output.report.summary.valid, false);
});

test('boundary rejection occurs before invocation recording or dataset I/O', async () => {
  let began = 0;
  let ioCalls = 0;
  const result = await validate(
    { source_uri: '/etc/hosts.geojson' },
    {
      recorder: {
        begin: async () => {
          began += 1;
          return 'should-not-begin';
        },
        finish: async () => undefined,
      },
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => {
            ioCalls += 1;
            return stat('/etc/hosts');
          },
          readFile: async () => {
            ioCalls += 1;
            return readFile('/etc/hosts');
          },
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /boundary violation/i);
  assert.equal(began, 0);
  assert.equal(ioCalls, 0);
});
