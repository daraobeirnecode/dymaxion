import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeCapability } from '../src/capabilities/registry.js';
import type { TraceArcgisDependenciesOutput } from '../src/capabilities/trace-arcgis-dependencies.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../src/contracts/canonical.js';
import { EvidenceBundleSchema } from '../src/contracts/evidence.js';
import { runSkill, type RunSkillDependencies, type SkillResult } from '../src/skills/executor.js';
import {
  ArcgisChangeRiskCaseManifestSchema,
  ArcgisChangeRiskCaseSchema,
  ChangeRiskReportSchema,
  buildExportInput,
  buildPilotEvidence,
  deriveChangeRiskReport,
  loadCaseManifest,
  renderChangeRiskSvg,
  runPilotCase,
  traceStructureSha256,
  validateLockedCaseAgainstTrace,
  type ArcgisChangeRiskCase,
} from '../src/pilots/arcgis-change-risk-runner.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const NOW = new Date('2026-07-22T12:00:00.000Z');
const APP = 'a'.repeat(32);
const MAP = 'b'.repeat(32);
const LAYER = 'c'.repeat(32);
const SERVICE = `service:${sha256Text('https://services.arcgis.com/example/arcgis/rest/services/Layer/FeatureServer/0')}`;

function pilotCase(extra: Partial<ArcgisChangeRiskCase> = {}): ArcgisChangeRiskCase {
  return ArcgisChangeRiskCaseSchema.parse({
    slug: 'juneau-old-public-gis',
    project_id: '519e8c7c-5176-5de6-a8cf-52b7772e0e34',
    portal_url: 'https://juneaucounty.maps.arcgis.com',
    org_id: 'bT3EoWZjN5T5Pbld',
    organization_name: 'Juneau County, Wisconsin',
    root_item_id: APP,
    expected_root_title: 'Risk <Pilot> & Review',
    expected_web_map_id: MAP,
    expected_minimum_direct_reference_count: 2,
    review_posture: 'retirement_cleanup',
    ...extra,
  });
}

