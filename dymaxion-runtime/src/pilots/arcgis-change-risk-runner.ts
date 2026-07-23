// Locked three-case ArcGIS change-risk value pilot. The deterministic packet
// construction (ticket sections, SVG, evidence, markdown tables) lives in
// src/workflows/change-risk-packet-core.ts and is shared with the
// agent-callable arcgis_change_risk_packet workflow; this module owns the
// locked case manifest, locked-identity validation, pilot report/record
// schemas, and the pilot CLI/persist flow. Pilot output remains byte-identical
// to the reviewed release.

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
import { canonicalJson, sha256Text } from '../contracts/canonical.js';
import { type EvidenceBundle } from '../contracts/evidence.js';
import { type RunSkillDependencies, type SkillResult, runSkill as defaultRunSkill } from '../skills/executor.js';
import {
  InMemoryApprovalStore,
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
} from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';
import {
  ChangeTicketSchema,
  CountSchema,
  DeterministicSamplesSchema,
  HUMAN_ENTERED_FACTS_NOTE,
  ITEM_ID_RE,
  PILOT_WORDING,
  PacketMetricSchema,
  REVIEW_SCOPE_DISCLAIMER,
  ReviewScopeSchema,
  SACRAMENTO_RE,
  Sha256Schema,
  UUID_RE,
  assertSanitizedTraceServiceReferences,
  buildPacketEvidence,
  classifyDependencyNode,
  decisionSummarySectionLines,
  deriveChangeTicketCore,
  limitationsSectionLines,
  mdCell,
  nextActionSectionLines,
  normalizePortalUrl,
  operatorBaselineSectionLines,
  publicArcgisOnlineOrgRootProblem,
  renderDependencyMapSvg,
  sanitizedServiceReferenceProblem,
  ticketFactSectionLines,
  traceStructureSha256,
} from '../workflows/change-risk-packet-core.js';

export {
  HUMAN_ENTERED_FACTS_NOTE,
  classifyDependencyNode,
  traceStructureSha256,
} from '../workflows/change-risk-packet-core.js';

const RUNNER_VERSION = '1.1.0';
const CASE_SLUGS = ['juneau-old-public-gis', 'la-county-cannabis-zones', 'tweed-planning-detail'] as const;

type CaseSlug = (typeof CASE_SLUGS)[number];

function publicArcgisOnlinePortalRootProblem(raw: string): string | null {
  return publicArcgisOnlineOrgRootProblem(raw, {
    noExplicitPort: 'pilot portal_url must be an ArcGIS Online organization root with no explicit port',
    publicAgolOnly: 'pilot cases must use public ArcGIS Online organization roots',
    noPathOrPort: 'pilot portal_url must be an ArcGIS Online organization root with no path or port',
  });
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

export const ChangeRiskReportSchema = z
  .object({
    schema_version: z.literal('1.1.0'),
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
    review_scope: ReviewScopeSchema,
    metrics: PacketMetricSchema,
    hashes: z
      .object({
        trace_report_sha256: Sha256Schema,
        trace_structure_sha256: Sha256Schema,
        trace_evidence_sha256: Sha256Schema,
      })
      .strict(),
    deterministic_samples: DeterministicSamplesSchema,
    change_ticket: ChangeTicketSchema,
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.change_ticket.next_action.command !== buildRerunCommand(report.case.slug)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['change_ticket', 'next_action', 'command'],
        message: 'next_action.command must equal the code-owned rerun command for the locked case',
      });
    }
  });

