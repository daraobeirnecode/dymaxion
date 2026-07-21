import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { allCapabilities } from '../src/capabilities/registry.js';
import {
  AUTHALIC_RADIUS_METERS,
  MAX_CANDIDATE_FEATURES,
  MAX_COMBINED_SOURCE_BYTES,
  MAX_COORDINATE_ORDINATES,
  MAX_COORDINATE_POSITIONS,
  MAX_DISTANCE_METERS,
  MAX_DURATION_MS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_OUTPUT_BYTES,
  MAX_PAIR_EVALUATIONS,
  MAX_PRIMARY_FEATURES,
  MAX_SOURCE_BYTES,
  RunVectorAnalysisOutputSchema,
  assertCombinedSourceBytes,
  assertOutputBytesWithinLimit,
  createFeatureCollectionOutputBudget,
  deriveArtifact,
  runVectorAnalysisCapability,
  type RunVectorAnalysisOutput,
} from '../src/capabilities/run-vector-analysis.js';
import { canonicalJson, sha256Text } from '../src/contracts/canonical.js';
import { CapabilityManifestSchema } from '../src/contracts/capability.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const AGENT_RUN_ID = '00000000-0000-0000-0000-00000000001f';
const FIXED_NOW = new Date('2026-07-21T12:34:56.000Z');

type SinkCounts = { audit: number; begin: number; finish: number; stat: number; readFile: number };

function deps(counts?: SinkCounts, overrides: Partial<RunSkillDependencies> = {}): RunSkillDependencies {
  const sinkCounts = counts ?? { audit: 0, begin: 0, finish: 0, stat: 0, readFile: 0 };
  return {
    recorder: {
      begin: async () => {
        sinkCounts.begin += 1;
        return 'invocation-run-vector-analysis-test';
      },
      finish: async () => {
        sinkCounts.finish += 1;
      },
    },
    audit: async () => {
      sinkCounts.audit += 1;
    },
    boundaryOptions: {
      audit: async () => {
        sinkCounts.audit += 1;
      },
    },
    capabilityContext: {
      now: () => FIXED_NOW,
      io: {
        stat: async (path: string) => {
          sinkCounts.stat += 1;
          return stat(path);
        },
        readFile: async (path: string) => {
          sinkCounts.readFile += 1;
          return readFile(path);
        },
      },
    },
    ...overrides,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(repoRoot, '.tmp-run-vector-analysis-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fc(features: unknown[]): Record<string, unknown> {
  return { type: 'FeatureCollection', features };
}

function point(coordinates: unknown, properties: unknown = {}, id?: string | number): Record<string, unknown> {
  return { type: 'Feature', ...(id === undefined ? {} : { id }), properties, geometry: { type: 'Point', coordinates } };
}

async function writeGeojson(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

async function run(
  input: Record<string, unknown>,
  overrides: Partial<RunSkillDependencies> = {},
): Promise<{ ok: boolean; error?: string; output: RunVectorAnalysisOutput; counts: SinkCounts }> {
  const counts = { audit: 0, begin: 0, finish: 0, stat: 0, readFile: 0 };
  const result = await runSkill('run_vector_analysis', input, AGENT_RUN_ID, deps(counts, overrides));
  return { ok: result.ok, error: result.error, output: result.output as RunVectorAnalysisOutput, counts };
}

function parsedArtifact(output: RunVectorAnalysisOutput): any {
  return JSON.parse(output.artifact.content);
}

test('run_vector_analysis manifest, schemas and registry are strict and trace Phase 1F ceilings', () => {
  const manifest = runVectorAnalysisCapability.manifest;
  assert.equal(manifest.slug, 'run_vector_analysis');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.classification, 'read');
  assert.deepEqual(manifest.allowed_sources, ['filesystem']);
  assert.deepEqual(manifest.allowed_hosts, []);
  assert.deepEqual(manifest.identity, { required: false, permissions: [] });
  assert.equal(manifest.resource_limits.max_records, MAX_PRIMARY_FEATURES + MAX_CANDIDATE_FEATURES);
  assert.equal(manifest.resource_limits.max_bytes, MAX_COMBINED_SOURCE_BYTES);
  assert.equal(manifest.resource_limits.max_duration_ms, MAX_DURATION_MS);
  assert.equal(manifest.resource_limits.max_source_bytes, MAX_SOURCE_BYTES);
  assert.equal(manifest.resource_limits.max_primary_records, MAX_PRIMARY_FEATURES);
  assert.equal(manifest.resource_limits.max_candidate_records, MAX_CANDIDATE_FEATURES);
  assert.equal(manifest.resource_limits.max_coordinate_positions, MAX_COORDINATE_POSITIONS);
  assert.equal(manifest.resource_limits.max_coordinate_ordinates, MAX_COORDINATE_ORDINATES);
  assert.equal(manifest.resource_limits.max_json_depth, MAX_JSON_DEPTH);
  assert.equal(manifest.resource_limits.max_json_nodes, MAX_JSON_NODES);
  assert.equal(manifest.resource_limits.max_pair_evaluations, MAX_PAIR_EVALUATIONS);
  assert.equal(manifest.resource_limits.max_output_bytes, MAX_OUTPUT_BYTES);
  assert.deepEqual(manifest.artifacts, [
    { name: 'nearest_point_geojson', media_type: 'application/geo+json; charset=utf-8', required: true },
  ]);
  assert.deepEqual(manifest.idempotency.key_fields, [
    'source_uri',
    'candidate_source_uri',
    'operation',
    'max_distance_meters',
    'source_sha256',
    'candidate_sha256',
  ]);
  assert.equal(manifest.cancellation.supported, true);
  assert.throws(() => CapabilityManifestSchema.parse({ ...manifest, resource_limits: { ...manifest.resource_limits, bogus: 1 } }), /unrecognized/i);

  const schema = runVectorAnalysisCapability.inputSchema;
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson', unexpected: true }), /unrecognized/i);
  assert.equal(schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson' }).operation, 'nearest_point');
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson', operation: 'buffer' }));
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'a.geojson' }), /distinct/i);
  assert.throws(() => schema.parse({ source_uri: './a.geojson', candidate_source_uri: 'sub/../a.geojson' }), /distinct/i);
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson', max_distance_meters: 0 }));
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson', max_distance_meters: Number.POSITIVE_INFINITY }));
  assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: 'b.geojson', max_distance_meters: MAX_DISTANCE_METERS + 0.001 }));
  for (const bad of [
    'https://example.maps.arcgis.com/f.geojson?token=CANARY',
    'file:///tmp/f.geojson',
    'z://user:pass@example/path.geojson',
    'z://example/path.geojson',
    '//user:pass@example/path.geojson',
    '\\\\server\\share\\x.geojson',
    'x.geojson?token=CANARY',
    'x.geojson#frag',
    'x%20.geojson',
    'access_token=CANARY.geojson',
    'Bearer CANARY.geojson',
    `bad${String.fromCharCode(0)}.geojson`,
    'x.json',
  ]) {
    assert.throws(() => schema.parse({ source_uri: bad, candidate_source_uri: 'b.geojson' }));
    assert.throws(() => schema.parse({ source_uri: 'a.geojson', candidate_source_uri: bad }));
  }
  assert.doesNotThrow(() => schema.parse({ source_uri: 'token-inventory.geojson', candidate_source_uri: 'postal_code=95814.geojson' }));
  assert.deepEqual(
    schema.parse({ source_uri: 'C:\\data\\primary.geojson', candidate_source_uri: 'D:/data/candidate.geojson' }),
    {
      source_uri: 'C:\\data\\primary.geojson',
      candidate_source_uri: 'D:/data/candidate.geojson',
      operation: 'nearest_point',
    },
  );
  assert.ok(allCapabilities().some((capability) => capability.manifest.slug === 'run_vector_analysis'));
  assert.equal(allCapabilities().length, 7);
});

