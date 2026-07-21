import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { allCapabilities } from '../src/capabilities/registry.js';
import {
  GenerateMapArtifactOutputSchema,
  MAX_AUDIENCE_CHARS,
  MAX_BYTES,
  MAX_COORDINATE_POSITIONS,
  MAX_DURATION_MS,
  MAX_FEATURES,
  MAX_GEOMETRY_COLLECTION_DEPTH,
  MAX_HEIGHT_PX,
  MAX_PURPOSE_CHARS,
  MAX_SVG_BYTES,
  MAX_TITLE_CHARS,
  MAX_WIDTH_PX,
  generateMapArtifactCapability,
  type GenerateMapArtifactOutput,
} from '../src/capabilities/generate-map-artifact.js';
import { sha256Canonical, sha256Text } from '../src/contracts/canonical.js';
import { CapabilityManifestSchema } from '../src/contracts/capability.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const AGENT_RUN_ID = '00000000-0000-0000-0000-000000000001';
const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');

type SinkCounts = { audit: number; begin: number; finish: number; stat: number; readFile: number };

function deps(counts?: SinkCounts, overrides: Partial<RunSkillDependencies> = {}): RunSkillDependencies {
  const sinkCounts = counts ?? { audit: 0, begin: 0, finish: 0, stat: 0, readFile: 0 };
  return {
    recorder: {
      begin: async () => {
        sinkCounts.begin += 1;
        return 'invocation-test';
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
  const dir = await mkdtemp(join(repoRoot, '.tmp-map-artifact-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeGeojson(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

async function generate(
  input: Record<string, unknown>,
  overrides: Partial<RunSkillDependencies> = {},
): Promise<{ ok: boolean; error?: string; output: GenerateMapArtifactOutput; counts: SinkCounts }> {
  const counts = { audit: 0, begin: 0, finish: 0, stat: 0, readFile: 0 };
  const result = await runSkill('generate_map_artifact', input, AGENT_RUN_ID, deps(counts, overrides));
  return { ok: result.ok, error: result.error, output: result.output as GenerateMapArtifactOutput, counts };
}

const familyCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: '<script>not used</script>' }, geometry: { type: 'Point', coordinates: [-105, 39.7] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[-104.9, 39.75], [-104.8, 39.78]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-105.2, 39.6], [-105.1, 39.65]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[-105.3, 39.62], [-105.25, 39.66]]] } },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-105.4, 39.5], [-105.0, 39.5], [-105.0, 39.9], [-105.4, 39.9], [-105.4, 39.5]],
          [[-105.3, 39.6], [-105.2, 39.6], [-105.2, 39.7], [-105.3, 39.7], [-105.3, 39.6]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[[ -104.7, 39.55], [-104.6, 39.55], [-104.6, 39.65], [-104.7, 39.65], [-104.7, 39.55]]]],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [-104.5, 39.8] }] },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
};

test('generate_map_artifact manifest, schema and registry are strict and trace all Phase 1E ceilings', () => {
  const manifest = generateMapArtifactCapability.manifest;
  assert.equal(manifest.slug, 'generate_map_artifact');
  assert.equal(manifest.classification, 'read');
  assert.deepEqual(manifest.allowed_hosts, []);
  assert.deepEqual(manifest.allowed_sources, ['filesystem']);
  assert.equal(manifest.resource_limits.max_records, MAX_FEATURES);
  assert.equal(manifest.resource_limits.max_bytes, MAX_BYTES);
  assert.equal(manifest.resource_limits.max_duration_ms, MAX_DURATION_MS);
  assert.equal(manifest.resource_limits.max_coordinate_positions, MAX_COORDINATE_POSITIONS);
  assert.equal(manifest.resource_limits.max_geometry_collection_depth, MAX_GEOMETRY_COLLECTION_DEPTH);
  assert.equal(manifest.resource_limits.max_svg_bytes, MAX_SVG_BYTES);
  assert.equal(manifest.resource_limits.max_width_px, MAX_WIDTH_PX);
  assert.equal(manifest.resource_limits.max_height_px, MAX_HEIGHT_PX);
  assert.equal(manifest.resource_limits.max_title_chars, MAX_TITLE_CHARS);
  assert.equal(manifest.resource_limits.max_purpose_chars, MAX_PURPOSE_CHARS);
  assert.equal(manifest.resource_limits.max_audience_chars, MAX_AUDIENCE_CHARS);
  assert.throws(() => CapabilityManifestSchema.parse({ ...manifest, resource_limits: { ...manifest.resource_limits, bogus_limit: 1 } }), /unrecognized/i);

  const schema = generateMapArtifactCapability.inputSchema;
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', unknown: true }), /unrecognized/i);
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', target_format: 'png' }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', width: MAX_WIDTH_PX + 1 }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', height: MAX_HEIGHT_PX + 1 }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', title: 'a'.repeat(MAX_TITLE_CHARS + 1) }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', title: 'Authorization: Bearer CANARY' }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson', purpose: 'access_token=CANARY' }));
  assert.throws(() => schema.parse({ source_uri: 'https://example.maps.arcgis.com/f.geojson?token=CANARY' }));
  assert.throws(() => schema.parse({ source_uri: 'file:///tmp/f.geojson' }));
  assert.throws(() => schema.parse({ source_uri: 'x.geojson#frag' }));
  assert.throws(() => schema.parse({ source_uri: 'x%20.geojson' }));
  assert.throws(() => schema.parse({ source_uri: 'Bearer CANARY.geojson' }));
  assert.doesNotThrow(() => schema.parse({ source_uri: 'token-inventory.geojson' }));
  assert.doesNotThrow(() => schema.parse({ source_uri: 'postal_code=95814.geojson' }));
  assert.ok(allCapabilities().some((capability) => capability.manifest.slug === 'generate_map_artifact'));
  assert.equal(allCapabilities().length, 6);
});

