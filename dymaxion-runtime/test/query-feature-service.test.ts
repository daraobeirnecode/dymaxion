import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  ArcGisRequestFailure,
  canonicalFormBody,
  containsCredentialMaterial,
  fetchArcGisTransport,
  redactSecrets,
  requestArcGisJson,
  type ArcGisRestTransport,
  type ArcGisTransportPostRequest,
  type ArcGisTransportRequest,
} from '../src/capabilities/arcgis-rest.js';
import { queryFeatureServiceCapability } from '../src/capabilities/query-feature-service.js';
import { allCapabilities } from '../src/capabilities/registry.js';
import { EvidenceBundleSchema } from '../src/contracts/evidence.js';
import { sha256Canonical, sha256Text } from '../src/contracts/canonical.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const LAYER_URL = 'https://services.arcgis.com/synthorg/arcgis/rest/services/Hydrants/FeatureServer/0';
const QUERY_URL = `${LAYER_URL}/query`;
const META_KEY = `GET ${LAYER_URL}?f=json`;
const NOW = new Date('2026-07-19T12:00:00.000Z');
const RUN_ID = '00000000-0000-0000-0000-000000000001';

type Route = { status?: number; contentType?: string; body: unknown };

function postKey(url: string, form: Record<string, string>): string {
  return `POST ${url} ${canonicalFormBody(form)}`;
}

/** Exact method+URL+canonical-form fixture transport; fails closed on any
 * unexpected request. */
function fixtureTransport(routes: Record<string, Route>): ArcGisRestTransport & {
  calls: string[];
} {
  const calls: string[] = [];
  const respond = (key: string) => {
    const route = routes[key];
    if (!route) throw new Error(`unexpected request in test: ${key}`);
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return {
      status: route.status ?? 200,
      contentType: route.contentType ?? 'application/json; charset=utf-8',
      bodyText: body,
    };
  };
  return {
    calls,
    async get(request: ArcGisTransportRequest) {
      const key = `GET ${request.url.href}`;
      calls.push(key);
      return respond(key);
    },
    async postForm(request: ArcGisTransportPostRequest) {
      const key = `POST ${request.url.href} ${request.body}`;
      calls.push(key);
      return respond(key);
    },
  };
}

function testDependencies(
  transport: ArcGisRestTransport,
  overrides: Partial<RunSkillDependencies> = {},
): RunSkillDependencies {
  return {
    recorder: {
      begin: async () => 'invocation-test',
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: {
      audit: async () => undefined,
      resolveHost: async () => ['93.184.216.34'],
    },
    capabilityContext: {
      now: () => NOW,
      io: { arcgisTransport: transport },
    },
    ...overrides,
  };
}

function layerMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 0,
    name: 'Hydrants',
    type: 'Feature Layer',
    geometryType: 'esriGeometryPoint',
    objectIdField: 'OBJECTID',
    capabilities: 'Query,Extract',
    maxRecordCount: 2,
    extent: { spatialReference: { wkid: 4326 } },
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false },
      { name: 'STATUS', type: 'esriFieldTypeString', nullable: true },
      { name: 'FLOW_GPM', type: 'esriFieldTypeDouble', nullable: true },
    ],
    ...extra,
  };
}

const IDS_FORM = { f: 'json', where: '1=1', returnIdsOnly: 'true', returnGeometry: 'false' };

function featureForm(ids: number[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    f: 'json',
    objectIds: ids.join(','),
    outFields: 'OBJECTID,STATUS',
    returnGeometry: 'false',
    ...extra,
  };
}

function feature(oid: number, status: string): Record<string, unknown> {
  return { attributes: { OBJECTID: oid, STATUS: status } };
}

function smallLayerRoutes(): Record<string, Route> {
  return {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: {
      body: { objectIdFieldName: 'OBJECTID', objectIds: [3, 1, 2] },
    },
    [postKey(QUERY_URL, featureForm([1, 2]))]: {
      body: { features: [feature(2, 'open'), feature(1, 'ok')] },
    },
    [postKey(QUERY_URL, featureForm([3]))]: {
      body: { features: [feature(3, 'shut')] },
    },
  };
}

const baseInput = { layer_url: LAYER_URL, out_fields: ['STATUS'] };

