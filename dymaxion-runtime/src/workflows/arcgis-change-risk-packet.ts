// arcgis_change_risk_packet — the agent-callable deterministic change-risk
// workflow. One planner step orchestrates: live public trace → generic packet
// derivation (identities derived from the trace, never locked expectations) →
// deterministic SVG + Markdown → export preview → ONE exact gateway approval
// bound to the full canonical persist payload (which embeds the exact ZIP
// target hash, the SVG artifact bytes, and the Markdown sidecar identity) →
// approved persist through export_evidence_bundle's unchanged approval
// machinery → sidecar publication with per-sink re-verification of the same
// consumed approval → verified attachment metadata for gateway delivery.
//
// Preview, rejection, and expiry persist nothing and deliver nothing.

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
import { containsCredentialMaterial } from '../capabilities/arcgis-rest.js';
import { sha256Canonical, sha256Text } from '../contracts/canonical.js';
import { type EvidenceBundle } from '../contracts/evidence.js';
import { runSkill as defaultRunSkill, type SkillResult } from '../skills/executor.js';
import {
  createApprovalRequest,
  deriveApprovalTarget,
  getApprovalRecord,
  type ApprovalDependencies,
} from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';
import {
  ChangeTicketSchema,
  CountSchema,
  DeterministicSamplesSchema,
  ITEM_ID_RE,
  LIVE_WORDING,
  PacketMetricSchema,
  REVIEW_SCOPE_DISCLAIMER,
  ReviewScopeSchema,
  SACRAMENTO_RE,
  Sha256Schema,
  UUID_RE,
  assertSanitizedTraceServiceReferences,
  buildPacketEvidence,
  decisionSummarySectionLines,
  deriveChangeTicketCore,
  limitationsSectionLines,
  mdCell,
  nextActionSectionLines,
  normalizePortalUrl,
  operatorBaselineSectionLines,
  publicArcgisOnlineOrgRootProblem,
  renderDependencyMapSvg,
  ticketFactSectionLines,
  type TraceNode,
} from './change-risk-packet-core.js';
import {
  WorkflowManifestSchema,
  type DeliveredAttachment,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
  type WorkflowExecutionResult,
} from './contract.js';
import {
  deliverableHandle,
  deliverablePath,
  parseDeliverableHandle,
  readVerifiedDeliverable,
  storeDeliverable,
  trustedArtifactRootFromEnv,
} from './deliverable-storage.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export const WORKFLOW_SLUG = 'arcgis_change_risk_packet';
export const WORKFLOW_VERSION = '1.0.0';

export const MARKDOWN_ENTRY = 'change-ticket.md' as const;
export const SVG_ENTRY = 'dependency-map.svg' as const;
export const MARKDOWN_MEDIA_TYPE = 'text/markdown; charset=utf-8';
export const SVG_MEDIA_TYPE = 'image/svg+xml; charset=utf-8';
export const ZIP_MEDIA_TYPE = 'application/zip';

// Shell-safe display label: fits inside single quotes in the copy-ready CLI
// command, so quotes, backticks, dollar signs, and backslashes are rejected
// at the schema, not escaped later.
const ORGANIZATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.()&-]{0,158}$/;

export const ArcgisChangeRiskPacketInputSchema = z
  .object({
    portal_url: z.string().url().max(2_048),
    root_item_id: z.string().regex(ITEM_ID_RE),
    project_id: z.string().regex(UUID_RE),
    review_posture: z.enum(['retirement_cleanup', 'change_review']),
    organization_name: z
      .string()
      .regex(ORGANIZATION_NAME_RE, 'organization_name allows only letters, digits, spaces, and , . ( ) & -')
      .refine((value) => !value.endsWith(' '), 'organization_name must not end with a space')
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (SACRAMENTO_RE.test(`${input.portal_url} ${input.organization_name ?? ''}`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['portal_url'],
        message: 'Sacramento targets are prohibited',
      });
    }
    const portalProblem = publicArcgisOnlineOrgRootProblem(input.portal_url, {
      noExplicitPort: 'portal_url must be an ArcGIS Online organization root with no explicit port',
      publicAgolOnly: 'this workflow accepts only public ArcGIS Online organization roots',
      noPathOrPort: 'portal_url must be an ArcGIS Online organization root with no path or port',
    });
    if (portalProblem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_url'], message: portalProblem });
    }
    if (input.organization_name && containsCredentialMaterial(input.organization_name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['organization_name'],
        message: 'organization_name contains credential-shaped material',
      });
    }
  });

