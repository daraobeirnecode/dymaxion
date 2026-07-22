import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ExportEvidenceBundleInputSchema,
  ExportEvidenceBundleOutputSchema,
  type ExportEvidenceBundleInput,
  type ExportEvidenceBundleOutput,
} from '../capabilities/export-evidence-bundle.js';
import {
  TraceArcgisDependenciesOutputSchema,
  type TraceArcgisDependenciesOutput,
} from '../capabilities/trace-arcgis-dependencies.js';
import { validatePortalUrl } from '../capabilities/arcgis-rest.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import { EvidenceBundleSchema, type EvidenceBundle } from '../contracts/evidence.js';
import { type RunSkillDependencies, type SkillResult, runSkill as defaultRunSkill } from '../skills/executor.js';
import {
  InMemoryApprovalStore,
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
} from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';

const RUNNER_VERSION = '1.0.0';
const ITEM_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CASE_SLUGS = ['juneau-old-public-gis', 'la-county-cannabis-zones', 'tweed-planning-detail'] as const;
const SACRAMENTO_RE = /sacramento|saccity/i;

type CaseSlug = (typeof CASE_SLUGS)[number];

function publicArcgisOnlinePortalRootProblem(raw: string): string | null {
  const sharedProblem = validatePortalUrl(raw);
  if (sharedProblem) return sharedProblem;
  const authority = raw.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes(':')) {
    return 'pilot portal_url must be an ArcGIS Online organization root with no explicit port';
  }
  const url = new URL(raw);
  if (!url.hostname.toLowerCase().endsWith('.maps.arcgis.com')) {
    return 'pilot cases must use public ArcGIS Online organization roots';
  }
  if (url.port || url.pathname !== '/') {
    return 'pilot portal_url must be an ArcGIS Online organization root with no path or port';
  }
  return null;
}

export const ArcgisChangeRiskCaseSchema = z
  .object({
    slug: z.enum(CASE_SLUGS),
    project_id: z.string().regex(UUID_RE),
    portal_url: z.string().url().max(2_048),
    org_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    organization_name: z.string().min(1).max(160),
    root_item_id: z.string().regex(ITEM_ID_RE),
    expected_root_title: z.string().min(1).max(300),
    expected_web_map_id: z.string().regex(ITEM_ID_RE),
    expected_minimum_direct_reference_count: z.number().int().nonnegative().max(1_000),
    review_posture: z.enum(['retirement_cleanup', 'change_review']),
  })
  .strict()
  .superRefine((item, context) => {
    if (SACRAMENTO_RE.test(`${item.portal_url} ${item.organization_name} ${item.expected_root_title}`)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_url'], message: 'Sacramento targets are not allowed in this pilot' });
    }
    const portalProblem = publicArcgisOnlinePortalRootProblem(item.portal_url);
    if (portalProblem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_url'], message: portalProblem });
    }
  });

export const ArcgisChangeRiskCaseManifestSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    cases: z.array(ArcgisChangeRiskCaseSchema).length(CASE_SLUGS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    const slugs = manifest.cases.map((item) => item.slug).sort();
    for (const [index, item] of manifest.cases.entries()) {
      if (seen.has(item.slug)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', index, 'slug'], message: 'duplicate case slug' });
      }
      seen.add(item.slug);
    }
    if (slugs.join('\n') !== [...CASE_SLUGS].sort().join('\n')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'case manifest must contain exactly the locked pilot case IDs' });
    }
  });

const CountSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const PilotMetricSchema = z
  .object({
    node_count: CountSchema,
    edge_count: CountSchema,
    item_node_count: CountSchema,
    service_node_count: CountSchema,
    owner_count: CountSchema,
    missing_node_count: CountSchema,
    unresolved_reference_count: CountSchema,
    cycle_count: CountSchema,
    warning_count: CountSchema,
    request_count: CountSchema,
    response_bytes: CountSchema,
    direct_web_map_reference_count: CountSchema,
    truncated: z.boolean(),
    truncation_reasons: z.array(z.string()),
  })
  .strict();

