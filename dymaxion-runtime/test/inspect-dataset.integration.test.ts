import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { inspectDatasetCapability } from '../src/capabilities/inspect-dataset.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const fixtures = join(repoRoot, 'gisbench', 'fixtures');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

function testDependencies(overrides: Partial<RunSkillDependencies> = {}): RunSkillDependencies {
  return {
    recorder: {
      begin: async () => 'invocation-test',
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      io: { stat, readFile },
    },
    ...overrides,
  };
}

test('inspect_dataset is a strict read-only versioned capability', () => {
  assert.equal(inspectDatasetCapability.manifest.slug, 'inspect_dataset');
  assert.equal(inspectDatasetCapability.manifest.classification, 'read');
  assert.equal(inspectDatasetCapability.manifest.version, '1.0.0');
  assert.throws(
    () => inspectDatasetCapability.inputSchema.parse({ source_uri: 'x.geojson', unknown: true }),
    /unrecognized/i,
  );
});

test('inspect_dataset runs end-to-end through the real runtime dispatcher', async () => {
  const source = join(fixtures, 'synthetic-points.geojson');
  const result = await runSkill(
    'inspect_dataset',
    { source_uri: source },
    '00000000-0000-0000-0000-000000000001',
    testDependencies(),
  );

  assert.equal(result.ok, true, result.error);
  const output = result.output as {
    passport: {
      feature_count: number;
      format: string;
      crs: string | null;
      axis_order: string | null;
      units: string | null;
      extent: number[] | null;
      geometry_types: string[];
      temporal_fields: Array<{ name: string; parsed_count: number }>;
      warnings: string[];
    };
    evidence: { execution: { mode: string }; source: { sha256: string } };
  };
  assert.doesNotThrow(() => inspectDatasetCapability.outputSchema.parse(result.output));
  assert.throws(
    () => inspectDatasetCapability.outputSchema.parse({ ...(result.output as object), unexpected: true }),
    /unrecognized|unknown/i,
  );
  assert.equal(output.passport.feature_count, 2);
  assert.equal(output.passport.format, 'GeoJSON');
  assert.equal(output.passport.crs, 'OGC:CRS84');
  assert.equal(output.passport.axis_order, 'longitude,latitude');
  assert.equal(output.passport.units, 'degrees');
  assert.deepEqual(output.passport.extent, [-105.1001, 39.6002, -104.9002, 39.7001]);
  assert.deepEqual(output.passport.geometry_types, ['Point']);
  assert.deepEqual(output.passport.temporal_fields, [
    {
      name: 'observed_at',
      min: '2026-01-15T10:00:00.000Z',
      max: '2026-02-20T11:30:00.000Z',
      parsed_count: 2,
    },
  ]);
  assert.equal(output.evidence.execution.mode, 'deterministic');
  assert.match(output.evidence.source.sha256, /^[a-f0-9]{64}$/);
});

test('boundary rejection occurs before invocation recording or dataset I/O', async () => {
  let began = 0;
  let ioCalls = 0;
  const dependencies = testDependencies({
    recorder: {
      begin: async () => {
        began += 1;
        return 'should-not-begin';
      },
      finish: async () => undefined,
    },
    capabilityContext: {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
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
  });

  const result = await runSkill(
    'inspect_dataset',
    { source_uri: '/etc/hosts' },
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /boundary violation/i);
  assert.equal(began, 0);
  assert.equal(ioCalls, 0);
});

test('inspect_dataset rejects malformed, oversized, and unsupported inputs honestly', async () => {
  const deps = testDependencies();
  const malformed = await runSkill(
    'inspect_dataset',
    { source_uri: join(fixtures, 'malformed.geojson') },
    '00000000-0000-0000-0000-000000000001',
    deps,
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.error ?? '', /malformed GeoJSON/i);

  const oversized = await runSkill(
    'inspect_dataset',
    { source_uri: join(fixtures, 'synthetic-points.geojson'), max_bytes: 100 },
    '00000000-0000-0000-0000-000000000001',
    deps,
  );
  assert.equal(oversized.ok, false);
  assert.match(oversized.error ?? '', /resource limit/i);

  const unsupported = await runSkill(
    'inspect_dataset',
    { source_uri: join(fixtures, 'unsupported.csv') },
    '00000000-0000-0000-0000-000000000001',
    deps,
  );
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error ?? '', /unsupported dataset format/i);
});