export type ArcgisChangeRiskPacketInput = z.infer<typeof ArcgisChangeRiskPacketInputSchema>;

/** Exact copy-ready rerun command; every value is schema-validated so the
 * command stays code-owned and shell-safe. */
export function buildChangeRiskPacketCommand(input: {
  portal_url: string;
  root_item_id: string;
  project_id: string;
  review_posture: 'retirement_cleanup' | 'change_review';
  organization_name?: string | null;
}): string {
  const organizationName = input.organization_name ?? null;
  return [
    'dymaxion change-risk-packet \\',
    `  --portal-url ${normalizePortalUrl(input.portal_url)} \\`,
    `  --root-item-id ${input.root_item_id} \\`,
    `  --project-id ${input.project_id} \\`,
    `  --review-posture ${input.review_posture}${organizationName ? ' \\' : ''}`,
    ...(organizationName ? [`  --organization-name '${organizationName}'`] : []),
  ].join('\n');
}

export const ChangeRiskPacketReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    workflow: z
      .object({ slug: z.literal(WORKFLOW_SLUG), version: z.literal(WORKFLOW_VERSION) })
      .strict(),
    subject: z
      .object({
        label: z.string().regex(/^change-risk-[a-f0-9]{32}$/),
        project_id: z.string().regex(UUID_RE),
        organization_name: z.string().regex(ORGANIZATION_NAME_RE).nullable(),
        organization_label: z.string().min(1).max(160),
        portal_url: z.string().url(),
        review_posture: z.enum(['retirement_cleanup', 'change_review']),
      })
      .strict(),
    source_identity: z
      .object({
        root_item_id: z.string().regex(ITEM_ID_RE),
        root_title: z.string().min(1),
        web_map_id: z.string().regex(ITEM_ID_RE),
        web_map_title: z.string().min(1).nullable(),
        derived_from_live_trace: z.literal(true),
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
    const expected = buildChangeRiskPacketCommand({
      portal_url: report.subject.portal_url,
      root_item_id: report.source_identity.root_item_id,
      project_id: report.subject.project_id,
      review_posture: report.subject.review_posture,
      organization_name: report.subject.organization_name,
    });
    if (report.change_ticket.next_action.command !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['change_ticket', 'next_action', 'command'],
        message: 'next_action.command must equal the code-owned workflow rerun command',
      });
    }
    if (report.subject.label !== `change-risk-${report.source_identity.root_item_id}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject', 'label'],
        message: 'subject.label must be derived from the root item id',
      });
    }
  });

export type ChangeRiskPacketReport = z.infer<typeof ChangeRiskPacketReportSchema>;

const DeliverableIdentitySchema = z
  .object({
    entry: z.enum([MARKDOWN_ENTRY, SVG_ENTRY]),
    file_name: z.string().min(1).max(160),
    media_type: z.enum([MARKDOWN_MEDIA_TYPE, SVG_MEDIA_TYPE]),
    sha256: Sha256Schema,
    bytes: CountSchema.min(1),
  })
  .strict();

const AttachmentMetadataSchema = z
  .object({
    name: z.string().min(1).max(160),
    original_name: z.string().min(1).max(160),
    media_type: z.string().min(1),
    sha256: Sha256Schema,
    bytes: CountSchema.min(1),
    handle: z.string().min(1).max(300),
  })
  .strict();

export const ArcgisChangeRiskPacketOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    workflow: z
      .object({ slug: z.literal(WORKFLOW_SLUG), version: z.literal(WORKFLOW_VERSION) })
      .strict(),
    outcome: z.enum(['persisted', 'rejected', 'expired']),
    report: ChangeRiskPacketReportSchema,
    sidecar_deliverables: z
      .object({ markdown: DeliverableIdentitySchema, svg: DeliverableIdentitySchema })
      .strict(),
    preview: z.object({ archive_sha256: Sha256Schema, archive_bytes: CountSchema.min(1) }).strict(),
    persist: z
      .object({
        handle: z.string().min(1),
        archive_sha256: Sha256Schema,
        archive_bytes: CountSchema.min(1),
        created: z.boolean(),
        read_back_verified: z.literal(true),
      })
      .strict()
      .nullable(),
    attachments: z.array(AttachmentMetadataSchema).max(3),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.outcome === 'persisted') {
      if (!output.persist || output.attachments.length !== 3) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachments'],
          message: 'persisted outcome requires the persist record and exactly three attachments',
        });
        return;
      }
      if (output.persist.archive_sha256 !== output.preview.archive_sha256) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['persist', 'archive_sha256'],
          message: 'persisted archive must match the approved preview hash',
        });
      }

      const expected = new Map([
        ['bundle.zip', {
          originalName: 'evidence-bundle.zip',
          mediaType: ZIP_MEDIA_TYPE,
          sha256: output.persist.archive_sha256,
          bytes: output.persist.archive_bytes,
          entry: 'bundle.zip' as const,
        }],
        [MARKDOWN_ENTRY, {
          originalName: output.sidecar_deliverables.markdown.file_name,
          mediaType: MARKDOWN_MEDIA_TYPE,
          sha256: output.sidecar_deliverables.markdown.sha256,
          bytes: output.sidecar_deliverables.markdown.bytes,
          entry: MARKDOWN_ENTRY,
        }],
        [SVG_ENTRY, {
          originalName: output.sidecar_deliverables.svg.file_name,
          mediaType: SVG_MEDIA_TYPE,
          sha256: output.sidecar_deliverables.svg.sha256,
          bytes: output.sidecar_deliverables.svg.bytes,
          entry: SVG_ENTRY,
        }],
      ]);

      for (const [index, attachment] of output.attachments.entries()) {
        const identity = expected.get(attachment.name);
        let parsedHandle: ReturnType<typeof parseDeliverableHandle> | undefined;
        try {
          parsedHandle = parseDeliverableHandle(attachment.handle);
        } catch {
          // The generic issue below intentionally avoids echoing the rejected handle.
        }
        if (
          !identity
          || attachment.original_name !== identity.originalName
          || attachment.media_type !== identity.mediaType
          || attachment.sha256 !== identity.sha256
          || attachment.bytes !== identity.bytes
          || !parsedHandle
          || parsedHandle.projectId !== output.report.subject.project_id
          || parsedHandle.bundleSha256 !== output.persist.archive_sha256
          || parsedHandle.entry !== identity.entry
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['attachments', index],
            message: 'attachment metadata is not bound to the persisted deliverable identity',
          });
        }
      }
      if (new Set(output.attachments.map((attachment) => attachment.name)).size !== expected.size) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachments'],
          message: 'attachments must contain each required deliverable exactly once',
        });
      }
      try {
        const persistedHandle = parseDeliverableHandle(output.persist.handle);
        if (
          persistedHandle.projectId !== output.report.subject.project_id
          || persistedHandle.bundleSha256 !== output.persist.archive_sha256
          || persistedHandle.entry !== 'bundle.zip'
        ) {
          throw new Error('mismatch');
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['persist', 'handle'],
          message: 'persist handle is not bound to the persisted archive identity',
        });
      }
    } else if (output.persist !== null || output.attachments.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: 'rejected/expired outcomes persist and deliver nothing',
      });
    }
  });

export type ArcgisChangeRiskPacketOutput = z.infer<typeof ArcgisChangeRiskPacketOutputSchema>;

interface DerivedIdentity {
  root: TraceNode;
  webMap: TraceNode;
}

/** Derive the packet identity from the live trace — no expected titles or
 * locked Web Map IDs are accepted from the caller. */
export function derivePacketIdentityFromTrace(
  input: ArcgisChangeRiskPacketInput,
  trace: TraceArcgisDependenciesOutput,
): DerivedIdentity {
  const report = trace.report;
  if (normalizePortalUrl(report.portal.url) !== normalizePortalUrl(input.portal_url)) {
    throw new Error('trace portal identity does not match the requested portal');
  }
  const rootId = `item:${input.root_item_id}`;
  const root = report.nodes.find((node) => node.id === rootId);
  if (!root || root.kind !== 'item' || root.item_id !== input.root_item_id || !root.is_root) {
    throw new Error('root item is missing from the dependency graph');
  }
  if (root.type !== 'Web Mapping Application') {
    throw new Error('root item is not a Web Mapping Application; this workflow reviews app → Web Map dependencies only');
  }
  if (!root.title) {
    throw new Error('root item has no public title; refusing to build a packet without an honest source identity');
  }
  const webMapTargets = [
    ...new Set(
      report.edges
        .filter((edge) => edge.from === rootId && edge.relationship === 'web_map')
        .map((edge) => edge.to),
    ),
  ];
  if (webMapTargets.length !== 1) {
    throw new Error(`expected exactly one Web Map reference from the root application, found ${webMapTargets.length}`);
  }
  const webMap = report.nodes.find((node) => node.id === webMapTargets[0]);
  if (!webMap || webMap.kind !== 'item' || webMap.item_id === null) {
    throw new Error('referenced Web Map is missing from the dependency graph');
  }
  if (webMap.type !== 'Web Map') {
    throw new Error('referenced Web Map item is not a Web Map');
  }
  return { root, webMap };
}

export function deriveWorkflowReport(
  input: ArcgisChangeRiskPacketInput,
  trace: TraceArcgisDependenciesOutput,
): ChangeRiskPacketReport {
  assertSanitizedTraceServiceReferences(trace);
  const identity = derivePacketIdentityFromTrace(input, trace);
  const normalizedPortal = normalizePortalUrl(input.portal_url);
  const command = buildChangeRiskPacketCommand({
    portal_url: normalizedPortal,
    root_item_id: input.root_item_id,
    project_id: input.project_id,
    review_posture: input.review_posture,
    organization_name: input.organization_name ?? null,
  });
  const core = deriveChangeTicketCore(
    {
      root_item_id: input.root_item_id,
      web_map_id: identity.webMap.item_id!,
      review_posture: input.review_posture,
      expected_minimum_direct_reference_count: null,
      next_action: {
        description:
          'Have a human ArcGIS administrator complete the operator-baseline protocol, then rerun this packet from the dymaxion-runtime directory with the exact command below.',
        command,
      },
    },
    trace,
    LIVE_WORDING,
  );
  return ChangeRiskPacketReportSchema.parse({
    schema_version: '1.0.0',
    workflow: { slug: WORKFLOW_SLUG, version: WORKFLOW_VERSION },
    subject: {
      label: `change-risk-${input.root_item_id}`,
      project_id: input.project_id,
      organization_name: input.organization_name ?? null,
      organization_label: input.organization_name ?? new URL(normalizedPortal).hostname,
      portal_url: normalizedPortal,
      review_posture: input.review_posture,
    },
    source_identity: {
      root_item_id: input.root_item_id,
      root_title: identity.root.title!,
      web_map_id: identity.webMap.item_id!,
      web_map_title: identity.webMap.title,
      derived_from_live_trace: true,
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

export function renderWorkflowSvg(
  report: ChangeRiskPacketReport,
  trace: TraceArcgisDependenciesOutput,
): string {
  report = ChangeRiskPacketReportSchema.parse(report);
  return renderDependencyMapSvg(
    {
      title_slug: report.subject.label,
      root_title: report.source_identity.root_title,
      organization_label: report.subject.organization_label,
      review_posture: report.subject.review_posture,
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

/**
 * Workflow change-ticket Markdown. Deliberately archive-hash-free: this
 * document is an approved, hash-bound sidecar whose identity is embedded in
 * the approval's canonical persist payload. Embedding the ZIP hash here would
 * make the sidecar/ZIP identity derivation circular. The ZIP hash travels in
 * approval review, delivery metadata, and the deterministic narrative instead.
 */
export function renderWorkflowMarkdown(report: ChangeRiskPacketReport): string {
  report = ChangeRiskPacketReportSchema.parse(report);
  const ticket = report.change_ticket;
  const lines: string[] = [
    `# Change-ticket packet: ${report.subject.label}`,
    '',
    '## Source identity (derived from live trace)',
    '',
    `- Project: \`${report.subject.project_id}\``,
    `- Organization label: ${mdCell(report.subject.organization_label)}${report.subject.organization_name === null ? ' (derived from portal hostname; no operator label supplied)' : ''}`,
    `- Portal: ${report.subject.portal_url} (public ArcGIS Online organization root; anonymous access only)`,
    `- Root item: \`${report.source_identity.root_item_id}\` — ${mdCell(report.source_identity.root_title)} (Web Mapping Application)`,
    `- Web Map: \`${report.source_identity.web_map_id}\`${report.source_identity.web_map_title ? ` — ${mdCell(report.source_identity.web_map_title)}` : ''}`,
    `- Workflow: ${WORKFLOW_SLUG} v${WORKFLOW_VERSION} · report schema ${report.schema_version}`,
    '- Identity source: the root title and Web Map identity above were derived from the live public trace, not from a locked case manifest.',
    '',
    ...decisionSummarySectionLines(report.subject.review_posture, ticket, report.review_scope.disclaimer),
    ...ticketFactSectionLines(ticket),
    '## Evidence, provenance and integrity',
    '',
    `- Trace report SHA-256 (timestamp-bearing): \`${report.hashes.trace_report_sha256}\``,
    `- Trace structure SHA-256 (timestamp-neutral; comparable across reruns): \`${report.hashes.trace_structure_sha256}\``,
    `- Trace evidence SHA-256: \`${report.hashes.trace_evidence_sha256}\``,
    `- ArcGIS REST requests / response bytes: ${report.metrics.request_count} / ${report.metrics.response_bytes}`,
    '- The evidence ZIP and this change-ticket sidecar are independently hash/byte-bound in the operator-approved persist payload and delivery metadata; the ZIP hash is intentionally not embedded here because that would make their deterministic identity derivation circular.',
    '- Timestamp-neutral structure hashes are the rerun-comparable identifiers; the full report hash intentionally embeds retrieval timestamps and per-run request evidence.',
    '',
    ...operatorBaselineSectionLines(ticket),
    ...limitationsSectionLines(report.limitations),
    ...nextActionSectionLines(ticket),
  ];
  return `${lines.join('\n')}\n`;
}