export const ChangeRiskReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    runner: z.object({ name: z.literal('arcgis-change-risk-value-pilot'), version: z.literal(RUNNER_VERSION) }).strict(),
    case: z
      .object({
        slug: z.enum(CASE_SLUGS),
        project_id: z.string().regex(UUID_RE),
        organization_name: z.string().min(1),
        org_id: z.string().min(1),
        portal_url: z.string().url(),
        review_posture: z.enum(['retirement_cleanup', 'change_review']),
      })
      .strict(),
    locked_identity: z
      .object({
        root_item_id: z.string().regex(ITEM_ID_RE),
        root_title: z.string().min(1),
        web_map_id: z.string().regex(ITEM_ID_RE),
        web_map_title: z.string().min(1).nullable(),
      })
      .strict(),
    review_scope: z
      .object({
        band: z.enum(['small', 'medium', 'large', 'very_large']),
        supporting_edge_count: CountSchema,
        basis: z.array(z.string().min(1)).min(1),
        disclaimer: z.literal('Descriptive review-scope proxy only; not a probability, severity, or operational-risk score.'),
      })
      .strict(),
    metrics: PilotMetricSchema,
    hashes: z
      .object({
        trace_report_sha256: Sha256Schema,
        trace_structure_sha256: Sha256Schema,
        trace_evidence_sha256: Sha256Schema,
      })
      .strict(),
    deterministic_samples: z.array(
      z
        .object({ from: z.string().min(1), to: z.string().min(1), relationship: z.string().min(1), locator: z.string().min(1), reference: z.string().min(1) })
        .strict(),
    ).max(3),
    findings: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const PilotCaseRecordSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    case_slug: z.enum(CASE_SLUGS),
    trace: z.object({ ok: z.boolean(), duration_ms: CountSchema }).strict(),
    export_preview: z
      .object({ ok: z.boolean(), duration_ms: CountSchema, archive_sha256: Sha256Schema, archive_bytes: CountSchema })
      .strict(),
    export_persist: z
      .object({ ok: z.boolean(), duration_ms: CountSchema, created: z.boolean(), handle: z.string().min(1), archive_sha256: Sha256Schema, archive_bytes: CountSchema, read_back_verified: z.boolean() })
      .strict()
      .nullable(),
    repeat: z
      .object({
        trace_report_hash_matches: z.boolean(),
        trace_structure_hash_matches: z.boolean(),
        preview_archive_hash_matches: z.boolean(),
        second_trace_report_sha256: Sha256Schema,
        second_trace_structure_sha256: Sha256Schema,
        second_preview_archive_sha256: Sha256Schema,
        second_trace_duration_ms: CountSchema,
        second_preview_duration_ms: CountSchema,
        explanation: z.string().min(1),
      })
      .strict()
      .nullable(),
    report: ChangeRiskReportSchema,
    markdown: z.string().min(1),
  })
  .strict();

export type ArcgisChangeRiskCase = z.infer<typeof ArcgisChangeRiskCaseSchema>;
export type ArcgisChangeRiskCaseManifest = z.infer<typeof ArcgisChangeRiskCaseManifestSchema>;
export type ChangeRiskReport = z.infer<typeof ChangeRiskReportSchema>;
export type PilotCaseRecord = z.infer<typeof PilotCaseRecordSchema>;

type RunSkillFn = (
  slug: string,
  input: Record<string, unknown>,
  agentRunId: string,
  dependencies?: Partial<RunSkillDependencies>,
) => Promise<SkillResult>;

export interface PilotRunnerOptions {
  approvePersist: boolean;
  artifactRoot?: string;
  outputDir?: string;
  agentRunId?: string;
  repeat?: boolean;
  runSkillFn?: RunSkillFn;
  now?: () => Date;
  dependencies?: Partial<RunSkillDependencies>;
}

export interface VerifiedPersistedArchive {
  path: string;
  sha256: string;
  bytes: number;
}

function normalizePortalUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/$/, '')}`;
}

function traceOutputFromResult(result: SkillResult): TraceArcgisDependenciesOutput {
  if (!result.ok) throw new Error(`trace_arcgis_dependencies failed: ${result.error ?? 'unknown error'}`);
  return TraceArcgisDependenciesOutputSchema.parse(result.output);
}

function exportOutputFromResult(result: SkillResult, operation: 'preview' | 'persist'): ExportEvidenceBundleOutput {
  if (!result.ok) throw new Error(`export_evidence_bundle ${operation} failed: ${result.error ?? 'unknown error'}`);
  return ExportEvidenceBundleOutputSchema.parse(result.output);
}

function nodeLabel(node: TraceArcgisDependenciesOutput['report']['nodes'][number]): string {
  return node.item_id ?? node.service_url ?? node.id;
}

export function validateLockedCaseAgainstTrace(
  pilotCase: ArcgisChangeRiskCase,
  trace: TraceArcgisDependenciesOutput,
): void {
  const report = trace.report;
  if (normalizePortalUrl(report.portal.url) !== normalizePortalUrl(pilotCase.portal_url)) {
    throw new Error(`case '${pilotCase.slug}' portal identity changed`);
  }
  const rootId = `item:${pilotCase.root_item_id}`;
  const mapId = `item:${pilotCase.expected_web_map_id}`;
  const byId = new Map(report.nodes.map((node) => [node.id, node]));
  const root = byId.get(rootId);
  if (!root || root.kind !== 'item' || root.item_id !== pilotCase.root_item_id || !root.is_root) {
    throw new Error(`case '${pilotCase.slug}' locked root item is missing from the dependency graph`);
  }
  if (root.type !== 'Web Mapping Application') {
    throw new Error(`case '${pilotCase.slug}' locked root is no longer a Web Mapping Application`);
  }
  if (root.title !== pilotCase.expected_root_title) {
    throw new Error(`case '${pilotCase.slug}' locked root title changed`);
  }
  const webMap = byId.get(mapId);
  if (!webMap || webMap.kind !== 'item' || webMap.item_id !== pilotCase.expected_web_map_id) {
    throw new Error(`case '${pilotCase.slug}' locked Web Map is missing from the dependency graph`);
  }
  if (webMap.type !== 'Web Map') {
    throw new Error(`case '${pilotCase.slug}' locked Web Map item type changed`);
  }
  if (!report.edges.some((edge) => edge.from === rootId && edge.to === mapId && edge.relationship === 'web_map')) {
    throw new Error(`case '${pilotCase.slug}' locked app→Web Map edge is missing`);
  }
  const directReferenceCount = report.edges.filter((edge) => edge.from === mapId).length;
  if (directReferenceCount < pilotCase.expected_minimum_direct_reference_count) {
    throw new Error(`case '${pilotCase.slug}' direct Web Map reference count fell below the validated minimum`);
  }
}

function reviewScopeBand(edgeCount: number): ChangeRiskReport['review_scope']['band'] {
  if (edgeCount > 75) return 'very_large';
  if (edgeCount > 30) return 'large';
  if (edgeCount > 10) return 'medium';
  return 'small';
}

export function traceStructureSha256(trace: TraceArcgisDependenciesOutput): string {
  const stableReport = structuredClone(trace.report);
  stableReport.retrieved_at = '1970-01-01T00:00:00.000Z';
  return sha256Canonical(stableReport);
}

export function deriveChangeRiskReport(
  pilotCase: ArcgisChangeRiskCase,
  trace: TraceArcgisDependenciesOutput,
): ChangeRiskReport {
  validateLockedCaseAgainstTrace(pilotCase, trace);
  const report = trace.report;
  const root = report.nodes.find((node) => node.id === `item:${pilotCase.root_item_id}`)!;
  const webMap = report.nodes.find((node) => node.id === `item:${pilotCase.expected_web_map_id}`)!;
  const owners = [...new Set(report.nodes.flatMap((node) => (node.owner ? [node.owner] : [])))].sort();
  const missingNodeCount = report.nodes.filter((node) => node.support === 'missing' || node.support === 'unfetched').length;
  const directWebMapReferences = report.edges.filter((edge) => edge.from === `item:${pilotCase.expected_web_map_id}`);
  const responseBytes = (trace.evidence.requests ?? []).reduce((sum, request) => sum + request.bytes, 0);
  const basis = [
    `${report.totals.edge_count} supported dependency edges and ${report.totals.service_node_count} sanitized service leaves require human review before change.`,
    `${owners.length} visible owner reference${owners.length === 1 ? '' : 's'} ${owners.length === 1 ? 'appears' : 'appear'} in public item metadata; this is not authenticated owner inventory.`,
  ];
  if (missingNodeCount || report.unresolved_references.length) {
    basis.push(`${missingNodeCount} missing/unfetched nodes and ${report.unresolved_references.length} unresolved references reduce confidence.`);
  }
  if (report.truncation.truncated) {
    basis.push('The dependency trace was truncated, so the review cannot claim complete supported-path coverage.');
  }
  const findings = [
    `${directWebMapReferences.length} direct supported references were observed from the locked Web Map; manifest minimum was ${pilotCase.expected_minimum_direct_reference_count}.`,
    report.totals.service_node_count === 0
      ? 'No service leaves were found through supported paths.'
      : `${report.totals.service_node_count} item-provided service URL leaves were sanitized and not contacted.`,
    report.cycles.length === 0 ? 'No dependency cycles were reported.' : `${report.cycles.length} dependency cycle(s) were reported.`,
    report.truncation.truncated ? `Trace truncated: ${report.truncation.reasons.join('; ')}` : 'Trace completed without truncation.',
  ];
  const sortedSamples = [...report.edges]
    .sort((a, b) => `${a.relationship}\u0000${a.from}\u0000${a.to}\u0000${a.locator}`.localeCompare(`${b.relationship}\u0000${b.from}\u0000${b.to}\u0000${b.locator}`))
    .slice(0, 3)
    .map((edge) => {
      const node = report.nodes.find((candidate) => candidate.id === edge.to);
      return {
        from: edge.from,
        to: edge.to,
        relationship: edge.relationship,
        locator: edge.locator,
        reference: node ? nodeLabel(node) : edge.to,
      };
    });

  return ChangeRiskReportSchema.parse({
    schema_version: '1.0.0',
    runner: { name: 'arcgis-change-risk-value-pilot', version: RUNNER_VERSION },
    case: {
      slug: pilotCase.slug,
      project_id: pilotCase.project_id,
      organization_name: pilotCase.organization_name,
      org_id: pilotCase.org_id,
      portal_url: normalizePortalUrl(pilotCase.portal_url),
      review_posture: pilotCase.review_posture,
    },
    locked_identity: {
      root_item_id: pilotCase.root_item_id,
      root_title: root.title ?? pilotCase.expected_root_title,
      web_map_id: pilotCase.expected_web_map_id,
      web_map_title: webMap.title,
    },
    review_scope: {
      band: reviewScopeBand(report.totals.edge_count),
      supporting_edge_count: report.totals.edge_count,
      basis,
      disclaimer: 'Descriptive review-scope proxy only; not a probability, severity, or operational-risk score.',
    },
    metrics: {
      node_count: report.totals.node_count,
      edge_count: report.totals.edge_count,
      item_node_count: report.totals.item_node_count,
      service_node_count: report.totals.service_node_count,
      owner_count: owners.length,
      missing_node_count: missingNodeCount,
      unresolved_reference_count: report.unresolved_references.length,
      cycle_count: report.cycles.length,
      warning_count: report.warnings.length,
      request_count: report.totals.request_count,
      response_bytes: responseBytes,
      direct_web_map_reference_count: directWebMapReferences.length,
      truncated: report.truncation.truncated,
      truncation_reasons: report.truncation.reasons,
    },
    hashes: {
      trace_report_sha256: sha256Canonical(report),
      trace_structure_sha256: traceStructureSha256(trace),
      trace_evidence_sha256: sha256Canonical(trace.evidence),
    },
    deterministic_samples: sortedSamples,
    findings,
    limitations: [
      'This pilot traces only documented Web Mapping Application → Web Map → item/service paths supported by trace_arcgis_dependencies.',
      'It does not query authenticated organization users, private inventory, reverse dependencies, or item-provided service URLs.',
      'Visible owners come only from public ArcGIS item metadata in the bounded dependency graph.',
      'A technical run is not a time-saved, cost-saved, or customer-value claim without a human baseline.',
    ],
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function svgText(x: number, y: number, value: string, size = 16, weight = 400): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" font-family="Arial, sans-serif" fill="#111827">${xmlEscape(value)}</text>`;
}