test('run_vector_analysis input schema is lexical-only and contains no filesystem canonicalization', async () => {
  const source = await readFile(join(repoRoot, 'dymaxion-runtime/src/capabilities/run-vector-analysis.ts'), 'utf8');
  const schemaRegion = source.slice(source.indexOf('const SourceUriSchema'), source.indexOf('const CountSchema'));
  assert.ok(schemaRegion.includes('resolve(input.source_uri)'));
  for (const forbidden of ['canonicalBoundaryPath', 'existsSync', 'realpathSync', 'stat(', 'readFile(']) {
    assert.equal(schemaRegion.includes(forbidden), false, forbidden);
  }
});

test('nearest_point succeeds with known distances, exact artifact/evidence hashes, canonical deterministic output', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary 🗺️.geojson', fc([
      point([-105, 40, 123], { name: 'A', nested: { ok: true } }, 'p-a'),
      point([179.9, 0], null, 2),
      point([0, 89.9], { note: 'polar' }),
    ]));
    const candidate = await writeGeojson(dir, 'candidate data.geojson', fc([
      point([-105, 40.001], { secret: 'must not copy' }, 'c-near'),
      point([179.95, 0], { never: 'copied' }, 42),
      point([-179.95, 0], { closer_across_antimeridian: true }, 'anti'),
      point([90, 89.9], { polar: 'near longitude convergence' }, 'polar-east'),
    ]));
    const first = await run({ source_uri: source, candidate_source_uri: candidate });
    const second = await run({ source_uri: source, candidate_source_uri: candidate });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.doesNotThrow(() => RunVectorAnalysisOutputSchema.parse(first.output));
    assert.deepEqual(first.output, second.output);
    assert.equal(first.output.artifact.format, 'geojson');
    assert.equal(first.output.artifact.media_type, 'application/geo+json; charset=utf-8');
    assert.equal(first.output.artifact.bytes, Buffer.byteLength(first.output.artifact.content, 'utf8'));
    assert.equal(first.output.artifact.sha256, sha256Text(first.output.artifact.content));
    assert.equal(first.output.report.output.sha256, first.output.artifact.sha256);
    assert.equal(first.output.report.output.bytes, first.output.artifact.bytes);
    assert.equal(first.output.evidence.outputs[0].sha256, first.output.artifact.sha256);
    assert.equal(first.output.evidence.outputs[0].bytes, first.output.artifact.bytes);
    assert.equal(first.output.evidence.parameters.sha256, sha256Text(first.output.evidence.parameters.canonical_json));
    assert.equal(first.output.evidence.source.sha256, sha256Text(await readFile(source)));
    assert.equal(first.output.evidence.related_sources?.[0].sha256, sha256Text(await readFile(candidate)));
    assert.equal(first.output.evidence.related_sources?.[0].role, 'candidate_features');
    assert.equal(first.output.evidence.parameters.canonical_json, canonicalJson({
      algorithm: 'haversine_spherical_great_circle',
      authalic_radius_meters: AUTHALIC_RADIUS_METERS,
      candidate_sha256: first.output.evidence.related_sources?.[0].sha256,
      candidate_source_uri: first.output.report.candidate.source_uri,
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
      max_distance_meters: null,
      operation: 'nearest_point',
      rounding: 'nearest_millimetre',
      source_sha256: first.output.evidence.source.sha256,
      source_uri: first.output.report.source.source_uri,
      tie_break: 'candidate_source_index',
    }));

    const artifact = parsedArtifact(first.output);
    assert.equal(first.output.artifact.content, canonicalJson(artifact));
    assert.equal(artifact.type, 'FeatureCollection');
    assert.equal(artifact.features.length, 3);
    assert.deepEqual(artifact.features.map((feature: any) => feature.id), ['p-a', 2, undefined]);
    assert.deepEqual(artifact.features[0].geometry, { coordinates: [-105, 40, 123], type: 'Point' });
    assert.deepEqual(artifact.features[0].properties.name, 'A');
    assert.deepEqual(artifact.features[0].properties._dymaxion, {
      candidate_id: 'c-near',
      candidate_index: 0,
      distance_meters: 111.195,
      matched: true,
      operation: 'nearest_point',
    });
    assert.equal(artifact.features[1].properties._dymaxion.candidate_index, 1);
    assert.equal(artifact.features[1].properties._dymaxion.candidate_id, 42);
    assert.equal(artifact.features[1].properties._dymaxion.distance_meters, 5559.754);
    assert.equal(artifact.features[2].properties._dymaxion.candidate_index, 3);
    assert.equal(artifact.features[2].properties._dymaxion.distance_meters, 15725.355);
    assert.equal(JSON.stringify(artifact).includes('must not copy'), false);
    assert.equal(JSON.stringify(artifact).includes('closer_across_antimeridian'), false);
    assert.equal(first.output.report.counts.pair_evaluations, 12);
    assert.equal(first.output.report.counts.primary_ordinates, 7);
    assert.equal(first.output.report.counts.candidate_ordinates, 8);
    assert.equal(first.output.report.counts.total_ordinates, 15);
    assert.equal(first.output.report.counts.matched, 3);
    assert.equal(first.output.report.counts.unmatched, 0);
    assert.deepEqual(first.output.report.algorithm, {
      name: 'haversine_spherical_great_circle',
      authalic_radius_meters: AUTHALIC_RADIUS_METERS,
      distance_units: 'meters',
      rounding: 'nearest millimetre',
      tie_break: 'rounded distance then candidate source index',
      longitude_delta: 'normalized across antimeridian to [-180,180]',
    });
    assert.ok(first.output.report.qa.limitations.some((limitation) => limitation.includes('spherical')));
    assert.ok(first.output.report.qa.limitations.some((limitation) => limitation.includes('Point-only')));
  });
});