test('query_feature_service is a strict read-only versioned capability with no credential inputs', () => {
  const capability = queryFeatureServiceCapability;
  assert.equal(capability.manifest.slug, 'query_feature_service');
  assert.equal(capability.manifest.classification, 'read');
  assert.equal(capability.manifest.version, '1.0.0');
  assert.equal(capability.manifest.resource_limits.max_records, 10_000);
  assert.equal(capability.manifest.resource_limits.max_bytes, 16_777_216);
  assert.ok(allCapabilities().some((c) => c.manifest.slug === 'query_feature_service'));
  assert.equal(allCapabilities().length, 4);

  const schema = capability.inputSchema;
  assert.doesNotThrow(() => schema.parse(baseInput));
  assert.throws(() => schema.parse({ ...baseInput, unknown_field: 1 }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, token: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, api_key: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, password: 'abc' }), /unrecognized/i);

  // URL strictness.
  assert.throws(() => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('https', 'http') }), /https/);
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: 'https://user:pw@services.arcgis.com/a/FeatureServer/0' }),
    /credential/,
  );
  assert.throws(() => schema.parse({ ...baseInput, layer_url: `${LAYER_URL}?token=x` }), /query string/);
  assert.throws(() => schema.parse({ ...baseInput, layer_url: `${LAYER_URL}#frag` }), /query string|fragment/);
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: 'https://services.arcgis.com/a/../b/FeatureServer/0' }),
    /traversal/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: 'https://services.arcgis.com/a%2Fb/FeatureServer/0' }),
    /traversal|encoded/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: 'https://services.arcgis.com/a\\b/FeatureServer/0' }),
    /backslash/,
  );
  assert.throws(() => schema.parse({ ...baseInput, layer_url: `${LAYER_URL}/` }), /FeatureServer/);
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('/0', '') }),
    /FeatureServer/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('FeatureServer', 'MapServer') }),
    /FeatureServer/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('FeatureServer', 'ImageServer') }),
    /FeatureServer/,
  );
  assert.throws(() => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('/0', '/01') }), /FeatureServer/);
  assert.throws(() => schema.parse({ ...baseInput, layer_url: LAYER_URL.replace('/0', '/x') }), /FeatureServer/);

  // Field strictness.
  assert.throws(() => schema.parse({ ...baseInput, out_fields: [] }), /at least 1/i);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['*'] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['BAD-NAME'] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['a.b'] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['STATUS', 'status'] }), /unique/);
  assert.throws(
    () => schema.parse({ ...baseInput, out_fields: Array.from({ length: 101 }, (_, i) => `f_${i}`) }),
    /at most 100|too_big|less than or equal/i,
  );
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['ACCESS_KEY'] }), /credential-like/);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['TOKEN'] }), /credential-like/);
  assert.throws(() => schema.parse({ ...baseInput, out_fields: ['accessToken'] }), /credential-like/);

  // where strictness.
  assert.throws(() => schema.parse({ ...baseInput, where: '   ' }), /non-whitespace predicate/);
  assert.throws(
    () => schema.parse({ ...baseInput, where: `a${String.fromCharCode(0)}b` }),
    /control/,
  );
  assert.throws(() => schema.parse({ ...baseInput, where: 'a\nb' }), /control/);
  assert.throws(() => schema.parse({ ...baseInput, where: "token='x'" }), /credential material/);
  for (const where of [
    "STATUS = 'token=CANARY'",
    "STATUS = 'client_secret=CANARY'",
  ]) {
    assert.throws(() => schema.parse({ ...baseInput, where }), /credential material/);
  }
  assert.doesNotThrow(() => schema.parse({ ...baseInput, where: "STATUS = 'postal_code=95814'" }));
  assert.throws(() => schema.parse({ ...baseInput, where: 'x'.repeat(2_049) }), /at most 2048|too_big/i);
  assert.doesNotThrow(() => schema.parse({ ...baseInput, where: "STATUS = 'open' AND FLOW_GPM > 500" }));

  // out_sr only with geometry.
  assert.throws(() => schema.parse({ ...baseInput, out_sr: 3857 }), /return_geometry/);
  assert.doesNotThrow(() => schema.parse({ ...baseInput, return_geometry: true, out_sr: 3857 }));
  assert.throws(() => schema.parse({ ...baseInput, return_geometry: true, out_sr: 0 }), /greater than 0|positive/i);

  // Deferred query modes are rejected by the strict schema — no partial support.
  for (const deferred of [
    { outStatistics: [] },
    { groupByFieldsForStatistics: 'STATUS' },
    { orderByFields: 'STATUS' },
    { geometry: '{}' },
    { geometryType: 'esriGeometryEnvelope' },
    { spatialRel: 'esriSpatialRelIntersects' },
    { distance: 10 },
    { datumTransformation: 1234 },
    { returnAttachments: true },
    { relationshipId: 0 },
    { returnRelatedRecords: true },
    { time: '0,1' },
    { gdbVersion: 'SDE.DEFAULT' },
  ]) {
    assert.throws(() => schema.parse({ ...baseInput, ...deferred }), /unrecognized/i, JSON.stringify(deferred));
  }

  // Ceilings.
  assert.throws(() => schema.parse({ ...baseInput, page_size: 0 }), /greater than 0|positive/i);
  assert.throws(() => schema.parse({ ...baseInput, page_size: 2_001 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_records: 10_001 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_requests: 201 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_response_bytes: 512 }), /greater than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_response_bytes: 2_097_153 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_total_response_bytes: 16_777_217 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_duration_ms: 999 }), /greater than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_duration_ms: 30_001 }), /less than or equal/i);
});