export function renderChangeRiskSvg(report: ChangeRiskReport): string {
  const width = 960;
  const height = 540;
  const maxMetric = Math.max(1, report.metrics.edge_count, report.metrics.service_node_count, report.metrics.owner_count, report.metrics.unresolved_reference_count + report.metrics.missing_node_count);
  const bars = [
    ['Edges', report.metrics.edge_count, '#2563eb'],
    ['Service leaves', report.metrics.service_node_count, '#7c3aed'],
    ['Visible owners', report.metrics.owner_count, '#059669'],
    ['Missing/unresolved', report.metrics.missing_node_count + report.metrics.unresolved_reference_count, '#dc2626'],
  ] as const;
  const barMarkup = bars.map(([label, value, color], index) => {
    const y = 190 + index * 54;
    const barWidth = Math.round((value / maxMetric) * 420);
    return [
      svgText(74, y + 21, `${label}: ${value}`, 15),
      `<rect x="250" y="${y}" width="420" height="26" rx="8" fill="#e5e7eb"/>`,
      `<rect x="250" y="${y}" width="${barWidth}" height="26" rx="8" fill="${color}"/>`,
    ].join('');
  }).join('');
  const warning = report.metrics.truncated
    ? `Truncated: ${report.metrics.truncation_reasons.join('; ')}`
    : 'No trace truncation reported.';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xmlEscape(report.case.slug)} ArcGIS change-risk summary</title>