test('geometry families, multipart polygons and holes render deterministic safe inline SVG with exact evidence hashes', async () => {
  await withTempDir(async (dir) => {
    const path = await writeGeojson(dir, 'useful geometry 🗺️.geojson', familyCollection);
    const first = await generate({
      source_uri: path,
      title: 'Demo <Map> & "Artifact"',
      purpose: 'Render without raw <script>alert(1)</script> markup.',
      audience: 'Operators & reviewers',
      style: 'blueprint',
      point_symbol: 'square',
      width: 640,
      height: 480,
    });
    const second = await generate({
      source_uri: path,
      title: 'Demo <Map> & "Artifact"',
      purpose: 'Render without raw <script>alert(1)</script> markup.',
      audience: 'Operators & reviewers',
      style: 'blueprint',
      point_symbol: 'square',
      width: 640,
      height: 480,
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(first.output.artifact.content, second.output.artifact.content);
    assert.deepEqual(first.output.evidence, second.output.evidence);
    assert.doesNotThrow(() => GenerateMapArtifactOutputSchema.parse(first.output));
    assert.equal(first.output.artifact.media_type, 'image/svg+xml; charset=utf-8');
    assert.equal(first.output.artifact.bytes, Buffer.byteLength(first.output.artifact.content, 'utf8'));
    assert.equal(first.output.artifact.sha256, sha256Text(first.output.artifact.content));
    assert.equal(first.output.report.artifact.sha256, first.output.artifact.sha256);
    assert.equal(first.output.evidence.outputs[0].bytes, first.output.artifact.bytes);
    assert.equal(first.output.evidence.outputs[0].sha256, first.output.artifact.sha256);
    assert.equal(first.output.evidence.parameters.sha256, sha256Text(first.output.evidence.parameters.canonical_json));
    assert.equal(first.output.evidence.source.sha256, sha256Text(await readFile(path)));
    assert.equal(first.output.report.file_sha256, first.output.evidence.source.sha256);
    assert.equal(first.output.report.source_uri, first.output.evidence.source.uri);
    assert.equal(first.output.report.source_handle, path);
    assert.match(first.output.report.source_uri, /^file:/);
    assert.deepEqual(first.output.report.sources, [
      {
        kind: 'local-file',
        attribution: first.output.report.source_attribution,
        sha256: first.output.report.file_sha256,
      },
    ]);
    assert.deepEqual(first.output.report.legend.entries.map((entry) => entry.family), ['polygon', 'line', 'point']);
    assert.match(
      first.output.artifact.content,
      /<rect x="48" y="119\.111" width="544" height="241\.778"/,
    );
    assert.throws(
      () => GenerateMapArtifactOutputSchema.parse({ ...(first.output as object), unexpected: true }),
      /unrecognized|unknown/i,
    );
    assert.match(first.output.artifact.content, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg/);
    assert.doesNotMatch(first.output.artifact.content.toLowerCase(), /<script|javascript:|<!doctype|<!entity|<foreignobject|\son[a-z]+\s*=| href=|xlink:href=|url\(/);
    assert.ok(!first.output.artifact.content.includes('<script>alert(1)</script>'));
    assert.ok(!first.output.artifact.content.includes('not used'));
    assert.ok(first.output.artifact.content.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.equal(first.output.report.geometry_counts.Point, 2); // one direct + one inside GeometryCollection
    assert.equal(first.output.report.geometry_counts.MultiPoint, 1);
    assert.equal(first.output.report.geometry_counts.LineString, 1);
    assert.equal(first.output.report.geometry_counts.MultiLineString, 1);
    assert.equal(first.output.report.geometry_counts.Polygon, 1);
    assert.equal(first.output.report.geometry_counts.MultiPolygon, 1);
    assert.equal(first.output.report.geometry_counts.GeometryCollection, 1);
    assert.equal(first.output.report.geometry_counts.null_geometry, 1);
    assert.ok(first.output.report.qa.limitations.some((limitation) => limitation.includes('No basemap')));
  });
});

test('antimeridian and empty/point degenerate extents are deliberate and deterministic', async () => {
  await withTempDir(async (dir) => {
    const antiPath = await writeGeojson(dir, 'antimeridian.geojson', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[179.6, 10], [-179.7, 10.2]] } }],
    });
    const anti = await generate({ source_uri: antiPath });
    assert.equal(anti.ok, true, anti.error);
    assert.equal(anti.output.report.extent.antimeridian_crosses, true);
    assert.ok(anti.output.report.extent.viewport[2] - anti.output.report.extent.viewport[0] < 2);
    assert.ok(anti.output.report.qa.warnings.some((warning) => warning.includes('Antimeridian-aware')));

    const emptyPath = await writeGeojson(dir, 'empty.geojson', { type: 'FeatureCollection', features: [] });
    const empty = await generate({ source_uri: emptyPath });
    assert.equal(empty.ok, true, empty.error);
    assert.equal(empty.output.report.extent.empty, true);
    assert.equal(empty.output.report.extent.source, null);
    assert.deepEqual(empty.output.report.extent.viewport, [-180, -90, 180, 90]);
    assert.ok(empty.output.artifact.content.includes('Empty FeatureCollection'));

    const pointPath = await writeGeojson(dir, 'point.geojson', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [12.0004, 34.0004] } }],
    });
    const point = await generate({ source_uri: pointPath });
    assert.equal(point.ok, true, point.error);
    assert.deepEqual(point.output.report.extent.source, [12.0004, 34.0004, 12.0004, 34.0004]);
    assert.deepEqual(point.output.report.extent.viewport, [11.5004, 33.5004, 12.5004, 34.5004]);

    const negativeExtentPath = await writeGeojson(dir, 'negative-extent.geojson', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiPoint', coordinates: [[-105.4, 39.5], [-104.8, 39.9]] },
        },
      ],
    });
    const negativeExtent = await generate({ source_uri: negativeExtentPath });
    assert.equal(negativeExtent.ok, true, negativeExtent.error);
    assert.deepEqual(negativeExtent.output.report.extent.source, [-105.4, 39.5, -104.8, 39.9]);

    const datelinePointPath = await writeGeojson(dir, 'dateline-point.geojson', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [179.8, 0] } }],
    });
    const datelinePoint = await generate({ source_uri: datelinePointPath });
    assert.equal(datelinePoint.ok, true, datelinePoint.error);
    assert.deepEqual(datelinePoint.output.report.extent.source, [179.8, 0, 179.8, 0]);
    assert.deepEqual(datelinePoint.output.report.extent.viewport, [179.3, -0.5, 180.3, 0.5]);
    assert.equal(datelinePoint.output.report.extent.antimeridian_crosses, true);
    assert.ok(datelinePoint.output.report.qa.warnings.some((warning) => warning.includes('Antimeridian-aware')));
    assert.match(datelinePoint.output.artifact.content, />Antimeridian-aware extent<\/text>/);
    assert.doesNotMatch(datelinePoint.output.artifact.content, />CRS84 extent<\/text>/);

    const roundedBoundaryPath = await writeGeojson(dir, 'rounded-boundary.geojson', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [179.50000000000003, 0] },
        },
      ],
    });
    const roundedBoundary = await generate({ source_uri: roundedBoundaryPath });
    assert.equal(roundedBoundary.ok, true, roundedBoundary.error);
    assert.deepEqual(roundedBoundary.output.report.extent.viewport, [179, -0.5, 180, 0.5]);
    assert.equal(roundedBoundary.output.report.extent.antimeridian_crosses, false);
    assert.equal(roundedBoundary.output.report.qa.warnings.some((warning) => warning.includes('Antimeridian-aware')), false);
    assert.match(roundedBoundary.output.artifact.content, />CRS84 extent<\/text>/);
    assert.doesNotMatch(roundedBoundary.output.artifact.content, />Antimeridian-aware extent<\/text>/);
  });
});