export interface SidecarIdentity {
  entry: typeof MARKDOWN_ENTRY | typeof SVG_ENTRY;
  file_name: string;
  media_type: typeof MARKDOWN_MEDIA_TYPE | typeof SVG_MEDIA_TYPE;
  sha256: string;
  bytes: number;
}

export function buildWorkflowEvidence(
  report: ChangeRiskPacketReport,
  trace: TraceArcgisDependenciesOutput,
  svg: string,
  markdownIdentity: SidecarIdentity,
  generatedAt: string,
): EvidenceBundle {
  report = ChangeRiskPacketReportSchema.parse(report);
  const artifactSha = sha256Text(svg);
  return buildPacketEvidence(
    {
      bundleId: `${WORKFLOW_SLUG}:${report.source_identity.root_item_id}:${artifactSha.slice(0, 16)}`,
      capability: WORKFLOW_SLUG,
      capabilityVersion: WORKFLOW_VERSION,
      format: 'ArcGIS dependency change-risk packet',
      parameters: {
        workflow_slug: WORKFLOW_SLUG,
        workflow_version: WORKFLOW_VERSION,
        portal_url: report.subject.portal_url,
        root_item_id: report.source_identity.root_item_id,
        web_map_id: report.source_identity.web_map_id,
        project_id: report.subject.project_id,
        review_posture: report.subject.review_posture,
        trace_report_sha256: report.hashes.trace_report_sha256,
        artifact_sha256: artifactSha,
        markdown_sha256: markdownIdentity.sha256,
        markdown_bytes: markdownIdentity.bytes,
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

export function buildWorkflowExportInput(
  report: ChangeRiskPacketReport,
  trace: TraceArcgisDependenciesOutput,
  evidence: EvidenceBundle,
  svg: string,
  markdownIdentity: SidecarIdentity,
  svgIdentity: SidecarIdentity,
  operation: 'preview' | 'persist',
  targetBundleSha256?: string,
): ExportEvidenceBundleInput {
  report = ChangeRiskPacketReportSchema.parse(report);
  assertSanitizedTraceServiceReferences(trace);
  return ExportEvidenceBundleInputSchema.parse({
    operation,
    project_id: report.subject.project_id,
    bundle_slug: report.subject.label,
    report: {
      schema_version: '1.0.0',
      review: structuredClone(report),
      trace_report: structuredClone(trace.report),
      trace_evidence: structuredClone(trace.evidence),
      // Binds both sidecar deliverable identities (exact SHA-256 + bytes) into
      // the canonical persist payload the operator approves.
      sidecar_deliverables: {
        markdown: { ...markdownIdentity },
        svg: { ...svgIdentity },
      },
    },
    evidence,
    artifact: {
      output_name: 'arcgis_change_risk_svg',
      file_name: SVG_ENTRY,
      media_type: SVG_MEDIA_TYPE,
      content: svg,
    },
    ...(targetBundleSha256 ? { target_bundle_sha256: targetBundleSha256 } : {}),
  });
}

function traceOutputFromResult(result: SkillResult): TraceArcgisDependenciesOutput {
  if (!result.ok) throw new Error(`trace_arcgis_dependencies failed: ${result.error ?? 'unknown error'}`);
  return TraceArcgisDependenciesOutputSchema.parse(result.output);
}

function exportOutputFromResult(result: SkillResult, operation: 'preview' | 'persist'): ExportEvidenceBundleOutput {
  if (!result.ok) throw new Error(`export_evidence_bundle ${operation} failed: ${result.error ?? 'unknown error'}`);
  return ExportEvidenceBundleOutputSchema.parse(result.output);
}

interface ConsumedAuthorityBinding {
  approvalId: string;
  agentRunId: string;
  payloadHash: string;
  target: string;
  credentialIdentity: string;
}

/** Fail-closed re-verification of the SAME consumed approval record at every
 * additional persistence sink: it must be durably approved, already consumed
 * (once, atomically, by the export persist), and bound to this exact run,
 * canonical payload hash, target, and configured credential identity. */
export async function assertConsumedApprovalAuthority(
  binding: ConsumedAuthorityBinding,
  dependencies?: ApprovalDependencies,
): Promise<void> {
  const record = await getApprovalRecord(binding.approvalId, dependencies);
  if (
    !record ||
    record.decision !== 'approved' ||
    record.consumedAt === null ||
    record.agentRunId !== binding.agentRunId ||
    record.payloadHash !== binding.payloadHash ||
    record.target !== binding.target ||
    record.credentialIdentity !== binding.credentialIdentity
  ) {
    throw new Error('consumed approval authority could not be re-verified at the persistence sink');
  }
}

function sanitizeInline(text: string, max = 80): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(cleaned);
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join('')}…` : cleaned;
}

function buildSummary(
  report: ChangeRiskPacketReport,
  outcome: ArcgisChangeRiskPacketOutput['outcome'],
  attachments: DeliveredAttachment[],
): string {
  const metrics = report.metrics;
  const lines = [
    `ArcGIS change-risk packet for root item ${report.source_identity.root_item_id} — '${sanitizeInline(report.source_identity.root_title)}' (Web Mapping Application).`,
    `Portal ${report.subject.portal_url} (public ArcGIS Online, anonymous metadata only). Derived Web Map ${report.source_identity.web_map_id}.`,
    `Bounded graph: ${metrics.node_count} nodes, ${metrics.edge_count} edges, ${metrics.service_node_count} sanitized service leaves (never contacted), ${metrics.unresolved_reference_count} unresolved reference(s), ${metrics.missing_node_count} missing/inaccessible node(s). Review scope: ${report.review_scope.band} — descriptive proxy only, not a risk score.`,
    `Trace structure SHA-256 (timestamp-neutral): ${report.hashes.trace_structure_sha256}.`,
  ];
  if (outcome === 'persisted') {
    lines.push('Deliverables (persisted after exact operator approval):');
    for (const attachment of attachments) {
      lines.push(`- ${attachment.name} — ${attachment.media_type}, ${attachment.bytes} bytes, SHA-256 ${attachment.sha256}`);
    }
  } else {
    lines.push(
      outcome === 'rejected'
        ? 'Persistence approval was rejected; no deliverable was persisted or delivered.'
        : 'Persistence approval expired; no deliverable was persisted or delivered.',
    );
  }
  lines.push(
    'No authenticated owner inventory, no reverse-dependency search, and no completed human baseline; no time-saved or customer-value claim is made.',
  );
  return lines.join('\n');
}

export const arcgisChangeRiskPacketManifest = WorkflowManifestSchema.parse({
  schema_version: '1.0.0',
  slug: WORKFLOW_SLUG,
  name: 'ArcGIS change-risk change-ticket packet',
  description:
    'Deterministic composed workflow: trace one public ArcGIS Online Web Mapping Application, derive an operator change-ticket packet (Markdown, dependency-map SVG, evidence ZIP), and persist/deliver the three files only after an exact operator approval of the full persist payload.',
  version: WORKFLOW_VERSION,
  kind: 'composed-workflow',
  capabilities_used: ['trace_arcgis_dependencies', 'export_evidence_bundle'],
  requires_gateway_approval: true,
  input_summary: ['portal_url*', 'root_item_id*', 'project_id*', 'review_posture*', 'organization_name'],
  input_schema_version: '1.0.0',
  output_schema_version: '1.0.0',
});

export const arcgisChangeRiskPacketWorkflow: WorkflowDefinition<
  ArcgisChangeRiskPacketInput,
  ArcgisChangeRiskPacketOutput
> = {
  manifest: arcgisChangeRiskPacketManifest,
  inputSchema: ArcgisChangeRiskPacketInputSchema,
  outputSchema: ArcgisChangeRiskPacketOutputSchema,
  async execute(
    rawInput: ArcgisChangeRiskPacketInput,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowExecutionResult<ArcgisChangeRiskPacketOutput>> {
    const input = ArcgisChangeRiskPacketInputSchema.parse(rawInput);
    const runSkillFn = context.runSkillFn ?? defaultRunSkill;
    const now = context.now ?? (() => new Date());
    const agentRunId = context.agentRunId;
    if (!agentRunId) throw new Error('workflow execution requires an agent run id');
    const baseDependencies = {
      ...(context.runSkillDependencies ?? {}),
      capabilityContext: { ...(context.runSkillDependencies?.capabilityContext ?? {}), now },
    };

    // 1. Live public trace (read-only; boundary + Sacramento denylist enforced
    //    by the shared runSkill preflight before any network dispatch).
    const traceInput = {
      portal_url: input.portal_url,
      root_item_ids: [input.root_item_id],
      max_depth: 4,
      max_nodes: 200,
      max_edges: 400,
      max_requests: 200,
    };
    const traceResult = await runSkillFn('trace_arcgis_dependencies', traceInput, agentRunId, baseDependencies);
    const trace = traceOutputFromResult(traceResult);

    // 2. Deterministic packet derivation with live-derived identity.
    const report = deriveWorkflowReport(input, trace);
    const svg = renderWorkflowSvg(report, trace);
    const markdown = renderWorkflowMarkdown(report);
    const markdownIdentity: SidecarIdentity = {
      entry: MARKDOWN_ENTRY,
      file_name: MARKDOWN_ENTRY,
      media_type: MARKDOWN_MEDIA_TYPE,
      sha256: sha256Text(markdown),
      bytes: Buffer.byteLength(markdown, 'utf8'),
    };
    const svgIdentity: SidecarIdentity = {
      entry: SVG_ENTRY,
      file_name: SVG_ENTRY,
      media_type: SVG_MEDIA_TYPE,
      sha256: sha256Text(svg),
      bytes: Buffer.byteLength(svg, 'utf8'),
    };
    const generatedAt = now().toISOString();
    const evidence = buildWorkflowEvidence(report, trace, svg, markdownIdentity, generatedAt);

    // 3. Mutation-free export preview fixes the exact ZIP identity.
    const previewInput = buildWorkflowExportInput(report, trace, evidence, svg, markdownIdentity, svgIdentity, 'preview');
    const previewResult = await runSkillFn(
      'export_evidence_bundle',
      previewInput as Record<string, unknown>,
      agentRunId,
      baseDependencies,
    );
    const preview = exportOutputFromResult(previewResult, 'preview');

    // 4. Exact canonical persist payload: embeds the ZIP target hash, the full
    //    SVG artifact bytes, and both sidecar identities (SHA-256 + bytes).
    const persistInput = buildWorkflowExportInput(
      report,
      trace,
      evidence,
      svg,
      markdownIdentity,
      svgIdentity,
      'persist',
      preview.archive.sha256,
    );
    const credentialIdentity = resolveExecutionCredentialIdentity('export_evidence_bundle');
    const target = deriveApprovalTarget('export_evidence_bundle', persistInput as Record<string, unknown>);
    const approvalRequest = await createApprovalRequest(
      agentRunId,
      `Persist ArcGIS change-risk packet deliverables (evidence ZIP, change-ticket Markdown, dependency-map SVG) for root item ${input.root_item_id} in project ${input.project_id}`,
      persistInput as Record<string, unknown>,
      {
        timeoutMinutes: context.approvalTimeoutMinutes ?? 30,
        target,
        credentialIdentity,
      },
      context.approvalDependencies,
    );

    // 5. The originating gateway presents the approval; the runtime never
    //    decides. Rejection/expiry stops before any persistence.
    const decision = await context.gateway.requestApproval(approvalRequest);
    if (!decision.approved) {
      const outcome = decision.decision === 'expired' ? 'expired' : 'rejected';
      const output = ArcgisChangeRiskPacketOutputSchema.parse({
        schema_version: '1.0.0',
        workflow: { slug: WORKFLOW_SLUG, version: WORKFLOW_VERSION },
        outcome,
        report,
        sidecar_deliverables: { markdown: markdownIdentity, svg: svgIdentity },
        preview: { archive_sha256: preview.archive.sha256, archive_bytes: preview.archive.bytes },
        persist: null,
        attachments: [],
      });
      return { output, deliveries: [], summary: buildSummary(report, outcome, []) };
    }

    // 6. Approved persist through export_evidence_bundle's unchanged approval
    //    machinery: runSkill consumes the approval atomically ONCE, and the
    //    capability re-verifies its execution grant at every storage sink.
    const trustedRootConfigured = context.trustedRoot ?? trustedArtifactRootFromEnv();
    const trustedRootRealpath = await realpath(resolve(trustedRootConfigured));
    const persistResult = await runSkillFn(
      'export_evidence_bundle',
      persistInput as Record<string, unknown>,
      agentRunId,
      {
        ...baseDependencies,
        capabilityContext: {
          ...(baseDependencies.capabilityContext ?? {}),
          io: {
            ...(baseDependencies.capabilityContext?.io ?? {}),
            artifactRoot: trustedRootRealpath,
          },
        },
        approvalRequest,
        approvalDependencies: context.approvalDependencies,
      },
    );
    const persist = exportOutputFromResult(persistResult, 'persist');
    if (persist.archive.sha256 !== preview.archive.sha256 || !persist.archive.read_back_verified) {
      throw new Error('persisted archive did not match the approved preview identity');
    }

    // 7. Sidecar publication. Every sink re-verifies the same consumed
    //    approval record (approved + consumed + exact payload hash/target/
    //    credential identity/agent run) immediately before writing.
    const authorityBinding: ConsumedAuthorityBinding = {
      approvalId: approvalRequest.id,
      agentRunId,
      payloadHash: sha256Canonical(persistInput),
      target,
      credentialIdentity,
    };
    const authorize = async (): Promise<void> =>
      assertConsumedApprovalAuthority(authorityBinding, context.approvalDependencies);
    await authorize();
    const storedMarkdown = await storeDeliverable(
      {
        projectId: input.project_id,
        bundleSha256: persist.archive.sha256,
        entry: MARKDOWN_ENTRY,
        content: markdown,
        expectedSha256: markdownIdentity.sha256,
        expectedBytes: markdownIdentity.bytes,
      },
      { trustedRoot: trustedRootRealpath, authorize },
    );
    const storedSvg = await storeDeliverable(
      {
        projectId: input.project_id,
        bundleSha256: persist.archive.sha256,
        entry: SVG_ENTRY,
        content: svg,
        expectedSha256: svgIdentity.sha256,
        expectedBytes: svgIdentity.bytes,
      },
      { trustedRoot: trustedRootRealpath, authorize },
    );

    // 8. Verified attachment metadata. Each path is revalidated against its
    //    approved identity before it is handed to any delivery surface.
    const zipParsed = { projectId: input.project_id, bundleSha256: persist.archive.sha256, entry: 'bundle.zip' as const };
    const zipPath = deliverablePath(trustedRootRealpath, zipParsed);
    await readVerifiedDeliverable({
      path: zipPath,
      trustedRoot: trustedRootRealpath,
      expectedSha256: persist.archive.sha256,
      expectedBytes: persist.archive.bytes,
    });
    await readVerifiedDeliverable({
      path: storedMarkdown.path,
      trustedRoot: trustedRootRealpath,
      expectedSha256: markdownIdentity.sha256,
      expectedBytes: markdownIdentity.bytes,
    });
    await readVerifiedDeliverable({
      path: storedSvg.path,
      trustedRoot: trustedRootRealpath,
      expectedSha256: svgIdentity.sha256,
      expectedBytes: svgIdentity.bytes,
    });
    const deliveries: DeliveredAttachment[] = [
      {
        name: 'bundle.zip',
        original_name: 'evidence-bundle.zip',
        media_type: ZIP_MEDIA_TYPE,
        sha256: persist.archive.sha256,
        bytes: persist.archive.bytes,
        handle: persist.handle,
        path: zipPath,
      },
      {
        name: MARKDOWN_ENTRY,
        original_name: markdownIdentity.file_name,
        media_type: MARKDOWN_MEDIA_TYPE,
        sha256: markdownIdentity.sha256,
        bytes: markdownIdentity.bytes,
        handle: deliverableHandle({ ...zipParsed, entry: MARKDOWN_ENTRY }),
        path: storedMarkdown.path,
      },
      {
        name: SVG_ENTRY,
        original_name: svgIdentity.file_name,
        media_type: SVG_MEDIA_TYPE,
        sha256: svgIdentity.sha256,
        bytes: svgIdentity.bytes,
        handle: deliverableHandle({ ...zipParsed, entry: SVG_ENTRY }),
        path: storedSvg.path,
      },
    ];

    const output = ArcgisChangeRiskPacketOutputSchema.parse({
      schema_version: '1.0.0',
      workflow: { slug: WORKFLOW_SLUG, version: WORKFLOW_VERSION },
      outcome: 'persisted',
      report,
      sidecar_deliverables: { markdown: markdownIdentity, svg: svgIdentity },
      preview: { archive_sha256: preview.archive.sha256, archive_bytes: preview.archive.bytes },
      persist: {
        handle: persist.handle,
        archive_sha256: persist.archive.sha256,
        archive_bytes: persist.archive.bytes,
        created: persist.created,
        read_back_verified: true,
      },
      attachments: deliveries.map(({ path: _path, ...metadata }) => metadata),
    });
    return { output, deliveries, summary: buildSummary(report, 'persisted', deliveries) };
  },
};