test('queries a small layer deterministically through the dispatcher', async () => {
  const transport = fixtureTransport(smallLayerRoutes());
  const result = await runSkill('query_feature_service', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  const output = result.output as Record<string, any>;
  assert.doesNotThrow(() => queryFeatureServiceCapability.outputSchema.parse(output));
  assert.throws(() => queryFeatureServiceCapability.outputSchema.parse({ ...output, extra: 1 }), /unrecognized/i);

  const report = output.report;
  assert.equal(report.retrieved_at, '2026-07-19T12:00:00.000Z');
  assert.equal(report.service.url, LAYER_URL);
  assert.equal(report.service.layer_id, 0);
  assert.equal(report.service.name, 'Hydrants');
  assert.equal(report.service.type, 'Feature Layer');
  assert.equal(report.service.geometry_type, 'esriGeometryPoint');
  assert.equal(report.service.object_id_field, 'OBJECTID');
  assert.equal(report.service.source_spatial_reference, 4326);
  assert.equal(report.service.output_spatial_reference, null); // no geometry requested
  assert.equal(report.service.max_record_count, 2);
  assert.deepEqual(report.service.requested_fields, ['STATUS']);
  assert.deepEqual(report.service.effective_fields, ['OBJECTID', 'STATUS']);
  assert.equal(report.parameters.where, '1=1');
  assert.equal(report.parameters.return_geometry, false);
  assert.equal(report.parameters.page_size, 2); // bounded by maxRecordCount

  // Canonical: server returned IDs [3,1,2] and page order [2,1] — output is
  // ascending object-ID order with canonical attribute keys.
  assert.deepEqual(
    report.features.map((f: any) => f.object_id),
    [1, 2, 3],
  );
  assert.deepEqual(report.features[0], {
    object_id: 1,
    attributes: { OBJECTID: 1, STATUS: 'ok' },
    geometry: null,
  });
  assert.deepEqual(report.totals, {
    matched_object_ids: 3,
    selected_object_ids: 3,
    returned_records: 3,
    request_count: 4,
    response_bytes: report.totals.response_bytes,
  });
  assert.ok(report.totals.response_bytes > 0);
  assert.equal(report.truncation.truncated, false);
  assert.ok(report.caveats.some((c: string) => c.includes('anonymous/public')));

  // Versioned evidence: POST method + canonical request-body hashes; no
  // query string on any /query evidence URL.
  const evidence = output.evidence;
  assert.doesNotThrow(() => EvidenceBundleSchema.parse(evidence));
  assert.equal(evidence.schema_version, '1.2.0');
  assert.equal(evidence.execution.mode, 'deterministic');
  assert.equal(evidence.source.identity.kind, 'arcgis_feature_layer');
  assert.equal(evidence.source.identity.value, LAYER_URL);
  assert.deepEqual(
    evidence.requests.map((request: { name: string }) => request.name),
    ['layer_metadata', 'query_ids', 'query_features:1', 'query_features:2'],
  );
  const [metaRequest, idsRequest, page1, page2] = evidence.requests;
  assert.equal(metaRequest.url, `${LAYER_URL}?f=json`);
  assert.equal(metaRequest.method, undefined); // GET evidence stays backward-compatible
  assert.equal(metaRequest.request_sha256, undefined);
  for (const [request, form] of [
    [idsRequest, IDS_FORM],
    [page1, featureForm([1, 2])],
    [page2, featureForm([3])],
  ] as const) {
    assert.equal(request.url, QUERY_URL);
    assert.ok(!request.url.includes('?'));
    assert.equal(request.method, 'POST');
    assert.equal(request.request_sha256, sha256Text(canonicalFormBody(form)));
  }
  assert.equal(evidence.outputs[0].name, 'arcgis_feature_query');
  assert.equal(evidence.outputs[0].sha256, sha256Canonical(report));
  assert.equal(evidence.gis_metadata.row_count, 3);
  assert.deepEqual(evidence.gis_metadata.geometry_types, []);
});

test('requested fields resolve case-insensitively to canonical metadata names with automatic object-ID inclusion', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [7] } },
    [postKey(QUERY_URL, {
      f: 'json',
      objectIds: '7',
      outFields: 'OBJECTID,FLOW_GPM,STATUS',
      returnGeometry: 'false',
    })]: { body: { features: [{ attributes: { OBJECTID: 7, STATUS: 'ok', FLOW_GPM: 2.5 } }] } },
  };
  const transport = fixtureTransport(routes);
  const result = await runSkill(
    'query_feature_service',
    { layer_url: LAYER_URL, out_fields: ['status', 'flow_gpm'] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.deepEqual(report.service.requested_fields, ['FLOW_GPM', 'STATUS']);
  assert.deepEqual(report.service.effective_fields, ['OBJECTID', 'FLOW_GPM', 'STATUS']);
  assert.deepEqual(report.features[0].attributes, { OBJECTID: 7, FLOW_GPM: 2.5, STATUS: 'ok' });
  // Requesting the object-ID field explicitly does not duplicate it.
  const transport2 = fixtureTransport({
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [7] } },
    [postKey(QUERY_URL, {
      f: 'json',
      objectIds: '7',
      outFields: 'OBJECTID,STATUS',
      returnGeometry: 'false',
    })]: { body: { features: [{ attributes: { OBJECTID: 7, STATUS: 'ok' } }] } },
  });
  const result2 = await runSkill(
    'query_feature_service',
    { layer_url: LAYER_URL, out_fields: ['objectid', 'STATUS'] },
    RUN_ID,
    testDependencies(transport2),
  );
  assert.equal(result2.ok, true, result2.error);
  assert.deepEqual((result2.output as any).report.service.effective_fields, ['OBJECTID', 'STATUS']);
});

test('unknown requested fields fail closed after metadata validation', async () => {
  const transport = fixtureTransport({ [META_KEY]: { body: layerMetadata() } });
  const result = await runSkill(
    'query_feature_service',
    { layer_url: LAYER_URL, out_fields: ['NOPE'] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /requested field 'NOPE' does not exist/);
  assert.equal(transport.calls.length, 1); // metadata only, no query dispatch
});

test('a custom where predicate reaches only the object-ID discovery form and never a URL', async () => {
  const where = "STATUS = 'ZQXWMARKER'";
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, { ...IDS_FORM, where })]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: { body: { features: [feature(1, 'ok')] } },
  };
  const transport = fixtureTransport(routes);
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, where },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const output = result.output as any;
  // The predicate is deliberately part of canonical parameter evidence…
  assert.ok(String(output.evidence.parameters.canonical_json).includes('ZQXWMARKER'));
  assert.equal(output.report.parameters.where, where);
  // …but never appears in any evidence URL.
  for (const request of output.evidence.requests) {
    assert.ok(!String(request.url).includes('ZQXWMARKER'));
    assert.ok(!String(request.url).includes('?') || String(request.url).endsWith('f=json'));
  }
});

test('optional geometry and outSR flow into the form, the report, and sanitized geometry output', async () => {
  const canary = 'token=SYNTHETICFAKEVALUE555';
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1, 2] } },
    [postKey(QUERY_URL, {
      f: 'json',
      objectIds: '1,2',
      outFields: 'OBJECTID,STATUS',
      returnGeometry: 'true',
      outSR: '3857',
    })]: {
      body: {
        spatialReference: { wkid: 3857 },
        features: [
          {
            attributes: { OBJECTID: 1, STATUS: 'ok' },
            geometry: { x: 1.5, y: 2.5, note: canary, token: 'SYNTHETICFAKEVALUE666' },
          },
          { attributes: { OBJECTID: 2, STATUS: 'dry' } },
        ],
      },
    },
  };
  const transport = fixtureTransport(routes);
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, return_geometry: true, out_sr: 3857 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const output = result.output as any;
  const report = output.report;
  assert.equal(report.service.output_spatial_reference, 3857);
  assert.equal(report.parameters.out_sr, 3857);
  assert.deepEqual(report.features[0].geometry, {
    x: 1.5,
    y: 2.5,
    note: 'token=<redacted>',
  });
  assert.equal(report.features[1].geometry, null);
  assert.ok(report.warnings.some((w: string) => w.includes('credential-like key was removed')));
  assert.ok(report.warnings.some((w: string) => w.includes('returned no geometry')));
  assert.equal(output.evidence.gis_metadata.crs, 'WKID:3857');
  assert.deepEqual(output.evidence.gis_metadata.geometry_types, ['esriGeometryPoint']);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes('SYNTHETICFAKEVALUE555'));
  assert.ok(!serialized.includes('SYNTHETICFAKEVALUE666'));
});