<desc id="desc">Deterministic pilot summary for ${xmlEscape(report.locked_identity.root_title)}. Service URLs are sanitized references and are not contacted.</desc>
<rect width="960" height="540" fill="#f8fafc"/>
<rect x="40" y="36" width="880" height="468" rx="22" fill="#ffffff" stroke="#cbd5e1"/>
${svgText(74, 84, 'ArcGIS change-risk value pilot', 24, 700)}
${svgText(74, 116, report.locked_identity.root_title, 18, 700)}
${svgText(74, 144, `${report.case.organization_name} · ${report.case.review_posture.replace(/_/g, ' ')}`, 15)}
<circle cx="810" cy="104" r="58" fill="#111827"/>
${svgText(765, 97, report.review_scope.band.toUpperCase(), 13, 700).replace('fill="#111827"', 'fill="#ffffff"')}
${svgText(779, 124, `${report.review_scope.supporting_edge_count} edges`, 16, 700).replace('fill="#111827"', 'fill="#ffffff"')}
${barMarkup}
${svgText(74, 430, warning, 14, 700)}
${svgText(74, 456, 'Limitations: supported dependency paths only; no authenticated inventory; no reverse dependency search.', 13)}
${svgText(74, 482, `Trace report SHA-256: ${report.hashes.trace_report_sha256.slice(0, 16)}…`, 13)}
</svg>`;
  if (/(<script|<foreignObject|on\w+=|xlink:href|href=|<!DOCTYPE|<style)/i.test(svg)) {
    throw new Error('generated SVG failed forbidden-construct scan');
  }
  return svg;
}

export function buildPilotEvidence(
  report: ChangeRiskReport,
  trace: TraceArcgisDependenciesOutput,
  svg: string,
  generatedAt: string,
): EvidenceBundle {
  const traceReportJson = canonicalJson(trace.report);
  const traceReportBytes = Buffer.byteLength(traceReportJson, 'utf8');
  const traceEvidenceJson = canonicalJson(trace.evidence);
  const traceEvidenceSha = sha256Text(traceEvidenceJson);
  const traceEvidenceBytes = Buffer.byteLength(traceEvidenceJson, 'utf8');
  const artifactBytes = Buffer.byteLength(svg, 'utf8');
  const artifactSha = sha256Text(svg);
  const parametersJson = canonicalJson({
    case_slug: report.case.slug,
    root_item_id: report.locked_identity.root_item_id,
    web_map_id: report.locked_identity.web_map_id,
    trace_report_sha256: report.hashes.trace_report_sha256,
    artifact_sha256: artifactSha,
    runner_version: RUNNER_VERSION,
  });
  return EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `arcgis_change_risk_value_pilot:${report.case.slug}:${artifactSha.slice(0, 16)}`,
    generated_at: generatedAt,
    source: {
      uri: `dymaxion:inline-trace-report:${report.hashes.trace_report_sha256}`,
      identity: { kind: 'arcgis_dependency_trace_report', value: report.hashes.trace_report_sha256 },
      version: {},
      retrieved_at: trace.report.retrieved_at,
      sha256: report.hashes.trace_report_sha256,
      bytes: traceReportBytes,
    },
    related_sources: [
      {
        role: 'trace_evidence',
        uri: `dymaxion:inline-trace-evidence:${traceEvidenceSha}`,
        identity: { kind: 'arcgis_dependency_trace_evidence', value: traceEvidenceSha },
        version: {},
        retrieved_at: trace.evidence.generated_at,
        sha256: traceEvidenceSha,
        bytes: traceEvidenceBytes,
      },
    ],
    gis_metadata: {
      format: 'ArcGIS dependency change-risk pilot',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: report.metrics.node_count,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: { canonical_json: parametersJson, sha256: sha256Text(parametersJson) },
    execution: {
      capability: 'arcgis_change_risk_value_pilot',
      capability_version: RUNNER_VERSION,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'arcgis_change_risk_svg',
        sha256: artifactSha,
        bytes: artifactBytes,
        validation: { valid: true, checks: ['deterministic closed-primitive SVG generated and hash-bound'], warnings: report.metrics.truncated ? ['dependency trace was truncated'] : [] },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
}

export function buildExportInput(
  pilotCase: ArcgisChangeRiskCase,
  report: ChangeRiskReport,
  trace: TraceArcgisDependenciesOutput,
  evidence: EvidenceBundle,
  svg: string,
  operation: 'preview' | 'persist',
  targetBundleSha256?: string,
): ExportEvidenceBundleInput {
  return ExportEvidenceBundleInputSchema.parse({
    operation,
    project_id: pilotCase.project_id,
    bundle_slug: `${pilotCase.slug}-change-risk`,
    report: {
      schema_version: '1.0.0',
      review: structuredClone(report),
      trace_report: structuredClone(trace.report),
      trace_evidence: structuredClone(trace.evidence),
    },
    evidence,
    artifact: {
      output_name: 'arcgis_change_risk_svg',
      file_name: `${pilotCase.slug}-change-risk.svg`,
      media_type: 'image/svg+xml; charset=utf-8',
      content: svg,
    },
    ...(targetBundleSha256 ? { target_bundle_sha256: targetBundleSha256 } : {}),
  });
}

export function renderMarkdownRecord(record: Omit<PilotCaseRecord, 'markdown'>): string {
  const lines = [
    `# ${record.case_slug} change-risk pilot record`,
    '',
    `- Review-scope proxy: **${record.report.review_scope.band}** (${record.report.review_scope.supporting_edge_count} supporting edges; not an operational-risk score)`,
    `- Root item: \`${record.report.locked_identity.root_item_id}\` — ${record.report.locked_identity.root_title}`,
    `- Web Map: \`${record.report.locked_identity.web_map_id}\`${record.report.locked_identity.web_map_title ? ` — ${record.report.locked_identity.web_map_title}` : ''}`,
    `- Nodes/edges: ${record.report.metrics.node_count}/${record.report.metrics.edge_count}`,
    `- Service leaves: ${record.report.metrics.service_node_count}`,
    `- Visible owners: ${record.report.metrics.owner_count}`,
    `- Trace requests/bytes: ${record.report.metrics.request_count}/${record.report.metrics.response_bytes}`,
    `- Trace report hash: \`${record.report.hashes.trace_report_sha256}\``,
    `- Preview ZIP: \`${record.export_preview.archive_sha256}\` (${record.export_preview.archive_bytes} bytes)`,
    `- Persisted ZIP: ${record.export_persist ? `\`${record.export_persist.archive_sha256}\` (${record.export_persist.archive_bytes} bytes, read-back ${record.export_persist.read_back_verified})` : 'not requested'}`,
    '',
    '## Findings',
    ...record.report.findings.map((finding) => `- ${finding}`),
    '',
    '## Limitations',
    ...record.report.limitations.map((limitation) => `- ${limitation}`),
  ];
  return `${lines.join('\n')}\n`;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function loadCaseManifest(path: string): Promise<ArcgisChangeRiskCaseManifest> {
  return ArcgisChangeRiskCaseManifestSchema.parse(await readJsonFile(path));
}

async function ensureTrustedRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new Error('trusted artifact root must be an existing directory');
  return realpath(absolute);
}

async function verifyPersistedArchive(
  trustedRoot: string,
  projectId: string,
  archiveSha256: string,
  expectedBytes: number,
): Promise<VerifiedPersistedArchive> {
  const root = await ensureTrustedRoot(trustedRoot);
  const archivePath = join(root, 'projects', projectId, 'artifacts', archiveSha256, 'bundle.zip');
  const resolved = resolve(archivePath);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error('persisted archive path escaped trusted root');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('persisted archive is not a regular file');
    if (info.size !== expectedBytes) throw new Error('persisted archive byte count mismatch');
    const bytes = await handle.readFile();
    const sha256 = sha256Text(bytes);
    if (sha256 !== archiveSha256) throw new Error('persisted archive hash mismatch');
    return { path: resolved, sha256, bytes: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

async function safeWriteRecord(outputDir: string, slug: CaseSlug, json: string, markdown: string): Promise<void> {
  const root = resolve(outputDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  for (const [suffix, content] of [['json', json], ['md', markdown]] as const) {
    const target = resolve(realRoot, `${slug}.${suffix}`);
    if (!target.startsWith(`${realRoot}${sep}`)) throw new Error('record output path escaped output directory');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

function baseDependencies(now: () => Date, overrides: Partial<RunSkillDependencies> = {}): Partial<RunSkillDependencies> {
  let invocationSequence = 0;
  return {
    recorder: {
      begin: async () => `pilot-invocation-${sha256Text(now().toISOString()).slice(0, 12)}-${++invocationSequence}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: { now },
    ...overrides,
  };
}

