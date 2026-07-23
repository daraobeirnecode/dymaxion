// Shared ArcGIS change-risk packet construction. This module owns the
// deterministic report/ticket/SVG/markdown/evidence building blocks that both
// the locked three-case pilot (src/pilots/arcgis-change-risk-runner.ts) and
// the agent-callable arcgis_change_risk_packet workflow compose. The pilot's
// outputs must stay byte-identical, so every string here is either verbatim
// pilot text or explicitly parameterized through PacketWording.

import { z } from 'zod';
import { MAX_ARTIFACT_BYTES } from '../capabilities/export-evidence-bundle.js';
import type { TraceArcgisDependenciesOutput } from '../capabilities/trace-arcgis-dependencies.js';
import { containsCredentialMaterial, validatePortalUrl } from '../capabilities/arcgis-rest.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import { EvidenceBundleSchema, type EvidenceBundle } from '../contracts/evidence.js';

export const ITEM_ID_RE = /^[a-f0-9]{32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SACRAMENTO_RE = /sacramento|saccity/i;
const MAX_SERVICE_PATH_DECODE_PASSES = 3;

export type TraceNode = TraceArcgisDependenciesOutput['report']['nodes'][number];
export type TraceUnresolvedReference =
  TraceArcgisDependenciesOutput['report']['unresolved_references'][number];

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * Defence in depth for report/export sinks. The trace capability already
 * sanitizes terminal service references, but packet sinks refuse to serialize
 * a contaminated or regressed trace contract. The returned problem is fixed
 * and never includes the untrusted URL.
 */
export function sanitizedServiceReferenceProblem(raw: string): string | null {
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

export function assertSanitizedTraceServiceReferences(trace: TraceArcgisDependenciesOutput): void {
  for (const node of trace.report.nodes) {
    if (node.service_url !== null && sanitizedServiceReferenceProblem(node.service_url) !== null) {
      throw new Error('trace contains an unsafe service reference');
    }
  }
}

export interface PortalRootLabels {
  noExplicitPort: string;
  publicAgolOnly: string;
  noPathOrPort: string;
}

/** Reject anything that is not a public ArcGIS Online organization root. */
export function publicArcgisOnlineOrgRootProblem(
  raw: string,
  labels: PortalRootLabels,
): string | null {
  const sharedProblem = validatePortalUrl(raw);
  if (sharedProblem) return sharedProblem;
  const authority = raw.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes(':')) {
    return labels.noExplicitPort;
  }
  const url = new URL(raw);
  if (!url.hostname.toLowerCase().endsWith('.maps.arcgis.com')) {
    return labels.publicAgolOnly;
  }
  if (url.port || url.pathname !== '/') {
    return labels.noPathOrPort;
  }
  return null;
}

export function normalizePortalUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/$/, '')}`;
}

export const CountSchema = z.number().int().nonnegative();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PacketMetricSchema = z
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
export const DependencyClassificationSchema = z.enum([
  'supported_item',
  'unsupported_item_type',
  'service_reference_leaf',
  'missing_or_inaccessible',
]);

export const SharingLabelSchema = z.enum(['public', 'org', 'shared', 'private', 'unknown']);
export const SupportLabelSchema = z.enum(['expandable', 'terminal', 'service_reference', 'missing', 'unfetched']);
export const UnresolvedReasonSchema = z.enum([
  'malformed_item_id',
  'unparseable_url',
  'unsupported_url_scheme',
  'credential_bearing_url',
]);

export const ObservedFactSchema = z
  .object({
    evidence_class: z.literal('observed'),
    name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    source: z.string().min(1),
  })
  .strict();

export const DerivedFindingSchema = z
  .object({
    evidence_class: z.literal('derived'),
    name: z.string().min(1),
    statement: z.string().min(1),
    derivation: z.string().min(1),
  })
  .strict();

export const HumanEnteredFactSchema = z
  .object({
    evidence_class: z.literal('human_entered'),
    name: z.string().min(1),
    value: z.string().min(1),
    entered_by: z.string().min(1),
  })
  .strict();

export const UnavailableFactSchema = z
  .object({
    evidence_class: z.literal('unavailable'),
    status: z.literal('unavailable'),
    name: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const AffectedDependencySchema = z
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

export const UnresolvedReferenceRowSchema = z
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

export const OperatorBaselineSchema = z
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

export const REVIEW_SCOPE_DISCLAIMER =
  'Descriptive review-scope proxy only; not a probability, severity, or operational-risk score.';

export const ReviewScopeSchema = z
  .object({
    band: z.enum(['small', 'medium', 'large', 'very_large']),
    supporting_edge_count: CountSchema,
    basis: z.array(z.string().min(1)).min(1),
    disclaimer: z.literal(REVIEW_SCOPE_DISCLAIMER),
  })
  .strict();

export const DeterministicSamplesSchema = z
  .array(
    z
      .object({ from: z.string().min(1), to: z.string().min(1), relationship: z.string().min(1), locator: z.string().min(1), reference: z.string().min(1) })
      .strict(),
  )
  .max(3);

export type DependencyClassification = z.infer<typeof DependencyClassificationSchema>;
export type ChangeTicket = z.infer<typeof ChangeTicketSchema>;
export type PacketMetrics = z.infer<typeof PacketMetricSchema>;
export type ReviewScopeBand = z.infer<typeof ReviewScopeSchema>['band'];

export function reviewScopeBand(edgeCount: number): ReviewScopeBand {
  if (edgeCount > 75) return 'very_large';
  if (edgeCount > 30) return 'large';
  if (edgeCount > 10) return 'medium';
  return 'small';
}

export function classifyDependencyNode(node: TraceNode): DependencyClassification {
  if (node.support === 'missing' || node.support === 'unfetched') return 'missing_or_inaccessible';
  if (node.kind === 'service' || node.support === 'service_reference') return 'service_reference_leaf';
  return node.support === 'expandable' ? 'supported_item' : 'unsupported_item_type';
}

/**
 * Wording differences between the locked pilot packet (which talks about the
 * "locked" case validated against a manifest) and the live agent workflow
 * packet (whose Web Map identity is derived from the trace, not locked). The
 * shared derivation logic and evidence structure stay identical; only these
 * strings vary.
 */
export interface PacketWording {
  rootAction: string;
  reviewPostureRetirement: string;
  reviewPostureChange: string;
  nodesSummaryRootLabel: string;
  reverseDependencyReason: string;
  limitationsFirst: string;
  baselineScenarioStep: string;
  directReferenceFinding: (count: number, expectedMinimum: number | null) => {
    statement: string;
    derivation: string;
  };
}

export const PILOT_WORDING: PacketWording = {
  rootAction:
    'Confirm the change ticket scope covers this locked root application before any modification or retirement.',
  reviewPostureRetirement:
    'retirement_cleanup: the locked Web Mapping Application is under retirement/cleanup review; confirm every supporting reference before decommissioning.',
  reviewPostureChange:
    'change_review: the locked Web Mapping Application is under pre-change review; confirm every supporting reference before modifying the application or its Web Map.',
  nodesSummaryRootLabel: 'including the locked root',
  reverseDependencyReason:
    'The trace is downstream-only; other applications consuming these services are not discovered (frozen pilot scope).',
  limitationsFirst:
    'This pilot traces only documented Web Mapping Application → Web Map → item/service paths supported by trace_arcgis_dependencies.',
  baselineScenarioStep:
    'Select one approved public or non-production ArcGIS change scenario equivalent to this locked case; never a Sacramento or employer system.',
  directReferenceFinding: (count, expectedMinimum) => ({
    statement: `${count} direct supported-path references were observed from the locked Web Map; the case manifest requires at least ${expectedMinimum} (a validated lower bound, not an exact expected total).`,
    derivation:
      'Count of trace edges whose from-node is the locked Web Map, checked against the manifest expected_minimum_direct_reference_count lower bound.',
  }),
};

export const LIVE_WORDING: PacketWording = {
  rootAction:
    'Confirm the change ticket scope covers this root application before any modification or retirement.',
  reviewPostureRetirement:
    'retirement_cleanup: the reviewed Web Mapping Application is under retirement/cleanup review; confirm every supporting reference before decommissioning.',
  reviewPostureChange:
    'change_review: the reviewed Web Mapping Application is under pre-change review; confirm every supporting reference before modifying the application or its Web Map.',
  nodesSummaryRootLabel: 'including the root application',
  reverseDependencyReason:
    'The trace is downstream-only; other applications consuming these services are not discovered (frozen workflow scope).',
  limitationsFirst:
    'This workflow traces only documented Web Mapping Application → Web Map → item/service paths supported by trace_arcgis_dependencies.',
  baselineScenarioStep:
    'Select one approved public or non-production ArcGIS change scenario equivalent to this reviewed case; never a Sacramento or employer system.',
  directReferenceFinding: (count) => ({
    statement: `${count} direct supported-path references were observed from the derived Web Map; the Web Map identity was derived from the live trace, so no locked minimum applies.`,
    derivation: 'Count of trace edges whose from-node is the derived Web Map.',
  }),
};

function recommendedDependencyAction(
  node: TraceNode,
  classification: DependencyClassification,
  wording: PacketWording,
): string {
  if (node.is_root) {
    return wording.rootAction;
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

export function sortedUnresolvedReferences(
  references: readonly TraceUnresolvedReference[],
): TraceUnresolvedReference[] {
  return [...references].sort((a, b) =>
    `${a.from}\u0000${a.locator}\u0000${a.kind}\u0000${a.reason}`.localeCompare(
      `${b.from}\u0000${b.locator}\u0000${b.kind}\u0000${b.reason}`,
    ),
  );
}

export function traceStructureSha256(trace: TraceArcgisDependenciesOutput): string {
  const stableReport = structuredClone(trace.report);
  stableReport.retrieved_at = '1970-01-01T00:00:00.000Z';
  return sha256Canonical(stableReport);
}

function nodeLabel(node: TraceNode): string {
  return node.item_id ?? node.service_url ?? node.id;
}

export interface PacketCoreSubject {
  root_item_id: string;
  web_map_id: string;
  review_posture: 'retirement_cleanup' | 'change_review';
  expected_minimum_direct_reference_count: number | null;
  next_action: { description: string; command: string };
}

export interface PacketCore {
  band: ReviewScopeBand;
  basis: string[];
  metrics: PacketMetrics;
  hashes: { trace_report_sha256: string; trace_structure_sha256: string; trace_evidence_sha256: string };
  deterministic_samples: z.infer<typeof DeterministicSamplesSchema>;
  change_ticket: ChangeTicket;
  limitations: string[];
  owners: string[];
  root: TraceNode;
  webMap: TraceNode;
}

/**
 * Deterministic shared middle of the change-risk packet: metrics, review
 * scope basis, evidence-class ticket sections, deterministic samples, and
 * hashes — everything except caller-specific identity blocks. Callers must
 * validate identity (locked pilot manifest or live-derived workflow identity)
 * before invoking; missing root/Web Map nodes fail closed here regardless.
 */
export function deriveChangeTicketCore(
  subject: PacketCoreSubject,
  trace: TraceArcgisDependenciesOutput,
  wording: PacketWording,
): PacketCore {
  assertSanitizedTraceServiceReferences(trace);
  const report = trace.report;
  const root = report.nodes.find((node) => node.id === `item:${subject.root_item_id}`);
  const webMap = report.nodes.find((node) => node.id === `item:${subject.web_map_id}`);
  if (!root || !webMap) {
    throw new Error('packet subject root or Web Map is missing from the dependency graph');
  }
  const owners = [...new Set(report.nodes.flatMap((node) => (node.owner ? [node.owner] : [])))].sort();
  const missingNodeCount = report.nodes.filter((node) => node.support === 'missing' || node.support === 'unfetched').length;
  const directWebMapReferences = report.edges.filter((edge) => edge.from === `item:${subject.web_map_id}`);
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
          recommended_action: recommendedDependencyAction(node, classification, wording),
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

  const directReferenceFinding = wording.directReferenceFinding(
    directWebMapReferences.length,
    subject.expected_minimum_direct_reference_count,
  );
  const derivedFindings = [
    {
      name: 'direct_web_map_reference_lower_bound',
      statement: directReferenceFinding.statement,
      derivation: directReferenceFinding.derivation,
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
      reason: wording.reverseDependencyReason,
    },
    {
      name: 'live_service_state',
      reason: 'Item-provided service URLs are never dispatched, so live service availability, schema, and ownership are unverified.',
    },
  ].map((fact) => ({ evidence_class: 'unavailable' as const, status: 'unavailable' as const, ...fact }));

  const changeTicket: ChangeTicket = {
    review_posture_statement:
      subject.review_posture === 'retirement_cleanup'
        ? wording.reviewPostureRetirement
        : wording.reviewPostureChange,
    decision_summary: [
      `Review posture: ${subject.review_posture}.`,
      `Review scope: ${band} (${report.totals.edge_count} supporting edges; descriptive proxy only, not a risk score).`,
      `${report.totals.node_count} nodes are in the bounded graph (${wording.nodesSummaryRootLabel}): ${classificationCounts.supported_item} supported, ${classificationCounts.unsupported_item_type} unsupported item type(s), ${classificationCounts.service_reference_leaf} service-reference leaf/leaves, ${classificationCounts.missing_or_inaccessible} missing/inaccessible.`,
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
        wording.baselineScenarioStep,
        'Have an ArcGIS administrator perform the dependency review manually in the portal (UI or REST), recording wall-clock time, items inspected, owners identified, and errors noticed.',
        'Repeat the same review using this packet; record the same measures plus every correction the administrator makes to packet content.',
        'Record whether the administrator would attach this packet to a real change ticket, and what is missing for that.',
        'Capture the results in a separately reviewed human baseline record with the administrator identity. This generated packet remains immutable; only after that review may any time-saved or usability claim be made.',
      ],
    },
    next_action: {
      description: subject.next_action.description,
      command: subject.next_action.command,
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

  return {
    band,
    basis,
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
      wording.limitationsFirst,
      'It does not query authenticated organization users, private inventory, reverse dependencies, or item-provided service URLs.',
      'Visible owners come only from public ArcGIS item metadata in the bounded dependency graph.',
      'A technical run is not a time-saved, cost-saved, or customer-value claim without a human baseline.',
    ],
    owners,
    root,
    webMap,
  };
}

// ---------------------------------------------------------------------------
// Deterministic dependency-map SVG
// ---------------------------------------------------------------------------

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

export interface DependencyMapSvgView {
  title_slug: string;
  root_title: string;
  organization_label: string;
  review_posture: string;
  band: ReviewScopeBand;
  supporting_edge_count: number;
  truncated: boolean;
  truncation_reasons: string[];
  trace_structure_sha256: string;
  trace_report_sha256: string;
}

/**
 * Deterministic layered dependency map: one column per trace depth, nodes
 * sorted by (depth, id); unresolved references are rendered as visible dashed
 * cells one column right of their source node and are never hidden. All
 * untrusted text (titles, types, sanitized service URLs) is length-capped and
 * XML-escaped; the closed-primitive scan and artifact byte ceiling still
 * apply.
 */
export function renderDependencyMapSvg(
  view: DependencyMapSvgView,
  trace: TraceArcgisDependenciesOutput,
): string {
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
  const warning = view.truncated
    ? `Truncated: ${view.truncation_reasons.join('; ')}`
    : 'No trace truncation reported.';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xmlEscape(view.title_slug)} ArcGIS change-ticket dependency map</title>
<desc id="desc">Deterministic dependency map for ${xmlEscape(view.root_title)}. Item-provided service URLs are sanitized references and are never contacted.</desc>
<rect width="${width}" height="${height}" fill="#f8fafc"/>
${svgText(MARGIN_X, 44, 'ArcGIS change-ticket dependency map', 24, 700)}
${svgText(MARGIN_X, 76, clip(view.root_title, 88), 18, 700)}
${svgText(MARGIN_X, 102, clip(`${view.organization_label} · ${view.review_posture.replace(/_/g, ' ')}`, 104), 15)}
${svgText(MARGIN_X, 126, `Review scope: ${view.band} (${view.supporting_edge_count} supporting edges) — descriptive proxy only, not a risk score.`, 13)}
${svgText(MARGIN_X, 146, 'Columns are trace depth 0..n; dashed cells right of a node are its unresolved references.', 12)}
${edgeMarkup.join('\n')}
${cellMarkup.join('\n')}
${legendMarkup.join('\n')}
${svgText(MARGIN_X, footerTop + 20, clip(warning, 120), 13, 700)}
${svgText(MARGIN_X, footerTop + 42, 'Supported dependency paths only; no authenticated owner inventory; no reverse dependency search.', 12)}
${svgText(MARGIN_X, footerTop + 62, `Structure SHA-256 (timestamp-neutral): ${view.trace_structure_sha256.slice(0, 16)}… · Trace report SHA-256: ${view.trace_report_sha256.slice(0, 16)}…`, 12)}
</svg>`;
  if (/(<script|<foreignObject|on\w+=|xlink:href|href=|<!DOCTYPE|<style)/i.test(svg)) {
    throw new Error('generated SVG failed forbidden-construct scan');
  }
  if (Buffer.byteLength(svg, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new Error('generated SVG exceeded the artifact byte ceiling');
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Shared evidence bundle assembly
// ---------------------------------------------------------------------------

export interface PacketEvidenceParams {
  bundleId: string;
  capability: string;
  capabilityVersion: string;
  format: string;
  parameters: Record<string, unknown>;
  traceReportSha256: string;
  nodeCount: number;
  truncated: boolean;
  svg: string;
  generatedAt: string;
}

export function buildPacketEvidence(
  params: PacketEvidenceParams,
  trace: TraceArcgisDependenciesOutput,
): EvidenceBundle {
  assertSanitizedTraceServiceReferences(trace);
  const traceReportJson = canonicalJson(trace.report);
  const traceReportBytes = Buffer.byteLength(traceReportJson, 'utf8');
  const traceEvidenceJson = canonicalJson(trace.evidence);
  const traceEvidenceSha = sha256Text(traceEvidenceJson);
  const traceEvidenceBytes = Buffer.byteLength(traceEvidenceJson, 'utf8');
  const artifactBytes = Buffer.byteLength(params.svg, 'utf8');
  const artifactSha = sha256Text(params.svg);
  const parametersJson = canonicalJson(params.parameters);
  return EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: params.bundleId,
    generated_at: params.generatedAt,
    source: {
      uri: `dymaxion:inline-trace-report:${params.traceReportSha256}`,
      identity: { kind: 'arcgis_dependency_trace_report', value: params.traceReportSha256 },
      version: {},
      retrieved_at: trace.report.retrieved_at,
      sha256: params.traceReportSha256,
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
      format: params.format,
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: params.nodeCount,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: { canonical_json: parametersJson, sha256: sha256Text(parametersJson) },
    execution: {
      capability: params.capability,
      capability_version: params.capabilityVersion,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'arcgis_change_risk_svg',
        sha256: artifactSha,
        bytes: artifactBytes,
        validation: { valid: true, checks: ['deterministic closed-primitive SVG generated and hash-bound'], warnings: params.truncated ? ['dependency trace was truncated'] : [] },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
}

// ---------------------------------------------------------------------------
// Shared markdown section rendering
// ---------------------------------------------------------------------------

/** Markdown table cells must not break table structure or open fences even
 * when sanitized upstream metadata contains pipes, backticks, or newlines
 * (LF, CRLF, or a standalone CR). */
export function mdCell(value: string | number | boolean | null): string {
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

export function decisionSummarySectionLines(
  reviewPosture: string,
  ticket: ChangeTicket,
  disclaimer: string,
): string[] {
  return [
    '## Decision summary and review posture',
    '',
    `- Review posture: **${reviewPosture}** — ${ticket.review_posture_statement}`,
    ...ticket.decision_summary.map((line) => `- ${line}`),
    `- ${disclaimer}`,
    '',
  ];
}

export function ticketFactSectionLines(ticket: ChangeTicket): string[] {
  const lines: string[] = [
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
  return lines;
}

export function operatorBaselineSectionLines(ticket: ChangeTicket): string[] {
  return [
    `## Operator baseline protocol (status: ${ticket.operator_baseline.status})`,
    '',
    `- Machine-readable status: \`${ticket.operator_baseline.status}\` (completed_by: none)`,
    '- No time-saved, usability, correction-burden, adoption, or customer-value claim is valid until a human ArcGIS administrator completes this protocol.',
    '',
    ...ticket.operator_baseline.protocol.map((step, index) => `${index + 1}. ${step}`),
    '',
  ];
}

export function limitationsSectionLines(limitations: readonly string[]): string[] {
  return ['## Limitations', '', ...limitations.map((limitation) => `- ${limitation}`), ''];
}

export function nextActionSectionLines(ticket: ChangeTicket): string[] {
  return [
    '## Copy-ready next action',
    '',
    ticket.next_action.description,
    '',
    '```bash',
    ticket.next_action.command,
    '```',
  ];
}