test('geometry without out_sr reports the source spatial reference; tables reject geometry', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, {
      f: 'json',
      objectIds: '1',
      outFields: 'OBJECTID,STATUS',
      returnGeometry: 'true',
    })]: {
      body: {
        spatialReference: { wkid: 4326 },
        features: [{ attributes: { OBJECTID: 1, STATUS: 'ok' }, geometry: { x: 1, y: 2 } }],
      },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, return_geometry: true },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  assert.equal((result.output as any).report.service.output_spatial_reference, 4326);

  const table = layerMetadata({ type: 'Table' });
  delete (table as Record<string, unknown>).geometryType;
  const tableResult = await runSkill(
    'query_feature_service',
    { ...baseInput, return_geometry: true },
    RUN_ID,
    testDependencies(fixtureTransport({ [META_KEY]: { body: table } })),
  );
  assert.equal(tableResult.ok, false);
  assert.match(tableResult.error ?? '', /no geometry type/);
});

test('latestWkid takes precedence over a legacy wkid in spatial-reference reporting', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: {
      body: layerMetadata({
        extent: { spatialReference: { wkid: 102100, latestWkid: 3857 } },
      }),
    },
    [postKey(QUERY_URL, IDS_FORM)]: {
      body: { objectIdFieldName: 'OBJECTID', objectIds: [1] },
    },
    [postKey(QUERY_URL, featureForm([1], { returnGeometry: 'true' }))]: {
      body: {
        spatialReference: { wkid: 102100, latestWkid: 3857 },
        features: [{ ...feature(1, 'open'), geometry: { x: 1, y: 2 } }],
      },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, return_geometry: true },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const output = result.output as any;
  assert.equal(output.report.service.source_spatial_reference, 3857);
  assert.equal(output.report.service.output_spatial_reference, 3857);
  assert.equal(output.evidence.gis_metadata.crs, 'WKID:3857');
});

test('geometry responses fail closed when spatialReference is missing or differs from outSR', async () => {
  const cases: Array<{ spatialReference?: unknown; message: RegExp }> = [
    { message: /did not report a valid spatialReference WKID/ },
    { spatialReference: { wkid: 4326 }, message: /did not match expected output WKID 3857/ },
  ];
  for (const testCase of cases) {
    const body: Record<string, unknown> = {
      features: [{ ...feature(1, 'open'), geometry: { x: 1, y: 2 } }],
    };
    if (testCase.spatialReference !== undefined) {
      body.spatialReference = testCase.spatialReference;
    }
    const routes: Record<string, Route> = {
      [META_KEY]: { body: layerMetadata() },
      [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
      [postKey(QUERY_URL, featureForm([1], { returnGeometry: 'true', outSR: '3857' }))]: {
        body,
      },
    };
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput, return_geometry: true, out_sr: 3857 },
      RUN_ID,
      testDependencies(fixtureTransport(routes)),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', testCase.message);
  }
});

test('geometry responses fail closed when split pages report inconsistent spatial references', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata({ extent: null }) },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1, 2] } },
    [postKey(QUERY_URL, featureForm([1], { returnGeometry: 'true' }))]: {
      body: {
        spatialReference: { wkid: 4326 },
        features: [{ ...feature(1, 'open'), geometry: { x: 1, y: 2 } }],
      },
    },
    [postKey(QUERY_URL, featureForm([2], { returnGeometry: 'true' }))]: {
      body: {
        spatialReference: { wkid: 3857 },
        features: [{ ...feature(2, 'closed'), geometry: { x: 3, y: 4 } }],
      },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, return_geometry: true, page_size: 1 },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /inconsistent spatialReference WKIDs 4326 and 3857/);
});

test('report and output hash are canonical regardless of ID and feature response order', async () => {
  const run = async (variant: 'forward' | 'reversed') => {
    const routes: Record<string, Route> = {
      [META_KEY]: { body: layerMetadata() },
      [postKey(QUERY_URL, IDS_FORM)]: {
        body:
          variant === 'forward'
            ? { objectIdFieldName: 'OBJECTID', objectIds: [1, 2, 3] }
            : { objectIds: [3, 1, 2], objectIdFieldName: 'OBJECTID' },
      },
      [postKey(QUERY_URL, featureForm([1, 2]))]: {
        body:
          variant === 'forward'
            ? { features: [feature(1, 'ok'), feature(2, 'open')] }
            : { features: [feature(2, 'open'), feature(1, 'ok')] },
      },
      [postKey(QUERY_URL, featureForm([3]))]: { body: { features: [feature(3, 'shut')] } },
    };
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput },
      RUN_ID,
      testDependencies(fixtureTransport(routes)),
    );
    assert.equal(result.ok, true, result.error);
    return (result.output as any).report;
  };
  const forward = await run('forward');
  const reversed = await run('reversed');
  assert.deepEqual(forward, reversed);
  assert.equal(sha256Canonical(forward), sha256Canonical(reversed));
});

