import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  parseArcGisPageEnvelope,
  redactSecrets,
  requestArcGisJson,
  type ArcGisRestTransport,
  type ArcGisTransportRequest,
} from '../src/capabilities/arcgis-rest.js';
import { inspectArcgisOrgCapability } from '../src/capabilities/inspect-arcgis-org.js';
import { allCapabilities } from '../src/capabilities/registry.js';
import { EvidenceBundleSchema } from '../src/contracts/evidence.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const PORTAL = 'https://demo-org.maps.arcgis.com';
const ORG = 'DEMOORG123';
const REST = `${PORTAL}/sharing/rest`;
const NOW = new Date('2026-07-18T12:00:00.000Z');
const RUN_ID = '00000000-0000-0000-0000-000000000001';

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

function epoch(iso: string): number {
  return Date.parse(iso);
}

const portalSelfBody = {
  id: ORG,
  name: 'Demo Synthetic Org',
  urlKey: 'demo-org',
  access: 'public',
  created: epoch('2020-01-01T00:00:00.000Z'),
  modified: epoch('2026-06-01T00:00:00.000Z'),
};

function smallOrgRoutes(): Record<string, Route> {
  return {
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/portals/${ORG}/users?f=json&start=1&num=10`]: {
      body: {
        total: 2,
        start: 1,
        num: 10,
        nextStart: -1,
        users: [
          {
            username: 'ada.analyst',
            fullName: 'Ada Analyst',
            role: 'org_admin',
            created: epoch('2021-03-01T00:00:00.000Z'),
            modified: epoch('2026-05-01T00:00:00.000Z'),
            lastLogin: epoch('2026-07-01T08:00:00.000Z'),
          },
          {
            username: 'greg.gis',
            fullName: 'Greg GIS',
            role: 'org_publisher',
            created: epoch('2022-06-15T00:00:00.000Z'),
            modified: epoch('2024-01-01T00:00:00.000Z'),
            lastLogin: -1,
          },
        ],
      },
    },
    [`${REST}/community/groups?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=10`]: {
      body: {
        total: 1,
        start: 1,
        num: 10,
        nextStart: -1,
        results: [
          {
            id: 'g1aaaaaaaaaaaaaa',
            title: 'Operations',
            owner: 'ada.analyst',
            access: 'org',
            created: epoch('2021-04-01T00:00:00.000Z'),
            modified: epoch('2026-01-01T00:00:00.000Z'),
          },
        ],
      },
    },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=10`]: {
      body: {
        total: 3,
        start: 1,
        num: 10,
        nextStart: -1,
        results: [
          {
            id: 'i1aaaaaaaaaaaaaa',
            title: 'Hydrants',
            owner: 'ada.analyst',
            type: 'Feature Service',
            access: 'public',
            created: epoch('2023-01-01T00:00:00.000Z'),
            modified: epoch('2026-07-01T00:00:00.000Z'),
            size: 2048,
            url: `${PORTAL}/server/rest/services/Hydrants/FeatureServer`,
          },
          {
            id: 'i2bbbbbbbbbbbbbb',
            title: 'Old Basemap Notes',
            owner: 'greg.gis',
            type: 'Web Map',
            access: 'private',
            created: epoch('2022-01-01T00:00:00.000Z'),
            modified: epoch('2024-05-01T00:00:00.000Z'),
            size: 512,
          },
          {
            id: 'i3cccccccccccccc',
            title: 'Mystery Layer Service', // service-like title must NOT classify it
            owner: 'ada.analyst',
            type: 'CSV',
            access: 'weird-access-value',
            created: epoch('2023-06-01T00:00:00.000Z'),
            modified: -1,
            size: 100,
          },
        ],
      },
    },
  };
}

const baseInput = {
  portal_url: PORTAL,
  org_id: ORG,
  page_size: 10,
  max_records: 10,
  stale_after_days: 365,
};

