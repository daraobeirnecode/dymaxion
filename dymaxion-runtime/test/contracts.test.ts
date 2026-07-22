import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityManifestSchema } from '../src/contracts/capability.js';
import { EvidenceBundleSchema } from '../src/contracts/evidence.js';
import { canonicalJson, sha256Canonical } from '../src/contracts/canonical.js';

const capability = {
  schema_version: '1.0.0',
  slug: 'inspect_dataset',
  name: 'Inspect dataset',
  description: 'Read-only deterministic inspection of one allowlisted local GeoJSON dataset.',
  version: '1.0.0',
  classification: 'read',
  identity: { required: false, permissions: [] },
  allowed_hosts: [],
  allowed_sources: ['filesystem'],
  resource_limits: {
    max_records: 10_000,
    max_bytes: 1_048_576,
    max_duration_ms: 5_000,
    max_cost_usd: 0,
  },
  idempotency: { mode: 'deterministic', key_fields: ['source_uri', 'sha256'] },
  dry_run: { supported: false, reason: 'Read-only capability.' },
  cancellation: { supported: true, checkpoint: 'before_file_read' },
  artifacts: [{ name: 'dataset_passport', media_type: 'application/json', required: true }],
  rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
  validation: { suite: 'gisbench', version: '0.1.0', supported_gis_versions: ['GeoJSON RFC 7946'] },
  input_schema_version: '1.0.0',
  output_schema_version: '1.0.0',
} as const;

const evidence = {
  schema_version: '1.0.0',
  bundle_id: 'inspect_dataset:fixture',
  generated_at: '2026-07-18T12:00:00.000Z',
  source: {
    uri: 'file:///workspace/fixtures/points.geojson',
    identity: { kind: 'file', value: '/workspace/fixtures/points.geojson' },
    version: { modified_at: '2026-07-18T11:00:00.000Z' },
    retrieved_at: '2026-07-18T12:00:00.000Z',
    sha256: 'a'.repeat(64),
  },
  gis_metadata: {
    format: 'GeoJSON',
    crs: 'OGC:CRS84',
    axis_order: 'longitude,latitude',
    units: 'degrees',
    extent: [-122.5, 37.7, -122.3, 37.9],
    schema: [{ name: 'id', types: ['number'], nullable: false }],
    row_count: 2,
    geometry_types: ['Point'],
    temporal_fields: [],
  },
  parameters: { canonical_json: '{"source_uri":"file:///workspace/fixtures/points.geojson"}', sha256: 'b'.repeat(64) },
  execution: {
    capability: 'inspect_dataset',
    capability_version: '1.0.0',
    mode: 'deterministic',
    model_planning: [],
  },
  outputs: [{ name: 'dataset_passport', sha256: 'c'.repeat(64), validation: { valid: true, checks: ['schema'] } }],
  approvals: [],
  rollback: { required: false, strategy: 'none', artifacts: [] },
} as const;

test('capability manifests are versioned, complete, and strict', () => {
  assert.equal(CapabilityManifestSchema.parse(capability).classification, 'read');
  assert.throws(() => CapabilityManifestSchema.parse({ ...capability, surprise: true }), /unrecognized/i);
  assert.throws(
    () => CapabilityManifestSchema.parse({ ...capability, resource_limits: { max_bytes: 1 } }),
    /max_records|invalid/i,
  );
});

test('resource limit contract accepts optional vector-analysis ceilings and remains strict', () => {
  const legacyParsed = CapabilityManifestSchema.parse(capability);
  assert.deepEqual(legacyParsed.resource_limits, capability.resource_limits);

  const vectorAnalysisCapability = {
    ...capability,
    slug: 'run_vector_analysis',
    name: 'Run vector analysis',
    resource_limits: {
      ...capability.resource_limits,
      max_pair_evaluations: 250_000,
      max_output_bytes: 2_097_152,
      max_source_bytes: 1_048_576,
      max_primary_records: 1_000,
      max_candidate_records: 1_000,
      max_coordinate_ordinates: 8_000,
      max_json_depth: 32,
      max_json_nodes: 20_000,
    },
  };

  const parsed = CapabilityManifestSchema.parse(vectorAnalysisCapability);
  assert.equal(parsed.resource_limits.max_pair_evaluations, 250_000);
  assert.equal(parsed.resource_limits.max_output_bytes, 2_097_152);
  assert.equal(parsed.resource_limits.max_source_bytes, 1_048_576);
  assert.equal(parsed.resource_limits.max_primary_records, 1_000);
  assert.equal(parsed.resource_limits.max_candidate_records, 1_000);
  assert.equal(parsed.resource_limits.max_coordinate_ordinates, 8_000);
  assert.equal(parsed.resource_limits.max_json_depth, 32);
  assert.equal(parsed.resource_limits.max_json_nodes, 20_000);

  for (const field of [
    'max_pair_evaluations',
    'max_output_bytes',
    'max_source_bytes',
    'max_primary_records',
    'max_candidate_records',
    'max_coordinate_ordinates',
    'max_json_depth',
    'max_json_nodes',
  ] as const) {
    for (const value of [0, -1, 1.5]) {
      assert.throws(
        () =>
          CapabilityManifestSchema.parse({
            ...capability,
            resource_limits: { ...capability.resource_limits, [field]: value },
          }),
        /greater than 0|integer|too small|invalid/i,
      );
    }
  }

  assert.throws(
    () =>
      CapabilityManifestSchema.parse({
        ...capability,
        resource_limits: { ...capability.resource_limits, unexpected_limit: 1 },
      }),
    /unrecognized/i,
  );
});