test('max_records selects the lowest canonical object IDs with truthful truncation', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [5, 1, 9, 3] } },
    [postKey(QUERY_URL, featureForm([1, 3]))]: {
      body: { features: [feature(1, 'ok'), feature(3, 'shut')] },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, max_records: 2 },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.deepEqual(
    report.features.map((f: any) => f.object_id),
    [1, 3],
  );
  assert.equal(report.totals.matched_object_ids, 4);
  assert.equal(report.totals.selected_object_ids, 2);
  assert.equal(report.truncation.truncated, true);
  assert.ok(report.truncation.reasons[0].includes('4 object IDs matched'));
  assert.ok(report.caveats.some((c: string) => c.includes('max_records ceiling')));
});

test('exceededTransferLimit splits batches into deterministic halves in ascending order', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata({ maxRecordCount: 4 }) },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [4, 2, 1, 3] } },
    [postKey(QUERY_URL, featureForm([1, 2, 3, 4]))]: { body: { exceededTransferLimit: true, features: [] } },
    [postKey(QUERY_URL, featureForm([1, 2]))]: {
      body: { features: [feature(1, 'a'), feature(2, 'b')] },
    },
    [postKey(QUERY_URL, featureForm([3, 4]))]: {
      body: { features: [feature(4, 'd'), feature(3, 'c')] },
    },
  };
  const transport = fixtureTransport(routes);
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const output = result.output as any;
  assert.deepEqual(
    output.report.features.map((f: any) => f.object_id),
    [1, 2, 3, 4],
  );
  assert.equal(output.report.totals.request_count, 5); // meta + ids + failed page + 2 halves
  assert.deepEqual(
    output.evidence.requests.map((r: any) => r.name),
    ['layer_metadata', 'query_ids', 'query_features:1', 'query_features:2', 'query_features:3'],
  );
  assert.ok(output.report.warnings.some((w: string) => w.includes('split into deterministic halves')));
  // The failed attempt is byte-accounted.
  assert.equal(
    output.report.totals.response_bytes,
    output.evidence.requests.reduce((sum: number, r: any) => sum + r.bytes, 0),
  );
});

test('a singleton batch that still exceeds the transfer limit fails closed', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: { body: { exceededTransferLimit: true, features: [] } },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /single object ID/);
});

test('object-ID discovery failures and identity mismatches fail closed', async () => {
  const cases: Array<{ body: unknown; message: RegExp }> = [
    { body: { objectIds: [1, 1] }, message: /duplicate object IDs/ },
    { body: { objectIds: [1.5] }, message: /non-safe-integer/ },
    { body: { objectIds: ['1'] }, message: /non-safe-integer/ },
    { body: { objectIds: [Number.MAX_SAFE_INTEGER + 2] }, message: /non-safe-integer/ },
    { body: { objectIds: [1], exceededTransferLimit: true }, message: /incomplete|exceededTransferLimit/ },
    { body: { objectIds: [1], exceededTransferLimit: 'true' }, message: /non-boolean exceededTransferLimit/ },
    { body: {}, message: /missing the objectIds array/ },
    { body: { objectIds: [1], objectIdFieldName: 'OTHER_ID' }, message: /different object-ID field/ },
  ];
  for (const testCase of cases) {
    const routes: Record<string, Route> = {
      [META_KEY]: { body: layerMetadata() },
      [postKey(QUERY_URL, IDS_FORM)]: { body: testCase.body },
    };
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput },
      RUN_ID,
      testDependencies(fixtureTransport(routes)),
    );
    assert.equal(result.ok, false, JSON.stringify(testCase.body));
    assert.match(result.error ?? '', testCase.message);
  }
});

test('an empty match set succeeds with zero features and no feature dispatches', async () => {
  for (const idsBody of [{ objectIds: null }, { objectIds: [] }]) {
    const routes: Record<string, Route> = {
      [META_KEY]: { body: layerMetadata() },
      [postKey(QUERY_URL, IDS_FORM)]: { body: idsBody },
    };
    const transport = fixtureTransport(routes);
    const result = await runSkill('query_feature_service', { ...baseInput }, RUN_ID, testDependencies(transport));
    assert.equal(result.ok, true, result.error);
    const report = (result.output as any).report;
    assert.deepEqual(report.features, []);
    assert.equal(report.totals.matched_object_ids, 0);
    assert.equal(report.totals.request_count, 2);
    assert.equal(transport.calls.length, 2);
  }
});

test('feature pages with duplicate, unrequested, or missing object IDs fail closed', async () => {
  const cases: Array<{ features: unknown; message: RegExp }> = [
    { features: [feature(1, 'a'), feature(1, 'b')], message: /duplicate object IDs within a batch/ },
    { features: [feature(1, 'a'), feature(9, 'x')], message: /not requested in the batch/ },
    { features: [feature(1, 'a')], message: /omitted requested object IDs/ },
    { features: [{ attributes: { OBJECTID: 1, objectid: 1, STATUS: 'a' } }], message: /2 object-ID attributes/ },
    { features: [{ attributes: { OBJECTID: 1.5, STATUS: 'a' } }], message: /non-safe-integer object ID/ },
    { features: [{ noAttributes: true }], message: /without an attributes object/ },
    { features: 'nope', message: /missing the features array/ },
  ];
  for (const testCase of cases) {
    const routes: Record<string, Route> = {
      [META_KEY]: { body: layerMetadata() },
      [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1, 2] } },
      [postKey(QUERY_URL, featureForm([1, 2]))]: {
        body: testCase.features === 'nope' ? { count: 2 } : { features: testCase.features },
      },
    };
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput },
      RUN_ID,
      testDependencies(fixtureTransport(routes)),
    );
    assert.equal(result.ok, false, JSON.stringify(testCase.features));
    assert.match(result.error ?? '', testCase.message);
  }
});

