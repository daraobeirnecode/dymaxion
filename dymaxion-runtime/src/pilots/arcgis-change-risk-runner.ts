import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ExportEvidenceBundleInputSchema,
  ExportEvidenceBundleOutputSchema,
  MAX_ARTIFACT_BYTES,
  type ExportEvidenceBundleInput,
  type ExportEvidenceBundleOutput,
} from '../capabilities/export-evidence-bundle.js';
import {
  TraceArcgisDependenciesOutputSchema,
  type TraceArcgisDependenciesOutput,
} from '../capabilities/trace-arcgis-dependencies.js';
import { containsCredentialMaterial, validatePortalUrl } from '../capabilities/arcgis-rest.js';
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

const RUNNER_VERSION = '1.1.0';
const ITEM_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CASE_SLUGS = ['juneau-old-public-gis', 'la-county-cannabis-zones', 'tweed-planning-detail'] as const;
const SACRAMENTO_RE = /sacramento|saccity/i;
const MAX_SERVICE_PATH_DECODE_PASSES = 3;

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * Defence in depth for report/export sinks. The trace capability already
 * sanitizes terminal service references, but this runner refuses to serialize
 * a contaminated or regressed trace contract. The returned problem is fixed
 * and never includes the untrusted URL.
 */
function sanitizedServiceReferenceProblem(raw: string): string | null {
  if (raw.includes('\\')) return 'service reference is not canonical';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'service reference is not an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'service reference must use HTTP(S)';
  }
  if (url.username || url.password || url.search || url.hash) {
    return 'service reference contains forbidden URL components';
  }
  if (url.href !== raw) return 'service reference is not canonical';

  let current = url.pathname;
  if (hasTraversalSegment(current) || containsCredentialMaterial(current)) {
    return 'service reference path is unsafe';
  }
  for (let pass = 0; pass < MAX_SERVICE_PATH_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return 'service reference path encoding is invalid';
    }
    if (hasTraversalSegment(decoded) || containsCredentialMaterial(decoded)) {
      return 'service reference path is unsafe';
    }
    if (decoded === current) return null;
    current = decoded;
  }
  return 'service reference path encoding is excessive';
}

function assertSanitizedTraceServiceReferences(trace: TraceArcgisDependenciesOutput): void {
  for (const node of trace.report.nodes) {
    if (node.service_url !== null && sanitizedServiceReferenceProblem(node.service_url) !== null) {
      throw new Error('trace contains an unsafe service reference');
    }
  }
}

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

// Change-ticket evidence classes are structurally distinct object shapes, not
// prose labels: observed facts carry a source pointer into trace output,
// derived findings carry their deterministic derivation rule, human-entered
// facts carry an author, and unavailable facts carry a machine-readable
// 'unavailable' status. Untrusted values inside them were already sanitized
// and length-capped by trace_arcgis_dependencies before they reach this layer.
const DependencyClassificationSchema = z.enum([
  'supported_item',
  'unsupported_item_type',
  'service_reference_leaf',
  'missing_or_inaccessible',
]);

const SharingLabelSchema = z.enum(['public', 'org', 'shared', 'private', 'unknown']);
const SupportLabelSchema = z.enum(['expandable', 'terminal', 'service_reference', 'missing', 'unfetched']);
const UnresolvedReasonSchema = z.enum([
  'malformed_item_id',
  'unparseable_url',
  'unsupported_url_scheme',
  'credential_bearing_url',
]);

const ObservedFactSchema = z
  .object({
    evidence_class: z.literal('observed'),
    name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    source: z.string().min(1),
  })
  .strict();

const DerivedFindingSchema = z
  .object({
    evidence_class: z.literal('derived'),
    name: z.string().min(1),
    statement: z.string().min(1),
    derivation: z.string().min(1),
  })
  .strict();

const HumanEnteredFactSchema = z
  .object({
    evidence_class: z.literal('human_entered'),
    name: z.string().min(1),
    value: z.string().min(1),
    entered_by: z.string().min(1),
  })
  .strict();

