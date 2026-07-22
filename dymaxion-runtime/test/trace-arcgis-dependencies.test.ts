import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  containsCredentialMaterial,
  redactSecrets,
  type ArcGisRestTransport,
  type ArcGisTransportRequest,
} from '../src/capabilities/arcgis-rest.js';
import { traceArcgisDependenciesCapability } from '../src/capabilities/trace-arcgis-dependencies.js';
import { allCapabilities } from '../src/capabilities/registry.js';
import { EvidenceBundleSchema } from '../src/contracts/evidence.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const PORTAL = 'https://demo-org.maps.arcgis.com';
const REST = `${PORTAL}/sharing/rest`;
const NOW = new Date('2026-07-19T12:00:00.000Z');
const RUN_ID = '00000000-0000-0000-0000-000000000001';

const APP = 'a'.repeat(32);
const MAP = 'b'.repeat(32);
const LAYER = 'c'.repeat(32);
const TABLE = 'd'.repeat(32);
const MAP2 = 'e'.repeat(32);
const MISSING = 'f'.repeat(32);

const SERVICE_URL = 'https://services.arcgis.com/synth/arcgis/rest/services/Hydrants/FeatureServer/0';
const BASEMAP_URL = 'https://tiles.arcgis.com/synth/arcgis/rest/services/Topo/MapServer';

const metaUrl = (id: string) => `${REST}/content/items/${id}?f=json`;
const dataUrl = (id: string) => `${REST}/content/items/${id}/data?f=json`;

type Route = { status?: number; contentType?: string; body: unknown };

function fixtureTransport(routes: Record<string, Route>): ArcGisRestTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(request: ArcGisTransportRequest) {
      calls.push(request.url.href);
      const route = routes[request.url.href];
      if (!route) throw new Error(`unexpected request in test: ${request.url.href}`);
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return {
        status: route.status ?? 200,
        contentType: route.contentType ?? 'application/json; charset=utf-8',
        bodyText: body,
      };
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

function meta(id: string, type: string, title: string, extra: Record<string, unknown> = {}): Route {
  return { body: { id, type, title, owner: 'ada.analyst', access: 'public', ...extra } };
}

function chainRoutes(): Record<string, Route> {
  return {
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Hydrant Viewer'),
    [dataUrl(APP)]: { body: { map: { itemId: MAP } } },
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Hydrant Operations Map', { access: 'org' }),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [{ itemId: LAYER, url: SERVICE_URL }],
        tables: [{ itemId: TABLE }],
        baseMap: { baseMapLayers: [{ url: BASEMAP_URL }] },
      },
    },
    [metaUrl(LAYER)]: meta(LAYER, 'Feature Service', 'Hydrants'),
    [metaUrl(TABLE)]: meta(TABLE, 'Feature Service', 'Inspections Table', { access: 'private' }),
  };
}

const baseInput = { portal_url: PORTAL, root_item_ids: [APP] };

test('trace_arcgis_dependencies is a strict read-only versioned capability with no credential inputs', () => {
  const capability = traceArcgisDependenciesCapability;
  assert.equal(capability.manifest.slug, 'trace_arcgis_dependencies');
  assert.equal(capability.manifest.classification, 'read');
  assert.equal(capability.manifest.version, '1.0.0');
  assert.equal(capability.manifest.resource_limits.max_records, 1_500); // 500 nodes + 1000 edges
  assert.ok(allCapabilities().some((c) => c.manifest.slug === 'trace_arcgis_dependencies'));

  const schema = capability.inputSchema;
  assert.throws(() => schema.parse({ ...baseInput, unknown_field: 1 }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, token: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, api_key: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, password: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, service_url: 'https://x.example' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, portal_url: 'http://demo-org.maps.arcgis.com' }), /https/);
  assert.throws(
    () => schema.parse({ ...baseInput, portal_url: 'https://user:pw@demo-org.maps.arcgis.com' }),
    /credential/,
  );
  assert.throws(() => schema.parse({ ...baseInput, portal_url: `${PORTAL}/?token=x` }), /query string/);
  assert.throws(() => schema.parse({ ...baseInput, portal_url: `${PORTAL}/a/../b` }), /traversal/);
  assert.throws(() => schema.parse({ ...baseInput, root_item_ids: [] }), /at least 1/i);
  assert.throws(() => schema.parse({ ...baseInput, root_item_ids: ['abc'] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, root_item_ids: [`${APP}0`] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, root_item_ids: ['g'.repeat(32)] }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, root_item_ids: ['../../etc/passwd'] }), /invalid/i);
  assert.throws(
    () => schema.parse({ ...baseInput, root_item_ids: [APP, APP.toUpperCase()] }),
    /unique/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, root_item_ids: Array.from({ length: 26 }, (_, i) => `${i.toString(16)}`.padStart(2, '0').repeat(16)) }),
    /at most 25|too_big|less than or equal/i,
  );
  assert.throws(() => schema.parse({ ...baseInput, max_depth: 0 }), /greater than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_depth: 7 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_nodes: 501 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_edges: 1_001 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_requests: 1_001 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_response_bytes: 512 }), /greater than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, max_duration_ms: 60_000 }), /less than or equal/i);
});