test('metadata validation failures fail closed with redacted errors', async () => {
  const canary = 'SYNTHETICFAKEVALUE777';
  const cases: Array<{ metadata: Record<string, unknown>; message: RegExp }> = [
    { metadata: layerMetadata({ type: 'Raster Layer' }), message: /Feature Layer or Table/ },
    { metadata: layerMetadata({ capabilities: 'Create,Update' }), message: /Query capability/ },
    { metadata: layerMetadata({ capabilities: 7 }), message: /capabilities string/ },
    { metadata: layerMetadata({ fields: [] }), message: /non-empty fields array/ },
    { metadata: layerMetadata({ fields: [{ name: 42 }] }), message: /malformed field entry/ },
    { metadata: layerMetadata({ fields: [{ name: 'bad name' }] }), message: /unsupported field name/ },
    {
      metadata: layerMetadata({
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'objectid', type: 'esriFieldTypeInteger' },
        ],
      }),
      message: /duplicate field names/,
    },
    { metadata: layerMetadata({ objectIdField: 'MISSING' }), message: /does not name a usable metadata field/ },
    {
      metadata: layerMetadata({ objectIdField: 'STATUS' }),
      message: /does not have type esriFieldTypeOID/,
    },
    {
      metadata: layerMetadata({
        objectIdField: undefined,
        fields: [
          { name: 'OID_A', type: 'esriFieldTypeOID' },
          { name: 'OID_B', type: 'esriFieldTypeOID' },
          { name: 'STATUS', type: 'esriFieldTypeString' },
        ],
      }),
      message: /exactly one unambiguous object-ID field; found 2/,
    },
    { metadata: layerMetadata({ id: 3 }), message: /identity mismatch/ },
  ];
  for (const testCase of cases) {
    const metadata = { ...testCase.metadata };
    if (metadata.objectIdField === undefined) delete metadata.objectIdField;
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput },
      RUN_ID,
      testDependencies(fixtureTransport({ [META_KEY]: { body: metadata } })),
    );
    assert.equal(result.ok, false, JSON.stringify(testCase.metadata.type ?? testCase.metadata));
    assert.match(result.error ?? '', testCase.message);
    assert.ok(!(result.error ?? '').includes(canary));
  }
});

test('credential-like metadata fields are excluded from the queryable set, never returned', async () => {
  const metadata = layerMetadata({
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false },
      { name: 'STATUS', type: 'esriFieldTypeString', nullable: true },
      { name: 'API_KEY', type: 'esriFieldTypeString', nullable: true },
    ],
  });
  const routes: Record<string, Route> = {
    [META_KEY]: { body: metadata },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: { body: { features: [feature(1, 'ok')] } },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.ok(report.warnings.some((w: string) => w.includes('credential-like name was excluded')));
  assert.ok(!JSON.stringify(result.output).includes('API_KEY'));
});

test('a missing maxRecordCount falls back to the documented bound with a warning', async () => {
  const metadata = layerMetadata({ maxRecordCount: undefined });
  delete (metadata as Record<string, unknown>).maxRecordCount;
  const routes: Record<string, Route> = {
    [META_KEY]: { body: metadata },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: { body: { features: [feature(1, 'ok')] } },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.equal(report.service.max_record_count, 1_000);
  assert.equal(report.parameters.page_size, 1_000);
  assert.ok(report.warnings.some((w: string) => w.includes('documented fallback of 1000')));
});

test('unexpected attributes are discarded, missing requested attributes become null, non-primitives fail', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1, 2] } },
    [postKey(QUERY_URL, featureForm([1, 2]))]: {
      body: {
        features: [
          { attributes: { OBJECTID: 1, STATUS: 'ok', SURPRISE: 'token=SYNTHETICFAKEVALUE888' } },
          { attributes: { OBJECTID: 2 } },
        ],
      },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.deepEqual(report.features[0].attributes, { OBJECTID: 1, STATUS: 'ok' });
  assert.deepEqual(report.features[1].attributes, { OBJECTID: 2, STATUS: null });
  assert.ok(report.warnings.some((w: string) => w.includes('outside the effective field list')));
  assert.ok(report.warnings.some((w: string) => w.includes("missing requested field 'STATUS'")));
  assert.ok(!JSON.stringify(result.output).includes('SYNTHETICFAKEVALUE888'));

  const objectRoutes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: {
      body: { features: [{ attributes: { OBJECTID: 1, STATUS: { nested: true } } }] },
    },
  };
  const objectResult = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(objectRoutes)),
  );
  assert.equal(objectResult.ok, false);
  assert.match(objectResult.error ?? '', /not a supported primitive/);
});

test('attribute string values are redacted before serialization', async () => {
  const routes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata({ name: 'Hydrants token=SYNTHETICFAKEVALUE211' }) },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
    [postKey(QUERY_URL, featureForm([1]))]: {
      body: {
        features: [
          { attributes: { OBJECTID: 1, STATUS: 'Bearer SYNTHETICFAKEVALUE212' } },
        ],
      },
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(fixtureTransport(routes)),
  );
  assert.equal(result.ok, true, result.error);
  const serialized = JSON.stringify(result.output);
  assert.ok(!serialized.includes('SYNTHETICFAKEVALUE211'));
  assert.ok(!serialized.includes('SYNTHETICFAKEVALUE212'));
  const report = (result.output as any).report;
  assert.equal(report.service.name, 'Hydrants token=<redacted>');
  assert.equal(report.features[0].attributes.STATUS, 'Bearer <redacted>');
});

test('compound signature, authorization, and targeted code credentials are detected and redacted', () => {
  for (const value of [
    'x-signature=CANARY',
    'oauth_code=CANARY',
    'authCode=CANARY',
    'client_code=CANARY',
    'proxy_authorization=CANARY',
  ]) {
    assert.equal(containsCredentialMaterial(value), true, value);
    assert.ok(!redactSecrets(value).includes('CANARY'), value);
  }
  assert.equal(containsCredentialMaterial('postal_code=95814'), false);
  assert.equal(redactSecrets('postal_code=95814'), 'postal_code=95814');
});