test('inspect_arcgis_org is a strict read-only versioned capability with no credential inputs', () => {
  assert.equal(inspectArcgisOrgCapability.manifest.slug, 'inspect_arcgis_org');
  assert.equal(inspectArcgisOrgCapability.manifest.classification, 'read');
  assert.equal(inspectArcgisOrgCapability.manifest.version, '1.0.0');
  // Input max_records is per retrieved section (users/groups/items, each ≤ 2000);
  // the manifest states the honest total output ceiling including derived services.
  assert.equal(inspectArcgisOrgCapability.manifest.resource_limits.max_records, 8_000);
  assert.ok(allCapabilities().some((c) => c.manifest.slug === 'inspect_arcgis_org'));

  const schema = inspectArcgisOrgCapability.inputSchema;
  assert.throws(() => schema.parse({ ...baseInput, unknown_field: 1 }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, token: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, api_key: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, password: 'abc' }), /unrecognized/i);
  assert.throws(() => schema.parse({ ...baseInput, portal_url: 'http://demo-org.maps.arcgis.com' }), /https/);
  assert.throws(
    () => schema.parse({ ...baseInput, portal_url: 'https://user:pw@demo-org.maps.arcgis.com' }),
    /credential/,
  );
  assert.throws(
    () => schema.parse({ ...baseInput, portal_url: `${PORTAL}/?token=x` }),
    /query string/,
  );
  assert.throws(() => schema.parse({ ...baseInput, portal_url: `${PORTAL}/a/../b` }), /traversal/);
  assert.throws(() => schema.parse({ ...baseInput, org_id: '../etc' }), /invalid/i);
  assert.throws(() => schema.parse({ ...baseInput, include: ['users', 'users'] }), /unique/);
  assert.throws(() => schema.parse({ ...baseInput, include: ['services'] }), /derived from items/);
  assert.throws(() => schema.parse({ ...baseInput, page_size: 101 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, item_owner: 'a b' }), /invalid/i);
});

test('inspect_arcgis_org inventories a small org deterministically through the dispatcher', async () => {
  const transport = fixtureTransport(smallOrgRoutes());
  const result = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, true, result.error);
  const output = result.output as Record<string, any>;
  assert.doesNotThrow(() => inspectArcgisOrgCapability.outputSchema.parse(output));
  assert.throws(
    () => inspectArcgisOrgCapability.outputSchema.parse({ ...output, extra: 1 }),
    /unrecognized/i,
  );

  const report = output.report;
  assert.equal(report.portal.org_id, ORG);
  assert.equal(report.portal.name, 'Demo Synthetic Org');
  assert.equal(report.retrieved_at, '2026-07-18T12:00:00.000Z');

  // Deterministic timestamp normalization: epoch ms → ISO-8601, -1 → null.
  assert.equal(report.users.records[0].last_login_at, '2026-07-01T08:00:00.000Z');
  assert.equal(report.users.records[1].last_login_at, null);
  assert.equal(report.users.retrieved_count, 2);
  assert.equal(report.groups.records[0].access, 'org');

  // Item-type normalization: authoritative type only, never title text.
  const [hydrants, webmap, csv] = report.items.records;
  assert.equal(hydrants.service_backed, true);
  assert.equal(hydrants.service_url, `${PORTAL}/server/rest/services/Hydrants/FeatureServer`);
  assert.equal(webmap.service_backed, false);
  assert.equal(csv.service_backed, false); // 'Mystery Layer Service' title, CSV type
  assert.equal(csv.access, 'unknown');
  assert.ok(report.warnings.some((w: string) => w.includes("i3cccccccccccccc' access")));

  // Staleness: threshold 365d from fixed clock; unknown modified → null stale.
  assert.equal(hydrants.stale, false);
  assert.equal(webmap.stale, true);
  assert.equal(webmap.days_since_modified, 808);
  assert.equal(csv.stale, null);
  assert.equal(report.staleness.threshold_days, 365);
  assert.equal(report.staleness.stale_item_count, 1);
  assert.equal(report.staleness.unknown_modified_count, 1);
  assert.equal(report.staleness.findings[0].item_id, 'i2bbbbbbbbbbbbbb');

  // Ownership and sharing summaries stay raw-count based and deterministic.
  assert.deepEqual(report.ownership_summary, [
    { owner: 'ada.analyst', item_count: 2 },
    { owner: 'greg.gis', item_count: 1 },
  ]);
  assert.deepEqual(report.sharing_summary, { public: 1, org: 0, shared: 0, private: 1, unknown: 1 });

  // Derived services section.
  assert.equal(report.services.retrieved_count, 1);
  assert.equal(report.services.records[0].item_id, 'i1aaaaaaaaaaaaaa');

  // Partial-visibility caveat is always present; no truncation on this org.
  assert.ok(report.caveats.some((c: string) => c.includes('not proof of a complete organization inventory')));
  assert.equal(report.truncation.truncated, false);

  // Versioned evidence with per-request identities and validated hashes.
  const evidence = output.evidence;
  assert.doesNotThrow(() => EvidenceBundleSchema.parse(evidence));
  assert.equal(evidence.execution.mode, 'deterministic');
  assert.equal(evidence.source.identity.kind, 'arcgis_org');
  assert.equal(evidence.requests.length, 4);
  assert.deepEqual(
    evidence.requests.map((r: { name: string }) => r.name),
    ['portal_self', 'users:page1', 'groups:page1', 'items:page1'],
  );
  for (const request of evidence.requests) {
    assert.match(request.sha256, /^[a-f0-9]{64}$/);
    assert.equal(request.status, 200);
  }
  assert.equal(evidence.gis_metadata.row_count, 6);

  // No secret-like material anywhere in output or evidence.
  const serialized = JSON.stringify(output);
  assert.ok(!/token=|password|authorization/i.test(serialized));
});

