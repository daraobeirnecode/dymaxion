// Phase 1G deterministic evidence-bundle export. Preview is pure; persist is
// exact-hash, one-time-approval-bound, create-only durable storage.

import { TextDecoder, TextEncoder } from 'node:util';
import { z } from 'zod';
import { canonicalJson, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema, type EvidenceBundle } from '../contracts/evidence.js';
import {
  claimConsumedApprovalReceipt,
  consumeApprovalExecutionGrant,
  verifyConsumedApprovalExecutionGrant,
} from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';
import { containsCredentialMaterial } from './arcgis-rest.js';
import {
  createProjectArtifactStorage,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_BUNDLE_FILES,
  type ProjectArtifactStorage,
} from './artifact-storage.js';
import {
  createDeterministicZip,
  MAX_DETERMINISTIC_ZIP_ENTRIES,
} from './deterministic-zip.js';

export const CAPABILITY_VERSION = '1.0.0';
export const MAX_REPORT_BYTES = 1_048_576;
export const MAX_EVIDENCE_BYTES = 1_048_576;
export const MAX_ARTIFACT_BYTES = 2_097_152;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 20_000;
export const MAX_DURATION_MS = 5_000;
export const ZIP_PROFILE = 'store-fixed-1980-utf8-crc32-v1' as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const SAFE_OUTPUT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.(?:svg|geojson)$/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function inspectJsonValue(value: unknown, context: z.RefinementCtx): void {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number, path: Array<string | number>): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      addIssue(context, path, 'report exceeds JSON node ceiling');
      return;
    }
    if (depth > MAX_JSON_DEPTH) {
      addIssue(context, path, 'report exceeds JSON depth ceiling');
      return;
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) addIssue(context, path, 'report contains non-finite number');
      return;
    }
    if (typeof item !== 'object') {
      addIssue(context, path, `report contains unsupported ${typeof item}`);
      return;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) {
      addIssue(context, path, 'report accepts only plain JSON objects');
      return;
    }
    if (seen.has(item)) {
      addIssue(context, path, 'report must not contain cycles or repeated object references');
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, depth + 1, [...path, index]));
    } else {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (child === undefined) addIssue(context, [...path, key], 'report does not allow undefined');
        else visit(child, depth + 1, [...path, key]);
      }
    }
    seen.delete(item);
  };
  visit(value, 1, []);
}

function strictUtf8Bytes(value: string): Uint8Array {
  if (LONE_SURROGATE_RE.test(value)) throw new Error('artifact content must be valid round-trip UTF-8');
  const bytes = utf8Encoder.encode(value);
  if (fatalUtf8Decoder.decode(bytes) !== value) throw new Error('artifact content must be valid round-trip UTF-8');
  return bytes;
}

function safeName(schema: z.ZodString, label: string): z.ZodEffects<z.ZodString, string, string> {
  return schema.refine((value) => !value.includes('..') && !containsCredentialMaterial(value), {
    message: `${label} contains unsafe or credential-shaped material`,
  });
}

const BundleSlugSchema = safeName(z.string().min(1).max(80).regex(SAFE_SLUG_RE), 'bundle_slug');
const OutputNameSchema = safeName(z.string().min(1).max(80).regex(SAFE_OUTPUT_RE), 'artifact.output_name');
const FileNameSchema = safeName(z.string().min(1).max(128).regex(SAFE_FILE_RE), 'artifact.file_name');
const Sha256Schema = z.string().regex(SHA256_RE);
const CountSchema = z.number().int().nonnegative();

const JsonValueSchema = z.unknown().superRefine(inspectJsonValue);

const ExportArtifactSchema = z
  .object({
    output_name: OutputNameSchema,
    file_name: FileNameSchema,
    media_type: z.enum([
      'image/svg+xml; charset=utf-8',
      'application/geo+json; charset=utf-8',
    ]),
    content: z.string().min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const svg = artifact.file_name.endsWith('.svg');
    const expected = svg
      ? 'image/svg+xml; charset=utf-8'
      : 'application/geo+json; charset=utf-8';
    if (artifact.media_type !== expected) addIssue(context, ['media_type'], 'artifact extension and media_type mismatch');
    try {
      const bytes = strictUtf8Bytes(artifact.content);
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) addIssue(context, ['content'], 'artifact content exceeds byte ceiling');
    } catch (error) {
      addIssue(context, ['content'], error instanceof Error ? error.message : 'artifact content is invalid UTF-8');
    }
  });