test('traces an app→map→item/service chain deterministically through the dispatcher', async () => {
  const transport = fixtureTransport(chainRoutes());
  // Uppercase root id is normalized to canonical lowercase before any URL is built.
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [APP.toUpperCase()] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const output = result.output as Record<string, any>;
  assert.doesNotThrow(() => traceArcgisDependenciesCapability.outputSchema.parse(output));
  assert.throws(
    () => traceArcgisDependenciesCapability.outputSchema.parse({ ...output, extra: 1 }),
    /unrecognized/i,
  );

  const report = output.report;
  assert.equal(report.retrieved_at, '2026-07-19T12:00:00.000Z');
  assert.deepEqual(report.parameters.root_item_ids, [APP]);
  assert.deepEqual(report.roots, [`item:${APP}`]);
  assert.equal(report.totals.node_count, 6);
  assert.equal(report.totals.item_node_count, 4);
  assert.equal(report.totals.service_node_count, 2);
  assert.equal(report.totals.edge_count, 5);
  assert.equal(report.totals.request_count, 6);
  assert.deepEqual(report.cycles, []);
  assert.deepEqual(report.unresolved_references, []);
  assert.equal(report.truncation.truncated, false);

  const byId = new Map(report.nodes.map((node: any) => [node.id, node]));
  const app = byId.get(`item:${APP}`) as any;
  assert.equal(app.support, 'expandable');
  assert.equal(app.expanded, true);
  assert.equal(app.depth, 0);
  assert.equal(app.is_root, true);
  assert.equal(app.type, 'Web Mapping Application');
  assert.deepEqual(app.impact, { upstream_count: 0, downstream_count: 5 });

  const map = byId.get(`item:${MAP}`) as any;
  assert.equal(map.depth, 1);
  assert.equal(map.access, 'org');
  assert.deepEqual(map.impact, { upstream_count: 1, downstream_count: 4 });

  const layer = byId.get(`item:${LAYER}`) as any;
  assert.equal(layer.support, 'terminal'); // service-backed types are terminal item nodes
  assert.equal(layer.expanded, false);
  assert.equal(layer.depth, 2);
  assert.deepEqual(layer.impact, { upstream_count: 2, downstream_count: 0 });

  const serviceNodes = report.nodes.filter((node: any) => node.kind === 'service');
  assert.equal(serviceNodes.length, 2);
  for (const node of serviceNodes) {
    assert.match(node.id, /^service:[a-f0-9]{64}$/); // full SHA-256, no truncated prefix
    assert.equal(node.support, 'service_reference');
    assert.equal(node.item_id, null);
  }
  assert.ok(serviceNodes.some((node: any) => node.service_url === SERVICE_URL));
  assert.ok(serviceNodes.some((node: any) => node.service_url === BASEMAP_URL));

  const relationships = report.edges.map((edge: any) => `${edge.relationship}:${edge.locator}`).sort();
  assert.deepEqual(relationships, [
    'basemap_layer:baseMap.baseMapLayers[].url',
    'operational_layer:operationalLayers[].itemId',
    'operational_layer:operationalLayers[].url',
    'table:tables[].itemId',
    'web_map:map.itemId',
  ]);

  // Versioned evidence: dispatch-order requests, validated hashes.
  const evidence = output.evidence;
  assert.doesNotThrow(() => EvidenceBundleSchema.parse(evidence));
  assert.equal(evidence.execution.mode, 'deterministic');
  assert.equal(evidence.source.identity.kind, 'arcgis_dependency_roots');
  assert.deepEqual(
    evidence.requests.map((request: { name: string }) => request.name),
    [
      `item_meta:${APP}`,
      `item_data:${APP}`,
      `item_meta:${MAP}`,
      `item_data:${MAP}`,
      `item_meta:${LAYER}`,
      `item_meta:${TABLE}`,
    ],
  );
  assert.equal(evidence.outputs[0].name, 'arcgis_dependency_graph');
});

test('item-provided service URLs are never dispatched, even on allowed hosts', async () => {
  const transport = fixtureTransport(chainRoutes());
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  // Both service URLs are on *.arcgis.com and would pass the boundary — they
  // still must never be fetched.
  for (const call of transport.calls) {
    assert.ok(
      call.startsWith(`${REST}/content/items/`),
      `unexpected non-item request dispatched: ${call}`,
    );
  }
  assert.ok(!transport.calls.some((call) => call.includes('FeatureServer')));
  assert.ok(!transport.calls.some((call) => call.includes('MapServer')));
});