test('pagination follows positive nextStart cursors and terminates on -1', async () => {
  const routes: Record<string, Route> = {
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: {
      body: {
        total: 4,
        nextStart: 3,
        results: [
          { id: 'p1aaaaaaaaaaaaaa', owner: 'ada.analyst', type: 'Web Map', access: 'org', created: 1, modified: epoch('2026-07-01T00:00:00.000Z') },
          { id: 'p2aaaaaaaaaaaaaa', owner: 'ada.analyst', type: 'Web Map', access: 'org', created: 2, modified: epoch('2026-07-01T00:00:00.000Z') },
        ],
      },
    },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=3&num=2`]: {
      body: {
        total: 4,
        nextStart: -1,
        results: [
          { id: 'p3aaaaaaaaaaaaaa', owner: 'ada.analyst', type: 'Web Map', access: 'org', created: 3, modified: epoch('2026-07-01T00:00:00.000Z') },
          { id: 'p4aaaaaaaaaaaaaa', owner: 'ada.analyst', type: 'Web Map', access: 'org', created: 4, modified: epoch('2026-07-01T00:00:00.000Z') },
        ],
      },
    },
  };
  const transport = fixtureTransport(routes);
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 2, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.equal(report.items.retrieved_count, 4);
  assert.equal(report.items.total_reported, 4);
  assert.equal(report.items.truncated, false);
  assert.equal(transport.calls.length, 3);
  assert.equal(report.users, null);
  assert.equal(report.groups, null);
});

test('item_owner filter is encoded into the search query, never a raw path', async () => {
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}+AND+owner%3Aada.analyst&sortField=created&sortOrder=asc&start=1&num=10`]: {
      body: {
        total: 1,
        nextStart: -1,
        results: [
          { id: 'f1aaaaaaaaaaaaaa', owner: 'ada.analyst', type: 'Web Map', access: 'org', modified: epoch('2026-07-01T00:00:00.000Z') },
        ],
      },
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 10, max_records: 10, item_owner: 'ada.analyst' },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.equal(report.items.retrieved_count, 1);
  assert.equal(report.parameters.item_owner, 'ada.analyst');
});