test('request, per-response byte, and total byte ceilings fail the run closed', async () => {
  // Request ceiling: meta + ids consume the budget before any feature page.
  const requestRoutes = smallLayerRoutes();
  const requestResult = await runSkill(
    'query_feature_service',
    { ...baseInput, max_requests: 2 },
    RUN_ID,
    testDependencies(fixtureTransport(requestRoutes)),
  );
  assert.equal(requestResult.ok, false);
  assert.match(requestResult.error ?? '', /2-request ceiling/);

  // Per-response ceiling.
  const bigBody = { objectIds: Array.from({ length: 2_000 }, (_, i) => i + 1) };
  const byteRoutes: Record<string, Route> = {
    [META_KEY]: { body: layerMetadata() },
    [postKey(QUERY_URL, IDS_FORM)]: { body: bigBody },
  };
  const byteResult = await runSkill(
    'query_feature_service',
    { ...baseInput, max_response_bytes: 1_024 },
    RUN_ID,
    testDependencies(fixtureTransport(byteRoutes)),
  );
  assert.equal(byteResult.ok, false);
  assert.match(byteResult.error ?? '', /byte limit/);

  // Total ceiling: a metadata response of exactly 1024 bytes exhausts the
  // whole-run budget, so the next dispatch must fail on the TOTAL ceiling.
  const template = JSON.stringify(layerMetadata({ description: '' }));
  const padded = layerMetadata({ description: 'x'.repeat(1_024 - Buffer.byteLength(template, 'utf8')) });
  assert.equal(Buffer.byteLength(JSON.stringify(padded), 'utf8'), 1_024);
  const totalRoutes: Record<string, Route> = {
    [META_KEY]: { body: padded },
    [postKey(QUERY_URL, IDS_FORM)]: { body: { objectIds: [1] } },
  };
  const totalResult = await runSkill(
    'query_feature_service',
    { ...baseInput, max_total_response_bytes: 1_024 },
    RUN_ID,
    testDependencies(fixtureTransport(totalRoutes)),
  );
  assert.equal(totalResult.ok, false);
  assert.match(totalResult.error ?? '', /total response ceiling/);
});

test('the duration ceiling is enforced between dispatches', async () => {
  const routes = smallLayerRoutes();
  const inner = fixtureTransport(routes);
  const slowTransport: ArcGisRestTransport = {
    get: (request) => inner.get(request),
    postForm: async (request) => {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 550));
      return inner.postForm!(request);
    },
  };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput, max_duration_ms: 1_000 },
    RUN_ID,
    testDependencies(slowTransport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /duration ceiling/);
});

test('HTTP failures, redirects, error envelopes, and malformed responses fail closed with redaction', async () => {
  const cases: Array<{ route: Route; message: RegExp }> = [
    { route: { status: 302, body: '' }, message: /redirect/ },
    { route: { status: 404, body: {} }, message: /HTTP 404/ },
    { route: { status: 500, body: {} }, message: /HTTP 500/ },
    { route: { contentType: 'text/html', body: '<html></html>' }, message: /content type/ },
    { route: { body: '{invalid' }, message: /invalid JSON/ },
    { route: { body: '[1,2]' }, message: /non-object JSON/ },
    {
      route: {
        body: { error: { code: 499, message: 'denied token=SYNTHETICFAKEVALUE999' } },
      },
      message: /error envelope \(code 499\)/,
    },
  ];
  for (const testCase of cases) {
    const result = await runSkill(
      'query_feature_service',
      { ...baseInput },
      RUN_ID,
      testDependencies(fixtureTransport({ [META_KEY]: testCase.route })),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', testCase.message);
    assert.ok(!(result.error ?? '').includes('SYNTHETICFAKEVALUE999'));
  }
});

test('boundary rejection happens before transport dispatch and invocation recording', async () => {
  const transport = fixtureTransport({});
  let began = false;
  const result = await runSkill(
    'query_feature_service',
    {
      ...baseInput,
      layer_url: 'https://city-of-sacramento.maps.arcgis.com/arcgis/rest/services/X/FeatureServer/0',
    },
    RUN_ID,
    testDependencies(transport, {
      recorder: {
        begin: async () => {
          began = true;
          return 'invocation-test';
        },
        finish: async () => undefined,
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /boundary violation/i);
  assert.equal(began, false);
  assert.deepEqual(transport.calls, []);
});

test('non-allowlisted hosts and private DNS answers are blocked per dispatch', async () => {
  const transport = fixtureTransport(smallLayerRoutes());
  const privateDns = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      boundaryOptions: { audit: async () => undefined, resolveHost: async () => ['192.168.1.10'] },
    }),
  );
  assert.equal(privateDns.ok, false);
  assert.match(privateDns.error ?? '', /private_or_reserved_address/);
  assert.deepEqual(transport.calls, []);

  const lookalike = await runSkill(
    'query_feature_service',
    { ...baseInput, layer_url: 'https://services.arcgis.com.evil.example/a/FeatureServer/0' },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(lookalike.ok, false);
  assert.match(lookalike.error ?? '', /boundary violation/i);
  assert.deepEqual(transport.calls, []);
});

test('every outbound request re-checks the boundary immediately before dispatch', async () => {
  const boundaryChecks: string[] = [];
  const transport = fixtureTransport(smallLayerRoutes());
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      boundaryOptions: {
        resolveHost: async () => ['93.184.216.34'],
        audit: async (eventType, payload) => {
          if (eventType === 'data_query') boundaryChecks.push(String(payload.url));
        },
      },
    }),
  );
  assert.equal(result.ok, true, result.error);
  // 1 executor preflight (layer_url) + 4 per-dispatch checks.
  assert.equal(boundaryChecks.length, 5);
  assert.equal(boundaryChecks.filter((url) => url === `${LAYER_URL}/query`).length, 3);
});