test('canonical graph and output hash are independent of root, array, and object-key order', async () => {
  const run = async (variant: 'forward' | 'reversed') => {
    const layers =
      variant === 'forward'
        ? `[{"itemId":"${LAYER}","url":"${SERVICE_URL}"},{"itemId":"${TABLE}"}]`
        : `[{"itemId":"${TABLE}"},{"url":"${SERVICE_URL}","itemId":"${LAYER}"}]`;
    const mapData =
      variant === 'forward'
        ? `{"operationalLayers":${layers},"baseMap":{"baseMapLayers":[{"url":"${BASEMAP_URL}"}]}}`
        : `{"baseMap":{"baseMapLayers":[{"url":"${BASEMAP_URL}"}]},"operationalLayers":${layers}}`;
    const appMeta =
      variant === 'forward'
        ? `{"id":"${APP}","type":"Web Mapping Application","title":"Hydrant Viewer","owner":"ada.analyst","access":"public"}`
        : `{"access":"public","owner":"ada.analyst","title":"Hydrant Viewer","type":"Web Mapping Application","id":"${APP}"}`;
    const transport = fixtureTransport({
      [metaUrl(APP)]: { body: appMeta },
      [dataUrl(APP)]: { body: { values: { webmap: MAP } } },
      [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Hydrant Operations Map'),
      [dataUrl(MAP)]: { body: mapData },
      [metaUrl(LAYER)]: meta(LAYER, 'Feature Service', 'Hydrants'),
      [metaUrl(TABLE)]: meta(TABLE, 'Feature Service', 'Inspections Table'),
    });
    const roots = variant === 'forward' ? [APP, MAP] : [MAP, APP];
    const result = await runSkill(
      'trace_arcgis_dependencies',
      { portal_url: PORTAL, root_item_ids: roots },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const forward = await run('forward');
  const reversed = await run('reversed');

  // Identical canonical report and report hash. Traversal itself is canonical
  // (sorted roots/levels/references), so the dispatch order recorded in
  // evidence is identical too; only the body hashes differ (object-key order).
  assert.deepEqual(reversed.report, forward.report);
  assert.equal(reversed.evidence.outputs[0].sha256, forward.evidence.outputs[0].sha256);
  assert.deepEqual(
    reversed.evidence.requests.map((request: { name: string }) => request.name),
    forward.evidence.requests.map((request: { name: string }) => request.name),
  );
  assert.equal(forward.evidence.requests[0].name, `item_meta:${APP}`);
  assert.equal(reversed.evidence.requests[0].name, `item_meta:${APP}`);
  assert.deepEqual(forward.report.roots, [`item:${APP}`, `item:${MAP}`]);
  assert.deepEqual(
    forward.report.nodes.map((node: any) => node.id),
    [...forward.report.nodes.map((node: any) => node.id)].sort(),
  );
});

test('cycles terminate deterministically and duplicate references deduplicate canonically', async () => {
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Map A'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [{ itemId: MAP2 }, { itemId: MAP2 }, { itemId: MAP }],
      },
    },
    [metaUrl(MAP2)]: meta(MAP2, 'Web Map', 'Map B'),
    [dataUrl(MAP2)]: { body: { operationalLayers: [{ itemId: MAP }] } },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  // Each item fetched exactly once despite the cycle and the duplicate refs.
  assert.equal(transport.calls.length, 4);
  assert.equal(new Set(transport.calls).size, 4);
  assert.equal(report.totals.node_count, 2);
  // A→B (deduplicated), A→A self-loop, B→A.
  assert.equal(report.totals.edge_count, 3);
  assert.deepEqual(report.cycles, [[`item:${MAP}`, `item:${MAP2}`]]);
  const nodeA = report.nodes.find((node: any) => node.id === `item:${MAP}`);
  // Mutual reachability: everything is upstream and downstream of everything.
  assert.deepEqual(nodeA.impact, { upstream_count: 1, downstream_count: 1 });
});

test('missing items, malformed ids, and credential-bearing URLs resolve to warnings, not leaks', async () => {
  const canaries = ['CANARY_URL_PW_1x', 'CANARY_URL_USER_2y', 'CANARY_QS_TOKEN_3z', 'CANARY_ENVELOPE_4w'];
  const transport = fixtureTransport({
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Broken App'),
    [dataUrl(APP)]: { body: { map: { itemId: MAP } } },
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Broken Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [
          { itemId: MISSING },
          { itemId: 'not-a-valid-item-id' },
          { url: `https://CANARY_URL_USER_2y:CANARY_URL_PW_1x@services.arcgis.com/x/FeatureServer` },
          { url: 'ftp://tiles.example.com/x' },
          { url: 'https://services.arcgis.com/ok/FeatureServer?token=CANARY_QS_TOKEN_3z#frag' },
        ],
      },
    },
    [metaUrl(MISSING)]: {
      body: { error: { code: 400, message: `Item does not exist. token=${'CANARY_ENVELOPE_4w'}` } },
    },
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  const output = result.output as any;
  const report = output.report;

  const missingNode = report.nodes.find((node: any) => node.id === `item:${MISSING}`);
  assert.equal(missingNode.support, 'missing');
  assert.equal(missingNode.type, null);
  assert.ok(report.warnings.some((w: string) => w.includes(`item '${MISSING}': item metadata was unavailable`)));

  const reasons = report.unresolved_references.map((ref: any) => ref.reason).sort();
  assert.deepEqual(reasons, ['credential_bearing_url', 'malformed_item_id', 'unsupported_url_scheme']);
  for (const ref of report.unresolved_references) {
    assert.equal(ref.from, `item:${MAP}`);
  }

  // The query-bearing URL survives only as a sanitized root.
  const sanitized = report.nodes.find(
    (node: any) => node.service_url === 'https://services.arcgis.com/ok/FeatureServer',
  );
  assert.ok(sanitized, 'sanitized service node missing');
  assert.ok(report.caveats.some((c: string) => c.includes('Missing or unresolved references')));

  const serialized = JSON.stringify(result);
  for (const canary of canaries) {
    assert.ok(!serialized.includes(canary), `canary ${canary} leaked into serialized result`);
  }

  // The tolerated envelope response is byte-accounted and truthfully recorded
  // in dispatch-order evidence — exactly once, with its real status.
  const evidence = output.evidence;
  assert.deepEqual(
    evidence.requests.map((request: { name: string }) => request.name),
    [
      `item_meta:${APP}`,
      `item_data:${APP}`,
      `item_meta:${MAP}`,
      `item_data:${MAP}`,
      `item_meta:${MISSING}`,
    ],
  );
  const failedRequest = evidence.requests[4];
  assert.equal(failedRequest.status, 200); // ArcGIS envelope arrives with HTTP 200
  assert.ok(failedRequest.bytes > 0);
  assert.match(failedRequest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.totals.request_count, evidence.requests.length);
});

test('repeated tolerated error envelopes cannot evade the total byte ceiling', async () => {
  const envelope = (id: string): Route => ({
    body: { error: { code: 400, message: `Item ${id} does not exist. ${'pad'.repeat(150)}` } },
  });
  const missingA = '1'.repeat(32);
  const missingB = '2'.repeat(32);
  const missingC = '3'.repeat(32);
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Leaky Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [{ itemId: missingA }, { itemId: missingB }, { itemId: missingC }],
      },
    },
    [metaUrl(missingA)]: envelope(missingA),
    [metaUrl(missingB)]: envelope(missingB),
    [metaUrl(missingC)]: envelope(missingC),
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP], max_total_response_bytes: 1_024 },
    RUN_ID,
    testDependencies(transport),
  );
  // The envelope bytes accumulate against the total ceiling, so the run fails
  // closed instead of fetching tolerated-error responses forever.
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /exceeded \d+ byte limit|byte total response ceiling/);
  assert.ok(
    transport.calls.length < 5,
    `traversal should stop before all missing items are fetched (made ${transport.calls.length} calls)`,
  );
});