export async function runPilotCase(
  pilotCase: ArcgisChangeRiskCase,
  options: PilotRunnerOptions,
): Promise<PilotCaseRecord> {
  const runSkillFn = options.runSkillFn ?? defaultRunSkill;
  const now = options.now ?? (() => new Date());
  const agentRunId = options.agentRunId ?? `arcgis-change-risk-${pilotCase.slug}`;
  const dependencies = baseDependencies(now, options.dependencies);
  const traceInput = {
    portal_url: pilotCase.portal_url,
    root_item_ids: [pilotCase.root_item_id],
    max_depth: 4,
    max_nodes: 200,
    max_edges: 400,
    max_requests: 200,
  };
  const traceResult = await runSkillFn('trace_arcgis_dependencies', traceInput, agentRunId, dependencies);
  const trace = traceOutputFromResult(traceResult);
  const report = deriveChangeRiskReport(pilotCase, trace);
  const svg = renderChangeRiskSvg(report);
  const generatedAt = now().toISOString();
  const evidence = buildPilotEvidence(report, trace, svg, generatedAt);
  const previewInput = buildExportInput(pilotCase, report, trace, evidence, svg, 'preview');
  const previewResult = await runSkillFn('export_evidence_bundle', previewInput as Record<string, unknown>, agentRunId, dependencies);
  const preview = exportOutputFromResult(previewResult, 'preview');

  let persist: ExportEvidenceBundleOutput | null = null;
  let persistDurationMs = 0;
  if (options.approvePersist) {
    if (!options.artifactRoot) throw new Error('--artifact-root is required with --approve-persist');
    const trustedRoot = await ensureTrustedRoot(options.artifactRoot);
    const persistInput = buildExportInput(pilotCase, report, trace, evidence, svg, 'persist', preview.archive.sha256);
    const store = new InMemoryApprovalStore();
    const credentialIdentity = resolveExecutionCredentialIdentity('export_evidence_bundle');
    const target = deriveApprovalTarget('export_evidence_bundle', persistInput as Record<string, unknown>);
    const approvalRequest = await createApprovalRequest(
      agentRunId,
      `Persist ArcGIS change-risk evidence bundle for ${pilotCase.slug}`,
      persistInput as Record<string, unknown>,
      { timeoutMinutes: 15, target, credentialIdentity },
      { store, now },
    );
    const approved = await decideApproval(approvalRequest.id, 'approved', 'local-operator', { store, now });
    if (!approved) throw new Error('local approval could not be recorded');
    const previousRoot = process.env.DYMAXION_ARTIFACT_ROOT;
    process.env.DYMAXION_ARTIFACT_ROOT = trustedRoot;
    try {
      const persistDeps = baseDependencies(now, {
        ...options.dependencies,
        approvalRequest,
        approvalDependencies: { store, now },
        capabilityContext: { ...(options.dependencies?.capabilityContext ?? {}), now },
      });
      const persistResult = await runSkillFn('export_evidence_bundle', persistInput as Record<string, unknown>, agentRunId, persistDeps);
      persistDurationMs = persistResult.durationMs;
      persist = exportOutputFromResult(persistResult, 'persist');
      await verifyPersistedArchive(trustedRoot, pilotCase.project_id, persist.archive.sha256, persist.archive.bytes);
    } finally {
      if (previousRoot === undefined) delete process.env.DYMAXION_ARTIFACT_ROOT;
      else process.env.DYMAXION_ARTIFACT_ROOT = previousRoot;
    }
  }

  let repeat: PilotCaseRecord['repeat'] = null;
  if (options.repeat !== false) {
    const repeatAgentRunId = `${agentRunId}-repeat`;
    const repeatTraceResult = await runSkillFn('trace_arcgis_dependencies', traceInput, repeatAgentRunId, dependencies);
    const repeatTrace = traceOutputFromResult(repeatTraceResult);
    const repeatReport = deriveChangeRiskReport(pilotCase, repeatTrace);
    const repeatSvg = renderChangeRiskSvg(repeatReport);
    const repeatEvidence = buildPilotEvidence(repeatReport, repeatTrace, repeatSvg, now().toISOString());
    const repeatPreviewInput = buildExportInput(pilotCase, repeatReport, repeatTrace, repeatEvidence, repeatSvg, 'preview');
    const repeatPreviewResult = await runSkillFn('export_evidence_bundle', repeatPreviewInput as Record<string, unknown>, repeatAgentRunId, dependencies);
    const repeatPreview = exportOutputFromResult(repeatPreviewResult, 'preview');
    const traceReportHashMatches = repeatReport.hashes.trace_report_sha256 === report.hashes.trace_report_sha256;
    const traceStructureHashMatches = repeatReport.hashes.trace_structure_sha256 === report.hashes.trace_structure_sha256;
    const previewArchiveHashMatches = repeatPreview.archive.sha256 === preview.archive.sha256;
    repeat = {
      trace_report_hash_matches: traceReportHashMatches,
      trace_structure_hash_matches: traceStructureHashMatches,
      preview_archive_hash_matches: previewArchiveHashMatches,
      second_trace_report_sha256: repeatReport.hashes.trace_report_sha256,
      second_trace_structure_sha256: repeatReport.hashes.trace_structure_sha256,
      second_preview_archive_sha256: repeatPreview.archive.sha256,
      second_trace_duration_ms: repeatTraceResult.durationMs,
      second_preview_duration_ms: repeatPreviewResult.durationMs,
      explanation: traceStructureHashMatches
        ? traceReportHashMatches && previewArchiveHashMatches
          ? 'Exact report and archive hashes matched across two independent public ArcGIS traces.'
          : 'Graph structure matched; full report or archive hashes varied because retrieval timestamps and request evidence are run-specific.'
        : 'Public ArcGIS graph structure changed between traces; inspect both runs before relying on the review.',
    };
  }
  const recordWithoutMarkdown = {
    schema_version: '1.0.0' as const,
    case_slug: pilotCase.slug,
    trace: { ok: true, duration_ms: traceResult.durationMs },
    export_preview: { ok: true, duration_ms: previewResult.durationMs, archive_sha256: preview.archive.sha256, archive_bytes: preview.archive.bytes },
    export_persist: persist
      ? { ok: true, duration_ms: persistDurationMs, created: persist.created, handle: persist.handle, archive_sha256: persist.archive.sha256, archive_bytes: persist.archive.bytes, read_back_verified: persist.archive.read_back_verified }
      : null,
    repeat,
    report,
  };
  const markdown = renderMarkdownRecord(recordWithoutMarkdown);
  const record = PilotCaseRecordSchema.parse({ ...recordWithoutMarkdown, markdown });
  if (options.outputDir) {
    const jsonRecord = { ...record };
    delete (jsonRecord as { markdown?: string }).markdown;
    await safeWriteRecord(options.outputDir, pilotCase.slug, `${canonicalJson(jsonRecord)}\n`, markdown);
  }
  return record;
}