test('output schema rejects forged artifact, report and evidence integrity bindings', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0], { name: 'A' }, 'p')]));
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0], {}, 'c')]));
    const result = await run({ source_uri: source, candidate_source_uri: candidate });
    assert.equal(result.ok, true, result.error);
    const base = result.output;
    assert.doesNotThrow(() => RunVectorAnalysisOutputSchema.parse(base));

    const semanticallyForgedParameters = structuredClone(base) as any;
    const differentCanonicalParameters = canonicalJson({
      ...JSON.parse(semanticallyForgedParameters.evidence.parameters.canonical_json),
      source_uri: 'file:///semantic-mismatch.geojson',
    });
    semanticallyForgedParameters.evidence.parameters.canonical_json = differentCanonicalParameters;
    semanticallyForgedParameters.evidence.parameters.sha256 = sha256Text(differentCanonicalParameters);
    const semanticMismatch = RunVectorAnalysisOutputSchema.safeParse(semanticallyForgedParameters);
    assert.equal(semanticMismatch.success, false);
    if (!semanticMismatch.success) {
      assert.ok(
        semanticMismatch.error.issues.some(
          (issue) => JSON.stringify(issue.path) === JSON.stringify(['evidence', 'parameters', 'canonical_json']),
        ),
        `semantic mismatch missing canonical_json issue; saw ${JSON.stringify(semanticMismatch.error.issues.map((issue) => issue.path))}`,
      );
      assert.equal(
        semanticMismatch.error.issues.some(
          (issue) => JSON.stringify(issue.path) === JSON.stringify(['evidence', 'parameters', 'sha256']),
        ),
        false,
      );
    }

    const invalidHash = 'f'.repeat(64);
    const cases: Array<[string, (forged: any) => void, Array<string | number>?]> = [
      ['artifact bytes', (forged) => { forged.artifact.bytes += 1; }, ['artifact', 'bytes']],
      ['artifact hash', (forged) => { forged.artifact.sha256 = invalidHash; }, ['artifact', 'sha256']],
      ['report output format', (forged) => { forged.report.output.format = 'json'; }, ['report', 'output', 'format']],
      ['report output media type', (forged) => { forged.report.output.media_type = 'application/json'; }, ['report', 'output', 'media_type']],
      ['report output bytes', (forged) => { forged.report.output.bytes += 1; }, ['report', 'output', 'bytes']],
      ['report output hash', (forged) => { forged.report.output.sha256 = invalidHash; }, ['report', 'output', 'sha256']],
      ['missing artifact evidence output', (forged) => { forged.evidence.outputs = []; }, ['evidence', 'outputs']],
      ['duplicate artifact evidence output', (forged) => { forged.evidence.outputs.push({ ...forged.evidence.outputs[0] }); }, ['evidence', 'outputs']],
      ['evidence output bytes', (forged) => { forged.evidence.outputs[0].bytes += 1; }, ['evidence', 'outputs', 0, 'bytes']],
      ['evidence output hash', (forged) => { forged.evidence.outputs[0].sha256 = invalidHash; }, ['evidence', 'outputs', 0, 'sha256']],
      ['evidence parameter hash', (forged) => { forged.evidence.parameters.sha256 = invalidHash; }, ['evidence', 'parameters', 'sha256']],
      ['evidence execution capability', (forged) => { forged.evidence.execution.capability = 'inspect_dataset'; }, ['evidence', 'execution', 'capability']],
      ['evidence execution capability version', (forged) => { forged.evidence.execution.capability_version = '9.9.9'; }, ['evidence', 'execution', 'capability_version']],
      ['primary source uri', (forged) => { forged.report.source.source_uri = 'file:///forged.geojson'; }, ['report', 'source', 'source_uri']],
      ['primary source hash', (forged) => { forged.report.source.sha256 = invalidHash; }, ['report', 'source', 'sha256']],
      ['missing candidate source', (forged) => { delete forged.evidence.related_sources; }, ['evidence', 'related_sources']],
      ['duplicate candidate source', (forged) => { forged.evidence.related_sources.push({ ...forged.evidence.related_sources[0], uri: 'file:///other.geojson' }); }, ['evidence', 'related_sources', 1, 'role']],
      ['candidate source uri', (forged) => { forged.report.candidate.source_uri = 'file:///forged-candidate.geojson'; }, ['report', 'candidate', 'source_uri']],
      ['candidate source hash', (forged) => { forged.report.candidate.sha256 = invalidHash; }, ['report', 'candidate', 'sha256']],
      ['bundle id hash fragment', (forged) => { forged.evidence.bundle_id = 'run_vector_analysis:0000000000000000'; }, ['evidence', 'bundle_id']],
    ];

    for (const [name, mutate, expectedPath] of cases) {
      const forged = structuredClone(base) as any;
      mutate(forged);
      const parsed = RunVectorAnalysisOutputSchema.safeParse(forged);
      assert.equal(parsed.success, false, name);
      if (expectedPath) {
        assert.ok(
          parsed.error.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(expectedPath)),
          `${name} missing expected issue path ${JSON.stringify(expectedPath)}; saw ${JSON.stringify(parsed.error.issues.map((issue) => issue.path))}`,
        );
      }
      assert.equal(JSON.stringify(parsed.error.issues).includes(base.artifact.sha256), false, name);
      assert.equal(JSON.stringify(parsed.error.issues).includes(base.artifact.content), false, name);
    }
  });
});