test('malformed, out-of-range, unsupported, depth, feature, coordinate, SVG-output, duration and cancellation limits fail closed', async () => {
  await withTempDir(async (dir) => {
    for (const [name, value, pattern] of [
      ['range.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [181, 0] } }] }, /coordinates must be in CRS84/],
      ['unsupported.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Circle', coordinates: [0, 0] } }] }, /unsupported GeoJSON geometry type/],
      ['malformed.geojson', { type: 'FeatureCollection', features: [{ type: 'NotFeature', properties: {}, geometry: null }] }, /not a Feature/],
      ['short-line.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0]] } }] }, /too few positions/],
      ['short-ring.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } }] }, /too few positions/],
      ['open-ring.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } }] }, /closed linear ring/],
      ['legacy-crs.geojson', { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:3857' } }, features: [] }, /legacy crs members/],
      ['missing-properties.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null }] }, /properties must be an object or null/],
      ['array-properties.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: [], geometry: null }] }, /properties must be an object or null/],
      ['higher-ordinate.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0, 'bad'] } }] }, /ordinates must all be finite numbers/],
      ['null-collection-member.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [null] } }] }, /GeometryCollection members must be Geometry objects/],
      ['features.geojson', { type: 'FeatureCollection', features: Array.from({ length: MAX_FEATURES + 1 }, () => ({ type: 'Feature', properties: {}, geometry: null })) }, /features > 10000/],
    ] as const) {
      const path = await writeGeojson(dir, name, value);
      const result = await generate({ source_uri: path });
      assert.equal(result.ok, false, name);
      assert.match(result.error ?? '', pattern);
    }

    const virtualOversizedPath = join(dir, 'virtual-oversized.geojson');
    const oversized = await generate(
      { source_uri: virtualOversizedPath },
      {
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => ({ size: MAX_BYTES + 1 }),
            readFile: async () => {
              throw new Error('readFile must not run after oversized stat');
            },
          },
        },
      },
    );
    assert.equal(oversized.ok, false);
    assert.match(oversized.error ?? '', /resource limit/);
    assert.equal(oversized.counts.readFile, 0);

    const invalidUtf8Path = await writeGeojson(dir, 'invalid-utf8.geojson', { type: 'FeatureCollection', features: [] });
    const invalidUtf8Bytes = Buffer.concat([
      Buffer.from('{"type":"FeatureCollection","foreign":"', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('","features":[]}\n', 'utf8'),
    ]);
    const invalidUtf8 = await generate(
      { source_uri: invalidUtf8Path },
      {
        capabilityContext: {
          now: () => FIXED_NOW,
          io: {
            stat: async () => ({ size: invalidUtf8Bytes.byteLength }),
            readFile: async () => invalidUtf8Bytes,
          },
        },
      },
    );
    assert.equal(invalidUtf8.ok, false);
    assert.match(invalidUtf8.error ?? '', /not valid UTF-8/);

    let geometry: unknown = { type: 'Point', coordinates: [0, 0] };
    for (let i = 0; i < MAX_GEOMETRY_COLLECTION_DEPTH + 1; i += 1) geometry = { type: 'GeometryCollection', geometries: [geometry] };
    const deep = await generate({ source_uri: await writeGeojson(dir, 'deep.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] }) });
    assert.equal(deep.ok, false);
    assert.match(deep.error ?? '', /GeometryCollection depth/);

    const tooManyCoords = await generate({
      source_uri: await writeGeojson(dir, 'coords.geojson', {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: Array.from({ length: MAX_COORDINATE_POSITIONS + 1 }, (_, i) => [i % 180, 0]) } }],
      }),
    });
    assert.equal(tooManyCoords.ok, false);
    assert.match(tooManyCoords.error ?? '', /coordinate positions/);

    const bigSvg = await generate({
      source_uri: await writeGeojson(dir, 'big-svg.geojson', {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: Array.from({ length: 10_000 }, (_, i) => [(i % 360) - 180, Math.floor(i / 360) % 80]) } }],
      }),
    });
    assert.equal(bigSvg.ok, false);
    assert.match(bigSvg.error ?? '', /SVG output/);

    const abortController = new AbortController();
    abortController.abort();
    const cancelled = await generate(
      { source_uri: await writeGeojson(dir, 'cancel.geojson', { type: 'FeatureCollection', features: [] }) },
      { capabilityContext: { now: () => FIXED_NOW, signal: abortController.signal, io: { stat, readFile } } },
    );
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.error ?? '', /cancelled before file read/);
    assert.equal(cancelled.counts.stat, 0);
    assert.equal(cancelled.counts.readFile, 0);

    const midAbortController = new AbortController();
    const cancelledAfterRead = await generate(
      { source_uri: await writeGeojson(dir, 'cancel-after-read.geojson', familyCollection) },
      {
        capabilityContext: {
          now: () => FIXED_NOW,
          signal: midAbortController.signal,
          io: {
            stat,
            readFile: async (path: string) => {
              const content = await readFile(path);
              midAbortController.abort();
              return content;
            },
          },
        },
      },
    );
    assert.equal(cancelledAfterRead.ok, false);
    assert.match(cancelledAfterRead.error ?? '', /cancelled/i);

    let parseSignalChecks = 0;
    const parseSignal = {
      get aborted(): boolean {
        parseSignalChecks += 1;
        return parseSignalChecks >= 8;
      },
    } as AbortSignal;
    const cancelledDuringCoordinates = await generate(
      {
        source_uri: await writeGeojson(dir, 'cancel-during-coordinates.geojson', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: Array.from({ length: 1_000 }, (_, index) => [-170 + index * 0.001, 10]),
              },
            },
          ],
        }),
      },
      { capabilityContext: { now: () => FIXED_NOW, signal: parseSignal, io: { stat, readFile } } },
    );
    assert.equal(cancelledDuringCoordinates.ok, false);
    assert.match(cancelledDuringCoordinates.error ?? '', /cancelled during coordinate (?:parsing|traversal)/i);
    assert.ok(parseSignalChecks >= 8);

    let ordinateSignalChecks = 0;
    const ordinateSignal = {
      get aborted(): boolean {
        ordinateSignalChecks += 1;
        return ordinateSignalChecks >= 6;
      },
    } as AbortSignal;
    const cancelledInsidePosition = await generate(
      {
        source_uri: await writeGeojson(dir, 'cancel-inside-position.geojson', {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: [0, 0, ...Array.from({ length: 100_000 }, () => 0)] },
            },
          ],
        }),
      },
      { capabilityContext: { now: () => FIXED_NOW, signal: ordinateSignal, io: { stat, readFile } } },
    );
    assert.equal(cancelledInsidePosition.ok, false);
    assert.match(cancelledInsidePosition.error ?? '', /cancelled during coordinate parsing/i);
    assert.ok(ordinateSignalChecks >= 6);

    let tick = 0;
    const duration = await generate(
      { source_uri: await writeGeojson(dir, 'duration.geojson', { type: 'FeatureCollection', features: [] }) },
      { capabilityContext: { now: () => new Date(FIXED_NOW.getTime() + tick++ * (MAX_DURATION_MS + 1)), io: { stat, readFile } } },
    );
    assert.equal(duration.ok, false);
    assert.match(duration.error ?? '', /duration/);
  });
});