test('failed-item request evidence is recorded without disturbing canonical hashes', async () => {
  // Two runs identical except the missing item's envelope message differs:
  // the canonical report (and its hash) must be identical, while the request
  // evidence honestly records different response hashes for the failure.
  const run = async (marker: string) => {
    const transport = fixtureTransport({
      [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Stable Map'),
      [dataUrl(MAP)]: { body: { operationalLayers: [{ itemId: MISSING }] } },
      [metaUrl(MISSING)]: { body: { error: { code: 400, message: `gone ${marker}` } } },
    });
    const result = await runSkill(
      'trace_arcgis_dependencies',
      { portal_url: PORTAL, root_item_ids: [MAP] },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const first = await run('alpha');
  const second = await run('beta');
  assert.deepEqual(second.report, first.report);
  assert.equal(second.evidence.outputs[0].sha256, first.evidence.outputs[0].sha256);
  assert.equal(first.evidence.requests.length, 3);
  assert.equal(first.evidence.requests[2].name, `item_meta:${MISSING}`);
  assert.notEqual(first.evidence.requests[2].sha256, second.evidence.requests[2].sha256);
});

test('credential-shaped metadata values are redacted while type matching still works', async () => {
  const metaCanaries = [
    'CANARY_META_TITLE_1a',
    'CANARY_META_OWNER_2b',
    'CANARY_META_TYPE_3c',
    'CANARY_META_BEARER_4d',
  ];
  const transport = fixtureTransport({
    [metaUrl(MAP)]: {
      body: {
        id: MAP,
        type: 'Web Map', // legitimate type must still classify as expandable
        title: 'Ops Map token=CANARY_META_TITLE_1a',
        owner: 'svc-account client_secret=CANARY_META_OWNER_2b',
        access: 'org',
      },
    },
    [dataUrl(MAP)]: { body: { operationalLayers: [{ itemId: LAYER }] } },
    [metaUrl(LAYER)]: {
      body: {
        id: LAYER,
        type: 'Custom Thing apikey=CANARY_META_TYPE_3c',
        title: 'Authorization: Bearer CANARY_META_BEARER_4d',
        owner: 'greg.gis',
        access: 'public',
      },
    },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;

  const mapNode = report.nodes.find((node: any) => node.id === `item:${MAP}`);
  assert.equal(mapNode.type, 'Web Map');
  assert.equal(mapNode.support, 'expandable'); // sanitization must not break matching
  assert.equal(mapNode.expanded, true);
  assert.equal(mapNode.title, 'Ops Map token=<redacted>');
  assert.equal(mapNode.owner, 'svc-account client_secret=<redacted>');

  const layerNode = report.nodes.find((node: any) => node.id === `item:${LAYER}`);
  assert.equal(layerNode.support, 'terminal'); // redacted unknown type stays terminal
  assert.equal(layerNode.type, 'Custom Thing apikey=<redacted>');
  assert.equal(layerNode.title, 'Authorization: Bearer <redacted>');

  const serialized = JSON.stringify(result);
  for (const canary of metaCanaries) {
    assert.ok(!serialized.includes(canary), `metadata canary ${canary} leaked into serialized result`);
  }
});

test('node, edge, request, and depth ceilings truncate honestly', async () => {
  // Node ceiling: root + 1 child, further references dropped with a reason.
  const nodeTransport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Wide Map'),
    [dataUrl(MAP)]: {
      body: { operationalLayers: [{ itemId: LAYER }, { itemId: TABLE }, { itemId: MAP2 }] },
    },
    [metaUrl(LAYER)]: meta(LAYER, 'Feature Service', 'Hydrants'),
  });
  const nodeResult = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP], max_nodes: 2 },
    RUN_ID,
    testDependencies(nodeTransport),
  );
  assert.equal(nodeResult.ok, true, nodeResult.error);
  const nodeReport = (nodeResult.output as any).report;
  assert.equal(nodeReport.totals.node_count, 2);
  assert.equal(nodeReport.truncation.truncated, true);
  assert.ok(nodeReport.truncation.reasons.some((r: string) => r.includes('2-node ceiling')));

  // Edge ceiling: only one edge added, second reference dropped.
  const edgeTransport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Wide Map'),
    [dataUrl(MAP)]: { body: { operationalLayers: [{ itemId: LAYER }, { itemId: TABLE }] } },
    [metaUrl(LAYER)]: meta(LAYER, 'Feature Service', 'Hydrants'),
  });
  const edgeResult = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP], max_edges: 1 },
    RUN_ID,
    testDependencies(edgeTransport),
  );
  assert.equal(edgeResult.ok, true, edgeResult.error);
  const edgeReport = (edgeResult.output as any).report;
  assert.equal(edgeReport.totals.edge_count, 1);
  assert.equal(edgeReport.totals.node_count, 2);
  assert.ok(edgeReport.truncation.reasons.some((r: string) => r.includes('1-edge ceiling')));

  // Request ceiling: metadata consumed the single request; data never fetched.
  const requestTransport = fixtureTransport({
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Hydrant Viewer'),
  });
  const requestResult = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [APP], max_requests: 1 },
    RUN_ID,
    testDependencies(requestTransport),
  );
  assert.equal(requestResult.ok, true, requestResult.error);
  const requestReport = (requestResult.output as any).report;
  assert.equal(requestTransport.calls.length, 1);
  assert.equal(requestReport.totals.request_count, 1);
  const appNode = requestReport.nodes[0];
  assert.equal(appNode.support, 'expandable');
  assert.equal(appNode.expanded, false);
  assert.ok(requestReport.truncation.reasons.some((r: string) => r.includes('1-request ceiling')));

  // Depth ceiling: the web map at depth 1 is fetched but not expanded.
  const depthTransport = fixtureTransport({
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Hydrant Viewer'),
    [dataUrl(APP)]: { body: { map: { itemId: MAP } } },
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Hydrant Operations Map'),
  });
  const depthResult = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [APP], max_depth: 1 },
    RUN_ID,
    testDependencies(depthTransport),
  );
  assert.equal(depthResult.ok, true, depthResult.error);
  const depthReport = (depthResult.output as any).report;
  assert.equal(depthTransport.calls.length, 3);
  assert.equal(depthReport.totals.node_count, 2);
  const mapNode = depthReport.nodes.find((node: any) => node.id === `item:${MAP}`);
  assert.equal(mapNode.support, 'expandable');
  assert.equal(mapNode.expanded, false);
  assert.ok(depthReport.truncation.reasons.some((r: string) => r.includes('depth ceiling')));
});