test('tie-breaking uses rounded millimetre distance then candidate source index', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0], { keep: true }, 'p')]));
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([
      point([0.001, 0], { omit: 'first' }, 'east'),
      point([-0.001, 0], { omit: 'second' }, 'west'),
    ]));
    const result = await run({ source_uri: source, candidate_source_uri: candidate });
    assert.equal(result.ok, true, result.error);
    assert.equal(parsedArtifact(result.output).features[0].properties._dymaxion.candidate_index, 0);
    assert.equal(parsedArtifact(result.output).features[0].properties._dymaxion.candidate_id, 'east');
  });
});

test('max distance, empty candidates and empty primaries are deterministic valid artifacts', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0], { a: 1 }, 'p')]));
    const farCandidate = await writeGeojson(dir, 'candidate.geojson', fc([point([1, 0], {}, 'far')]));
    const unmatched = await run({ source_uri: source, candidate_source_uri: farCandidate, max_distance_meters: 100 });
    assert.equal(unmatched.ok, true, unmatched.error);
    assert.deepEqual(parsedArtifact(unmatched.output).features[0].properties._dymaxion, {
      candidate_id: null,
      candidate_index: null,
      distance_meters: null,
      matched: false,
      operation: 'nearest_point',
    });
    assert.equal(unmatched.output.report.counts.matched, 0);
    assert.equal(unmatched.output.report.counts.unmatched, 1);

    const emptyCandidate = await writeGeojson(dir, 'empty-candidate.geojson', fc([]));
    const noCandidates = await run({ source_uri: source, candidate_source_uri: emptyCandidate });
    assert.equal(noCandidates.ok, true, noCandidates.error);
    assert.equal(noCandidates.output.report.counts.candidate_features, 0);
    assert.equal(noCandidates.output.report.counts.pair_evaluations, 0);
    assert.equal(parsedArtifact(noCandidates.output).features[0].properties._dymaxion.matched, false);

    const emptyPrimary = await writeGeojson(dir, 'empty-primary.geojson', fc([]));
    const empty = await run({ source_uri: emptyPrimary, candidate_source_uri: farCandidate });
    assert.equal(empty.ok, true, empty.error);
    assert.deepEqual(parsedArtifact(empty.output), { features: [], type: 'FeatureCollection' });
    assert.equal(empty.output.report.counts.input_features, 0);
    assert.equal(empty.output.report.counts.pair_evaluations, 0);
  });
});