test('repeated or non-advancing pagination cursors fail closed', async () => {
  const pageBody = {
    total: 4,
    nextStart: 1, // never advances
    results: [{ id: 'r1aaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', modified: 1 }],
  };
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: { body: pageBody },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 2, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /repeated or non-advancing pagination cursor/);
  assert.equal(transport.calls.length, 2); // portal self + one page, no runaway loop
});

test('report and output hash are canonical regardless of server page/record order', async () => {
  const itemBodies = (order: 'forward' | 'reversed') => {
    const all = [
      { id: 'o1aaaaaaaaaaaaaa', title: 'Alpha', owner: 'ada.analyst', type: 'Feature Service', access: 'public', created: 1, modified: epoch('2026-07-01T00:00:00.000Z'), url: 'https://services.arcgis.com/a/FeatureServer' },
      { id: 'o2bbbbbbbbbbbbbb', title: 'Beta', owner: 'greg.gis', type: 'Web Map', access: 'strange-value', created: 2, modified: epoch('2024-01-01T00:00:00.000Z') },
      { id: 'o3cccccccccccccc', title: 'Gamma', owner: 'ada.analyst', type: 'Map Service', access: 'org', created: 3, modified: epoch('2026-06-01T00:00:00.000Z'), url: 'https://services.arcgis.com/c/MapServer' },
    ];
    const ordered = order === 'forward' ? all : [all[2], all[1], all[0]];
    return {
      page1: { total: 3, nextStart: 3, results: ordered.slice(0, 2) },
      page2: { total: 3, nextStart: -1, results: ordered.slice(2) },
    };
  };
  const userBodies = (order: 'forward' | 'reversed') => {
    const all = [
      { username: 'ada.analyst', fullName: 'Ada Analyst', role: 'org_admin', created: 1, modified: 2, lastLogin: -1 },
      { username: 'greg.gis', fullName: 'Greg GIS', role: 'org_user', created: 3, modified: 4, lastLogin: 0 },
    ];
    return { total: 2, nextStart: -1, users: order === 'forward' ? all : [...all].reverse() };
  };
  const run = async (order: 'forward' | 'reversed') => {
    const items = itemBodies(order);
    const transport = fixtureTransport({
      [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
      [`${REST}/portals/${ORG}/users?f=json&start=1&num=2`]: { body: userBodies(order) },
      [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: { body: items.page1 },
      [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=3&num=2`]: { body: items.page2 },
    });
    const result = await runSkill(
      'inspect_arcgis_org',
      { portal_url: PORTAL, org_id: ORG, include: ['users', 'items', 'services'], page_size: 2, max_records: 10 },
      RUN_ID,
      testDependencies(transport),
    );
    assert.equal(result.ok, true, result.error);
    return result.output as any;
  };
  const forward = await run('forward');
  const reversed = await run('reversed');

  // Identical report (records, summaries, warnings) and identical output hash;
  // only the per-request evidence bodies may differ.
  assert.deepEqual(reversed.report, forward.report);
  assert.equal(reversed.evidence.outputs[0].sha256, forward.evidence.outputs[0].sha256);
  assert.deepEqual(
    forward.report.items.records.map((r: { id: string }) => r.id),
    ['o1aaaaaaaaaaaaaa', 'o2bbbbbbbbbbbbbb', 'o3cccccccccccccc'],
  );
  assert.deepEqual(
    forward.report.users.records.map((r: { username: string }) => r.username),
    ['ada.analyst', 'greg.gis'],
  );
  assert.deepEqual(
    forward.report.services.records.map((r: { item_id: string }) => r.item_id),
    ['o1aaaaaaaaaaaaaa', 'o3cccccccccccccc'],
  );
  // Request evidence stays in dispatch order in both runs.
  assert.deepEqual(
    forward.evidence.requests.map((r: { name: string }) => r.name),
    ['portal_self', 'users:page1', 'items:page1', 'items:page2'],
  );
  assert.deepEqual(
    reversed.evidence.requests.map((r: { name: string }) => r.name),
    forward.evidence.requests.map((r: { name: string }) => r.name),
  );
});

test('duplicate stable ids across pages fail closed instead of double-counting', async () => {
  const dupe = { id: 'dupaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', created: 1, modified: epoch('2026-07-01T00:00:00.000Z') };
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: {
      body: { total: 3, nextStart: 3, results: [dupe, { ...dupe, id: 'uniqbbbbbbbbbbbb' }] },
    },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=3&num=2`]: {
      body: { total: 3, nextStart: -1, results: [dupe] }, // same id again
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 2, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /duplicate stable id 'dupaaaaaaaaaaaaa'/);
});

test('server totals lower than retrieved records fail closed', async () => {
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=10`]: {
      body: {
        total: 1,
        nextStart: -1,
        results: [
          { id: 'lowaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', modified: 1 },
          { id: 'lowbbbbbbbbbbbbb', owner: 'a', type: 'Web Map', access: 'org', modified: 1 },
        ],
      },
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 10, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /reported total 1 lower than the 2 records retrieved/);
});

test('malformed pagination envelopes fail closed', async () => {
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: {
      body: { total: 4, nextStart: 'soon', results: [] },
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 2, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /malformed nextStart cursor/);
});

test('max_records ceiling truncates honestly with explicit reasons and caveats', async () => {
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=2`]: {
      body: {
        total: 50,
        nextStart: 3,
        results: [
          { id: 't1aaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', modified: epoch('2026-07-01T00:00:00.000Z') },
          { id: 't2aaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', modified: epoch('2026-07-01T00:00:00.000Z') },
        ],
      },
    },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=3&num=1`]: {
      body: {
        total: 50,
        nextStart: 4,
        results: [{ id: 't3aaaaaaaaaaaaaa', owner: 'a', type: 'Web Map', access: 'org', modified: epoch('2026-07-01T00:00:00.000Z') }],
      },
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items'], page_size: 2, max_records: 3 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  assert.equal(report.items.retrieved_count, 3);
  assert.equal(report.items.total_reported, 50);
  assert.equal(report.items.truncated, true);
  assert.equal(report.truncation.truncated, true);
  assert.ok(report.truncation.reasons.some((r: string) => r.includes('3-record ceiling')));
  assert.ok(report.caveats.some((c: string) => c.includes('retrieved records')));
});

test('input schema ceilings bound page_size, max_records, and stale_after_days', () => {
  const schema = inspectArcgisOrgCapability.inputSchema;
  assert.throws(() => schema.parse({ ...baseInput, max_records: 2_001 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, stale_after_days: 3_651 }), /less than or equal/i);
  assert.throws(() => schema.parse({ ...baseInput, stale_after_days: 0 }), /greater than or equal/i);
});

test('HTTP failures, redirects, and ArcGIS error envelopes are rejected with secrets redacted', async () => {
  const http500 = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { status: 500, body: 'boom' },
  });
  const failed = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(http500));
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /HTTP 500/);

  const redirect = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { status: 302, body: '' },
  });
  const redirected = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(redirect));
  assert.equal(redirected.ok, false);
  assert.match(redirected.error ?? '', /redirects are not followed/);

  // ArcGIS error envelope arrives with HTTP 200 and a token-bearing message.
  const envelope = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: {
      body: { error: { code: 498, message: 'Invalid token: token=SECRETVALUE12345 rejected' } },
    },
  });
  const enveloped = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(envelope));
  assert.equal(enveloped.ok, false);
  assert.match(enveloped.error ?? '', /error envelope \(code 498\)/);
  assert.ok(!enveloped.error?.includes('SECRETVALUE12345'), 'secret must be redacted from errors');
  assert.match(enveloped.error ?? '', /<redacted>/);

  const html = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { contentType: 'text/html', body: '<html></html>' },
  });
  const htmlResult = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(html));
  assert.equal(htmlResult.ok, false);
  assert.match(htmlResult.error ?? '', /unexpected content type/);
});

test('portal identity mismatches fail closed', async () => {
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: { ...portalSelfBody, id: 'OTHERORG999' } },
  });
  const result = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /portal identity mismatch/);
});

test('boundary rejection happens before transport dispatch and invocation recording', async () => {
  const transport = fixtureTransport({});
  let began = 0;
  const denied = await runSkill(
    'inspect_arcgis_org',
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
    'inspect_arcgis_org',
    { ...baseInput, portal_url: 'https://evil.example.com' },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(offAllowlist.ok, false);
  assert.match(offAllowlist.error ?? '', /boundary violation/i);
  assert.equal(transport.calls.length, 0);
});

test('every outbound request re-checks the boundary immediately before dispatch', async () => {
  // The audit stub sees one allowed data_query event per outbound request.
  const audited: string[] = [];
  const transport = fixtureTransport(smallOrgRoutes());
  const dependencies = testDependencies(transport, {
    boundaryOptions: {
      audit: async (eventType, payload) => {
        if (eventType === 'data_query') audited.push(String((payload as { url?: string }).url ?? ''));
      },
      resolveHost: async () => ['93.184.216.34'],
    },
  });
  const result = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, dependencies);
  assert.equal(result.ok, true, result.error);
  // 1 executor preflight (portal_url) + 4 per-request checks (portal self,
  // users page, groups page, items page).
  assert.equal(audited.length, 5);
  assert.equal(transport.calls.length, 4);
});

test('cancellation is honored before requests are dispatched', async () => {
  const transport = fixtureTransport(smallOrgRoutes());
  const controller = new AbortController();
  controller.abort();
  const result = await runSkill(
    'inspect_arcgis_org',
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

test('requestArcGisJson enforces byte ceilings and JSON structure', async () => {
  const boundary = { audit: async () => undefined, resolveHost: async () => ['93.184.216.34'] };
  const oversized: ArcGisRestTransport = {
    get: async () => ({ status: 200, contentType: 'application/json', bodyText: `{"pad":"${'x'.repeat(300)}"}` }),
  };
  await assert.rejects(
    requestArcGisJson({
      name: 'oversized',
      url: new URL(`${REST}/portals/${ORG}?f=json`),
      transport: oversized,
      boundary,
      timeoutMs: 1_000,
      maxBytes: 100,
    }),
    /exceeded 100 byte limit/,
  );

  const nonObject: ArcGisRestTransport = {
    get: async () => ({ status: 200, contentType: 'application/json', bodyText: '[1,2,3]' }),
  };
  await assert.rejects(
    requestArcGisJson({
      name: 'array',
      url: new URL(`${REST}/portals/${ORG}?f=json`),
      transport: nonObject,
      boundary,
      timeoutMs: 1_000,
      maxBytes: 1_000,
    }),
    /non-object JSON body/,
  );

  const invalid: ArcGisRestTransport = {
    get: async () => ({ status: 200, contentType: 'application/json', bodyText: '{nope' }),
  };
  await assert.rejects(
    requestArcGisJson({
      name: 'invalid',
      url: new URL(`${REST}/portals/${ORG}?f=json`),
      transport: invalid,
      boundary,
      timeoutMs: 1_000,
      maxBytes: 1_000,
    }),
    /invalid JSON/,
  );
});

test('page envelope parsing and secret redaction are strict', () => {
  assert.throws(() => parseArcGisPageEnvelope({ nextStart: -1 }, 'results', 'x'), /missing the 'results' array/);
  assert.throws(
    () => parseArcGisPageEnvelope({ results: [1], nextStart: -1 }, 'results', 'x'),
    /record 0 is not an object/,
  );
  const parsed = parseArcGisPageEnvelope({ results: [{ a: 1 }], nextStart: -1, total: 1 }, 'results', 'x');
  assert.equal(parsed.total, 1);
  assert.equal(parsed.nextStart, -1);

  assert.equal(redactSecrets('ok token=abc123 rest'), 'ok token=<redacted> rest');
  assert.equal(redactSecrets('?apikey=zzz&x=1'), '?apikey=<redacted>&x=1');
  assert.equal(redactSecrets('"access_token":"abc"'), '"access_token":"<redacted>"');
  assert.equal(redactSecrets('no secrets here'), 'no secrets here');
});

test('credential-bearing service URLs in item metadata never leak into output or evidence', async () => {
  const canaries = [
    'CANARY_USERINFO_PW_9x1z',
    'CANARY_USER_NAME_8y2w',
    'CANARY_TOKEN_7q2v',
    'CANARY_APIKEY_5m3u',
    'CANARY_ACCESS_TOKEN_4n4t',
    'CANARY_SIGNATURE_3p5s',
    'CANARY_CODE_2r6q',
    'CANARY_PASSWORD_1s7p',
    'CANARY_SECRET_0t8o',
  ];
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: { body: portalSelfBody },
    [`${REST}/search?f=json&q=orgid%3A${ORG}&sortField=created&sortOrder=asc&start=1&num=10`]: {
      body: {
        total: 3,
        nextStart: -1,
        results: [
          {
            id: 'e1aaaaaaaaaaaaaa',
            title: 'Userinfo Service',
            owner: 'ada.analyst',
            type: 'Feature Service',
            access: 'org',
            modified: epoch('2026-07-01T00:00:00.000Z'),
            url: `https://CANARY_USER_NAME_8y2w:CANARY_USERINFO_PW_9x1z@services.arcgis.com/x/FeatureServer`,
          },
          {
            id: 'e2bbbbbbbbbbbbbb',
            title: 'Query Secret Service',
            owner: 'ada.analyst',
            type: 'Feature Service',
            access: 'org',
            modified: epoch('2026-07-01T00:00:00.000Z'),
            url:
              'https://services.arcgis.com/y/FeatureServer' +
              '?token=CANARY_TOKEN_7q2v&api_key=CANARY_APIKEY_5m3u&access_token=CANARY_ACCESS_TOKEN_4n4t' +
              '&signature=CANARY_SIGNATURE_3p5s&code=CANARY_CODE_2r6q&password=CANARY_PASSWORD_1s7p' +
              '&secret=CANARY_SECRET_0t8o#frag',
          },
          {
            id: 'e3cccccccccccccc',
            title: 'Clean Service',
            owner: 'ada.analyst',
            type: 'Feature Service',
            access: 'org',
            modified: epoch('2026-07-01T00:00:00.000Z'),
            url: 'https://services.arcgis.com/z/FeatureServer',
          },
        ],
      },
    },
  });
  const result = await runSkill(
    'inspect_arcgis_org',
    { portal_url: PORTAL, org_id: ORG, include: ['items', 'services'], page_size: 10, max_records: 10 },
    RUN_ID,
    testDependencies(transport),
  );
  assert.equal(result.ok, true, result.error);
  const report = (result.output as any).report;
  const [userinfoItem, queryItem, cleanItem] = report.items.records;

  // Userinfo URL is rejected outright; query/fragment URL is stripped to the root.
  assert.equal(userinfoItem.service_url, null);
  assert.ok(report.warnings.some((w: string) => w.includes("e1aaaaaaaaaaaaaa' url: credential-bearing service URL was removed")));
  assert.equal(queryItem.service_url, 'https://services.arcgis.com/y/FeatureServer');
  assert.ok(report.warnings.some((w: string) => w.includes("e2bbbbbbbbbbbbbb' url: service URL query/fragment was removed")));
  assert.equal(cleanItem.service_url, 'https://services.arcgis.com/z/FeatureServer');

  // No canary survives anywhere in the serialized output, report, or evidence.
  const serialized = JSON.stringify(result);
  for (const canary of canaries) {
    assert.ok(!serialized.includes(canary), `canary ${canary} leaked into serialized result`);
  }
});

