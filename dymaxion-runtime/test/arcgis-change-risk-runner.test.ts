import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
  HUMAN_ENTERED_FACTS_NOTE,
  buildExportInput,
  buildPilotEvidence,
  buildRerunCommand,
  deriveChangeRiskReport,
  loadCaseManifest,
  renderChangeRiskSvg,
  renderMarkdownRecord,
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

const MISSING = 'd'.repeat(32);

/** traceOutput() plus one missing node, a hostile-but-harmless title, and two
 * unresolved references (one credential-rejected) so every dependency class
 * and unresolved state is present at once. */
function richTraceOutput(): TraceArcgisDependenciesOutput {
  const trace = traceOutput();
  const report = trace.report;
  const layer = report.nodes.find((node) => node.id === `item:${LAYER}`)!;
  layer.title = 'Layer <b>"quoted"</b> & co';
  report.nodes.push({
    id: `item:${MISSING}`,
    kind: 'item',
    item_id: MISSING,
    service_url: null,
    type: null,
    title: null,
    owner: null,
    access: 'unknown',
    support: 'missing',
    expanded: false,
    depth: 2,
    is_root: false,
    impact: { upstream_count: 1, downstream_count: 0 },
  });
  report.edges.push({ from: `item:${MAP}`, to: `item:${MISSING}`, relationship: 'operational_layer', locator: 'operationalLayers[].itemId' });
  report.unresolved_references.push(
    { from: `item:${MAP}`, locator: 'operationalLayers[].url', kind: 'service_url', reason: 'credential_bearing_url' },
    { from: `item:${MAP}`, locator: 'tables[].itemId', kind: 'item_id', reason: 'malformed_item_id' },
  );
  report.totals = { node_count: 5, edge_count: 4, item_node_count: 4, service_node_count: 1, request_count: 4 };
  report.warnings.push('item metadata was unavailable for one reference; node marked missing');
  return trace;
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
    report.change_ticket.derived_findings[0]!.statement,
    '2 direct supported-path references were observed from the locked Web Map; the case manifest requires at least 2 (a validated lower bound, not an exact expected total).',
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

  const svg = renderChangeRiskSvg(report, trace);
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

test('change ticket keeps observed, derived, human-entered, and unavailable facts structurally distinct', () => {
  const report = deriveChangeRiskReport(pilotCase(), richTraceOutput());
  const ticket = report.change_ticket;

  assert.ok(ticket.observed_facts.length >= 10);
  assert.ok(ticket.observed_facts.every((fact) => fact.evidence_class === 'observed' && fact.source.length > 0));
  assert.ok(ticket.derived_findings.every((finding) => finding.evidence_class === 'derived' && finding.derivation.length > 0));

  assert.deepEqual(ticket.human_entered_facts, []);
  assert.equal(ticket.human_entered_facts_note, HUMAN_ENTERED_FACTS_NOTE);

  assert.ok(ticket.unavailable_facts.every((fact) => fact.evidence_class === 'unavailable' && fact.status === 'unavailable'));
  const unavailableNames = ticket.unavailable_facts.map((fact) => fact.name);
  assert.ok(unavailableNames.includes('authenticated_owner_inventory'));
  assert.ok(unavailableNames.includes('human_operator_baseline'));
  assert.equal(ticket.operator_baseline.status, 'unavailable');
  assert.equal(ticket.operator_baseline.completed_by, null);
  assert.ok(ticket.operator_baseline.protocol.length >= 3);
  assert.match(ticket.next_action.description, /from the dymaxion-runtime directory/);
  assert.ok(!ticket.next_action.description.includes('repository root'));

  const classifications = new Set(ticket.affected_dependencies.map((row) => row.derived.classification));
  assert.deepEqual(
    [...classifications].sort(),
    ['missing_or_inaccessible', 'service_reference_leaf', 'supported_item', 'unsupported_item_type'],
  );
  const missingRow = ticket.affected_dependencies.find((row) => row.node_id === `item:${MISSING}`)!;
  assert.equal(missingRow.observed.support, 'missing');
  assert.equal(missingRow.derived.classification, 'missing_or_inaccessible');
  assert.equal(ticket.unresolved_references.length, 2);
  assert.equal(ticket.unresolved_references.filter((row) => row.derived.credential_rejected).length, 1);

  // Strictness: unknown keys and missing mandatory unavailable facts fail.
  assert.throws(() =>
    ChangeRiskReportSchema.parse({ ...report, change_ticket: { ...ticket, extra_field: true } }),
  );
  assert.throws(
    () =>
      ChangeRiskReportSchema.parse({
        ...report,
        change_ticket: {
          ...ticket,
          unavailable_facts: ticket.unavailable_facts.filter((fact) => fact.name !== 'human_operator_baseline'),
        },
      }),
    /human_operator_baseline/,
  );
  assert.throws(() =>
    ChangeRiskReportSchema.parse({
      ...report,
      change_ticket: {
        ...ticket,
        observed_facts: [{ ...ticket.observed_facts[0]!, evidence_class: 'derived' }],
      },
    }),
  );
  assert.throws(() =>
    ChangeRiskReportSchema.parse({
      ...report,
      change_ticket: {
        ...ticket,
        human_entered_facts: [
          { evidence_class: 'human_entered', name: 'claimed_time_saved', value: '50%', entered_by: 'unknown' },
        ],
      },
    }),
  );
  assert.throws(
    () =>
      ChangeRiskReportSchema.parse({
        ...report,
        change_ticket: { ...ticket, next_action: { ...ticket.next_action, command: 'rm -rf -- /' } },
      }),
    /code-owned rerun command/i,
  );
});

test('rerun command is exact, copy-ready, and free of secret placeholders', () => {
  const command = buildRerunCommand('juneau-old-public-gis');
  assert.equal(
    command,
    [
      'mkdir -p ../artifacts/arcgis-change-risk-records ../artifacts/arcgis-change-risk-root',
      'DYMAXION_CONFIG_DIR=../config \\',
      'DYMAXION_WORKSPACE_ROOT=.. \\',
      `DYMAXION_CREDENTIAL_IDENTITIES_JSON='{"export_evidence_bundle":"local-value-pilot-operator"}' \\`,
      'npx -y node@22.23.1 ./node_modules/tsx/dist/cli.mjs src/pilots/arcgis-change-risk-runner.ts \\',
      '  --case juneau-old-public-gis \\',
      '  --output-dir ../artifacts/arcgis-change-risk-records \\',
      '  --artifact-root ../artifacts/arcgis-change-risk-root \\',
      '  --approve-persist',
    ].join('\n'),
  );
  assert.ok(!/token|password|secret|api[_-]?key|YOUR_|<placeholder|xxxx/i.test(command));

  const report = deriveChangeRiskReport(pilotCase(), richTraceOutput());
  assert.equal(report.change_ticket.next_action.command, command);
});

test('runner source contains no literal NUL bytes', async () => {
  const source = await readFile(resolve('src/pilots/arcgis-change-risk-runner.ts'));
  assert.equal(source.includes(0), false);
});

test('dependency map SVG shows every node class and unresolved state with a legend, escaped and deterministic', () => {
  const trace = richTraceOutput();
  const report = deriveChangeRiskReport(pilotCase(), trace);
  const svg = renderChangeRiskSvg(report, trace);

  assert.equal(svg, renderChangeRiskSvg(deriveChangeRiskReport(pilotCase(), richTraceOutput()), richTraceOutput()));

  assert.ok(svg.includes('Supported item node (expanded by the trace) — 2'));
  assert.ok(svg.includes('Unsupported item type (present, not expanded) — 1'));
  assert.ok(svg.includes('Service-reference leaf (recorded, never contacted) — 1'));
  assert.ok(svg.includes('Missing/inaccessible item reference — 1'));
  assert.ok(svg.includes('Unresolved reference (kept visible; not a graph node) — 1'));
  assert.ok(svg.includes('Credential-rejected service reference (value removed, never dispatched) — 1'));

  assert.ok(svg.includes('credential-rejected reference'));
  assert.ok(svg.includes('credential_bearing_url'));
  assert.ok(svg.includes('malformed_item_id'));
  assert.ok(svg.includes('ROOT · item aaaaaaaa'));

  assert.ok(svg.includes('Layer &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &amp; co'));
  assert.ok(!svg.includes('<b>'));
  assert.ok(!/(<script|<foreignObject|on\w+=|xlink:href|href=|<!DOCTYPE|<style)/i.test(svg));

  const emojiTrace = richTraceOutput();
  emojiTrace.report.nodes.find((node) => node.id === `item:${LAYER}`)!.title = `${'x'.repeat(34)}😀 trailing`;
  const emojiSvg = renderChangeRiskSvg(deriveChangeRiskReport(pilotCase(), emojiTrace), emojiTrace);
  assert.ok(emojiSvg.includes(`${'x'.repeat(34)}😀…`));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(emojiSvg));
});