test('byte ceilings fail the run closed', async () => {
  const transport = fixtureTransport({
    [metaUrl(APP)]: { body: { id: APP, type: 'Web Map', pad: 'x'.repeat(4_000) } },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [APP], max_total_response_bytes: 1_024 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /exceeded 1024 byte limit/);
});

test('item identity mismatches fail closed', async () => {
  const transport = fixtureTransport({
    [metaUrl(APP)]: meta(MAP, 'Web Mapping Application', 'Impostor'),
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /item identity mismatch/);
});

test('a trace where no request succeeds fails honestly', async () => {
  const transport = fixtureTransport({
    [metaUrl(APP)]: { body: { error: { code: 400, message: 'Item does not exist' } } },
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no ArcGIS request succeeded/);
});

test('redirects and 5xx responses fail the whole run, not just the item', async () => {
  const redirect = fixtureTransport({ [metaUrl(APP)]: { status: 302, body: '' } });
  const redirected = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(redirect));
  assert.equal(redirected.ok, false);
  assert.match(redirected.error ?? '', /redirects are not followed/);

  const http500 = fixtureTransport({ [metaUrl(APP)]: { status: 500, body: 'boom' } });
  const failed = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(http500));
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /HTTP 500/);
});

test('boundary rejection happens before transport dispatch and invocation recording', async () => {
  const transport = fixtureTransport({});
  let began = 0;
  const denied = await runSkill(
    'trace_arcgis_dependencies',
    { ...baseInput, portal_url: 'https://city-of-sacramento.maps.arcgis.com' },
    RUN_ID,
    testDependencies(transport, {
      recorder: {
        begin: async () => {
          began += 1;
          return 'should-not-begin';
        },
        finish: async () => undefined,
      },
    }),
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /boundary violation/i);
  assert.equal(transport.calls.length, 0);
  assert.equal(began, 0);

  const offAllowlist = await runSkill(
    'trace_arcgis_dependencies',
    { ...baseInput, portal_url: 'https://evil.example.com' },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(offAllowlist.ok, false);
  assert.match(offAllowlist.error ?? '', /boundary violation/i);
  assert.equal(transport.calls.length, 0);
});

test('every outbound request re-checks the boundary immediately before dispatch', async () => {
  const audited: string[] = [];
  const transport = fixtureTransport(chainRoutes());
  const dependencies = testDependencies(transport, {
    boundaryOptions: {
      audit: async (eventType, payload) => {
        if (eventType === 'data_query') audited.push(String((payload as { url?: string }).url ?? ''));
      },
      resolveHost: async () => ['93.184.216.34'],
    },
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, dependencies);
  assert.equal(result.ok, true, result.error);
  // 1 executor preflight (portal_url) + 6 per-request checks.
  assert.equal(audited.length, 7);
  assert.equal(transport.calls.length, 6);
});

test('cancellation is honored before any request is dispatched', async () => {
  const transport = fixtureTransport(chainRoutes());
  const controller = new AbortController();
  controller.abort();
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      capabilityContext: {
        now: () => NOW,
        io: { arcgisTransport: transport },
        signal: controller.signal,
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /cancelled/);
  assert.equal(transport.calls.length, 0);
});

test('malformed known JSON paths warn deterministically without failing the trace', async () => {
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Odd Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: 'not-an-array',
        tables: [42, { itemId: LAYER }],
        baseMap: 'not-an-object',
      },
    },
    [metaUrl(LAYER)]: meta(LAYER, 'Feature Service', 'Hydrants'),
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.ok(report.warnings.some((w: string) => w.includes('operationalLayers is not an array')));
  assert.ok(report.warnings.some((w: string) => w.includes('tables entry is not an object')));
  assert.ok(report.warnings.some((w: string) => w.includes('baseMap is not an object')));
  assert.equal(report.totals.edge_count, 1); // the one valid tables itemId
});