export const ExportEvidenceBundleInputSchema = z
  .object({
    operation: z.enum(['preview', 'persist']),
    project_id: z.string().regex(UUID_RE),
    bundle_slug: BundleSlugSchema,
    report: JsonValueSchema,
    evidence: EvidenceBundleSchema,
    artifact: ExportArtifactSchema,
    target_bundle_sha256: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation === 'preview' && input.target_bundle_sha256 !== undefined) {
      addIssue(context, ['target_bundle_sha256'], 'target_bundle_sha256 is only valid for persist');
    }
    if (input.operation === 'persist' && input.target_bundle_sha256 === undefined) {
      addIssue(context, ['target_bundle_sha256'], 'target_bundle_sha256 is required for persist');
    }
    try {
      if (utf8Encoder.encode(canonicalJson(input.report)).byteLength > MAX_REPORT_BYTES) {
        addIssue(context, ['report'], 'report exceeds byte ceiling');
      }
    } catch (error) {
      addIssue(context, ['report'], error instanceof Error ? error.message : 'report is not canonical JSON');
    }
    try {
      if (utf8Encoder.encode(canonicalJson(input.evidence)).byteLength > MAX_EVIDENCE_BYTES) {
        addIssue(context, ['evidence'], 'evidence exceeds byte ceiling');
      }
    } catch (error) {
      addIssue(context, ['evidence'], error instanceof Error ? error.message : 'evidence is not canonical JSON');
    }
    let artifactBytes: Uint8Array;
    try {
      artifactBytes = strictUtf8Bytes(input.artifact.content);
    } catch {
      return;
    }
    const outputs = input.evidence.outputs;
    const output = outputs.length === 1 ? outputs[0] : undefined;
    if (!output) {
      addIssue(context, ['evidence', 'outputs'], 'evidence must contain exactly one artifact output');
    } else {
      if (output.name !== input.artifact.output_name) addIssue(context, ['evidence', 'outputs', 0, 'name'], 'artifact output name mismatch');
      if (output.sha256 !== sha256Text(artifactBytes)) addIssue(context, ['evidence', 'outputs', 0, 'sha256'], 'artifact output sha256 mismatch');
      if (output.bytes !== artifactBytes.byteLength) addIssue(context, ['evidence', 'outputs', 0, 'bytes'], 'artifact output bytes mismatch');
    }
  });

const ManifestEntryBaseSchema = z
  .object({ path: z.string().min(1), media_type: z.string().min(1) })
  .strict();
const ManifestJsonEntrySchema = z
  .object({
    path: z.literal('manifest.json'),
    media_type: z.literal('application/json; charset=utf-8'),
  })
  .strict();
const ManifestJsonHashedEntrySchema = z
  .object({
    path: z.enum(['report.json', 'evidence.json']),
    media_type: z.literal('application/json; charset=utf-8'),
    sha256: Sha256Schema,
    bytes: CountSchema,
  })
  .strict();
const ManifestArtifactEntrySchema = ManifestEntryBaseSchema.extend({
  sha256: Sha256Schema,
  bytes: CountSchema,
  output_name: OutputNameSchema,
}).strict();

export const BundleManifestSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    bundle_slug: BundleSlugSchema,
    project_id: z.string().regex(UUID_RE),
    created_by: z
      .object({ capability: z.literal('export_evidence_bundle'), capability_version: z.literal(CAPABILITY_VERSION) })
      .strict(),
    zip_profile: z.literal(ZIP_PROFILE),
    entries: z
      .object({
        manifest: ManifestJsonEntrySchema,
        report: ManifestJsonHashedEntrySchema.extend({ path: z.literal('report.json') }).strict(),
        evidence: ManifestJsonHashedEntrySchema.extend({ path: z.literal('evidence.json') }).strict(),
        artifact: ManifestArtifactEntrySchema,
      })
      .strict(),
    raw_sources_included: z.literal(false),
  })
  .strict();