test('resource limit contract accepts strict optional evidence-export ceilings', () => {
  const limits = {
    max_report_bytes: 1_048_576,
    max_evidence_bytes: 1_048_576,
    max_artifact_bytes: 2_097_152,
    max_archive_bytes: 5_242_880,
    max_archive_entries: 4,
    max_project_bytes: 67_108_864,
    max_project_bundles: 100,
  } as const;
  const parsed = CapabilityManifestSchema.parse({
    ...capability,
    slug: 'export_evidence_bundle',
    name: 'Export evidence bundle',
    classification: 'copy-on-write',
    resource_limits: { ...capability.resource_limits, ...limits },
  });

  for (const [field, value] of Object.entries(limits)) {
    assert.equal(parsed.resource_limits[field as keyof typeof limits], value);
    for (const invalid of [0, -1, 1.5]) {
      assert.throws(
        () =>
          CapabilityManifestSchema.parse({
            ...capability,
            resource_limits: { ...capability.resource_limits, [field]: invalid },
          }),
        /greater than 0|integer|too small|invalid/i,
      );
    }
  }
});

test('evidence bundles cover provenance and reject unknown fields recursively', () => {
  assert.equal(EvidenceBundleSchema.parse(evidence).execution.mode, 'deterministic');
  assert.deepEqual(EvidenceBundleSchema.parse(evidence), evidence);
  const withSourceBytes = {
    ...evidence,
    source: { ...evidence.source, bytes: 0 },
  };
  assert.equal(EvidenceBundleSchema.parse(withSourceBytes).source.bytes, 0);
  assert.equal(EvidenceBundleSchema.parse({ ...evidence, source: { ...evidence.source, bytes: 123 } }).source.bytes, 123);
  for (const bytes of [-1, 1.5]) {
    assert.throws(
      () => EvidenceBundleSchema.parse({ ...evidence, source: { ...evidence.source, bytes } }),
      /integer|greater than or equal|too small/i,
    );
  }
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, source: { ...evidence.source, bytes: 'unknown' } }),
    /number|invalid/i,
  );
  const withBytes = {
    ...evidence,
    outputs: [{ ...evidence.outputs[0], bytes: 123 }],
  };
  assert.equal(EvidenceBundleSchema.parse(withBytes).outputs[0]?.bytes, 123);
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, outputs: [{ ...evidence.outputs[0], bytes: -1 }] }),
    /greater than or equal|too small/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, source: { ...evidence.source, untrusted: true } }),
    /unrecognized/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, execution: { ...evidence.execution, mode: 'hand-wavy' } }),
    /invalid/i,
  );
});

test('evidence bundles accept strict non-empty related sources with unique bounded roles', () => {
  const relatedSource = {
    role: 'candidate_features',
    uri: 'file:///workspace/fixtures/candidates.geojson',
    identity: { kind: 'file', value: '/workspace/fixtures/candidates.geojson' },
    version: { modified_at: '2026-07-18T11:30:00.000Z' },
    retrieved_at: '2026-07-18T12:00:00.000Z',
    sha256: 'd'.repeat(64),
    bytes: 0,
    gis_metadata: {
      ...evidence.gis_metadata,
      row_count: 5,
    },
  };

  const withRelatedSources = { ...evidence, related_sources: [relatedSource] };
  assert.deepEqual(EvidenceBundleSchema.parse(withRelatedSources).related_sources, [relatedSource]);
  assert.equal(
    EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, bytes: 321 }] }).related_sources?.[0]?.bytes,
    321,
  );
  for (const bytes of [-1, 1.5]) {
    assert.throws(
      () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, bytes }] }),
      /integer|greater than or equal|too small/i,
    );
  }
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, bytes: 'unknown' }] }),
    /number|invalid/i,
  );

  assert.throws(() => EvidenceBundleSchema.parse({ ...evidence, related_sources: [] }), /at least 1|too_small/i);
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, role: '' }] }),
    /invalid[_ ]string|invalid format|pattern/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, role: 'x'.repeat(65) }] }),
    /invalid[_ ]string|invalid format|pattern/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, role: 'candidate\nsource' }] }),
    /invalid[_ ]string|invalid format|pattern/i,
  );
  assert.throws(
    () =>
      EvidenceBundleSchema.parse({
        ...evidence,
        related_sources: [relatedSource, { ...relatedSource, uri: 'file:///workspace/fixtures/other.geojson' }],
      }),
    (error: any) => {
      const issue = error?.issues?.find((candidate: any) => candidate.message === 'duplicate related source role');
      assert.deepEqual(issue?.path, ['related_sources', 1, 'role']);
      assert.equal(issue?.code, 'custom');
      return true;
    },
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, related_sources: [{ ...relatedSource, untrusted: true }] }),
    /unrecognized/i,
  );
  assert.throws(
    () =>
      EvidenceBundleSchema.parse({
        ...evidence,
        related_sources: [{ ...relatedSource, gis_metadata: { ...relatedSource.gis_metadata, untrusted: true } }],
      }),
    /unrecognized/i,
  );
});

test('canonical JSON and hashes are stable across object key order', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, b: 2 } }), '{"a":{"b":2,"d":4},"z":1}');
  assert.equal(canonicalJson({ ä: 4, å: 3, z: 2, a: 1 }), '{"a":1,"z":2,"ä":4,"å":3}');
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite JSON number/);
});