test('runner sinks reject contaminated service references before serialization without echo', () => {
  const cleanTrace = richTraceOutput();
  const cleanReport = deriveChangeRiskReport(pilotCase(), cleanTrace);
  const cleanSvg = renderChangeRiskSvg(cleanReport, cleanTrace);
  const cleanEvidence = buildPilotEvidence(cleanReport, cleanTrace, cleanSvg, NOW.toISOString());
  const marker = 'SERVICE_URL_CANARY';
  const badUrls = [
    `https://user:${marker}@services.arcgis.com/example/FeatureServer`,
    `https://services.arcgis.com/example/FeatureServer?token=${marker}`,
    `https://services.arcgis.com/example/FeatureServer#${marker}`,
    `https://services.arcgis.com/example/token=${marker}/FeatureServer`,
    `https://services.arcgis.com/example/token%3D${marker}/FeatureServer`,
    `https://services.arcgis.com/example/token%253D${marker}/FeatureServer`,
    `https://services.arcgis.com\\example\\token=${marker}\\FeatureServer`,
    `https://services.arcgis.com/safe/../${marker}/FeatureServer`,
    `https://services.arcgis.com/example/%ZZ${marker}/FeatureServer`,
    `https://services.arcgis.com/example/%2525252541${marker}/FeatureServer`,
  ];

  const contaminatedTrace = (serviceUrl: string): TraceArcgisDependenciesOutput => {
    const trace = structuredClone(cleanTrace);
    trace.report.nodes.find((node) => node.kind === 'service')!.service_url = serviceUrl;
    return trace;
  };
  const assertFixedNonEcho = (callback: () => unknown): void => {
    let caught: unknown;
    try {
      callback();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'trace contains an unsafe service reference');
    assert.ok(!JSON.stringify(caught).includes(marker));
  };

  for (const badUrl of badUrls) {
    assertFixedNonEcho(() => deriveChangeRiskReport(pilotCase(), contaminatedTrace(badUrl)));
  }

  const poisoned = contaminatedTrace(`https://services.arcgis.com/example/token%253D${marker}/FeatureServer`);
  assertFixedNonEcho(() => renderChangeRiskSvg(cleanReport, poisoned));
  assertFixedNonEcho(() => buildPilotEvidence(cleanReport, poisoned, cleanSvg, NOW.toISOString()));
  assertFixedNonEcho(() => buildExportInput(pilotCase(), cleanReport, poisoned, cleanEvidence, cleanSvg, 'preview'));

  const forgedReport = structuredClone(cleanReport);
  forgedReport.change_ticket.affected_dependencies.find((dependency) => dependency.observed.kind === 'service')!.observed.service_url =
    `https://services.arcgis.com/example/token=${marker}/FeatureServer`;
  const assertSchemaNonEcho = (callback: () => unknown): void => {
    let caught: unknown;
    try {
      callback();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /canonical, sanitized, and credential-free/i);
    assert.ok(!JSON.stringify(caught).includes(marker));
  };
  assertSchemaNonEcho(() => ChangeRiskReportSchema.parse(forgedReport));
  assertSchemaNonEcho(() => renderMarkdownRecord({ report: forgedReport } as never));
});