export const ExportBundleReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    project_id: z.string().regex(UUID_RE),
    bundle_slug: BundleSlugSchema,
    archive_sha256: Sha256Schema,
    archive_bytes: CountSchema,
    entry_count: z.literal(4),
    zip_profile: z.literal(ZIP_PROFILE),
    report: z.object({ sha256: Sha256Schema, bytes: CountSchema }).strict(),
    evidence: z.object({ sha256: Sha256Schema, bytes: CountSchema }).strict(),
    artifact: z
      .object({ output_name: OutputNameSchema, file_name: FileNameSchema, media_type: z.string().min(1), sha256: Sha256Schema, bytes: CountSchema })
      .strict(),
    raw_sources_included: z.literal(false),
  })
  .strict();

export const ExportEvidenceBundleOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    operation: z.enum(['preview', 'persist']),
    persisted: z.boolean(),
    created: z.boolean(),
    handle: z.string().regex(/^artifact:\/\/project\/[0-9a-f-]+\/bundle\/[a-f0-9]{64}$/),
    archive: z
      .object({
        media_type: z.literal('application/zip'),
        sha256: Sha256Schema,
        bytes: CountSchema,
        entries: z.literal(4),
        zip_profile: z.literal(ZIP_PROFILE),
        read_back_verified: z.boolean(),
      })
      .strict(),
    manifest: BundleManifestSchema,
    export_report: ExportBundleReportSchema,
    export_evidence: EvidenceBundleSchema,
  })
  .strict()
  .superRefine((output, context) => {
    const expectedHandle = `artifact://project/${output.manifest.project_id}/bundle/${output.archive.sha256}`;
    if (output.handle !== expectedHandle) addIssue(context, ['handle'], 'handle does not match archive and project');
    const persist = output.operation === 'persist';
    if (output.persisted !== persist) addIssue(context, ['persisted'], 'persisted does not match operation');
    if (output.created && !persist) addIssue(context, ['created'], 'preview cannot create an artifact');
    if (output.archive.read_back_verified !== persist) addIssue(context, ['archive', 'read_back_verified'], 'read-back claim does not match operation');
    if (output.manifest.zip_profile !== output.archive.zip_profile || output.export_report.zip_profile !== output.archive.zip_profile) {
      addIssue(context, ['manifest', 'zip_profile'], 'ZIP profile mismatch');
    }
    if (output.export_report.entry_count !== output.archive.entries) {
      addIssue(context, ['export_report', 'entry_count'], 'entry count mismatch');
    }
    if (output.export_report.archive_sha256 !== output.archive.sha256 || output.export_report.archive_bytes !== output.archive.bytes) {
      addIssue(context, ['export_report'], 'export report archive binding mismatch');
    }
    if (output.export_report.project_id !== output.manifest.project_id || output.export_report.bundle_slug !== output.manifest.bundle_slug) {
      addIssue(context, ['export_report'], 'export report manifest binding mismatch');
    }
    const manifestReport = output.manifest.entries.report;
    if (manifestReport.sha256 !== output.export_report.report.sha256 || manifestReport.bytes !== output.export_report.report.bytes) {
      addIssue(context, ['manifest', 'entries', 'report'], 'manifest report binding mismatch');
    }
    const manifestEvidence = output.manifest.entries.evidence;
    if (manifestEvidence.sha256 !== output.export_report.evidence.sha256 || manifestEvidence.bytes !== output.export_report.evidence.bytes) {
      addIssue(context, ['manifest', 'entries', 'evidence'], 'manifest evidence binding mismatch');
    }
    const manifestArtifact = output.manifest.entries.artifact;
    const reportArtifact = output.export_report.artifact;
    if (
      manifestArtifact.path !== reportArtifact.file_name ||
      manifestArtifact.output_name !== reportArtifact.output_name ||
      manifestArtifact.media_type !== reportArtifact.media_type ||
      manifestArtifact.sha256 !== reportArtifact.sha256 ||
      manifestArtifact.bytes !== reportArtifact.bytes
    ) {
      addIssue(context, ['manifest', 'entries', 'artifact'], 'manifest artifact binding mismatch');
    }
    if (
      output.export_evidence.source.sha256 !== manifestEvidence.sha256 ||
      output.export_evidence.source.bytes !== manifestEvidence.bytes ||
      output.export_evidence.source.uri !== `dymaxion:inline-evidence:${manifestEvidence.sha256}` ||
      output.export_evidence.source.identity.kind !== 'inline-evidence' ||
      output.export_evidence.source.identity.value !== manifestEvidence.sha256
    ) {
      addIssue(context, ['export_evidence', 'source'], 'export evidence source binding mismatch');
    }
    const expectedReplayFacts = {
      operation: output.operation,
      project_id: output.manifest.project_id,
      bundle_slug: output.manifest.bundle_slug,
      report: output.export_report.report,
      upstream_evidence: output.export_report.evidence,
      artifact: {
        output_name: reportArtifact.output_name,
        file_name: reportArtifact.file_name,
        media_type: reportArtifact.media_type,
        sha256: reportArtifact.sha256,
        bytes: reportArtifact.bytes,
      },
      ...(persist ? { target_bundle_sha256: output.archive.sha256 } : {}),
    };
    const expectedParametersJson = canonicalJson(expectedReplayFacts);
    if (
      output.export_evidence.parameters.canonical_json !== expectedParametersJson ||
      output.export_evidence.parameters.sha256 !== sha256Text(expectedParametersJson)
    ) {
      addIssue(context, ['export_evidence', 'parameters'], 'export evidence parameter binding mismatch');
    }
    const exportOutput = output.export_evidence.outputs[0];
    if (
      output.export_evidence.outputs.length !== 1 ||
      exportOutput?.name !== 'evidence_bundle_zip' ||
      exportOutput.sha256 !== output.archive.sha256 ||
      exportOutput.bytes !== output.archive.bytes
    ) {
      addIssue(context, ['export_evidence', 'outputs'], 'export evidence archive binding mismatch');
    }
    if (output.export_evidence.bundle_id !== `export_evidence_bundle:${output.archive.sha256}`) {
      addIssue(context, ['export_evidence', 'bundle_id'], 'export evidence bundle id mismatch');
    }
    if (output.export_evidence.approvals.length !== 0) {
      addIssue(context, ['export_evidence', 'approvals'], 'export response must not serialize unverifiable approval claims');
    }
  });