test('redactSecrets removes header-style Authorization and API-key credentials', async () => {
  assert.equal(
    redactSecrets('failed with Authorization: Bearer CANARY_HDR_BEARER_1a2b'),
    'failed with Authorization: Bearer <redacted>',
  );
  assert.equal(
    redactSecrets('sent authorization: Basic CANARY_HDR_BASIC_3c4d'),
    'sent authorization: Basic <redacted>',
  );
  assert.equal(
    redactSecrets('Authorization: CANARY_HDR_RAW_5e6f was rejected'),
    'Authorization: <redacted> was rejected',
  );
  assert.equal(
    redactSecrets('retry with Bearer CANARY_SCHEME_ONLY_7g8h attached'),
    'retry with Bearer <redacted> attached',
  );
  assert.equal(
    redactSecrets('X-Api-Key: CANARY_XAPI_9i0j and api-key: CANARY_APIHDR_1k2l'),
    'X-Api-Key: <redacted> and api-key: <redacted>',
  );

  // Propagation: header credentials inside an ArcGIS error envelope must be
  // redacted before the message can reach a thrown error.
  const transport = fixtureTransport({
    [`${REST}/portals/${ORG}?f=json`]: {
      body: {
        error: {
          code: 403,
          message: 'Denied. Authorization: Bearer CANARY_ENVELOPE_BEARER_3m4n and X-Api-Key: CANARY_ENVELOPE_KEY_5o6p sent',
        },
      },
    },
  });
  const result = await runSkill('inspect_arcgis_org', { ...baseInput }, RUN_ID, testDependencies(transport));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /error envelope \(code 403\)/);
  assert.ok(!result.error?.includes('CANARY_ENVELOPE_BEARER_3m4n'), 'bearer canary leaked');
  assert.ok(!result.error?.includes('CANARY_ENVELOPE_KEY_5o6p'), 'api-key canary leaked');
  assert.match(result.error ?? '', /Bearer <redacted>/);
});