test('an application without a supported web map reference warns and stays bounded', async () => {
  const transport = fixtureTransport({
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Custom Template App'),
    [dataUrl(APP)]: { body: { theme: { color: 'blue' }, source: 'custom-template' } },
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.equal(report.totals.node_count, 1);
  assert.equal(report.totals.edge_count, 0);
  assert.ok(
    report.warnings.some((w: string) => w.includes('no supported web map reference found in application data')),
  );
});

test('item data envelopes leave the node unexpanded with a warning', async () => {
  const transport = fixtureTransport({
    [metaUrl(APP)]: meta(APP, 'Web Mapping Application', 'Data-less App'),
    [dataUrl(APP)]: { body: { error: { code: 403, message: 'no data token=CANARY_DATA_ENV_5v' } } },
  });
  const result = await runSkill('trace_arcgis_dependencies', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  const node = report.nodes[0];
  assert.equal(node.support, 'expandable');
  assert.equal(node.expanded, false);
  assert.ok(report.warnings.some((w: string) => w.includes('item data was unavailable')));
  assert.ok(!JSON.stringify(result).includes('CANARY_DATA_ENV_5v'));
});

test('credential-shaped decoded path content in service URLs is rejected without echoing', async () => {
  const pathCanaries = [
    'CANARY_PATH_TOKEN_6a',
    'CANARY_PATH_ENC_7b',
    'CANARY_PATH_BEARER_8c',
    'CANARY_PATH_APIKEY_9d',
    'CANARY_PATH_APIKEY_ENC_0e',
  ];
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Path Canary Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [
          // Unencoded credential assignment inside the path.
          { url: 'https://services.arcgis.com/token=CANARY_PATH_TOKEN_6a/FeatureServer' },
          // Percent-encoded assignment that only appears after decoding.
          { url: 'https://services.arcgis.com/api_key%3DCANARY_PATH_ENC_7b/FeatureServer' },
          // Authorization material embedded in a path segment.
          { url: 'https://services.arcgis.com/Bearer%20CANARY_PATH_BEARER_8c/FeatureServer' },
          // Provider-style path-pair credentials, raw and encoded key names.
          { url: 'https://tiles.example.com/wms/apikey/CANARY_PATH_APIKEY_9d' },
          { url: 'https://tiles.example.com/wms/api%5Fkey/CANARY_PATH_APIKEY_ENC_0e' },
          // Ordinary service names must NOT be rejected.
          { url: 'https://services.arcgis.com/rest/services/Hydrants_2026/FeatureServer' },
          { url: 'https://services.arcgis.com/rest/services/token/FeatureServer' },
        ],
      },
    },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;

  // Exactly the two ordinary service URLs survive as sanitized leaves.
  const serviceUrls = report.nodes
    .filter((node: any) => node.kind === 'service')
    .map((node: any) => node.service_url)
    .sort();
  assert.deepEqual(serviceUrls, [
    'https://services.arcgis.com/rest/services/Hydrants_2026/FeatureServer',
    'https://services.arcgis.com/rest/services/token/FeatureServer',
  ]);

  // All credential-shaped paths are unresolved credential_bearing_url.
  const credentialRefs = report.unresolved_references.filter(
    (ref: any) => ref.reason === 'credential_bearing_url',
  );
  assert.equal(credentialRefs.length, 1); // canonically deduplicated per (from, locator, kind, reason)
  assert.equal(credentialRefs[0].locator, 'operationalLayers[].url');
  assert.ok(
    report.warnings.some((w: string) =>
      w.includes('credential-bearing service URL at operationalLayers[].url was removed'),
    ),
  );

  const serialized = JSON.stringify(result);
  for (const canary of pathCanaries) {
    assert.ok(!serialized.includes(canary), `path canary ${canary} leaked into serialized result`);
  }
});

test('an oversized tolerated 4xx cannot bypass the per-response byte ceiling', async () => {
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Oversize Map'),
    [dataUrl(MAP)]: { body: { operationalLayers: [{ itemId: MISSING }] } },
    [metaUrl(MISSING)]: {
      status: 404,
      body: { error: { code: 404, message: `not found ${'x'.repeat(4_000)}` } },
    },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP], max_response_bytes: 1_024 },
    RUN_ID,
    testDependencies(transport),
  );
  // The 404 status would normally be a tolerated per-item failure, but the
  // byte ceiling is classified first and fails the whole run closed.
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /exceeded 1024 byte limit/);
  assert.equal(transport.calls.length, 3);
});