export type ExportEvidenceBundleInput = z.infer<typeof ExportEvidenceBundleInputSchema>;
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type ExportEvidenceBundleOutput = z.infer<typeof ExportEvidenceBundleOutputSchema>;

type PreparedBundle = {
  archiveBytes: Uint8Array;
  archiveSha256: string;
  manifest: BundleManifest;
  exportReport: z.infer<typeof ExportBundleReportSchema>;
  reportSha256: string;
  reportBytes: number;
  upstreamEvidenceSha256: string;
  upstreamEvidenceBytes: number;
  artifactSha256: string;
  artifactBytes: number;
};

function checkpoint(started: number, context: CapabilityExecutionContext): void {
  if (context.signal?.aborted) throw new Error('export evidence bundle cancelled');
  const now = context.monotonicNow ?? (() => performance.now());
  if (now() - started > MAX_DURATION_MS) throw new Error('export evidence bundle duration exceeded');
}

function assembleBundle(input: ExportEvidenceBundleInput, context: CapabilityExecutionContext, started: number): PreparedBundle {
  checkpoint(started, context);
  const reportBytes = utf8Encoder.encode(canonicalJson(input.report));
  const upstreamEvidence = EvidenceBundleSchema.parse(input.evidence);
  const evidenceBytes = utf8Encoder.encode(canonicalJson(upstreamEvidence));
  const artifactBytes = strictUtf8Bytes(input.artifact.content);
  if (reportBytes.byteLength > MAX_REPORT_BYTES) throw new Error('report exceeds byte ceiling');
  if (evidenceBytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error('evidence exceeds byte ceiling');
  if (artifactBytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact content exceeds byte ceiling');

  const reportSha256 = sha256Text(reportBytes);
  const evidenceSha256 = sha256Text(evidenceBytes);
  const artifactSha256 = sha256Text(artifactBytes);
  const manifest = BundleManifestSchema.parse({
    schema_version: '1.0.0',
    bundle_slug: input.bundle_slug,
    project_id: input.project_id,
    created_by: { capability: 'export_evidence_bundle', capability_version: CAPABILITY_VERSION },
    zip_profile: ZIP_PROFILE,
    entries: {
      manifest: { path: 'manifest.json', media_type: 'application/json; charset=utf-8' },
      report: { path: 'report.json', media_type: 'application/json; charset=utf-8', sha256: reportSha256, bytes: reportBytes.byteLength },
      evidence: { path: 'evidence.json', media_type: 'application/json; charset=utf-8', sha256: evidenceSha256, bytes: evidenceBytes.byteLength },
      artifact: {
        path: input.artifact.file_name,
        media_type: input.artifact.media_type,
        output_name: input.artifact.output_name,
        sha256: artifactSha256,
        bytes: artifactBytes.byteLength,
      },
    },
    raw_sources_included: false,
  });
  const manifestBytes = utf8Encoder.encode(canonicalJson(manifest));
  checkpoint(started, context);
  const archive = createDeterministicZip([
    { name: 'manifest.json', bytes: manifestBytes },
    { name: 'report.json', bytes: reportBytes },
    { name: 'evidence.json', bytes: evidenceBytes },
    { name: input.artifact.file_name, bytes: artifactBytes },
  ]);
  if (archive.entries.length !== 4 || archive.bytes.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new Error('evidence bundle archive exceeds contract');
  }
  const exportReport = ExportBundleReportSchema.parse({
    schema_version: '1.0.0',
    project_id: input.project_id,
    bundle_slug: input.bundle_slug,
    archive_sha256: archive.sha256,
    archive_bytes: archive.bytes.byteLength,
    entry_count: 4,
    zip_profile: ZIP_PROFILE,
    report: { sha256: reportSha256, bytes: reportBytes.byteLength },
    evidence: { sha256: evidenceSha256, bytes: evidenceBytes.byteLength },
    artifact: {
      output_name: input.artifact.output_name,
      file_name: input.artifact.file_name,
      media_type: input.artifact.media_type,
      sha256: artifactSha256,
      bytes: artifactBytes.byteLength,
    },
    raw_sources_included: false,
  });
  return {
    archiveBytes: archive.bytes,
    archiveSha256: archive.sha256,
    manifest,
    exportReport,
    reportSha256,
    reportBytes: reportBytes.byteLength,
    upstreamEvidenceSha256: evidenceSha256,
    upstreamEvidenceBytes: evidenceBytes.byteLength,
    artifactSha256,
    artifactBytes: artifactBytes.byteLength,
  };
}

function buildExportEvidence(
  input: ExportEvidenceBundleInput,
  prepared: PreparedBundle,
  generatedAt: string,
): EvidenceBundle {
  const replayFacts = {
    operation: input.operation,
    project_id: input.project_id,
    bundle_slug: input.bundle_slug,
    report: { sha256: prepared.reportSha256, bytes: prepared.reportBytes },
    upstream_evidence: { sha256: prepared.upstreamEvidenceSha256, bytes: prepared.upstreamEvidenceBytes },
    artifact: {
      output_name: input.artifact.output_name,
      file_name: input.artifact.file_name,
      media_type: input.artifact.media_type,
      sha256: prepared.artifactSha256,
      bytes: prepared.artifactBytes,
    },
    ...(input.target_bundle_sha256 ? { target_bundle_sha256: input.target_bundle_sha256 } : {}),
  };
  const parametersJson = canonicalJson(replayFacts);
  return EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `export_evidence_bundle:${prepared.archiveSha256}`,
    generated_at: generatedAt,
    source: {
      uri: `dymaxion:inline-evidence:${prepared.upstreamEvidenceSha256}`,
      identity: { kind: 'inline-evidence', value: prepared.upstreamEvidenceSha256 },
      version: {},
      retrieved_at: generatedAt,
      sha256: prepared.upstreamEvidenceSha256,
      bytes: prepared.upstreamEvidenceBytes,
    },
    gis_metadata: {
      format: 'Dymaxion evidence bundle',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: 1,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: { canonical_json: parametersJson, sha256: sha256Text(parametersJson) },
    execution: {
      capability: 'export_evidence_bundle',
      capability_version: CAPABILITY_VERSION,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'evidence_bundle_zip',
        sha256: prepared.archiveSha256,
        bytes: prepared.archiveBytes.byteLength,
        validation: {
          valid: true,
          checks: [
            `deterministic ZIP profile ${ZIP_PROFILE}`,
            'four entry hashes and byte counts verified',
            ...(input.operation === 'persist' ? ['durable storage read-back verified'] : []),
          ],
          warnings: [],
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
}

function defaultArtifactRoot(): string {
  const configured = process.env.DYMAXION_ARTIFACT_ROOT?.trim() || process.env.DYMAXION_WORKSPACE_ROOT?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '/workspace';
  throw new Error('trusted artifact root is not configured');
}

function injectedArtifactRoot(context: CapabilityExecutionContext): string | undefined {
  const candidate = context.io?.artifactRoot;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new Error('invalid injected artifact root');
  }
  return candidate;
}

function injectedStorage(context: CapabilityExecutionContext): ProjectArtifactStorage | undefined {
  const candidate = context.io?.artifactStorage;
  if (!candidate) return undefined;
  if (typeof candidate !== 'object' || typeof (candidate as { storeBundle?: unknown }).storeBundle !== 'function') {
    throw new Error('invalid injected artifact storage');
  }
  return candidate as ProjectArtifactStorage;
}

async function preflight(input: ExportEvidenceBundleInput, context: CapabilityExecutionContext): Promise<void> {
  if (input.operation !== 'persist') return;
  const prepared = assembleBundle(input, context, (context.monotonicNow ?? (() => performance.now()))());
  if (input.target_bundle_sha256 !== prepared.archiveSha256) throw new Error('target_bundle_sha256 mismatch');
}

export const exportEvidenceBundleManifest = CapabilityManifestSchema.parse({
  schema_version: '1.0.0',
  slug: 'export_evidence_bundle',
  name: 'Export evidence bundle',
  description: 'Build a deterministic four-entry evidence ZIP and optionally persist it create-only by exact preview hash.',
  version: CAPABILITY_VERSION,
  classification: 'copy-on-write',
  identity: { required: false, permissions: [], credential_kinds: ['operator-configured-execution-identity'] },
  allowed_hosts: [],
  allowed_sources: ['inline-report', 'inline-evidence', 'inline-utf8-artifact'],
  resource_limits: {
    max_records: 1,
    max_bytes: MAX_REPORT_BYTES + MAX_EVIDENCE_BYTES + MAX_ARTIFACT_BYTES,
    max_duration_ms: MAX_DURATION_MS,
    max_cost_usd: 0,
    max_json_depth: MAX_JSON_DEPTH,
    max_json_nodes: MAX_JSON_NODES,
    max_report_bytes: MAX_REPORT_BYTES,
    max_evidence_bytes: MAX_EVIDENCE_BYTES,
    max_artifact_bytes: MAX_ARTIFACT_BYTES,
    max_archive_bytes: MAX_ARTIFACT_ARCHIVE_BYTES,
    max_archive_entries: MAX_DETERMINISTIC_ZIP_ENTRIES,
    max_project_bytes: MAX_PROJECT_ARTIFACT_BYTES,
    max_project_bundles: MAX_PROJECT_BUNDLE_FILES,
  },
  idempotency: { mode: 'deterministic', key_fields: ['project_id', 'target_bundle_sha256'] },
  dry_run: { supported: true, reason: 'preview builds identical archive bytes without storage mutation' },
  cancellation: { supported: true, checkpoint: 'validation, ZIP assembly, approval verification, quota, write and read-back boundaries' },
  artifacts: [{ name: 'evidence_bundle_zip', media_type: 'application/zip', required: true }],
  rollback: { supported: false, strategy: 'create-only content-addressed artifact; no deletion', reason: 'idempotent exact content requires no rollback' },
  validation: { suite: 'gisbench', version: '1.0.0', supported_gis_versions: ['GeoJSON RFC 7946', 'SVG 1.1'] },
  input_schema_version: '1.0.0',
  output_schema_version: '1.0.0',
});

export const exportEvidenceBundleCapability: CapabilityDefinition<
  ExportEvidenceBundleInput,
  ExportEvidenceBundleOutput
> = {
  manifest: exportEvidenceBundleManifest,
  inputSchema: ExportEvidenceBundleInputSchema,
  outputSchema: ExportEvidenceBundleOutputSchema,
  inputSummary: ['operation', 'project_id', 'bundle_slug', 'artifact.file_name', 'target_bundle_sha256'],
  boundaryFields: [],
  requiresApproval: (input) => input.operation === 'persist',
  preflight,
  async execute(input, context) {
    const monotonicNow = context.monotonicNow ?? (() => performance.now());
    const started = monotonicNow();
    const prepared = assembleBundle(input, context, started);
    const handle = `artifact://project/${input.project_id}/bundle/${prepared.archiveSha256}`;
    const generatedAt = (context.now ?? (() => new Date()))().toISOString();

    if (input.operation === 'preview') {
      return ExportEvidenceBundleOutputSchema.parse({
        schema_version: '1.0.0',
        operation: 'preview',
        persisted: false,
        created: false,
        handle,
        archive: {
          media_type: 'application/zip',
          sha256: prepared.archiveSha256,
          bytes: prepared.archiveBytes.byteLength,
          entries: 4,
          zip_profile: ZIP_PROFILE,
          read_back_verified: false,
        },
        manifest: prepared.manifest,
        export_report: prepared.exportReport,
        export_evidence: buildExportEvidence(input, prepared, generatedAt),
      });
    }

    if (input.target_bundle_sha256 !== prepared.archiveSha256) throw new Error('target_bundle_sha256 mismatch');
    if (!context.agentRunId) throw new Error('consumed approval receipt binding mismatch');
    checkpoint(started, context);
    const credentialIdentity = resolveExecutionCredentialIdentity('export_evidence_bundle');
    const approvalBinding = {
      agentRunId: context.agentRunId,
      skill: 'export_evidence_bundle',
      payload: input,
      credentialIdentity,
    };
    const approvalGrant = context.approvalExecutionGrant
      ?? claimConsumedApprovalReceipt(context.approvalReceipt, approvalBinding);
    const approval = consumeApprovalExecutionGrant(approvalGrant, approvalBinding);
    const authorizeSink = (): void => {
      verifyConsumedApprovalExecutionGrant(approvalGrant, approvalBinding);
    };
    checkpoint(started, context);
    const storage = injectedStorage(context) ?? createProjectArtifactStorage({
      trustedRoot: injectedArtifactRoot(context) ?? defaultArtifactRoot(),
      authorizeSink,
    });
    authorizeSink();
    const stored = await storage.storeBundle({
      projectId: input.project_id,
      bundleSha256: prepared.archiveSha256,
      archiveBytes: prepared.archiveBytes,
      signal: context.signal,
    });
    if (!stored.readbackVerified || stored.sha256 !== prepared.archiveSha256 || stored.bytes !== prepared.archiveBytes.byteLength || stored.handle !== handle) {
      throw new Error('artifact storage integrity result mismatch');
    }
    checkpoint(started, context);
    return ExportEvidenceBundleOutputSchema.parse({
      schema_version: '1.0.0',
      operation: 'persist',
      persisted: true,
      created: stored.created,
      handle: stored.handle,
      archive: {
        media_type: 'application/zip',
        sha256: prepared.archiveSha256,
        bytes: prepared.archiveBytes.byteLength,
        entries: 4,
        zip_profile: ZIP_PROFILE,
        read_back_verified: true,
      },
      manifest: prepared.manifest,
      export_report: prepared.exportReport,
      export_evidence: buildExportEvidence(input, prepared, generatedAt),
    });
  },
};