const UnavailableFactSchema = z
  .object({
    evidence_class: z.literal('unavailable'),
    status: z.literal('unavailable'),
    name: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const AffectedDependencySchema = z
  .object({
    node_id: z.string().min(1),
    observed: z
      .object({
        kind: z.enum(['item', 'service']),
        item_id: z.string().regex(ITEM_ID_RE).nullable(),
        service_url: z
          .string()
          .url()
          .refine((value) => sanitizedServiceReferenceProblem(value) === null, {
            message: 'service_url must be canonical, sanitized, and credential-free',
          })
          .nullable(),
        type: z.string().nullable(),
        title: z.string().nullable(),
        owner: z.string().nullable(),
        access: SharingLabelSchema,
        support: SupportLabelSchema,
        depth: CountSchema,
        is_root: z.boolean(),
      })
      .strict(),
    derived: z
      .object({
        classification: DependencyClassificationSchema,
        direct_from_locked_web_map: z.boolean(),
        recommended_action: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const UnresolvedReferenceRowSchema = z
  .object({
    observed: z
      .object({
        from: z.string().min(1),
        locator: z.string().min(1),
        kind: z.enum(['item_id', 'service_url']),
        reason: UnresolvedReasonSchema,
      })
      .strict(),
    derived: z
      .object({
        credential_rejected: z.boolean(),
        recommended_action: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const HUMAN_ENTERED_FACTS_NOTE =
  'No human-entered facts are recorded. This section stays intentionally empty until a human operator adds reviewed facts.';

const OperatorBaselineSchema = z
  .object({
    status: z.literal('unavailable'),
    completed_by: z.null(),
    protocol: z.array(z.string().min(1)).min(3),
  })
  .strict();

export const ChangeTicketSchema = z
  .object({
    review_posture_statement: z.string().min(1),
    decision_summary: z.array(z.string().min(1)).min(1),
    observed_facts: z.array(ObservedFactSchema).min(1),
    derived_findings: z.array(DerivedFindingSchema).min(1),
    human_entered_facts: z.array(HumanEnteredFactSchema).length(0),
    human_entered_facts_note: z.literal(HUMAN_ENTERED_FACTS_NOTE),
    unavailable_facts: z.array(UnavailableFactSchema).min(2),
    affected_dependencies: z.array(AffectedDependencySchema).min(1),
    unresolved_references: z.array(UnresolvedReferenceRowSchema),
    operator_baseline: OperatorBaselineSchema,
    next_action: z.object({ description: z.string().min(1), command: z.string().min(1) }).strict(),
  })
  .strict()
  .superRefine((ticket, context) => {
    for (const required of ['authenticated_owner_inventory', 'human_operator_baseline']) {
      if (!ticket.unavailable_facts.some((fact) => fact.name === required)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailable_facts'],
          message: `unavailable_facts must include '${required}'`,
        });
      }
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

type TraceNode = TraceArcgisDependenciesOutput['report']['nodes'][number];
type TraceUnresolvedReference = TraceArcgisDependenciesOutput['report']['unresolved_references'][number];
type DependencyClassification = z.infer<typeof DependencyClassificationSchema>;

export function classifyDependencyNode(node: TraceNode): DependencyClassification {
  if (node.support === 'missing' || node.support === 'unfetched') return 'missing_or_inaccessible';
  if (node.kind === 'service' || node.support === 'service_reference') return 'service_reference_leaf';
  return node.support === 'expandable' ? 'supported_item' : 'unsupported_item_type';
}

function recommendedDependencyAction(node: TraceNode, classification: DependencyClassification): string {
  if (node.is_root) {
    return 'Confirm the change ticket scope covers this locked root application before any modification or retirement.';
  }
  switch (classification) {
    case 'supported_item':
      return 'Review this supported item and its direct references in the portal before approving the change.';
    case 'unsupported_item_type':
      return 'Open this item in the portal and review its dependencies manually; this item type is not expanded by the bounded trace.';
    case 'service_reference_leaf':
      return 'Verify the service owner and contract with its administrator; this item-provided URL was recorded as evidence and never contacted.';
    case 'missing_or_inaccessible':
      return 'Confirm with the owning administrator whether this item was deleted, made private, or moved; anonymous metadata retrieval did not succeed.';
  }
}

function recommendedUnresolvedAction(reason: TraceUnresolvedReference['reason']): string {
  return reason === 'credential_bearing_url'
    ? 'Report this credential-bearing service reference to the owning administrator for credential rotation and source cleanup; the value was removed before output and never dispatched.'
    : 'Inspect the source item JSON at this locator manually; the reference could not be resolved into a supported node.';
}

function sortedUnresolvedReferences(references: readonly TraceUnresolvedReference[]): TraceUnresolvedReference[] {
  return [...references].sort((a, b) =>
    `${a.from}\u0000${a.locator}\u0000${a.kind}\u0000${a.reason}`.localeCompare(
      `${b.from}\u0000${b.locator}\u0000${b.kind}\u0000${b.reason}`,
    ),
  );
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

export function traceStructureSha256(trace: TraceArcgisDependenciesOutput): string {
  const stableReport = structuredClone(trace.report);
  stableReport.retrieved_at = '1970-01-01T00:00:00.000Z';
  return sha256Canonical(stableReport);
}

export function deriveChangeRiskReport(
  pilotCase: ArcgisChangeRiskCase,
  trace: TraceArcgisDependenciesOutput,
): ChangeRiskReport {
  assertSanitizedTraceServiceReferences(trace);
  validateLockedCaseAgainstTrace(pilotCase, trace);
  const report = trace.report;
  const root = report.nodes.find((node) => node.id === `item:${pilotCase.root_item_id}`)!;
  const webMap = report.nodes.find((node) => node.id === `item:${pilotCase.expected_web_map_id}`)!;
  const owners = [...new Set(report.nodes.flatMap((node) => (node.owner ? [node.owner] : [])))].sort();
  const missingNodeCount = report.nodes.filter((node) => node.support === 'missing' || node.support === 'unfetched').length;
  const directWebMapReferences = report.edges.filter((edge) => edge.from === `item:${pilotCase.expected_web_map_id}`);
  const responseBytes = (trace.evidence.requests ?? []).reduce((sum, request) => sum + request.bytes, 0);
  const basis = [
    `${report.totals.edge_count} dependency edges discovered through supported paths and ${report.totals.service_node_count} sanitized service leaves require human review before change.`,
    `${owners.length} visible owner reference${owners.length === 1 ? '' : 's'} ${owners.length === 1 ? 'appears' : 'appear'} in public item metadata; this is not authenticated owner inventory.`,
  ];
  if (missingNodeCount || report.unresolved_references.length) {
    basis.push(`${missingNodeCount} missing/unfetched nodes and ${report.unresolved_references.length} unresolved references reduce confidence.`);
  }
  if (report.truncation.truncated) {
    basis.push('The dependency trace was truncated, so the review cannot claim complete supported-path coverage.');
  }
  const band = reviewScopeBand(report.totals.edge_count);
  const directTargets = new Set(directWebMapReferences.map((edge) => edge.to));
  const affectedDependencies = [...report.nodes]
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
    .map((node) => {
      const classification = classifyDependencyNode(node);
      return {
        node_id: node.id,
        observed: {
          kind: node.kind,
          item_id: node.item_id,
          service_url: node.service_url,
          type: node.type,
          title: node.title,
          owner: node.owner,
          access: node.access,
          support: node.support,
          depth: node.depth,
          is_root: node.is_root,
        },
        derived: {
          classification,
          direct_from_locked_web_map: directTargets.has(node.id),
          recommended_action: recommendedDependencyAction(node, classification),
        },
      };
    });
  const classificationCounts: Record<DependencyClassification, number> = {
    supported_item: 0,
    unsupported_item_type: 0,
    service_reference_leaf: 0,
    missing_or_inaccessible: 0,
  };
  for (const row of affectedDependencies) classificationCounts[row.derived.classification] += 1;
  const unresolvedRows = sortedUnresolvedReferences(report.unresolved_references).map((reference) => ({
    observed: { from: reference.from, locator: reference.locator, kind: reference.kind, reason: reference.reason },
    derived: {
      credential_rejected: reference.reason === 'credential_bearing_url',
      recommended_action: recommendedUnresolvedAction(reference.reason),
    },
  }));
  const credentialRejectedCount = unresolvedRows.filter((row) => row.derived.credential_rejected).length;

  const observedFacts = [
    { name: 'portal_url', value: normalizePortalUrl(report.portal.url), source: 'trace report.portal.url (normalized)' },
    { name: 'retrieved_at', value: report.retrieved_at, source: 'trace report.retrieved_at (timestamp-bearing; excluded from the timestamp-neutral structure hash)' },
    { name: 'node_count', value: report.totals.node_count, source: 'trace report.totals.node_count' },
    { name: 'edge_count', value: report.totals.edge_count, source: 'trace report.totals.edge_count' },
    { name: 'item_node_count', value: report.totals.item_node_count, source: 'trace report.totals.item_node_count' },
    { name: 'service_node_count', value: report.totals.service_node_count, source: 'trace report.totals.service_node_count' },
    { name: 'request_count', value: report.totals.request_count, source: 'trace report.totals.request_count' },
    { name: 'response_bytes', value: responseBytes, source: 'sum of trace evidence.requests[].bytes' },
    { name: 'unresolved_reference_count', value: report.unresolved_references.length, source: 'trace report.unresolved_references length' },
    { name: 'cycle_count', value: report.cycles.length, source: 'trace report.cycles length' },
    { name: 'warning_count', value: report.warnings.length, source: 'trace report.warnings length' },
    { name: 'truncated', value: report.truncation.truncated, source: 'trace report.truncation.truncated' },
  ].map((fact) => ({ evidence_class: 'observed' as const, ...fact }));

  const derivedFindings = [
    {
      name: 'direct_web_map_reference_lower_bound',
      statement: `${directWebMapReferences.length} direct supported-path references were observed from the locked Web Map; the case manifest requires at least ${pilotCase.expected_minimum_direct_reference_count} (a validated lower bound, not an exact expected total).`,
      derivation: 'Count of trace edges whose from-node is the locked Web Map, checked against the manifest expected_minimum_direct_reference_count lower bound.',
    },
    {
      name: 'visible_owner_count',
      statement: `${owners.length} distinct visible owner reference${owners.length === 1 ? ' appears' : 's appear'} in public item metadata; this is not an authenticated owner inventory.`,
      derivation: 'Distinct non-null owner values across trace report.nodes.',
    },
    {
      name: 'review_scope_band',
      statement: `Review scope is '${band}' with ${report.totals.edge_count} supporting edges; a descriptive review-scope proxy only, not a probability, severity, or operational-risk score.`,
      derivation: 'Fixed supported-edge-count bands: small ≤ 10, medium ≤ 30, large ≤ 75, very_large > 75.',
    },
    {
      name: 'dependency_classification_counts',
      statement: `The bounded graph contains ${classificationCounts.supported_item} supported item node(s), ${classificationCounts.unsupported_item_type} unsupported item type(s), ${classificationCounts.service_reference_leaf} service-reference leaf/leaves, and ${classificationCounts.missing_or_inaccessible} missing/inaccessible node(s).`,
      derivation: 'Deterministic mapping from each trace node kind/support state: missing|unfetched → missing_or_inaccessible; service reference → service_reference_leaf; expandable item → supported_item; terminal item → unsupported_item_type.',
    },
    {
      name: 'service_leaves_never_contacted',
      statement:
        report.totals.service_node_count === 0
          ? 'No service leaves were found through supported paths.'
          : `${report.totals.service_node_count} item-provided service URL leaves were sanitized and recorded as never-dispatched evidence.`,
      derivation: 'trace report.totals.service_node_count plus the capability guarantee that item-provided service URLs are never contacted.',
    },
    {
      name: 'credential_rejected_references',
      statement:
        credentialRejectedCount === 0
          ? 'No credential-bearing service references were detected.'
          : `${credentialRejectedCount} credential-bearing service reference(s) were rejected; the values were removed before output and never dispatched.`,
      derivation: "Count of trace report.unresolved_references with reason 'credential_bearing_url'.",
    },
    {
      name: 'cycles',
      statement: report.cycles.length === 0 ? 'No dependency cycles were reported.' : `${report.cycles.length} dependency cycle(s) were reported.`,
      derivation: 'trace report.cycles length.',
    },
    {
      name: 'truncation',
      statement: report.truncation.truncated ? `Trace truncated: ${report.truncation.reasons.join('; ')}` : 'Trace completed without truncation.',
      derivation: 'trace report.truncation.',
    },
  ].map((finding) => ({ evidence_class: 'derived' as const, ...finding }));

  const unavailableFacts = [
    {
      name: 'authenticated_owner_inventory',
      reason: 'Anonymous ArcGIS Online REST access cannot enumerate organization users and no trusted ArcGIS credential provider exists; visible owners come only from public item metadata in the bounded graph.',
    },
    {
      name: 'human_operator_baseline',
      reason: 'No human ArcGIS administrator has completed the manual operator-baseline protocol; time-saved, usability, correction-burden, adoption, and customer-value measurements do not exist.',
    },
    {
      name: 'reverse_dependency_consumers',
      reason: 'The trace is downstream-only; other applications consuming these services are not discovered (frozen pilot scope).',
    },
    {
      name: 'live_service_state',
      reason: 'Item-provided service URLs are never dispatched, so live service availability, schema, and ownership are unverified.',
    },
  ].map((fact) => ({ evidence_class: 'unavailable' as const, status: 'unavailable' as const, ...fact }));

  const changeTicket = {
    review_posture_statement:
      pilotCase.review_posture === 'retirement_cleanup'
        ? 'retirement_cleanup: the locked Web Mapping Application is under retirement/cleanup review; confirm every supporting reference before decommissioning.'
        : 'change_review: the locked Web Mapping Application is under pre-change review; confirm every supporting reference before modifying the application or its Web Map.',
    decision_summary: [
      `Review posture: ${pilotCase.review_posture}.`,
      `Review scope: ${band} (${report.totals.edge_count} supporting edges; descriptive proxy only, not a risk score).`,
      `${report.totals.node_count} nodes are in the bounded graph (including the locked root): ${classificationCounts.supported_item} supported, ${classificationCounts.unsupported_item_type} unsupported item type(s), ${classificationCounts.service_reference_leaf} service-reference leaf/leaves, ${classificationCounts.missing_or_inaccessible} missing/inaccessible.`,
      unresolvedRows.length === 0
        ? 'No unresolved references were observed.'
        : `${unresolvedRows.length} unresolved reference(s) were observed, ${credentialRejectedCount} of them credential-rejected.`,
      'No human-entered facts and no completed operator baseline exist; time-saved, usability, and customer-value claims are blocked.',
    ],
    observed_facts: observedFacts,
    derived_findings: derivedFindings,
    human_entered_facts: [],
    human_entered_facts_note: HUMAN_ENTERED_FACTS_NOTE,
    unavailable_facts: unavailableFacts,
    affected_dependencies: affectedDependencies,
    unresolved_references: unresolvedRows,
    operator_baseline: {
      status: 'unavailable' as const,
      completed_by: null,
      protocol: [
        'Select one approved public or non-production ArcGIS change scenario equivalent to this locked case; never a Sacramento or employer system.',
        'Have an ArcGIS administrator perform the dependency review manually in the portal (UI or REST), recording wall-clock time, items inspected, owners identified, and errors noticed.',
        'Repeat the same review using this packet; record the same measures plus every correction the administrator makes to packet content.',
        'Record whether the administrator would attach this packet to a real change ticket, and what is missing for that.',
        'Capture the results in a separately reviewed human baseline record with the administrator identity. This generated packet remains immutable; only after that review may any time-saved or usability claim be made.',
      ],
    },
    next_action: {
      description: 'Have a human ArcGIS administrator complete the operator-baseline protocol, then rerun this locked case from the dymaxion-runtime directory with the exact command below.',
      command: buildRerunCommand(pilotCase.slug),
    },
  };

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
      root_title: root.title ?? pilotCase.expected_root_title,
      web_map_id: pilotCase.expected_web_map_id,
      web_map_title: webMap.title,
    },
    review_scope: {
      band,
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
    change_ticket: changeTicket,
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

function svgText(x: number, y: number, value: string, size = 16, weight = 400, fill = '#111827'): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" font-family="Arial, sans-serif" fill="${fill}">${xmlEscape(value)}</text>`;
}

function clip(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join('')}…` : value;
}

interface SvgCellStyle {
  fill: string;
  stroke: string;
  dash: string | null;
  legend: string;
}

const NODE_CLASS_STYLES: Record<DependencyClassification, SvgCellStyle> = {
  supported_item: { fill: '#dbeafe', stroke: '#1d4ed8', dash: null, legend: 'Supported item node (expanded by the trace)' },
  unsupported_item_type: { fill: '#fef3c7', stroke: '#b45309', dash: null, legend: 'Unsupported item type (present, not expanded)' },
  service_reference_leaf: { fill: '#ede9fe', stroke: '#6d28d9', dash: null, legend: 'Service-reference leaf (recorded, never contacted)' },
  missing_or_inaccessible: { fill: '#fee2e2', stroke: '#b91c1c', dash: '6 3', legend: 'Missing/inaccessible item reference' },
};
const UNRESOLVED_REFERENCE_STYLE: SvgCellStyle = { fill: '#ffffff', stroke: '#c2410c', dash: '3 3', legend: 'Unresolved reference (kept visible; not a graph node)' };
const CREDENTIAL_REJECTED_STYLE: SvgCellStyle = { fill: '#fecaca', stroke: '#7f1d1d', dash: '3 3', legend: 'Credential-rejected service reference (value removed, never dispatched)' };

interface SvgCell {
  key: string;
  from: string | null;
  style: SvgCellStyle;
  label1: string;
  label2: string;
}

/**
 * Deterministic layered dependency map: one column per trace depth, nodes
 * sorted by (depth, id); unresolved references are rendered as visible dashed
 * cells one column right of their source node and are never hidden. All
 * untrusted text (titles, types, sanitized service URLs) is length-capped and
 * XML-escaped; the closed-primitive scan and artifact byte ceiling still
 * apply.
 */
export function renderChangeRiskSvg(report: ChangeRiskReport, trace: TraceArcgisDependenciesOutput): string {
  report = ChangeRiskReportSchema.parse(report);
  assertSanitizedTraceServiceReferences(trace);
  const graph = trace.report;
  const nodes = [...graph.nodes].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const unresolved = sortedUnresolvedReferences(graph.unresolved_references);
  const depthById = new Map(nodes.map((node) => [node.id, node.depth]));

  const NODE_W = 250;
  const NODE_H = 42;
  const COL_GAP = 70;
  const ROW_GAP = 14;
  const MARGIN_X = 56;
  const HEADER_H = 168;

  const columns: SvgCell[][] = [];
  const pushCell = (column: number, cell: SvgCell): void => {
    (columns[column] ??= []).push(cell);
  };
  const classificationCounts: Record<DependencyClassification, number> = {
    supported_item: 0,
    unsupported_item_type: 0,
    service_reference_leaf: 0,
    missing_or_inaccessible: 0,
  };
  for (const node of nodes) {
    const classification = classifyDependencyNode(node);
    classificationCounts[classification] += 1;
    const label1 =
      node.kind === 'item'
        ? `${node.is_root ? 'ROOT · ' : ''}item ${node.item_id?.slice(0, 8) ?? '????????'} · ${clip(node.type ?? 'unknown type', 22)}`
        : 'service reference (not contacted)';
    const label2 = node.kind === 'item' ? clip(node.title ?? '(no title)', 36) : clip(node.service_url ?? node.id, 36);
    pushCell(node.depth, { key: node.id, from: null, style: NODE_CLASS_STYLES[classification], label1, label2 });
  }
  const credentialRejectedCount = unresolved.filter((reference) => reference.reason === 'credential_bearing_url').length;
  for (const [index, reference] of unresolved.entries()) {
    const credential = reference.reason === 'credential_bearing_url';
    pushCell((depthById.get(reference.from) ?? 0) + 1, {
      key: `unresolved:${index}`,
      from: reference.from,
      style: credential ? CREDENTIAL_REJECTED_STYLE : UNRESOLVED_REFERENCE_STYLE,
      label1: credential ? 'credential-rejected reference' : `unresolved ${reference.kind}`,
      label2: `${reference.reason} · ${clip(reference.locator, 26)}`,
    });
  }

  const columnCount = columns.length;
  const maxRows = Math.max(1, ...columns.map((cells) => cells?.length ?? 0));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [columnIndex, cells] of columns.entries()) {
    for (const [rowIndex, cell] of (cells ?? []).entries()) {
      positions.set(cell.key, {
        x: MARGIN_X + columnIndex * (NODE_W + COL_GAP),
        y: HEADER_H + rowIndex * (NODE_H + ROW_GAP),
      });
    }
  }

  const legendEntries: Array<{ style: SvgCellStyle; count: number }> = [
    { style: NODE_CLASS_STYLES.supported_item, count: classificationCounts.supported_item },
    { style: NODE_CLASS_STYLES.unsupported_item_type, count: classificationCounts.unsupported_item_type },
    { style: NODE_CLASS_STYLES.service_reference_leaf, count: classificationCounts.service_reference_leaf },
    { style: NODE_CLASS_STYLES.missing_or_inaccessible, count: classificationCounts.missing_or_inaccessible },
    { style: UNRESOLVED_REFERENCE_STYLE, count: unresolved.length - credentialRejectedCount },
    { style: CREDENTIAL_REJECTED_STYLE, count: credentialRejectedCount },
  ];
  const bodyH = maxRows * (NODE_H + ROW_GAP);
  const legendTop = HEADER_H + bodyH + 26;
  const legendH = 24 + legendEntries.length * 24;
  const footerTop = legendTop + legendH + 16;
  const width = Math.max(980, MARGIN_X * 2 + columnCount * NODE_W + (columnCount - 1) * COL_GAP);
  const height = footerTop + 92;

  const edgeMarkup: string[] = [];
  const sortedEdges = [...graph.edges].sort((a, b) =>
    `${a.from} ${a.to} ${a.relationship} ${a.locator}`.localeCompare(`${b.from} ${b.to} ${b.relationship} ${b.locator}`),
  );
  for (const edge of sortedEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    edgeMarkup.push(
      `<line x1="${from.x + NODE_W}" y1="${from.y + NODE_H / 2}" x2="${to.x}" y2="${to.y + NODE_H / 2}" stroke="#94a3b8" stroke-width="1.2"/>`,
    );
  }
  const cellMarkup: string[] = [];
  for (const cells of columns) {
    for (const cell of cells ?? []) {
      const position = positions.get(cell.key)!;
      if (cell.from) {
        const from = positions.get(cell.from);
        if (from) {
          edgeMarkup.push(
            `<line x1="${from.x + NODE_W}" y1="${from.y + NODE_H / 2}" x2="${position.x}" y2="${position.y + NODE_H / 2}" stroke="${cell.style.stroke}" stroke-width="1.2" stroke-dasharray="3 3"/>`,
          );
        }
      }
      const dash = cell.style.dash ? ` stroke-dasharray="${cell.style.dash}"` : '';
      cellMarkup.push(
        `<rect x="${position.x}" y="${position.y}" width="${NODE_W}" height="${NODE_H}" rx="6" fill="${cell.style.fill}" stroke="${cell.style.stroke}" stroke-width="1.4"${dash}/>`,
        svgText(position.x + 8, position.y + 17, clip(cell.label1, 40), 11, 700),
        svgText(position.x + 8, position.y + 33, cell.label2, 11),
      );
    }
  }
  const legendMarkup: string[] = [svgText(MARGIN_X, legendTop, 'Legend', 14, 700)];
  for (const [index, entry] of legendEntries.entries()) {
    const y = legendTop + 14 + index * 24;
    const dash = entry.style.dash ? ` stroke-dasharray="${entry.style.dash}"` : '';
    legendMarkup.push(
      `<rect x="${MARGIN_X}" y="${y}" width="26" height="14" rx="3" fill="${entry.style.fill}" stroke="${entry.style.stroke}" stroke-width="1.4"${dash}/>`,
      svgText(MARGIN_X + 36, y + 12, `${entry.style.legend} — ${entry.count}`, 13),
    );
  }
  const warning = report.metrics.truncated
    ? `Truncated: ${report.metrics.truncation_reasons.join('; ')}`
    : 'No trace truncation reported.';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xmlEscape(report.case.slug)} ArcGIS change-ticket dependency map</title>
<desc id="desc">Deterministic dependency map for ${xmlEscape(report.locked_identity.root_title)}. Item-provided service URLs are sanitized references and are never contacted.</desc>
<rect width="${width}" height="${height}" fill="#f8fafc"/>
${svgText(MARGIN_X, 44, 'ArcGIS change-ticket dependency map', 24, 700)}
${svgText(MARGIN_X, 76, clip(report.locked_identity.root_title, 88), 18, 700)}
${svgText(MARGIN_X, 102, clip(`${report.case.organization_name} · ${report.case.review_posture.replace(/_/g, ' ')}`, 104), 15)}
${svgText(MARGIN_X, 126, `Review scope: ${report.review_scope.band} (${report.review_scope.supporting_edge_count} supporting edges) — descriptive proxy only, not a risk score.`, 13)}
${svgText(MARGIN_X, 146, 'Columns are trace depth 0..n; dashed cells right of a node are its unresolved references.', 12)}
${edgeMarkup.join('\n')}
${cellMarkup.join('\n')}
${legendMarkup.join('\n')}
${svgText(MARGIN_X, footerTop + 20, clip(warning, 120), 13, 700)}
${svgText(MARGIN_X, footerTop + 42, 'Supported dependency paths only; no authenticated owner inventory; no reverse dependency search.', 12)}
${svgText(MARGIN_X, footerTop + 62, `Structure SHA-256 (timestamp-neutral): ${report.hashes.trace_structure_sha256.slice(0, 16)}… · Trace report SHA-256: ${report.hashes.trace_report_sha256.slice(0, 16)}…`, 12)}
</svg>`;
  if (/(<script|<foreignObject|on\w+=|xlink:href|href=|<!DOCTYPE|<style)/i.test(svg)) {
    throw new Error('generated SVG failed forbidden-construct scan');
  }
  if (Buffer.byteLength(svg, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new Error('generated SVG exceeded the artifact byte ceiling');
  }
  return svg;
}

export function buildPilotEvidence(
  report: ChangeRiskReport,
  trace: TraceArcgisDependenciesOutput,
  svg: string,
  generatedAt: string,
): EvidenceBundle {
  report = ChangeRiskReportSchema.parse(report);
  assertSanitizedTraceServiceReferences(trace);
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

/** Markdown table cells must not break table structure or open fences even
 * when sanitized upstream metadata contains pipes, backticks, or newlines. */
function mdCell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/[\r\n]+/g, ' ');
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
    '## Decision summary and review posture',
    '',
    `- Review posture: **${report.case.review_posture}** — ${ticket.review_posture_statement}`,
    ...ticket.decision_summary.map((line) => `- ${line}`),
    `- ${report.review_scope.disclaimer}`,
    '',
    '## Observed facts (evidence class: observed)',
    '',
    '| Fact | Value | Source |',
    '|---|---|---|',
    ...ticket.observed_facts.map((fact) => `| ${mdCell(fact.name)} | ${mdCell(String(fact.value))} | ${mdCell(fact.source)} |`),
    '',
    '## Derived findings (evidence class: derived; deterministic)',
    '',
    ...ticket.derived_findings.map((finding) => `- **${finding.name}**: ${finding.statement} _Derivation: ${finding.derivation}_`),
    '',
    '## Human-entered facts (evidence class: human_entered)',
    '',
  ];
  if (ticket.human_entered_facts.length === 0) {
    lines.push(`_${ticket.human_entered_facts_note}_`, '');
  } else {
    lines.push(
      '| Fact | Value | Entered by |',
      '|---|---|---|',
      ...ticket.human_entered_facts.map((fact) => `| ${mdCell(fact.name)} | ${mdCell(fact.value)} | ${mdCell(fact.entered_by)} |`),
      '',
    );
  }
  lines.push(
    '## Unavailable facts (evidence class: unavailable)',
    '',
    '| Fact | Status | Reason |',
    '|---|---|---|',
    ...ticket.unavailable_facts.map((fact) => `| ${mdCell(fact.name)} | \`${fact.status}\` | ${mdCell(fact.reason)} |`),
    '',
    '## Affected dependencies and owners',
    '',
    '| Node | Classification | Type / sanitized URL | Title | Owner | Access | Support | Direct from Web Map | Recommended action |',
    '|---|---|---|---|---|---|---|---|---|',
    ...ticket.affected_dependencies.map((row) =>
      [
        '',
        `\`${mdCell(row.node_id.length > 24 ? `${row.node_id.slice(0, 23)}…` : row.node_id)}\`${row.observed.is_root ? ' (root)' : ''}`,
        mdCell(row.derived.classification),
        mdCell(row.observed.kind === 'service' ? row.observed.service_url : row.observed.type),
        mdCell(row.observed.title),
        mdCell(row.observed.owner),
        mdCell(row.observed.access),
        mdCell(row.observed.support),
        row.derived.direct_from_locked_web_map ? 'yes' : 'no',
        mdCell(row.derived.recommended_action),
        '',
      ].join(' | ').trim(),
    ),
    '',
    '### Unresolved references (kept visible)',
    '',
  );
  if (ticket.unresolved_references.length === 0) {
    lines.push('_No unresolved references were observed._', '');
  } else {
    lines.push(
      '| From | Locator | Kind | Reason | Credential-rejected | Recommended action |',
      '|---|---|---|---|---|---|',
      ...ticket.unresolved_references.map((row) =>
        `| \`${mdCell(row.observed.from.length > 24 ? `${row.observed.from.slice(0, 23)}…` : row.observed.from)}\` | ${mdCell(row.observed.locator)} | ${mdCell(row.observed.kind)} | ${mdCell(row.observed.reason)} | ${row.derived.credential_rejected ? 'yes' : 'no'} | ${mdCell(row.derived.recommended_action)} |`,
      ),
      '',
    );
  }
  lines.push(
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
    `## Operator baseline protocol (status: ${ticket.operator_baseline.status})`,
    '',
    `- Machine-readable status: \`${ticket.operator_baseline.status}\` (completed_by: none)`,
    '- No time-saved, usability, correction-burden, adoption, or customer-value claim is valid until a human ArcGIS administrator completes this protocol.',
    '',
    ...ticket.operator_baseline.protocol.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
    '## Copy-ready next action',
    '',
    ticket.next_action.description,
    '',
    '```bash',
    ticket.next_action.command,
    '```',
  );
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