test('cancellation is honored before any request is dispatched', async () => {
  const transport = fixtureTransport(smallLayerRoutes());
  const controller = new AbortController();
  controller.abort();
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      boundaryOptions: { audit: async () => undefined, resolveHost: async () => ['93.184.216.34'] },
      capabilityContext: {
        now: () => NOW,
        io: { arcgisTransport: transport },
        signal: controller.signal,
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /cancelled before retrieval/);
  assert.deepEqual(transport.calls, []);
});

test('cancellation during the asynchronous boundary preflight prevents the dispatch', async () => {
  const transport = fixtureTransport(smallLayerRoutes());
  const controller = new AbortController();
  let boundaryCalls = 0;
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      boundaryOptions: {
        audit: async () => undefined,
        resolveHost: async () => {
          boundaryCalls += 1;
          // Abort while the capability awaits DNS inside its own per-request
          // boundary check (the second resolution; the first is the executor
          // preflight).
          if (boundaryCalls === 2) controller.abort();
          return ['93.184.216.34'];
        },
      },
      capabilityContext: {
        now: () => NOW,
        io: { arcgisTransport: transport },
        signal: controller.signal,
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /cancelled before request 'layer_metadata'/);
  assert.deepEqual(transport.calls, []);
});

test('a transport without POST support fails closed before any query dispatch', async () => {
  const inner = fixtureTransport(smallLayerRoutes());
  const getOnly: ArcGisRestTransport = { get: (request) => inner.get(request) };
  const result = await runSkill(
    'query_feature_service',
    { ...baseInput },
    RUN_ID,
    testDependencies(getOnly),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /does not support POST/);
  assert.equal(inner.calls.length, 1); // metadata GET only
});

test('canonical form bodies are order-independent and never appear in errors or evidence', async () => {
  assert.equal(
    canonicalFormBody({ b: '2', a: '1' }),
    canonicalFormBody({ a: '1', b: '2' }),
  );
  assert.equal(canonicalFormBody({ a: 'x y', b: '1,2' }), 'a=x+y&b=1%2C2');
  assert.equal(sha256Text(canonicalFormBody({ a: '1' })), sha256Text('a=1'));

  // A POST URL carrying a query string is refused before dispatch.
  const transport = fixtureTransport(smallLayerRoutes());
  const { requestArcGisJson } = await import('../src/capabilities/arcgis-rest.js');
  await assert.rejects(
    requestArcGisJson({
      name: 'bad_post',
      url: new URL(`${QUERY_URL}?f=json`),
      transport,
      boundary: { audit: async () => undefined, resolveHost: async () => ['93.184.216.34'] },
      timeoutMs: 1_000,
      maxBytes: 1_024,
      form: { f: 'json' },
    }),
    /must not carry a query string/,
  );
  assert.deepEqual(transport.calls, []);
});

test('production streamed byte overflow is a typed evidenced byte_limit failure', async () => {
  const originalFetch = globalThis.fetch;
  const oversizedBody = 'x'.repeat(8 * 1_024 * 1_024);
  globalThis.fetch = async () =>
    new Response(oversizedBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    let caught: unknown;
    try {
      await requestArcGisJson({
        name: 'streamed_overflow',
        url: new URL(`${LAYER_URL}?f=json`),
        transport: fetchArcGisTransport,
        boundary: {
          audit: async () => undefined,
          resolveHost: async () => ['93.184.216.34'],
        },
        timeoutMs: 1_000,
        maxBytes: 1_024,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ArcGisRequestFailure);
    assert.equal(caught.kind, 'byte_limit');
    assert.equal(caught.status, 200);
    assert.equal(caught.evidence.bytes, Buffer.byteLength(oversizedBody));
    assert.equal(caught.evidence.url, `${LAYER_URL}?f=json`);
    assert.equal(caught.evidence.sha256, sha256Text(oversizedBody));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('evidence request records accept method/request_sha256 and stay strict', () => {
  const request = {
    name: 'query_ids',
    url: QUERY_URL,
    status: 200,
    sha256: 'a'.repeat(64),
    bytes: 10,
    method: 'POST',
    request_sha256: 'b'.repeat(64),
  };
  const base = {
    schema_version: '1.2.0',
    bundle_id: 'query_feature_service:test',
    generated_at: '2026-07-19T12:00:00.000Z',
    requests: [request],
    source: {
      uri: QUERY_URL,
      identity: { kind: 'arcgis_feature_layer', value: LAYER_URL },
      version: {},
      retrieved_at: '2026-07-19T12:00:00.000Z',
      sha256: 'a'.repeat(64),
    },
    gis_metadata: {
      format: 'ArcGIS FeatureServer REST JSON',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: 0,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: { canonical_json: '{}', sha256: 'c'.repeat(64) },
    execution: {
      capability: 'query_feature_service',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      { name: 'arcgis_feature_query', sha256: 'd'.repeat(64), validation: { valid: true, checks: ['x'] } },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  };
  assert.doesNotThrow(() => EvidenceBundleSchema.parse(base));
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...base, requests: [{ ...request, body: 'x' }] }),
    /unrecognized/i,
  );
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...base, requests: [{ ...request, method: 'PUT' }] }),
    /invalid/i,
  );
  assert.throws(
    () => {
      const { request_sha256: _hash, ...postWithoutHash } = request;
      return EvidenceBundleSchema.parse({ ...base, requests: [postWithoutHash] });
    },
    /requires request_sha256/,
  );
  assert.throws(
    () => {
      const { method: _method, ...hashWithoutPost } = request;
      return EvidenceBundleSchema.parse({ ...base, requests: [hashWithoutPost] });
    },
    /only valid for POST/,
  );
});

test('capability source contains no literal NUL or control bytes', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/capabilities/query-feature-service.ts'),
    'utf8',
  );
  assert.ok(!source.includes(String.fromCharCode(0)));
  assert.ok(![...source].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t'));
});