export const PilotCaseRecordSchema = z
  .object({
    schema_version: z.literal('1.1.0'),
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

function traceOutputFromResult(result: SkillResult): TraceArcgisDependenciesOutput {
  if (!result.ok) throw new Error(`trace_arcgis_dependencies failed: ${result.error ?? 'unknown error'}`);
  return TraceArcgisDependenciesOutputSchema.parse(result.output);
}

function exportOutputFromResult(result: SkillResult, operation: 'preview' | 'persist'): ExportEvidenceBundleOutput {
  if (!result.ok) throw new Error(`export_evidence_bundle ${operation} failed: ${result.error ?? 'unknown error'}`);
  return ExportEvidenceBundleOutputSchema.parse(result.output);
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

/**
 * Exact copy-ready rerun command for one locked case, executed from
 * `dymaxion-runtime`. It names only operator configuration: the config dir,
 * workspace root, and the trusted local execution identity label
 * ('local-value-pilot-operator' is an identity name, not a credential value).
 * No secret, token, or placeholder appears here.
 */
export function buildRerunCommand(slug: ArcgisChangeRiskCase['slug']): string {
  return [
    'mkdir -p ../artifacts/arcgis-change-risk-records ../artifacts/arcgis-change-risk-root',
    'DYMAXION_CONFIG_DIR=../config \\',
    'DYMAXION_WORKSPACE_ROOT=.. \\',
    `DYMAXION_CREDENTIAL_IDENTITIES_JSON='{"export_evidence_bundle":"local-value-pilot-operator"}' \\`,
    'npx -y node@22.23.1 ./node_modules/tsx/dist/cli.mjs src/pilots/arcgis-change-risk-runner.ts \\',
    `  --case ${slug} \\`,
    '  --output-dir ../artifacts/arcgis-change-risk-records \\',
    '  --artifact-root ../artifacts/arcgis-change-risk-root \\',
    '  --approve-persist',
  ].join('\n');
}

export function deriveChangeRiskReport(
  pilotCase: ArcgisChangeRiskCase,
  trace: TraceArcgisDependenciesOutput,
): ChangeRiskReport {
  assertSanitizedTraceServiceReferences(trace);
  validateLockedCaseAgainstTrace(pilotCase, trace);
  const core = deriveChangeTicketCore(
    {
      root_item_id: pilotCase.root_item_id,
      web_map_id: pilotCase.expected_web_map_id,
      review_posture: pilotCase.review_posture,
      expected_minimum_direct_reference_count: pilotCase.expected_minimum_direct_reference_count,
      next_action: {
        description:
          'Have a human ArcGIS administrator complete the operator-baseline protocol, then rerun this locked case from the dymaxion-runtime directory with the exact command below.',
        command: buildRerunCommand(pilotCase.slug),
      },
    },
    trace,
    PILOT_WORDING,
  );

  return ChangeRiskReportSchema.parse({
    schema_version: '1.1.0',
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
      root_title: core.root.title ?? pilotCase.expected_root_title,
      web_map_id: pilotCase.expected_web_map_id,
      web_map_title: core.webMap.title,
    },
    review_scope: {
      band: core.band,
      supporting_edge_count: core.metrics.edge_count,
      basis: core.basis,
      disclaimer: REVIEW_SCOPE_DISCLAIMER,
    },
    metrics: core.metrics,
    hashes: core.hashes,
    deterministic_samples: core.deterministic_samples,
    change_ticket: core.change_ticket,
    limitations: core.limitations,
  });
}

export function renderChangeRiskSvg(report: ChangeRiskReport, trace: TraceArcgisDependenciesOutput): string {
  report = ChangeRiskReportSchema.parse(report);
  return renderDependencyMapSvg(
    {
      title_slug: report.case.slug,
      root_title: report.locked_identity.root_title,
      organization_label: report.case.organization_name,
      review_posture: report.case.review_posture,
      band: report.review_scope.band,
      supporting_edge_count: report.review_scope.supporting_edge_count,
      truncated: report.metrics.truncated,
      truncation_reasons: report.metrics.truncation_reasons,
      trace_structure_sha256: report.hashes.trace_structure_sha256,
      trace_report_sha256: report.hashes.trace_report_sha256,
    },
    trace,
  );
}

export function buildPilotEvidence(
  report: ChangeRiskReport,
  trace: TraceArcgisDependenciesOutput,
  svg: string,
  generatedAt: string,
): EvidenceBundle {
  report = ChangeRiskReportSchema.parse(report);
  const artifactSha = sha256Text(svg);
  return buildPacketEvidence(
    {
      bundleId: `arcgis_change_risk_value_pilot:${report.case.slug}:${artifactSha.slice(0, 16)}`,
      capability: 'arcgis_change_risk_value_pilot',
      capabilityVersion: RUNNER_VERSION,
      format: 'ArcGIS dependency change-risk pilot',
      parameters: {
        case_slug: report.case.slug,
        root_item_id: report.locked_identity.root_item_id,
        web_map_id: report.locked_identity.web_map_id,
        trace_report_sha256: report.hashes.trace_report_sha256,
        artifact_sha256: artifactSha,
        runner_version: RUNNER_VERSION,
      },
      traceReportSha256: report.hashes.trace_report_sha256,
      nodeCount: report.metrics.node_count,
      truncated: report.metrics.truncated,
      svg,
      generatedAt,
    },
    trace,
  );
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
  report = ChangeRiskReportSchema.parse(report);
  assertSanitizedTraceServiceReferences(trace);
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
  const report = ChangeRiskReportSchema.parse(record.report);
  const ticket = report.change_ticket;
  const lines: string[] = [
    `# Change-ticket packet: ${report.case.slug}`,
    '',
    '## Locked case and source identity',
    '',
    `- Case: \`${report.case.slug}\` (project \`${report.case.project_id}\`)`,
    `- Organization: ${mdCell(report.case.organization_name)} (org id \`${report.case.org_id}\`)`,
    `- Portal: ${report.case.portal_url} (ArcGIS Online organization root)`,
    `- Root item: \`${report.locked_identity.root_item_id}\` — ${mdCell(report.locked_identity.root_title)} (Web Mapping Application)`,
    `- Web Map: \`${report.locked_identity.web_map_id}\`${report.locked_identity.web_map_title ? ` — ${mdCell(report.locked_identity.web_map_title)}` : ''}`,
    `- Runner: ${report.runner.name} v${report.runner.version} · report schema ${report.schema_version} · record schema ${record.schema_version}`,
    '',
    ...decisionSummarySectionLines(report.case.review_posture, ticket, report.review_scope.disclaimer),
    ...ticketFactSectionLines(ticket),
    '## Evidence, provenance and integrity',
    '',
    `- Trace report SHA-256 (timestamp-bearing): \`${report.hashes.trace_report_sha256}\``,
    `- Trace structure SHA-256 (timestamp-neutral; comparable across reruns): \`${report.hashes.trace_structure_sha256}\``,
    `- Trace evidence SHA-256: \`${report.hashes.trace_evidence_sha256}\``,
    `- ArcGIS REST requests / response bytes: ${report.metrics.request_count} / ${report.metrics.response_bytes}`,
    `- Preview ZIP: \`${record.export_preview.archive_sha256}\` (${record.export_preview.archive_bytes} bytes)`,
    `- Persisted ZIP: ${record.export_persist ? `\`${record.export_persist.archive_sha256}\` (${record.export_persist.archive_bytes} bytes, read-back verified: ${record.export_persist.read_back_verified})` : 'not requested (preview only)'}`,
    ...(record.repeat
      ? [
          `- Independent repeat trace: structure hash match ${record.repeat.trace_structure_hash_matches}; full report hash match ${record.repeat.trace_report_hash_matches}; preview archive hash match ${record.repeat.preview_archive_hash_matches}. ${record.repeat.explanation}`,
        ]
      : []),
    '- Timestamp-neutral structure hashes are the rerun-comparable identifiers; full report and archive hashes intentionally embed retrieval timestamps and per-run request evidence.',
    '',
    ...operatorBaselineSectionLines(ticket),
    ...limitationsSectionLines(report.limitations),
    ...nextActionSectionLines(ticket),
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
  const svg = renderChangeRiskSvg(report, trace);
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
    const persistDeps = baseDependencies(now, {
      ...options.dependencies,
      approvalRequest,
      approvalDependencies: { store, now },
      capabilityContext: {
        ...(options.dependencies?.capabilityContext ?? {}),
        now,
        io: {
          ...(options.dependencies?.capabilityContext?.io ?? {}),
          artifactRoot: trustedRoot,
        },
      },
    });
    const persistResult = await runSkillFn('export_evidence_bundle', persistInput as Record<string, unknown>, agentRunId, persistDeps);
    persistDurationMs = persistResult.durationMs;
    persist = exportOutputFromResult(persistResult, 'persist');
    await verifyPersistedArchive(trustedRoot, pilotCase.project_id, persist.archive.sha256, persist.archive.bytes);
  }

  let repeat: PilotCaseRecord['repeat'] = null;
  if (options.repeat !== false) {
    const repeatAgentRunId = `${agentRunId}-repeat`;
    const repeatTraceResult = await runSkillFn('trace_arcgis_dependencies', traceInput, repeatAgentRunId, dependencies);
    const repeatTrace = traceOutputFromResult(repeatTraceResult);
    const repeatReport = deriveChangeRiskReport(pilotCase, repeatTrace);
    const repeatSvg = renderChangeRiskSvg(repeatReport, repeatTrace);
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
    schema_version: '1.1.0' as const,
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