test('preserves primary properties/id/geometry, rejects reserved _dymaxion and omits candidate properties', async () => {
  await withTempDir(async (dir) => {
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0], { leak: 'CANARY' }, 'c')]));
    const good = await writeGeojson(dir, 'good.geojson', fc([point([0, 0], null, 7)]));
    const goodResult = await run({ source_uri: good, candidate_source_uri: candidate });
    assert.equal(goodResult.ok, true, goodResult.error);
    const feature = parsedArtifact(goodResult.output).features[0];
    assert.equal(feature.id, 7);
    assert.equal(feature.geometry.coordinates[0], 0);
    assert.equal(JSON.stringify(feature).includes('CANARY'), false);

    const bad = await writeGeojson(dir, 'bad.geojson', fc([point([0, 0], { _dymaxion: { existing: true } })]));
    const badResult = await run({ source_uri: bad, candidate_source_uri: candidate });
    assert.equal(badResult.ok, false);
    assert.match(badResult.error ?? '', /reserved _dymaxion/i);
  });
});

test('rejects malformed JSON/UTF-8 and unsupported GeoJSON CRS/geometry/coordinate shapes without echoing source', async () => {
  await withTempDir(async (dir) => {
    const validCandidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0]) ]));
    const cases: Array<[string, Uint8Array | string, RegExp]> = [
      ['bad-json.geojson', '{"type":"FeatureCollection","features":[}', /invalid JSON syntax/],
      ['bad-utf8.geojson', new Uint8Array([0xff, 0xfe, 0xfd]), /not valid UTF-8/],
      ['not-fc.geojson', JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }), /root must be a FeatureCollection/],
      ['crs.geojson', JSON.stringify({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:4326' } }, features: [] }), /legacy crs/],
      ['feature-crs.geojson', JSON.stringify(fc([{ ...point([0, 0]), crs: { type: 'name', properties: { name: 'EPSG:3857' } } }])), /legacy crs/],
      ['geometry-crs.geojson', JSON.stringify(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', crs: { type: 'name', properties: { name: 'EPSG:3857' } }, coordinates: [0, 0] } }])), /legacy crs/],
      ['properties-crs.geojson', JSON.stringify(fc([point([0, 0], { crs: { type: 'name', properties: { name: 'EPSG:3857' } } })])), /legacy crs/],
      ['line.geojson', JSON.stringify(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }])), /Point geometry/],
      ['null.geojson', JSON.stringify(fc([{ type: 'Feature', properties: {}, geometry: null }])), /non-null Point geometry/],
      ['range.geojson', JSON.stringify(fc([point([181, 0])])), /longitude/],
      ['lat.geojson', JSON.stringify(fc([point([0, -91])])), /latitude/],
      ['short.geojson', JSON.stringify(fc([point([0])])), /position/],
      ['nan.geojson', '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,1e999]}}]}', /finite/],
      ['properties.geojson', JSON.stringify(fc([{ type: 'Feature', properties: [], geometry: { type: 'Point', coordinates: [0, 0] } }])), /properties/],
      ['id.geojson', JSON.stringify(fc([{ type: 'Feature', id: {}, properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }])), /id/],
    ];
    for (const [name, body, message] of cases) {
      const path = join(dir, name);
      await writeFile(path, body);
      const result = await run({ source_uri: path, candidate_source_uri: validCandidate });
      assert.equal(result.ok, false, `${name} unexpectedly succeeded`);
      assert.match(result.error ?? '', message, name);
      assert.doesNotMatch(result.error ?? '', /FeatureCollection.*coordinates|EPSG:\d+|bad-json|candidate/i);
    }
  });
});