function traceOutput(): TraceArcgisDependenciesOutput {
  const report = {
    schema_version: '1.0.0',
    portal: { url: 'https://juneaucounty.maps.arcgis.com' },
    retrieved_at: NOW.toISOString(),
    parameters: {
      root_item_ids: [APP],
      max_depth: 4,
      max_nodes: 200,
      max_edges: 400,
      max_requests: 200,
      max_response_bytes: 2_097_152,
      max_total_response_bytes: 8_388_608,
      max_duration_ms: 30_000,
    },
    roots: [`item:${APP}`],
    nodes: [
      {
        id: `item:${APP}`,
        kind: 'item',
        item_id: APP,
        service_url: null,
        type: 'Web Mapping Application',
        title: 'Risk <Pilot> & Review',
        owner: 'owner.app',
        access: 'public',
        support: 'expandable',
        expanded: true,
        depth: 0,
        is_root: true,
        impact: { upstream_count: 0, downstream_count: 3 },
      },
      {
        id: `item:${MAP}`,
        kind: 'item',
        item_id: MAP,
        service_url: null,
        type: 'Web Map',
        title: 'Operational Web Map',
        owner: 'owner.map',
        access: 'public',
        support: 'expandable',
        expanded: true,
        depth: 1,
        is_root: false,
        impact: { upstream_count: 1, downstream_count: 2 },
      },
      {
        id: `item:${LAYER}`,
        kind: 'item',
        item_id: LAYER,
        service_url: null,
        type: 'Feature Service',
        title: 'Layer Item',
        owner: 'owner.layer',
        access: 'public',
        support: 'terminal',
        expanded: false,
        depth: 2,
        is_root: false,
        impact: { upstream_count: 2, downstream_count: 0 },
      },
      {
        id: SERVICE,
        kind: 'service',
        item_id: null,
        service_url: 'https://services.arcgis.com/example/arcgis/rest/services/Layer/FeatureServer/0',
        type: null,
        title: null,
        owner: null,
        access: 'unknown',
        support: 'service_reference',
        expanded: false,
        depth: 2,
        is_root: false,
        impact: { upstream_count: 1, downstream_count: 0 },
      },
    ],
    edges: [
      { from: `item:${APP}`, to: `item:${MAP}`, relationship: 'web_map', locator: 'map.itemId' },
      { from: `item:${MAP}`, to: `item:${LAYER}`, relationship: 'operational_layer', locator: 'operationalLayers[].itemId' },
      { from: `item:${MAP}`, to: SERVICE, relationship: 'operational_layer', locator: 'operationalLayers[].url' },
    ],
    cycles: [],
    unresolved_references: [],
    totals: { node_count: 4, edge_count: 3, item_node_count: 3, service_node_count: 1, request_count: 4 },
    truncation: { truncated: false, reasons: [] },
    caveats: ['Only supported paths were parsed.'],
    warnings: [],
  };
  const reportJson = canonicalJson(report);
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.1.0',
    bundle_id: 'trace_arcgis_dependencies:test',
    generated_at: NOW.toISOString(),
    requests: [
      { name: `item_meta:${APP}`, url: `https://juneaucounty.maps.arcgis.com/sharing/rest/content/items/${APP}?f=json`, status: 200, sha256: '1'.repeat(64), bytes: 100 },
      { name: `item_data:${APP}`, url: `https://juneaucounty.maps.arcgis.com/sharing/rest/content/items/${APP}/data?f=json`, status: 200, sha256: '2'.repeat(64), bytes: 110 },
      { name: `item_meta:${MAP}`, url: `https://juneaucounty.maps.arcgis.com/sharing/rest/content/items/${MAP}?f=json`, status: 200, sha256: '3'.repeat(64), bytes: 120 },
      { name: `item_data:${MAP}`, url: `https://juneaucounty.maps.arcgis.com/sharing/rest/content/items/${MAP}/data?f=json`, status: 200, sha256: '4'.repeat(64), bytes: 130 },
    ],
    source: {
      uri: 'https://juneaucounty.maps.arcgis.com/sharing/rest',
      identity: { kind: 'arcgis_dependency_roots', value: APP },
      version: {},
      retrieved_at: NOW.toISOString(),
      sha256: sha256Text(APP),
      bytes: 460,
    },
    gis_metadata: { format: 'ArcGIS dependency graph', crs: null, axis_order: null, units: null, extent: null, schema: [], row_count: 4, geometry_types: [], temporal_fields: [] },
    parameters: { canonical_json: canonicalJson({ portal_url: 'https://juneaucounty.maps.arcgis.com', root_item_ids: [APP] }), sha256: sha256Text(canonicalJson({ portal_url: 'https://juneaucounty.maps.arcgis.com', root_item_ids: [APP] })) },
    execution: { capability: 'trace_arcgis_dependencies', capability_version: '1.0.0', mode: 'deterministic', model_planning: [] },
    outputs: [{ name: 'arcgis_dependency_graph', sha256: sha256Text(reportJson), bytes: Buffer.byteLength(reportJson, 'utf8'), validation: { valid: true, checks: ['fixture'], warnings: [] } }],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
  return { schema_version: '1.0.0', report, evidence } as TraceArcgisDependenciesOutput;
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'dymaxion-change-risk-'));
  const root = join(parent, 'trusted');
  await mkdir(root, { mode: 0o700 });
  try {
    return await fn(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('strict case manifest accepts only the locked non-Sacramento cases', async () => {
  const manifest = await loadCaseManifest(join(repoRoot, 'docs/pilots/arcgis-change-risk/cases.json'));
  assert.equal(manifest.cases.length, 3);
  assert.throws(() => ArcgisChangeRiskCaseManifestSchema.parse({ ...manifest, extra: true }), /unrecognized/i);
  assert.throws(() => ArcgisChangeRiskCaseManifestSchema.parse({ schema_version: '1.0.0', cases: manifest.cases.slice(0, 2) }), /3|case manifest/i);
  assert.throws(
    () => ArcgisChangeRiskCaseSchema.parse({ ...manifest.cases[0]!, organization_name: 'City of Sacramento', portal_url: 'https://saccity.maps.arcgis.com' }),
    /Sacramento/i,
  );
  assert.throws(() => ArcgisChangeRiskCaseSchema.parse({ ...manifest.cases[0]!, root_item_id: 'g'.repeat(32) }), /invalid/i);
  for (const portalUrl of [
    'https://pilot-user:pilot-pass@juneaucounty.maps.arcgis.com',
    'https://juneaucounty.maps.arcgis.com?f=json',
    'https://juneaucounty.maps.arcgis.com#fragment',
    'https://juneaucounty.maps.arcgis.com/sharing',
    'https://juneaucounty.maps.arcgis.com:443',
    'https://juneaucounty.maps.arcgis.com:444',
    'https://juneaucounty.maps.arcgis.com/%2e%2e/sharing',
    'https://juneaucounty.maps.arcgis.com/../sharing',
    'https://juneaucounty.maps.arcgis.com\\sharing',
  ]) {
    assert.throws(
      () => ArcgisChangeRiskCaseSchema.parse({ ...manifest.cases[0]!, portal_url: portalUrl }),
      /portal_url|portal root|credentials|query string|fragment|path|port|encoded|backslash/i,
      portalUrl,
    );
  }
});

test('derives a deterministic honest change-risk report and strict SVG without raw markup', () => {
  const c = pilotCase();
  const trace = traceOutput();
  const report = deriveChangeRiskReport(c, trace);
  assert.doesNotThrow(() => ChangeRiskReportSchema.parse(report));
  assert.equal(report.metrics.direct_web_map_reference_count, 2);
  assert.equal(report.metrics.response_bytes, 460);
  assert.equal(
    report.findings[0],
    '2 direct supported references were observed from the locked Web Map; manifest minimum was 2.',
  );
  assert.equal(
    report.review_scope.basis[1],
    '3 visible owner references appear in public item metadata; this is not authenticated owner inventory.',
  );
  assert.equal(report.hashes.trace_report_sha256, sha256Canonical(trace.report));
  assert.equal(report.hashes.trace_structure_sha256, traceStructureSha256(trace));
  assert.deepEqual(deriveChangeRiskReport(c, trace), report);
  assert.throws(
    () => validateLockedCaseAgainstTrace({ ...c, expected_minimum_direct_reference_count: 999 }, trace),
    /fell below the validated minimum/i,
  );
  assert.throws(() => validateLockedCaseAgainstTrace({ ...c, expected_root_title: 'changed' }, trace), /root title changed/i);

  const svg = renderChangeRiskSvg(report);
  assert.ok(svg.includes('Risk &lt;Pilot&gt; &amp; Review'));
  assert.ok(!svg.includes('<script'));
  assert.ok(!/on\w+=|foreignObject|href=|<!DOCTYPE/i.test(svg));

  const evidence = buildPilotEvidence(report, trace, svg, NOW.toISOString());
  assert.equal(evidence.outputs[0]!.sha256, sha256Text(svg));
  const exportInput = buildExportInput(c, report, trace, evidence, svg, 'preview');
  assert.equal(exportInput.artifact.file_name, 'juneau-old-public-gis-change-risk.svg');
  assert.deepEqual((exportInput.report as Record<string, unknown>).trace_report, trace.report);
  assert.deepEqual((exportInput.report as Record<string, unknown>).trace_evidence, trace.evidence);
});

test('runner previews only unless explicit approval persistence is requested', async () => {
  const calls: string[] = [];
  const fakeRunSkill = async (slug: string, input: Record<string, unknown>): Promise<SkillResult> => {
    calls.push(`${slug}:${input.operation ?? 'trace'}`);
    if (slug === 'trace_arcgis_dependencies') return { ok: true, output: traceOutput(), durationMs: 7, costUsd: 0 };
    const output = await executeCapability('export_evidence_bundle', input, { now: () => NOW, monotonicNow: () => 0 });
    return { ok: true, output, durationMs: 3, costUsd: 0 };
  };
  const record = await runPilotCase(pilotCase(), { approvePersist: false, repeat: true, runSkillFn: fakeRunSkill, now: () => NOW });
  assert.equal(record.export_persist, null);
  assert.deepEqual(calls, [
    'trace_arcgis_dependencies:trace',
    'export_evidence_bundle:preview',
    'trace_arcgis_dependencies:trace',
    'export_evidence_bundle:preview',
  ]);
  assert.equal(record.repeat?.trace_structure_hash_matches, true);
  assert.equal(record.repeat?.second_trace_duration_ms, 7);
  assert.equal(record.repeat?.second_preview_duration_ms, 3);

  await assert.rejects(
    () => runPilotCase(pilotCase(), { approvePersist: true, repeat: false, runSkillFn: fakeRunSkill, now: () => NOW }),
    /--artifact-root is required/i,
  );
});

test('explicit approval path uses runSkill approval APIs and verifies the persisted ZIP hash', async () => {
  await withTempRoot(async (artifactRoot) => {
    const previousIdentity = process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({ export_evidence_bundle: 'local-value-pilot-operator' });
    try {
      const composedRunSkill = async (
        slug: string,
        input: Record<string, unknown>,
        agentRunId: string,
        dependencies?: Partial<RunSkillDependencies>,
      ): Promise<SkillResult> => {
        if (slug === 'trace_arcgis_dependencies') return { ok: true, output: traceOutput(), durationMs: 11, costUsd: 0 };
        return runSkill(slug, input, agentRunId, dependencies);
      };
      const record = await runPilotCase(pilotCase(), {
        approvePersist: true,
        artifactRoot,
        repeat: false,
        runSkillFn: composedRunSkill,
        now: () => NOW,
      });
      assert.equal(record.export_persist?.read_back_verified, true);
      assert.equal(record.export_persist?.archive_sha256, record.export_preview.archive_sha256);
      assert.match(record.export_persist?.handle ?? '', /^artifact:\/\/project\//);
    } finally {
      if (previousIdentity === undefined) delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
      else process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = previousIdentity;
    }
  });
});