test('markdown packet contains all sections, the empty human-entered label, and the exact command block', async () => {
  const hostileRoot = 'Root before\n```bash\necho ROOT_SINK_CANARY\n```\nafter | root <b>';
  const hostileMap = 'Map before\n```bash\necho MARKDOWN_SINK_CANARY\n```\nafter | map <script>alert(1)</script>';
  const hostileOrg = 'Juneau | County <b>operator</b>';
  const hostileTrace = (): TraceArcgisDependenciesOutput => {
    const trace = richTraceOutput();
    trace.report.nodes.find((node) => node.id === `item:${APP}`)!.title = hostileRoot;
    trace.report.nodes.find((node) => node.id === `item:${MAP}`)!.title = hostileMap;
    return trace;
  };
  const fakeRunSkill = async (slug: string, input: Record<string, unknown>): Promise<SkillResult> => {
    if (slug === 'trace_arcgis_dependencies') return { ok: true, output: hostileTrace(), durationMs: 7, costUsd: 0 };
    const output = await executeCapability('export_evidence_bundle', input, { now: () => NOW, monotonicNow: () => 0 });
    return { ok: true, output, durationMs: 3, costUsd: 0 };
  };
  const record = await runPilotCase(pilotCase({ expected_root_title: hostileRoot, organization_name: hostileOrg }), {
    approvePersist: false,
    repeat: true,
    runSkillFn: fakeRunSkill,
    now: () => NOW,
  });
  const markdown = record.markdown;

  for (const heading of [
    '## Locked case and source identity',
    '## Decision summary and review posture',
    '## Observed facts (evidence class: observed)',
    '## Derived findings (evidence class: derived; deterministic)',
    '## Human-entered facts (evidence class: human_entered)',
    '## Unavailable facts (evidence class: unavailable)',
    '## Affected dependencies and owners',
    '### Unresolved references (kept visible)',
    '## Evidence, provenance and integrity',
    '## Operator baseline protocol (status: unavailable)',
    '## Limitations',
    '## Copy-ready next action',
  ]) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.ok(markdown.includes(`_${HUMAN_ENTERED_FACTS_NOTE}_`));
  assert.ok(markdown.includes('| authenticated_owner_inventory | `unavailable` |'));
  assert.ok(markdown.includes('| human_operator_baseline | `unavailable` |'));
  assert.ok(markdown.includes('credential_bearing_url'));
  assert.ok(markdown.includes('never contacted'));
  assert.ok(markdown.includes('Review posture: **retirement_cleanup**'));
  assert.ok(markdown.includes('```bash\n' + buildRerunCommand('juneau-old-public-gis') + '\n```'));
  // Hostile title cannot inject raw HTML or break the dependency table.
  assert.ok(markdown.includes('Layer &lt;b&gt;"quoted"&lt;/b&gt; &amp; co'));
  assert.ok(!markdown.includes('Layer <b>'));
  assert.ok(!markdown.includes('\n```bash\necho MARKDOWN_SINK_CANARY'));
  assert.ok(!markdown.includes('\n```bash\necho ROOT_SINK_CANARY'));
  assert.ok(markdown.includes('\\`\\`\\`bash'));
  assert.ok(markdown.includes('after \\| map &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(markdown.includes('Juneau \\| County &lt;b&gt;operator&lt;/b&gt;'));
  assert.ok(!markdown.includes('<script>'));
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