export async function runPilotManifest(
  manifest: ArcgisChangeRiskCaseManifest,
  selectedSlugs: readonly string[],
  options: PilotRunnerOptions,
): Promise<PilotCaseRecord[]> {
  const allowed = selectedSlugs.length ? new Set(selectedSlugs) : new Set(CASE_SLUGS);
  for (const slug of allowed) {
    if (!CASE_SLUGS.includes(slug as CaseSlug)) throw new Error(`unexpected case id '${slug}'`);
  }
  const records: PilotCaseRecord[] = [];
  for (const pilotCase of manifest.cases.filter((item) => allowed.has(item.slug))) {
    records.push(await runPilotCase(pilotCase, options));
  }
  return records;
}

function defaultCasesPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/pilots/arcgis-change-risk/cases.json');
}

function parseArgs(argv: string[]): { casesPath: string; selected: string[]; options: PilotRunnerOptions } {
  const selected: string[] = [];
  let casesPath = defaultCasesPath();
  const options: PilotRunnerOptions = { approvePersist: false, repeat: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--cases') casesPath = next();
    else if (arg === '--case') selected.push(...next().split(',').filter(Boolean));
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--artifact-root') options.artifactRoot = next();
    else if (arg === '--approve-persist') options.approvePersist = true;
    else if (arg === '--no-repeat') options.repeat = false;
    else if (arg === '--help') {
      console.log('Usage: tsx src/pilots/arcgis-change-risk-runner.ts [--cases path] [--case slug[,slug]] [--output-dir dir] [--artifact-root existing-dir --approve-persist]');
      process.exit(0);
    } else throw new Error(`unknown argument '${arg}'`);
  }
  return { casesPath, selected, options };
}

async function main(): Promise<void> {
  const { casesPath, selected, options } = parseArgs(process.argv.slice(2));
  const manifest = await loadCaseManifest(casesPath);
  const records = await runPilotManifest(manifest, selected, options);
  for (const record of records) {
    console.log(canonicalJson({
      case_slug: record.case_slug,
      review_scope: record.report.review_scope,
      preview_archive_sha256: record.export_preview.archive_sha256,
      persisted: record.export_persist !== null,
      persisted_archive_sha256: record.export_persist?.archive_sha256 ?? null,
      trace_report_sha256: record.report.hashes.trace_report_sha256,
    }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
