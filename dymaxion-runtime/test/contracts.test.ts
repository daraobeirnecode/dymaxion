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

test('evidence bundles cover provenance and reject unknown fields recursively', () => {
  assert.equal(EvidenceBundleSchema.parse(evidence).execution.mode, 'deterministic');
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, source: { ...evidence.source, untrusted: true } }),
    /unrecognized/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...evidence, execution: { ...evidence.execution, mode: 'hand-wavy' } }),
    /invalid/i,
  );
});

test('canonical JSON and hashes are stable across object key order', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, b: 2 } }), '{"a":{"b":2,"d":4},"z":1}');
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite JSON number/);
});