test('redactSecrets covers URL userinfo and every credential query parameter', () => {
  assert.equal(
    redactSecrets('see https://CANARY_USER_NAME_8y2w:CANARY_USERINFO_PW_9x1z@host.example/x'),
    'see https://<redacted>@host.example/x',
  );
  const params = [
    'token=CANARY_TOKEN_7q2v',
    'api_key=CANARY_APIKEY_5m3u',
    'apikey=CANARY_APIKEY_5m3u',
    'access_token=CANARY_ACCESS_TOKEN_4n4t',
    'signature=CANARY_SIGNATURE_3p5s',
    'code=CANARY_CODE_2r6q',
    'password=CANARY_PASSWORD_1s7p',
    'secret=CANARY_SECRET_0t8o',
  ];
  for (const param of params) {
    const redacted = redactSecrets(`https://h.example/p?${param}&keep=1`);
    assert.ok(!redacted.includes('CANARY_'), `canary survived redaction of '${param}'`);
    assert.ok(redacted.includes('=<redacted>'), `no redaction marker for '${param}'`);
    assert.ok(redacted.includes('keep=1'), `non-secret parameter dropped for '${param}'`);
  }
});

test('evidence contract accepts the additive requests field and stays strict', () => {
  const requests = [
    { name: 'portal_self', url: `${REST}/portals/${ORG}?f=json`, status: 200, sha256: 'a'.repeat(64), bytes: 10 },
  ];
  const base = {
    schema_version: '1.1.0',
    bundle_id: 'inspect_arcgis_org:fixture',
    generated_at: '2026-07-18T12:00:00.000Z',
    source: {
      uri: `${REST}/portals/${ORG}?f=json`,
      identity: { kind: 'arcgis_org', value: ORG },
      version: {},
      retrieved_at: '2026-07-18T12:00:00.000Z',
      sha256: 'a'.repeat(64),
    },
    gis_metadata: {
      format: 'ArcGIS Portal REST JSON',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: 0,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: { canonical_json: '{}', sha256: 'b'.repeat(64) },
    execution: {
      capability: 'inspect_arcgis_org',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  };
  assert.doesNotThrow(() => EvidenceBundleSchema.parse({ ...base, requests }));
  assert.doesNotThrow(() => EvidenceBundleSchema.parse(base)); // requests stays optional
  assert.throws(
    () => EvidenceBundleSchema.parse({ ...base, requests: [{ ...requests[0], token: 'x' }] }),
    /unrecognized/i,
  );
});