test('enforces file, combined, feature, coordinate, pair, output, duration and cancellation ceilings', async () => {
  await withTempDir(async (dir) => {
    const validPrimary = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0]) ]));
    const validCandidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0]) ]));

    let result = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, {
      capabilityContext: { now: () => FIXED_NOW, io: { stat: async () => ({ size: MAX_SOURCE_BYTES + 1 }), readFile } },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /resource limit exceeded.*bytes/);

    result = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, {
      capabilityContext: { now: () => FIXED_NOW, io: { stat: async () => ({ size: 1 }), readFile: async () => new Uint8Array(MAX_SOURCE_BYTES + 1) } },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /while reading/);

    assert.equal(assertCombinedSourceBytes(MAX_SOURCE_BYTES, MAX_SOURCE_BYTES, 'stat'), MAX_COMBINED_SOURCE_BYTES);
    assert.throws(() => assertCombinedSourceBytes(MAX_SOURCE_BYTES, MAX_SOURCE_BYTES + 1, 'stat'), /combined stat source bytes/);
    assert.throws(() => assertCombinedSourceBytes(MAX_SOURCE_BYTES, MAX_SOURCE_BYTES + 1, 'actual'), /combined actual source bytes/);
    assert.doesNotThrow(() => assertOutputBytesWithinLimit(MAX_OUTPUT_BYTES));
    assert.throws(() => assertOutputBytesWithinLimit(MAX_OUTPUT_BYTES + 1), /output GeoJSON/);
    const budget = createFeatureCollectionOutputBudget(64);
    assert.equal(budget.observedBytes(), Buffer.byteLength(canonicalJson(fc([])), 'utf8'));
    assert.throws(() => budget.addFeature(canonicalJson(point([0, 0], { payload: 'x'.repeat(100) }))), /output GeoJSON/);
    let outputTraversals = 0;
    assert.throws(
      () =>
        deriveArtifact(
          [
            { index: 0, lon: 0, lat: 0, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { payload: 'x'.repeat(100) } },
            { index: 1, lon: 1, lat: 0, geometry: { type: 'Point', coordinates: [1, 0] }, properties: {} },
          ],
          [{ index: 0, lon: 0, lat: 0, geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
          undefined,
          (stage) => { if (stage === 'primary output traversal') outputTraversals += 1; },
          128,
        ),
      /output GeoJSON/,
    );
    assert.equal(outputTraversals, 1);

    const tooManyPrimary = await writeGeojson(dir, 'too-many-primary.geojson', fc(Array.from({ length: MAX_PRIMARY_FEATURES + 1 }, () => point([0, 0]))));
    result = await run({ source_uri: tooManyPrimary, candidate_source_uri: validCandidate });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /primary features/);

    const tooManyCandidate = await writeGeojson(dir, 'too-many-candidate.geojson', fc(Array.from({ length: MAX_CANDIDATE_FEATURES + 1 }, () => point([0, 0]))));
    result = await run({ source_uri: validPrimary, candidate_source_uri: tooManyCandidate });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /candidate features/);

    const ordinateBomb = await writeGeojson(dir, 'ordinates.geojson', fc([point(Array.from({ length: MAX_COORDINATE_ORDINATES + 1 }, () => 0))]));
    result = await run({ source_uri: ordinateBomb, candidate_source_uri: validCandidate });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /coordinate ordinates/);

    const almostMaxOrdinates = Array.from({ length: Math.floor(MAX_COORDINATE_ORDINATES / 2) + 1 }, () => 0);
    const combinedOrdinatePrimary = await writeGeojson(dir, 'combined-ordinate-primary.geojson', fc([point(almostMaxOrdinates)]));
    const combinedOrdinateCandidate = await writeGeojson(dir, 'combined-ordinate-candidate.geojson', fc([point(almostMaxOrdinates)]));
    result = await run({ source_uri: combinedOrdinatePrimary, candidate_source_uri: combinedOrdinateCandidate });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /total coordinate ordinates/);

    const pairPrimary = await writeGeojson(dir, 'pair-primary.geojson', fc(Array.from({ length: 501 }, (_, index) => point([index / 1000, 0]))));
    const pairCandidate = await writeGeojson(dir, 'pair-candidate.geojson', fc(Array.from({ length: 500 }, (_, index) => point([index / 1000, 1]))));
    result = await run({ source_uri: pairPrimary, candidate_source_uri: pairCandidate });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /pair evaluations/);

    let monotonicTick = 0;
    result = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, {
      capabilityContext: {
        now: () => FIXED_NOW,
        monotonicNow: () => (monotonicTick++ === 0 ? 0 : MAX_DURATION_MS + 1),
        io: { stat, readFile },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /duration/);

    const fixedTimestamp = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, {
      capabilityContext: {
        now: () => FIXED_NOW,
        monotonicNow: (() => {
          let tick = 100;
          return () => { tick -= 1; return tick; };
        })(),
        io: { stat, readFile },
      },
    });
    assert.equal(fixedTimestamp.ok, true, fixedTimestamp.error);
    assert.equal(fixedTimestamp.output.report.generated_at, FIXED_NOW.toISOString());
    assert.equal(fixedTimestamp.output.evidence.generated_at, FIXED_NOW.toISOString());

    result = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, {
      capabilityContext: {
        now: () => FIXED_NOW,
        monotonicNow: () => Number.NaN,
        io: { stat, readFile },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /duration/);

    const aborted = new AbortController();
    aborted.abort();
    result = await run({ source_uri: validPrimary, candidate_source_uri: validCandidate }, { capabilityContext: { now: () => FIXED_NOW, signal: aborted.signal, io: { stat, readFile } } });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /cancelled/);
  });
});