test('active ceilings select canonical graph content regardless of root and reference order', async () => {
  // (a) max_nodes with reversed ROOTS: only the canonically smallest root
  // becomes a node in BOTH orders.
  const rootA = 'a'.repeat(32);
  const rootB = 'b'.repeat(32);
  const runRootCeiling = async (roots: string[]) => {
    const transport = fixtureTransport({
      [metaUrl(rootA)]: meta(rootA, 'Feature Service', 'Terminal Root A'),
    });
    const result = await runSkill(
      'trace_arcgis_dependencies',
      { portal_url: PORTAL, root_item_ids: roots, max_nodes: 1 },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const rootsForward = await runRootCeiling([rootA, rootB]);
  const rootsReversed = await runRootCeiling([rootB, rootA]);
  assert.deepEqual(rootsReversed.report, rootsForward.report);
  assert.equal(rootsReversed.evidence.outputs[0].sha256, rootsForward.evidence.outputs[0].sha256);
  assert.deepEqual(
    rootsForward.report.nodes.map((node: any) => node.id),
    [`item:${rootA}`],
  );
  assert.ok(rootsForward.report.truncation.reasons.some((r: string) => r.includes('1-node ceiling')));

  // (b) max_nodes with reversed CHILD references: the canonically smallest
  // child survives in BOTH orders.
  const childSmall = 'c'.repeat(32);
  const childLarge = 'd'.repeat(32);
  const runChildCeiling = async (order: 'forward' | 'reversed', input: Record<string, unknown>) => {
    const children =
      order === 'forward'
        ? [{ itemId: childSmall }, { itemId: childLarge }]
        : [{ itemId: childLarge }, { itemId: childSmall }];
    const transport = fixtureTransport({
      [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Ceiling Map'),
      [dataUrl(MAP)]: { body: { operationalLayers: children } },
      [metaUrl(childSmall)]: meta(childSmall, 'Feature Service', 'Small Child'),
    });
    const result = await runSkill(
      'trace_arcgis_dependencies',
      { portal_url: PORTAL, root_item_ids: [MAP], ...input },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const nodesForward = await runChildCeiling('forward', { max_nodes: 2 });
  const nodesReversed = await runChildCeiling('reversed', { max_nodes: 2 });
  assert.deepEqual(nodesReversed.report, nodesForward.report);
  assert.equal(nodesReversed.evidence.outputs[0].sha256, nodesForward.evidence.outputs[0].sha256);
  assert.ok(nodesForward.report.nodes.some((node: any) => node.id === `item:${childSmall}`));
  assert.ok(!nodesForward.report.nodes.some((node: any) => node.id === `item:${childLarge}`));

  // (c) max_edges with reversed CHILD references: the canonically smallest
  // edge survives in BOTH orders.
  const edgesForward = await runChildCeiling('forward', { max_edges: 1 });
  const edgesReversed = await runChildCeiling('reversed', { max_edges: 1 });
  assert.deepEqual(edgesReversed.report, edgesForward.report);
  assert.equal(edgesReversed.evidence.outputs[0].sha256, edgesForward.evidence.outputs[0].sha256);
  assert.deepEqual(
    edgesForward.report.edges.map((edge: any) => edge.to),
    [`item:${childSmall}`],
  );

  // (d) max_requests with reversed ROOTS: the canonically smallest root is
  // fetched, the other stays 'unfetched', in BOTH orders — and the request
  // evidence records the identical canonical dispatch order.
  const runRequestCeiling = async (roots: string[]) => {
    const transport = fixtureTransport({
      [metaUrl(rootA)]: meta(rootA, 'Web Map', 'Fetched Root'),
      [dataUrl(rootA)]: { body: { operationalLayers: [] } },
    });
    const result = await runSkill(
      'trace_arcgis_dependencies',
      { portal_url: PORTAL, root_item_ids: roots, max_requests: 2 },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const requestsForward = await runRequestCeiling([rootA, rootB]);
  const requestsReversed = await runRequestCeiling([rootB, rootA]);
  assert.deepEqual(requestsReversed.report, requestsForward.report);
  assert.equal(requestsReversed.evidence.outputs[0].sha256, requestsForward.evidence.outputs[0].sha256);
  assert.deepEqual(
    requestsForward.evidence.requests.map((request: { name: string }) => request.name),
    [`item_meta:${rootA}`, `item_data:${rootA}`],
  );
  assert.deepEqual(
    requestsReversed.evidence.requests.map((request: { name: string }) => request.name),
    requestsForward.evidence.requests.map((request: { name: string }) => request.name),
  );
  const unfetched = requestsForward.report.nodes.find((node: any) => node.id === `item:${rootB}`);
  assert.equal(unfetched.support, 'unfetched');
  assert.ok(requestsForward.report.truncation.reasons.some((r: string) => r.includes('2-request ceiling')));
});

test('cancellation during the boundary preflight prevents the dispatch', async () => {
  const transport = fixtureTransport(chainRoutes());
  const controller = new AbortController();
  let resolveCalls = 0;
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { ...baseInput },
    RUN_ID,
    testDependencies(transport, {
      boundaryOptions: {
        audit: async () => undefined,
        // First resolution serves the executor preflight; the abort lands
        // during the first per-request boundary check's DNS resolution.
        resolveHost: async () => {
          resolveCalls += 1;
          if (resolveCalls === 2) controller.abort();
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
  assert.match(result.error ?? '', /cancelled/);
  assert.equal(resolveCalls, 2); // preflight + one per-request check, then abort
  assert.equal(transport.calls.length, 0); // the dispatch never happened
});

test('multiply encoded path credentials are rejected at every decode depth without leakage', async () => {
  const doubleCanaries = ['CANARY_PATH_DOUBLE_9d', 'CANARY_PATH_DBLAUTH_0e'];
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Encoded Path Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [
          // Double-encoded assignment: token%253D → token%3D → token= only
          // appears on the SECOND decode pass.
          { url: 'https://services.arcgis.com/token%253DCANARY_PATH_DOUBLE_9d/FeatureServer' },
          // Double-encoded authorization material: Bearer%2520 → Bearer%20 → 'Bearer '.
          { url: 'https://services.arcgis.com/Bearer%2520CANARY_PATH_DBLAUTH_0e/FeatureServer' },
          // Malformed percent encoding fails closed.
          { url: 'https://services.arcgis.com/bad%2/FeatureServer' },
          // Nesting beyond the decode ceiling fails closed.
          { url: 'https://services.arcgis.com/deep%2525252525nest/FeatureServer' },
          // Ordinary encoded ArcGIS service names must remain accepted.
          { url: 'https://services.arcgis.com/rest/services/Fire%20Hydrants/FeatureServer' },
          { url: 'https://services.arcgis.com/rest/services/Caf%C3%A9_Sites/FeatureServer' },
        ],
      },
    },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;

  // Only the two ordinary encoded names survive, unaltered.
  const serviceUrls = report.nodes
    .filter((node: any) => node.kind === 'service')
    .map((node: any) => node.service_url)
    .sort();
  assert.deepEqual(serviceUrls, [
    'https://services.arcgis.com/rest/services/Caf%C3%A9_Sites/FeatureServer',
    'https://services.arcgis.com/rest/services/Fire%20Hydrants/FeatureServer',
  ]);

  // Both multiply encoded credentials classify as credential_bearing_url;
  // malformed and over-nested encodings classify as unparseable_url. The
  // records deduplicate canonically per (from, locator, kind, reason).
  assert.deepEqual(
    report.unresolved_references.map((ref: any) => ref.reason).sort(),
    ['credential_bearing_url', 'unparseable_url'],
  );
  assert.ok(
    report.warnings.some((w: string) =>
      w.includes('credential-bearing service URL at operationalLayers[].url was removed'),
    ),
  );
  assert.ok(
    report.warnings.some((w: string) =>
      w.includes('unparseable service URL at operationalLayers[].url was ignored'),
    ),
  );
  assert.ok(
    report.warnings.some((w: string) =>
      w.includes('service URL with excessive encoding nesting at operationalLayers[].url was ignored'),
    ),
  );

  // No raw canary — encoded or decoded — reaches report, warnings, or evidence.
  const serialized = JSON.stringify(result);
  for (const canary of doubleCanaries) {
    assert.ok(!serialized.includes(canary), `double-encoded canary ${canary} leaked into serialized result`);
  }
});

test('short Bearer/Basic authorization values in decoded paths are rejected; bare bearer/basic words are not', async () => {
  const shortAuthCanaries = ['AbC1234', 'CN4RY_A', 'QWo='];
  const transport = fixtureTransport({
    [metaUrl(MAP)]: meta(MAP, 'Web Map', 'Short Auth Map'),
    [dataUrl(MAP)]: {
      body: {
        operationalLayers: [
          // Tyr's reproduction: short (7-char) Bearer value in a FINAL path
          // segment behind a percent-encoded space.
          { url: 'https://services.arcgis.com/rest/Bearer%20AbC1234' },
          // Short Bearer value in a middle segment.
          { url: 'https://services.arcgis.com/rest/Bearer%20CN4RY_A/FeatureServer' },
          // Short (4-char, padded base64) Basic value, final segment.
          { url: 'https://services.arcgis.com/rest/Basic%20QWo=' },
          // Short Basic value in a middle segment.
          { url: 'https://services.arcgis.com/rest/Basic%20QWo=/FeatureServer' },
          // Ordinary names containing bearer/basic WITHOUT an authorization
          // value must remain accepted.
          { url: 'https://services.arcgis.com/rest/services/bearer/FeatureServer' },
          { url: 'https://services.arcgis.com/rest/services/BasicMapping/FeatureServer' },
          { url: 'https://services.arcgis.com/rest/services/Bearer' },
        ],
      },
    },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;

  // Only the three ordinary bearer/basic-named services survive.
  const serviceUrls = report.nodes
    .filter((node: any) => node.kind === 'service')
    .map((node: any) => node.service_url)
    .sort();
  assert.deepEqual(serviceUrls, [
    'https://services.arcgis.com/rest/services/BasicMapping/FeatureServer',
    'https://services.arcgis.com/rest/services/Bearer',
    'https://services.arcgis.com/rest/services/bearer/FeatureServer',
  ]);

  // All four short authorization values classify as credential_bearing_url
  // (canonically deduplicated per from/locator/kind/reason).
  assert.deepEqual(
    report.unresolved_references.map((ref: any) => ref.reason),
    ['credential_bearing_url'],
  );
  assert.ok(
    report.warnings.some((w: string) =>
      w.includes('credential-bearing service URL at operationalLayers[].url was removed'),
    ),
  );

  // No short authorization value reaches report, warnings, errors or evidence.
  const serialized = JSON.stringify(result);
  for (const canary of shortAuthCanaries) {
    assert.ok(!serialized.includes(canary), `short auth value ${canary} leaked into serialized result`);
  }
});

test('short Bearer/Basic values in item metadata are redacted before serialization', async () => {
  const metadataAuthCanaries = ['AbZ7654', 'QXk='];
  const transport = fixtureTransport({
    [metaUrl(MAP)]: {
      body: {
        id: MAP,
        type: 'Web Map', // legitimate type must still classify as expandable
        title: 'Ops Bearer AbZ7654 Map', // 7-char Bearer value in the title
        owner: 'svc Basic QXk= account', // 4-char padded Basic value in the owner
        access: 'org',
      },
    },
    [dataUrl(MAP)]: { body: { operationalLayers: [] } },
  });
  const result = await runSkill(
    'trace_arcgis_dependencies',
    { portal_url: PORTAL, root_item_ids: [MAP] },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  const node = report.nodes[0];
  assert.equal(node.support, 'expandable');
  assert.equal(node.expanded, true);
  assert.equal(node.title, 'Ops Bearer <redacted> Map');
  assert.equal(node.owner, 'svc Basic <redacted> account');

  const serialized = JSON.stringify(result);
  for (const canary of metadataAuthCanaries) {
    assert.ok(!serialized.includes(canary), `short auth metadata value ${canary} leaked into serialized result`);
  }
});

test('redactSecrets and the path detector share one token68 grammar with no length floor', () => {
  // Metadata-shaped text: short values redact.
  assert.equal(redactSecrets('title Bearer AbC1234 x'), 'title Bearer <redacted> x');
  assert.equal(redactSecrets('owner Basic QWo= y'), 'owner Basic <redacted> y');
  // Error-envelope-shaped text: short values redact before errors propagate.
  assert.equal(
    redactSecrets('error envelope: Bearer Ab1= rejected'),
    'error envelope: Bearer <redacted> rejected',
  );
  // Long existing cases keep working.
  assert.equal(
    redactSecrets('retry with Bearer CANARY_SCHEME_LONG_9z9z done'),
    'retry with Bearer <redacted> done',
  );
  assert.equal(
    redactSecrets('sent authorization: Basic CANARY_HDR_BASIC_LONG_1a2b'),
    'sent authorization: Basic <redacted>',
  );
  // Ordinary bare scheme words without a following token68 value survive.
  assert.equal(redactSecrets('bearer/FeatureServer path'), 'bearer/FeatureServer path');
  assert.equal(redactSecrets('BasicMapping service list'), 'BasicMapping service list');
  assert.equal(redactSecrets('named bearer'), 'named bearer');

  // The non-global detector agrees with redaction on short values, and stays
  // stateless across repeated calls (no /g lastIndex drift).
  assert.equal(containsCredentialMaterial('/x/Bearer a'), true);
  assert.equal(containsCredentialMaterial('/x/Bearer a'), true);
  assert.equal(containsCredentialMaterial('/x/Basic QWo='), true);
  assert.equal(containsCredentialMaterial('/rest/services/bearer/FeatureServer'), false);
  assert.equal(containsCredentialMaterial('/rest/services/bearer/FeatureServer'), false);
});

test('capability source contains no literal NUL bytes (delimiters use escaped \\u0000)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    resolve(import.meta.dirname, '../src/capabilities/trace-arcgis-dependencies.ts'),
    'utf8',
  );
  assert.ok(!source.includes(String.fromCharCode(0)), 'literal NUL byte found in capability source');
  // The escaped spelling must still be present as the map-key delimiter so
  // deterministic edge/unresolved keys keep their unambiguous separator.
  assert.ok(source.includes('\\u0000'), 'escaped \\u0000 delimiter spelling missing');
});