test('credential, URL, percent, malformed percent and invalid UTF-8 percent paths reject before boundary audit, recorder and I/O, while benign raw local names pass', async () => {
  await withTempDir(async (dir) => {
    const deniedInputs = [
      'access_token=CANARY.geojson',
      'Authorization: Bearer CANARY.geojson',
      'Basic CANARY.geojson',
      'access_token%3DCANARY.geojson',
      'access_token%253DCANARY.geojson',
      'access_token%2525253DCANARY.geojson',
      'access_token%ZZ%253DCANARY.geojson',
      'Bearer%ZZ%2520CANARY.geojson',
      'access_token%C0%AE%3DCANARY.geojson',
      'https://example.maps.arcgis.com/foo.geojson?token=CANARY',
    ];
    for (const source_uri of deniedInputs) {
      const result = await generate({ source_uri });
      assert.equal(result.ok, false, source_uri);
      assert.equal(result.counts.audit, 0, source_uri);
      assert.equal(result.counts.begin, 0, source_uri);
      assert.equal(result.counts.finish, 0, source_uri);
      assert.equal(result.counts.stat, 0, source_uri);
      assert.equal(result.counts.readFile, 0, source_uri);
      assert.ok(!String(result.error).includes('CANARY'));
      assert.ok(!String(result.error).includes(source_uri));
    }

    for (const name of ['token-inventory.geojson', 'bearer-map.geojson', 'raw spaces.geojson', 'unicode-é.geojson', 'postal_code=95814.geojson', 'monkey=value.geojson']) {
      const path = await writeGeojson(dir, name, { type: 'FeatureCollection', features: [] });
      const result = await generate({ source_uri: path });
      assert.equal(result.ok, true, `${name}: ${result.error}`);
      assert.equal(result.counts.begin, 1);
      assert.equal(result.counts.stat, 1);
      assert.equal(result.counts.readFile, 1);
    }
  });
});