test('cancellation checkpoints cover stat, read, parse, root, feature, ordinate and pair phases', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0])]));
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0])]));
    const input = runVectorAnalysisCapability.inputSchema.parse({ source_uri: source, candidate_source_uri: candidate });

    let aborted = false;
    await assert.rejects(
      () =>
        runVectorAnalysisCapability.execute(input, {
          now: () => FIXED_NOW,
          signal: { get aborted() { return aborted; } } as AbortSignal,
          io: {
            stat: async (path: string) => {
              const value = await stat(path);
              aborted = true;
              return value;
            },
            readFile,
          },
        }),
      /cancelled during primary after stat/,
    );

    aborted = false;
    await assert.rejects(
      () =>
        runVectorAnalysisCapability.execute(input, {
          now: () => FIXED_NOW,
          signal: { get aborted() { return aborted; } } as AbortSignal,
          io: {
            stat,
            readFile: async (path: string) => {
              const value = await readFile(path);
              aborted = true;
              return value;
            },
          },
        }),
      /cancelled during primary after read/,
    );

    async function expectAbortAtCheckpoint(abortAt: number, message: RegExp): Promise<void> {
      let checks = 0;
      await assert.rejects(
        () =>
          runVectorAnalysisCapability.execute(input, {
            now: () => FIXED_NOW,
            signal: { get aborted() { checks += 1; return checks >= abortAt; } } as AbortSignal,
            io: { stat, readFile },
          }),
        message,
      );
    }

    await expectAbortAtCheckpoint(13, /cancelled during primary JSON parse/);
    await expectAbortAtCheckpoint(16, /cancelled during primary root validation/);
    await expectAbortAtCheckpoint(29, /cancelled during feature traversal/);
    await expectAbortAtCheckpoint(31, /cancelled during coordinate ordinate traversal/);
    await expectAbortAtCheckpoint(53, /cancelled during pair evaluation/);
  });
});

test('stats both sources and enforces combined stat phase before any source read', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0])]));
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0])]));
    const events: string[] = [];
    const result = await run({ source_uri: source, candidate_source_uri: candidate }, {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async (path: string) => {
            events.push(path.endsWith('primary.geojson') ? 'stat:primary' : 'stat:candidate');
            return stat(path);
          },
          readFile: async (path: string) => {
            events.push(path.endsWith('primary.geojson') ? 'read:primary' : 'read:candidate');
            return readFile(path);
          },
        },
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(events, ['stat:primary', 'stat:candidate', 'read:primary', 'read:candidate']);
  });
});

test('executor runs generic capability preflight only after boundary and before recorder or execute', async () => {
  await withTempDir(async (dir) => {
    const goodSource = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0])]));
    const goodCandidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0])]));
    const outside = join(tmpdir(), `dymaxion-denied-${process.pid}.geojson`);
    await writeFile(outside, JSON.stringify(fc([point([0, 0])])), 'utf8');
    let preflightCalls = 0;
    const originalPreflight = runVectorAnalysisCapability.preflight;
    runVectorAnalysisCapability.preflight = async (input, context) => {
      preflightCalls += 1;
      await originalPreflight?.(input, context);
    };
    try {
      const denied = await run({ source_uri: outside, candidate_source_uri: goodCandidate });
      assert.equal(denied.ok, false);
      assert.equal(preflightCalls, 0);
      assert.equal(denied.counts.begin, 0);
      assert.equal(denied.counts.finish, 0);
      assert.equal(denied.counts.stat, 0);
      assert.equal(denied.counts.readFile, 0);

      const allowed = await run({ source_uri: goodSource, candidate_source_uri: goodCandidate });
      assert.equal(allowed.ok, true, allowed.error);
      assert.equal(preflightCalls, 1);
      assert.equal(allowed.counts.begin, 1);
      assert.equal(allowed.counts.stat, 2);
      assert.equal(allowed.counts.readFile, 2);
    } finally {
      runVectorAnalysisCapability.preflight = originalPreflight;
      await rm(outside, { force: true });
    }
  });
});

test('rejects URL, credential and percent paths before boundary audit, recorder or I/O while benign controls execute', async () => {
  await withTempDir(async (dir) => {
    const goodSource = await writeGeojson(dir, 'token inventory.geojson', fc([point([0, 0])]));
    const goodCandidate = await writeGeojson(dir, 'postal_code=95814.geojson', fc([point([0, 0])]));
    for (const bad of [
      'https://example.maps.arcgis.com/foo.geojson?token=CANARY',
      'z://user:pass@example/path.geojson',
      'z://example/path.geojson',
      '//user:pass@example/path.geojson',
      '\\\\server\\share\\x.geojson',
      'access_token=CANARY.geojson',
      'Bearer CANARY.geojson',
      'Basic CANARY.geojson',
      'encoded%20space.geojson',
      'access_token%3DCANARY.geojson',
      'access_token%ZZ%253DCANARY.geojson',
      'access_token%C0%AE%3DCANARY.geojson',
    ]) {
      const denied = await run({ source_uri: bad, candidate_source_uri: goodCandidate });
      assert.equal(denied.ok, false, bad);
      assert.equal(denied.counts.audit, 0, bad);
      assert.equal(denied.counts.begin, 0, bad);
      assert.equal(denied.counts.finish, 0, bad);
      assert.equal(denied.counts.stat, 0, bad);
      assert.equal(denied.counts.readFile, 0, bad);
      assert.doesNotMatch(denied.error ?? '', /CANARY|example\.maps|access_token|user|pass|example|z:\/\/|path\.geojson/i, bad);
    }
    const canonicalAlias = await run({ source_uri: './a.geojson', candidate_source_uri: 'sub/../a.geojson' });
    assert.equal(canonicalAlias.ok, false);
    assert.match(canonicalAlias.error ?? '', /distinct/i);
    assert.equal(canonicalAlias.counts.audit, 0);
    assert.equal(canonicalAlias.counts.begin, 0);
    assert.equal(canonicalAlias.counts.finish, 0);
    assert.equal(canonicalAlias.counts.stat, 0);
    assert.equal(canonicalAlias.counts.readFile, 0);

    const realSource = await writeGeojson(dir, 'real-source.geojson', fc([point([0, 0])]));
    const realpathAliasPath = join(dir, 'realpath-alias.geojson');
    let symlinkUnavailable = false;
    try {
      await symlink(realSource, realpathAliasPath);
    } catch (error: any) {
      if (process.platform === 'win32' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        symlinkUnavailable = true;
      } else {
        throw error;
      }
    }
    if (!symlinkUnavailable) {
      const realpathAlias = await run({ source_uri: realSource, candidate_source_uri: realpathAliasPath });
      assert.equal(realpathAlias.ok, false);
      assert.match(realpathAlias.error ?? '', /distinct/i);
      assert.doesNotMatch(realpathAlias.error ?? '', /real-source|realpath-alias|tmp-run-vector-analysis/i);
      assert.equal(realpathAlias.counts.audit, 0);
      assert.equal(realpathAlias.counts.begin, 0);
      assert.equal(realpathAlias.counts.finish, 0);
      assert.equal(realpathAlias.counts.stat, 0);
      assert.equal(realpathAlias.counts.readFile, 0);
    }

    const allowed = await run({ source_uri: goodSource, candidate_source_uri: goodCandidate });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.counts.begin, 1);
    assert.equal(allowed.counts.stat, 2);
    assert.equal(allowed.counts.readFile, 2);
  });
});

test('direct execution reasserts filesystem boundary before every stat/read and redacts adapter exceptions', async () => {
  await withTempDir(async (dir) => {
    const source = await writeGeojson(dir, 'primary.geojson', fc([point([0, 0])]));
    const candidate = await writeGeojson(dir, 'candidate.geojson', fc([point([0, 0])]));
    const boundaryTargets: string[] = [];
    const result = await run({ source_uri: source, candidate_source_uri: candidate }, {
      boundaryOptions: {
        audit: async () => {},
      },
      capabilityContext: {
        now: () => FIXED_NOW,
        boundary: {
          audit: async (_event, payload) => {
            boundaryTargets.push(String(payload.target ?? ''));
          },
        },
        io: {
          stat: async (path: string) => stat(path),
          readFile: async (path: string) => readFile(path),
        },
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(boundaryTargets.length, 0);

    const checked: string[] = [];
    const direct = await runVectorAnalysisCapability.execute(
      runVectorAnalysisCapability.inputSchema.parse({ source_uri: source, candidate_source_uri: candidate }),
      {
        now: () => FIXED_NOW,
        boundary: {
          audit: async (_event, payload) => {
            checked.push(String(payload.target ?? ''));
          },
        },
        io: {
          stat: async (path: string) => ({ size: (await stat(path)).size }),
          readFile: async (path: string) => readFile(path),
        },
      },
    );
    assert.equal(direct.report.counts.input_features, 1);

    const directAliasPath = join(dir, 'direct-alias.geojson');
    let directSymlinkUnavailable = false;
    try {
      await symlink(source, directAliasPath);
    } catch (error: any) {
      if (process.platform === 'win32' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        directSymlinkUnavailable = true;
      } else {
        throw error;
      }
    }
    if (!directSymlinkUnavailable) {
      let statCalls = 0;
      await assert.rejects(
        () =>
          runVectorAnalysisCapability.execute(
            runVectorAnalysisCapability.inputSchema.parse({ source_uri: source, candidate_source_uri: directAliasPath }),
            {
              now: () => FIXED_NOW,
              io: {
                stat: async (path: string) => { statCalls += 1; return ({ size: (await stat(path)).size }); },
                readFile: async (path: string) => readFile(path),
              },
            },
          ),
        /distinct/i,
      );
      assert.equal(statCalls, 0);
    }

    const failure = await run({ source_uri: source, candidate_source_uri: candidate }, {
      capabilityContext: {
        now: () => FIXED_NOW,
        io: {
          stat: async () => { throw new Error('stat leaked /tmp/access_token=CANARY.geojson'); },
          readFile,
        },
      },
    });
    assert.equal(failure.ok, false);
    assert.match(failure.error ?? '', /file stat failed/);
    assert.doesNotMatch(failure.error ?? '', /CANARY|access_token|\/tmp/);
  });
});
