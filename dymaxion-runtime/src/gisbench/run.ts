import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalFormBody, type ArcGisRestTransport } from '../capabilities/arcgis-rest.js';
import { createProjectArtifactStorage, type ProjectArtifactStorage } from '../capabilities/artifact-storage.js';
import { createDeterministicZip } from '../capabilities/deterministic-zip.js';
import { ExportEvidenceBundleInputSchema } from '../capabilities/export-evidence-bundle.js';
import { GenerateMapArtifactInputSchema } from '../capabilities/generate-map-artifact.js';
import { RunVectorAnalysisInputSchema } from '../capabilities/run-vector-analysis.js';
import { runSkill, type RunSkillDependencies } from '../skills/executor.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
  InMemoryApprovalStore,
  type ApprovalDependencies,
} from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';

// 5 Phase 0 inspect_dataset + 5 Phase 1A inspect_arcgis_org
// + 5 Phase 1B trace_arcgis_dependencies + 5 Phase 1C query_feature_service
// + 5 Phase 1D validate_spatial_data + 5 Phase 1E generate_map_artifact
// + 5 Phase 1F run_vector_analysis + 5 Phase 1G export_evidence_bundle
const TASK_COUNT = 40;

const ExpectationSchema = z
  .object({
    outcome: z.enum(['success', 'error']),
    golden_file: z.string().regex(/^[a-z0-9-]+\.json$/),
  })
  .strict();

const ToleranceSchema = z
  .object({
    numeric_absolute: z.number().nonnegative(),
    normalized_fields: z.array(z.string()),
  })
  .strict();

const ApprovalExpectationSchema = z.discriminatedUnion('required', [
  z.object({ required: z.literal(false), decision: z.literal('not-requested') }).strict(),
  z.object({ required: z.literal(true), decision: z.enum(['approved', 'rejected']), consumed: z.boolean() }).strict(),
]);

const DatasetTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('inspect_dataset'),
    input: z
      .object({
        fixture: z.string().min(1),
        max_bytes: z.number().int().positive().optional(),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum([
        'boundary_preflight',
        'stat',
        'read_file',
        'parse_geojson',
        'hash_sha256',
        'derive_metadata',
      ]),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const ArcgisTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('inspect_arcgis_org'),
    input: z
      .object({
        fixture: z.string().regex(/^arcgis\/[a-z0-9-]+$/),
        capability_input: z.record(z.unknown()),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum(['boundary_preflight', 'arcgis_request', 'paginate', 'derive_inventory', 'hash_sha256']),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const TraceTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('trace_arcgis_dependencies'),
    input: z
      .object({
        fixture: z.string().regex(/^arcgis\/[a-z0-9-]+$/),
        capability_input: z.record(z.unknown()),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum(['boundary_preflight', 'arcgis_request', 'derive_graph', 'hash_sha256']),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const QueryTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('query_feature_service'),
    input: z
      .object({
        fixture: z.string().regex(/^arcgis\/[a-z0-9-]+$/),
        capability_input: z.record(z.unknown()),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum(['boundary_preflight', 'arcgis_request', 'query_post', 'derive_features', 'hash_sha256']),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const ValidateTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('validate_spatial_data'),
    input: z
      .object({
        fixture: z.string().min(1),
        max_bytes: z.number().int().positive().optional(),
        max_features: z.number().int().positive().optional(),
        max_issues: z.number().int().positive().optional(),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum([
        'boundary_preflight',
        'stat',
        'read_file',
        'parse_geojson',
        'hash_sha256',
        'derive_validation_report',
      ]),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const MapArtifactTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('generate_map_artifact'),
    input: z
      .object({
        fixture: z.string().min(1),
        title: z.string().min(1).optional(),
        purpose: z.string().min(1).optional(),
        audience: z.string().min(1).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        style: z.enum(['dymaxion', 'monochrome', 'blueprint']).optional(),
        point_symbol: z.enum(['circle', 'square']).optional(),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum([
        'boundary_preflight',
        'stat',
        'read_file',
        'parse_geojson',
        'render_svg',
        'hash_sha256',
        'derive_map_report',
      ]),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const VectorAnalysisTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('run_vector_analysis'),
    input: z
      .object({
        source_fixture: z.string().min(1),
        candidate_fixture: z.string().min(1),
        operation: z.literal('nearest_point').optional(),
        max_distance_meters: z.number().positive().optional(),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum([
        'boundary_preflight',
        'stat',
        'read_file',
        'parse_geojson',
        'hash_sha256',
        'derive_vector_report',
      ]),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const ExportBundleTaskSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    capability: z.literal('export_evidence_bundle'),
    input: z
      .object({
        scenario: z.enum([
          'useful_preview',
          'deterministic_repeat',
          'approved_persist_idempotent',
          'tamper_mismatch_reject',
          'storage_root_reject',
        ]),
        project_id: z.string().uuid(),
        bundle_slug: z.string().min(1),
        report_fixture: z.string().regex(/^export-evidence-bundle\/[a-z0-9-]+\.json$/),
        evidence_fixture: z.string().regex(/^export-evidence-bundle\/[a-z0-9-]+\.json$/),
        artifact_fixture: z.string().regex(/^export-evidence-bundle\/[A-Za-z0-9_.-]+\.(?:svg|geojson)$/),
        artifact_output_name: z.string().min(1),
        artifact_file_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.(?:svg|geojson)$/),
        artifact_media_type: z.enum([
          'image/svg+xml; charset=utf-8',
          'application/geo+json; charset=utf-8',
        ]),
      })
      .strict(),
    expected: ExpectationSchema,
    tolerances: ToleranceSchema,
    allowed_operations: z.array(
      z.enum([
        'boundary_preflight',
        'canonicalize_json',
        'build_zip_store',
        'hash_sha256',
        'approval_request',
        'approval_consume',
        'storage_publish',
        'storage_readback',
        'storage_reject',
      ]),
    ),
    expected_approval: ApprovalExpectationSchema,
  })
  .strict();

const TaskSchema = z.discriminatedUnion('capability', [
  DatasetTaskSchema,
  ArcgisTaskSchema,
  TraceTaskSchema,
  QueryTaskSchema,
  ValidateTaskSchema,
  MapArtifactTaskSchema,
  VectorAnalysisTaskSchema,
  ExportBundleTaskSchema,
]);

type TaskDefinition = z.infer<typeof TaskSchema>;

export interface GisBenchResult {
  passed: number;
  failed: number;
  tasks: Array<{ id: string; ok: boolean; operations: string[]; error?: string }>;
}

function benchmarkRoot(): string {
  return process.env.GISBENCH_ROOT ?? resolve(process.cwd(), '../gisbench');
}

type NormalizationContext = { workspaceRoot: string; fixtureRoot: string };

const FIELD_NORMALIZERS: Record<string, (value: unknown, context: NormalizationContext) => unknown> = {
  '$.error': (value, context) => {
    if (typeof value !== 'string') throw new TypeError('$.error must be a string');
    return value
      .replaceAll(context.fixtureRoot, '<FIXTURE_ROOT>')
      .replaceAll(context.workspaceRoot, '<WORKSPACE_ROOT>');
  },
  '$.output.passport.source_uri': () => '<FIXTURE_URI>',
  '$.output.passport.source_handle': () => '<FIXTURE_PATH>',
  '$.output.report.source_uri': () => '<FIXTURE_URI>',
  '$.output.report.source_handle': () => '<FIXTURE_PATH>',
  '$.output.report.source.source_uri': () => '<FIXTURE_URI>',
  '$.output.report.source.source_handle': () => '<FIXTURE_PATH>',
  '$.output.report.candidate.source_uri': () => '<CANDIDATE_FIXTURE_URI>',
  '$.output.report.candidate.source_handle': () => '<CANDIDATE_FIXTURE_PATH>',
  '$.output.evidence.source.uri': () => '<FIXTURE_URI>',
  '$.output.evidence.source.identity.value': () => '<FIXTURE_PATH>',
  '$.output.evidence.related_sources[0].uri': () => '<CANDIDATE_FIXTURE_URI>',
  '$.output.evidence.related_sources[0].identity.value': () => '<CANDIDATE_FIXTURE_PATH>',
  '$.output.evidence.source.version.modified_at': () => '<NORMALIZED_FILE_MTIME>',
  '$.output.evidence.parameters.canonical_json': () => '<ENVIRONMENT_DEPENDENT_CANONICAL_PARAMETERS>',
  '$.output.evidence.parameters.sha256': () => '<ENVIRONMENT_DEPENDENT_PARAMETER_HASH>',
  '$.output.evidence.outputs[0].sha256': () => '<ENVIRONMENT_DEPENDENT_OUTPUT_HASH>',
};

function setNormalizedField(
  root: Record<string, unknown>,
  path: string,
  context: NormalizationContext,
): void {
  const normalize = FIELD_NORMALIZERS[path];
  assert.ok(normalize, `unsupported declared normalization field: ${path}`);
  const segments = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  assert.ok(segments.length, `invalid normalization field: ${path}`);
  let parent: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    assert.ok(parent !== null && typeof parent === 'object', `${path}: missing parent '${segment}'`);
    parent = (parent as Record<string, unknown>)[segment];
  }
  assert.ok(parent !== null && typeof parent === 'object', `${path}: missing field parent`);
  const key = segments.at(-1)!;
  const record = parent as Record<string, unknown>;
  assert.ok(Object.hasOwn(record, key), `${path}: declared field does not exist`);
  record[key] = normalize(record[key], context);
}

function validateDatasetEvidenceHashes(output: Record<string, unknown>): void {
  const passport = output.passport as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(passport && evidence, 'successful result requires passport and evidence');
  const source = evidence.source as Record<string, unknown>;
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  assert.equal(source.sha256, passport.file_sha256, 'evidence source hash must match the inspected file hash');
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'evidence parameter hash must validate before normalization',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'dataset_passport');
  assert.equal(
    outputs[0]?.sha256,
    sha256Canonical(passport),
    'evidence output hash must validate before normalization',
  );
}

function validateArcgisEvidenceHashes(output: Record<string, unknown>): void {
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(report && evidence, 'successful result requires report and evidence');
  const source = evidence.source as Record<string, unknown>;
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  const requests = evidence.requests as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(requests) && requests.length >= 1, 'retrieval evidence requires request records');
  assert.equal(requests[0]?.name, 'portal_self');
  assert.equal(
    source.sha256,
    requests[0]?.sha256,
    'evidence source hash must match the portal self request hash',
  );
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'evidence parameter hash must validate',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'arcgis_org_inventory');
  assert.equal(outputs[0]?.sha256, sha256Canonical(report), 'evidence output hash must validate');
}

function validateTraceEvidenceHashes(output: Record<string, unknown>): void {
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(report && evidence, 'successful result requires report and evidence');
  const source = evidence.source as Record<string, unknown>;
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  const requests = evidence.requests as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(requests) && requests.length >= 1, 'retrieval evidence requires request records');
  assert.match(String(requests[0]?.name), /^item_meta:[a-f0-9]{32}$/);
  assert.equal(
    source.sha256,
    requests[0]?.sha256,
    'evidence source hash must match the first item metadata request hash',
  );
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'evidence parameter hash must validate',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'arcgis_dependency_graph');
  assert.equal(outputs[0]?.sha256, sha256Canonical(report), 'evidence output hash must validate');
}

function validateQueryEvidenceHashes(output: Record<string, unknown>): void {
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(report && evidence, 'successful result requires report and evidence');
  const source = evidence.source as Record<string, unknown>;
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  const requests = evidence.requests as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(requests) && requests.length >= 2, 'retrieval evidence requires request records');
  assert.equal(requests[0]?.name, 'layer_metadata');
  assert.equal(
    source.sha256,
    requests[0]?.sha256,
    'evidence source hash must match the layer metadata request hash',
  );
  for (const request of requests.slice(1)) {
    assert.equal(request.method, 'POST', 'query dispatches must be POST-form requests');
    assert.match(String(request.request_sha256), /^[a-f0-9]{64}$/);
    assert.ok(!String(request.url).includes('?'), 'query evidence URLs must carry no query string');
  }
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'evidence parameter hash must validate',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'arcgis_feature_query');
  assert.equal(outputs[0]?.sha256, sha256Canonical(report), 'evidence output hash must validate');
}

/** Recompute the SHA-256 of the actual raw fixture bytes and require BOTH the
 * report and evidence source hashes to equal it — comparing the two to each
 * other alone would accept jointly wrong hashes. Runs before normalization. */
export function assertValidationSourceHashes(output: Record<string, unknown>, rawBytes: Uint8Array): void {
  const report = output.report as Record<string, unknown> | undefined;
  const evidence = output.evidence as Record<string, unknown> | undefined;
  const expected = sha256Text(rawBytes);
  assert.equal(
    report?.file_sha256,
    expected,
    'report source hash must equal the recomputed raw fixture hash',
  );
  assert.equal(
    (evidence?.source as Record<string, unknown> | undefined)?.sha256,
    expected,
    'evidence source hash must equal the recomputed raw fixture hash',
  );
}

function validateValidationEvidenceHashes(output: Record<string, unknown>): void {
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(report && evidence, 'successful result requires report and evidence');
  const source = evidence.source as Record<string, unknown>;
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  assert.equal(source.sha256, report.file_sha256, 'evidence source hash must match the validated file hash');
  assert.equal(
    (outputs[0]?.validation as Record<string, unknown> | undefined)?.valid,
    (report.summary as Record<string, unknown> | undefined)?.valid,
    'evidence artifact validity must mirror the dataset validation result',
  );
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'evidence parameter hash must validate before normalization',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'validation_report');
  assert.equal(
    outputs[0]?.sha256,
    sha256Canonical(report),
    'evidence output hash must validate before normalization',
  );
}

function validateMapArtifactEvidenceHashes(
  output: Record<string, unknown>,
  capabilityInput: Record<string, unknown> | undefined,
): void {
  const artifact = output.artifact as Record<string, unknown>;
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(artifact && report && evidence, 'successful map result requires artifact, report, and evidence');
  const parameters = evidence.parameters as Record<string, unknown>;
  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  const reportArtifact = report.artifact as Record<string, unknown>;
  const content = String(artifact.content);
  const exactBytes = Buffer.byteLength(content, 'utf8');
  const exactHash = sha256Text(content);
  assert.equal(artifact.bytes, exactBytes, 'inline SVG byte count must match exact UTF-8 bytes');
  assert.equal(artifact.sha256, exactHash, 'inline SVG hash must match exact UTF-8 bytes');
  assert.equal(reportArtifact?.bytes, exactBytes, 'report SVG byte count must match exact UTF-8 bytes');
  assert.equal(reportArtifact?.sha256, exactHash, 'report SVG hash must match exact UTF-8 bytes');
  assert.ok(capabilityInput, 'successful map result requires the exact capability input');
  const parsedInput = GenerateMapArtifactInputSchema.parse(capabilityInput);
  const expectedParameters = {
    audience: parsedInput.audience,
    height: parsedInput.height,
    point_symbol: parsedInput.point_symbol,
    purpose: parsedInput.purpose,
    source_uri: pathToFileURL(parsedInput.source_uri).href,
    style: parsedInput.style,
    target_format: parsedInput.target_format,
    title: parsedInput.title,
    width: parsedInput.width,
  };
  const expectedCanonicalParameters = canonicalJson(expectedParameters);
  assert.equal(
    parameters.canonical_json,
    expectedCanonicalParameters,
    'evidence canonical parameters must match the exact task input before normalization',
  );
  assert.equal(
    parameters.sha256,
    sha256Text(expectedCanonicalParameters),
    'evidence parameter hash must match the exact task input before normalization',
  );
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'map_svg');
  assert.equal(outputs[0]?.bytes, exactBytes, 'evidence SVG byte count must match exact UTF-8 bytes');
  assert.equal(outputs[0]?.sha256, exactHash, 'evidence SVG hash must match exact UTF-8 bytes');
}

function validateVectorAnalysisEvidenceHashes(
  output: Record<string, unknown>,
  capabilityInput: Record<string, unknown> | undefined,
): void {
  const artifact = output.artifact as Record<string, unknown>;
  const report = output.report as Record<string, unknown>;
  const evidence = output.evidence as Record<string, unknown>;
  assert.ok(artifact && report && evidence, 'successful vector result requires artifact, report, and evidence');
  assert.ok(capabilityInput, 'successful vector result requires the exact capability input');

  const content = String(artifact.content);
  const exactBytes = Buffer.byteLength(content, 'utf8');
  const exactHash = sha256Text(content);
  assert.equal(artifact.bytes, exactBytes, 'inline GeoJSON byte count must match exact UTF-8 bytes');
  assert.equal(artifact.sha256, exactHash, 'inline GeoJSON hash must match exact UTF-8 bytes');
  const reportOutput = report.output as Record<string, unknown>;
  assert.equal(reportOutput?.bytes, exactBytes, 'report GeoJSON byte count must match exact UTF-8 bytes');
  assert.equal(reportOutput?.sha256, exactHash, 'report GeoJSON hash must match exact UTF-8 bytes');

  const outputs = evidence.outputs as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(outputs) && outputs.length === 1, 'exactly one output artifact is required');
  assert.equal(outputs[0]?.name, 'nearest_point_geojson');
  assert.equal(outputs[0]?.bytes, exactBytes, 'evidence GeoJSON byte count must match exact UTF-8 bytes');
  assert.equal(outputs[0]?.sha256, exactHash, 'evidence GeoJSON hash must match exact UTF-8 bytes');

  const source = evidence.source as Record<string, unknown>;
  const relatedSources = evidence.related_sources as Array<Record<string, unknown>> | undefined;
  assert.ok(Array.isArray(relatedSources), 'vector evidence requires related candidate source');
  const candidateSources = relatedSources.filter((relatedSource) => relatedSource.role === 'candidate_features');
  assert.equal(candidateSources.length, 1, 'vector evidence requires exactly one candidate source');
  const candidateSource = candidateSources[0];
  const reportSource = report.source as Record<string, unknown>;
  const reportCandidate = report.candidate as Record<string, unknown>;
  assert.equal(reportSource?.source_uri, source?.uri, 'primary report source URI must match evidence source');
  assert.equal(reportSource?.sha256, source?.sha256, 'primary report source hash must match evidence source');
  assert.equal(reportCandidate?.source_uri, candidateSource?.uri, 'candidate report source URI must match evidence source');
  assert.equal(reportCandidate?.sha256, candidateSource?.sha256, 'candidate report source hash must match evidence source');

  const parameters = evidence.parameters as Record<string, unknown>;
  assert.equal(
    parameters.sha256,
    sha256Text(String(parameters.canonical_json)),
    'vector evidence parameter hash must validate before normalization',
  );
  assert.equal(
    evidence.bundle_id,
    `run_vector_analysis:${String(artifact.sha256).slice(0, 16)}`,
    'vector evidence bundle id must match artifact hash fragment',
  );

  const parsedInput = RunVectorAnalysisInputSchema.parse(capabilityInput);
  assert.equal(reportSource?.source_uri, pathToFileURL(parsedInput.source_uri).href, 'primary report source URI must match exact task input');
  assert.equal(reportCandidate?.source_uri, pathToFileURL(parsedInput.candidate_source_uri).href, 'candidate report source URI must match exact task input');
}

type ParsedZipEntry = { name: string; bytes: Uint8Array };

function readUInt16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function parseStoreZipEntries(bytes: Uint8Array): ParsedZipEntry[] {
  const entries: ParsedZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && readUInt32(bytes, offset) === 0x04034b50) {
    assert.equal(readUInt16(bytes, offset + 6), 0x0800, 'ZIP entries must set only the UTF-8 flag');
    assert.equal(readUInt16(bytes, offset + 8), 0, 'ZIP entries must use STORE/no compression');
    assert.equal(readUInt16(bytes, offset + 10), 0, 'ZIP entry DOS time must be fixed');
    assert.equal(readUInt16(bytes, offset + 12), 33, 'ZIP entry DOS date must be fixed');
    const compressedBytes = readUInt32(bytes, offset + 18);
    const uncompressedBytes = readUInt32(bytes, offset + 22);
    assert.equal(compressedBytes, uncompressedBytes, 'STORE compressed/uncompressed byte counts must match');
    const nameLength = readUInt16(bytes, offset + 26);
    const extraLength = readUInt16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + uncompressedBytes;
    assert.ok(dataEnd <= bytes.byteLength, 'ZIP local entry exceeds archive length');
    entries.push({
      name: Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8'),
      bytes: bytes.subarray(dataStart, dataEnd),
    });
    offset = dataEnd;
  }
  assert.equal(readUInt32(bytes, offset), 0x02014b50, 'ZIP central directory must follow local entries');
  return entries;
}

function validateExportBundleEvidenceHashes(
  output: Record<string, unknown>,
  capabilityInput: Record<string, unknown> | undefined,
): void {
  assert.ok(capabilityInput, 'export bundle validation requires exact capability input');
  const parsedInput = ExportEvidenceBundleInputSchema.parse(capabilityInput);
  const archive = output.archive as Record<string, unknown>;
  const manifest = output.manifest as Record<string, unknown>;
  const exportEvidence = output.export_evidence as Record<string, unknown>;
  assert.ok(archive && manifest && exportEvidence, 'successful export result requires archive, manifest, and export_evidence');
  assert.equal(String(output.handle).endsWith(String(archive.sha256)), true, 'handle suffix must equal archive sha256');
  assert.equal(archive.entries, 4, 'archive entry count must be exactly four');

  const reportBytes = Buffer.from(canonicalJson(parsedInput.report), 'utf8');
  const evidenceBytes = Buffer.from(canonicalJson(parsedInput.evidence), 'utf8');
  const artifactBytes = Buffer.from(parsedInput.artifact.content, 'utf8');
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const zip = createDeterministicZip([
    { name: 'manifest.json', bytes: manifestBytes },
    { name: 'report.json', bytes: reportBytes },
    { name: 'evidence.json', bytes: evidenceBytes },
    { name: parsedInput.artifact.file_name, bytes: artifactBytes },
  ]);
  assert.equal(zip.sha256, archive.sha256, 'recomputed deterministic ZIP hash must match response archive hash');
  assert.equal(zip.bytes.byteLength, archive.bytes, 'recomputed deterministic ZIP byte count must match response archive bytes');
  const parsedEntries = parseStoreZipEntries(zip.bytes);
  assert.deepEqual(
    parsedEntries.map((entry) => entry.name),
    ['manifest.json', 'report.json', 'evidence.json', parsedInput.artifact.file_name],
    'ZIP entries must be exactly four in manifest order',
  );
  const manifestEntries = manifest.entries as Record<string, Record<string, unknown>>;
  assert.equal(manifestEntries.artifact?.sha256, sha256Text(artifactBytes), 'manifest artifact hash must equal exact fixture bytes');
  assert.equal(manifestEntries.artifact?.bytes, artifactBytes.byteLength, 'manifest artifact byte count must equal exact fixture bytes');
  assert.equal(manifestEntries.report?.sha256, sha256Text(reportBytes), 'manifest report hash must equal exact fixture bytes');
  assert.equal(manifestEntries.evidence?.sha256, sha256Text(evidenceBytes), 'manifest evidence hash must equal canonical upstream evidence bytes');
  assert.equal(Buffer.from(parsedEntries[2]!.bytes).toString('utf8'), canonicalJson(parsedInput.evidence), 'ZIP evidence.json must equal canonical upstream evidence');
  assert.equal(parsedInput.evidence.approvals.length, 0, 'upstream fixture evidence must not carry approval facts');

  const parameters = exportEvidence.parameters as Record<string, unknown>;
  assert.equal(parameters.sha256, sha256Text(String(parameters.canonical_json)), 'export evidence parameter hash must validate before normalization');
  const approvals = exportEvidence.approvals as Array<Record<string, unknown>>;
  assert.deepEqual(approvals, [], 'export response must not serialize unverifiable approval claims');
  if (parsedInput.operation === 'preview') {
    assert.equal(archive.read_back_verified, false, 'preview must not claim storage read-back');
  } else {
    assert.equal(archive.read_back_verified, true, 'persist must report storage read-back verification');
  }
}

function validateEvidenceHashes(
  normalized: Record<string, unknown>,
  capability: TaskDefinition['capability'],
  capabilityInput?: Record<string, unknown>,
): void {
  if (normalized.ok !== true) return;
  assert.ok(normalized.output && typeof normalized.output === 'object', 'successful result requires output');
  const output = normalized.output as Record<string, unknown>;
  if (capability === 'inspect_dataset') validateDatasetEvidenceHashes(output);
  else if (capability === 'inspect_arcgis_org') validateArcgisEvidenceHashes(output);
  else if (capability === 'trace_arcgis_dependencies') validateTraceEvidenceHashes(output);
  else if (capability === 'query_feature_service') validateQueryEvidenceHashes(output);
  else if (capability === 'validate_spatial_data') validateValidationEvidenceHashes(output);
  else if (capability === 'generate_map_artifact') validateMapArtifactEvidenceHashes(output, capabilityInput);
  else if (capability === 'run_vector_analysis') validateVectorAnalysisEvidenceHashes(output, capabilityInput);
  else validateExportBundleEvidenceHashes(output, capabilityInput);
}

export function normalizeResult(
  result: { ok: boolean; output?: unknown; error?: string; costUsd: number },
  normalizedFields: string[],
  workspaceRoot: string,
  fixtureRoot: string,
  capability: TaskDefinition['capability'] = 'inspect_dataset',
  capabilityInput?: Record<string, unknown>,
): unknown {
  const normalized = JSON.parse(
    JSON.stringify({
      ok: result.ok,
      output: result.output,
      error: result.error,
      cost_usd: result.costUsd,
    }),
  ) as Record<string, unknown>;
  validateEvidenceHashes(normalized, capability, capabilityInput);
  const context = { workspaceRoot, fixtureRoot };
  for (const field of normalizedFields) setNormalizedField(normalized, field, context);
  return normalized;
}

function compareWithTolerance(actual: unknown, expected: unknown, tolerance: number, path = '$'): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${path}: ${actual} differs from ${expected}`);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}: array length`);
    actual.forEach((value, index) => compareWithTolerance(value, expected[index], tolerance, `${path}[${index}]`));
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    assert.deepEqual(Object.keys(actualRecord).sort(), Object.keys(expectedRecord).sort(), `${path}: object keys`);
    for (const key of Object.keys(expectedRecord)) {
      compareWithTolerance(actualRecord[key], expectedRecord[key], tolerance, `${path}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, path);
}

interface TaskRoots {
  benchmark: string;
  fixtures: string;
  workspace: string;
}

const RouteManifestSchema = z
  .object({
    description: z.string().min(1),
    routes: z.array(
      z
        .object({
          url: z.string().url(),
          // POST routes exact-match the canonicalized form entries; a request
          // whose method, URL, or form differs in any way finds no route and
          // fails the task closed.
          method: z.enum(['GET', 'POST']).optional(),
          form: z.record(z.string()).optional(),
          status: z.number().int().optional(),
          content_type: z.string().min(1).optional(),
          body_file: z.string().regex(/^[a-z0-9.-]+\.json$/),
        })
        .strict(),
    ),
  })
  .strict();

/** Fixture-backed transport: exact method+URL+canonical-form matching, no
 * network, fail closed on any unexpected request. */
async function loadFixtureTransport(
  fixtureDir: string,
  operations: Set<string>,
): Promise<ArcGisRestTransport> {
  const manifest = RouteManifestSchema.parse(
    JSON.parse(await readFile(join(fixtureDir, 'routes.json'), 'utf8')),
  );
  const routes = new Map<string, { status: number; contentType: string; bodyText: string }>();
  for (const route of manifest.routes) {
    const method = route.method ?? 'GET';
    assert.equal(
      method === 'POST',
      route.form !== undefined,
      `fixture route ${route.url}: form fixtures are exactly the POST routes`,
    );
    const key = method === 'POST' ? `POST ${route.url} ${canonicalFormBody(route.form!)}` : `GET ${route.url}`;
    routes.set(key, {
      status: route.status ?? 200,
      contentType: route.content_type ?? 'application/json; charset=utf-8',
      bodyText: await readFile(join(fixtureDir, route.body_file), 'utf8'),
    });
  }
  const respond = (key: string) => {
    const route = routes.get(key);
    if (!route) throw new Error(`fixture transport has no route for ${key}`);
    return { status: route.status, contentType: route.contentType, bodyText: route.bodyText };
  };
  return {
    async get(request) {
      operations.add('arcgis_request');
      const start = Number(request.url.searchParams.get('start') ?? '1');
      if (Number.isFinite(start) && start > 1) operations.add('paginate');
      return respond(`GET ${request.url.href}`);
    },
    async postForm(request) {
      operations.add('arcgis_request');
      operations.add('query_post');
      return respond(`POST ${request.url.href} ${request.body}`);
    },
  };
}

async function executeDatasetTask(
  task: z.infer<typeof DatasetTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const sourcePath = resolve(roots.fixtures, task.input.fixture);
  const dependencies: RunSkillDependencies = {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      io: {
        stat: async (path: string) => {
          operations.add('stat');
          return stat(path);
        },
        readFile: async (path: string) => {
          operations.add('read_file');
          return readFile(path);
        },
      },
    },
  };
  const input: Record<string, unknown> = { source_uri: sourcePath };
  if (task.input.max_bytes !== undefined) input.max_bytes = task.input.max_bytes;
  const result = await runSkill(
    task.capability,
    input,
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  if (operations.has('read_file')) operations.add('parse_geojson');
  if (result.ok) {
    operations.add('hash_sha256');
    operations.add('derive_metadata');
  }
  assertTaskExpectations(task, result.ok, operations);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
      task.capability,
    ),
    operations: [...operations],
  };
}

async function executeValidateTask(
  task: z.infer<typeof ValidateTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const sourcePath = resolve(roots.fixtures, task.input.fixture);
  const dependencies: RunSkillDependencies = {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      io: {
        stat: async (path: string) => {
          operations.add('stat');
          return stat(path);
        },
        readFile: async (path: string) => {
          operations.add('read_file');
          return readFile(path);
        },
      },
    },
  };
  const input: Record<string, unknown> = { source_uri: sourcePath };
  if (task.input.max_bytes !== undefined) input.max_bytes = task.input.max_bytes;
  if (task.input.max_features !== undefined) input.max_features = task.input.max_features;
  if (task.input.max_issues !== undefined) input.max_issues = task.input.max_issues;
  const result = await runSkill(
    task.capability,
    input,
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  if (operations.has('read_file')) operations.add('parse_geojson');
  if (result.ok) {
    operations.add('hash_sha256');
    operations.add('derive_validation_report');
    // Recompute the source hash from the raw fixture bytes (outside the
    // operation-accounted capability io) before any normalization.
    assertValidationSourceHashes(result.output as Record<string, unknown>, await readFile(sourcePath));
  }
  assertTaskExpectations(task, result.ok, operations);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
      task.capability,
    ),
    operations: [...operations],
  };
}

async function executeMapArtifactTask(
  task: z.infer<typeof MapArtifactTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const sourcePath = resolve(roots.fixtures, task.input.fixture);
  const dependencies: RunSkillDependencies = {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      io: {
        stat: async (path: string) => {
          operations.add('stat');
          return stat(path);
        },
        readFile: async (path: string) => {
          operations.add('read_file');
          return readFile(path);
        },
      },
    },
  };
  const input: Record<string, unknown> = { ...task.input, source_uri: sourcePath };
  delete input.fixture;
  const result = await runSkill(
    task.capability,
    input,
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  if (operations.has('read_file')) operations.add('parse_geojson');
  if (result.ok) {
    operations.add('render_svg');
    operations.add('hash_sha256');
    operations.add('derive_map_report');
    assertValidationSourceHashes(result.output as Record<string, unknown>, await readFile(sourcePath));
  }
  assertTaskExpectations(task, result.ok, operations);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
      task.capability,
      input,
    ),
    operations: [...operations],
  };
}

async function executeVectorAnalysisTask(
  task: z.infer<typeof VectorAnalysisTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const sourcePath = resolve(roots.fixtures, task.input.source_fixture);
  const candidatePath = resolve(roots.fixtures, task.input.candidate_fixture);
  const dependencies: RunSkillDependencies = {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    capabilityContext: {
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      monotonicNow: (() => {
        let tick = 0;
        return () => tick;
      })(),
      io: {
        stat: async (path: string) => {
          operations.add('stat');
          return stat(path);
        },
        readFile: async (path: string) => {
          operations.add('read_file');
          return readFile(path);
        },
      },
    },
  };
  const input: Record<string, unknown> = {
    source_uri: sourcePath,
    candidate_source_uri: candidatePath,
  };
  if (task.input.operation !== undefined) input.operation = task.input.operation;
  if (task.input.max_distance_meters !== undefined) input.max_distance_meters = task.input.max_distance_meters;
  const result = await runSkill(
    task.capability,
    input,
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  if (operations.has('read_file')) operations.add('parse_geojson');
  if (result.ok) {
    operations.add('hash_sha256');
    operations.add('derive_vector_report');
    const output = result.output as Record<string, unknown>;
    const primaryHash = sha256Text(await readFile(sourcePath));
    assert.equal(
      ((output.report as Record<string, unknown>).source as Record<string, unknown> | undefined)?.sha256,
      primaryHash,
      'primary report source hash must equal the recomputed raw fixture hash',
    );
    assert.equal(
      ((output.evidence as Record<string, unknown>).source as Record<string, unknown> | undefined)?.sha256,
      primaryHash,
      'primary evidence source hash must equal the recomputed raw fixture hash',
    );
    const candidateHash = sha256Text(await readFile(candidatePath));
    assert.equal(
      ((output.report as Record<string, unknown>).candidate as Record<string, unknown> | undefined)?.sha256,
      candidateHash,
      'candidate report source hash must equal the recomputed raw fixture hash',
    );
    const candidateSources = ((output.evidence as Record<string, unknown>).related_sources as Array<Record<string, unknown>> | undefined)?.filter(
      (source) => source.role === 'candidate_features',
    );
    assert.equal(
      candidateSources?.[0]?.sha256,
      candidateHash,
      'candidate evidence source hash must equal the recomputed raw fixture hash',
    );
  }
  assertTaskExpectations(task, result.ok, operations);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
      task.capability,
      input,
    ),
    operations: [...operations],
  };
}

async function loadExportBundleInput(
  task: z.infer<typeof ExportBundleTaskSchema>,
  roots: TaskRoots,
  operation: 'preview' | 'persist',
  targetBundleSha256?: string,
): Promise<Record<string, unknown>> {
  const report = JSON.parse(await readFile(resolve(roots.fixtures, task.input.report_fixture), 'utf8'));
  const evidence = JSON.parse(await readFile(resolve(roots.fixtures, task.input.evidence_fixture), 'utf8'));
  const artifactContent = await readFile(resolve(roots.fixtures, task.input.artifact_fixture), 'utf8');
  return ExportEvidenceBundleInputSchema.parse({
    operation,
    project_id: task.input.project_id,
    bundle_slug: task.input.bundle_slug,
    report,
    evidence,
    artifact: {
      output_name: task.input.artifact_output_name,
      file_name: task.input.artifact_file_name,
      media_type: task.input.artifact_media_type,
      content: artifactContent,
    },
    ...(targetBundleSha256 ? { target_bundle_sha256: targetBundleSha256 } : {}),
  }) as Record<string, unknown>;
}

function instrumentStorage(storage: ProjectArtifactStorage, operations: Set<string>): ProjectArtifactStorage {
  return {
    async storeBundle(request) {
      try {
        const stored = await storage.storeBundle(request);
        if (stored.created) operations.add('storage_publish');
        operations.add('storage_readback');
        return stored;
      } catch (error) {
        operations.add('storage_reject');
        throw error;
      }
    },
  };
}

function exportDependencies(
  task: z.infer<typeof ExportBundleTaskSchema>,
  operations: Set<string>,
  approvalDependencies: ApprovalDependencies,
  artifactRoot: string,
): RunSkillDependencies {
  const storage = createProjectArtifactStorage({
    trustedRoot: artifactRoot,
    authorizeSink: () => undefined,
    randomSuffix: () => `gisbench-${task.id}`,
  });
  return {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: { audit: async () => undefined },
    approvalDependencies,
    capabilityContext: {
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      monotonicNow: (() => {
        let tick = 0;
        return () => tick;
      })(),
      io: { artifactStorage: instrumentStorage(storage, operations) },
    },
  };
}

async function approveExportPersist(
  input: Record<string, unknown>,
  agentRunId: string,
  approvalDependencies: ApprovalDependencies,
  operations: Set<string>,
) {
  operations.add('approval_request');
  const request = await createApprovalRequest(
    agentRunId,
    'Persist deterministic evidence bundle',
    input,
    {
      timeoutMinutes: 5,
      target: deriveApprovalTarget('export_evidence_bundle', input),
      credentialIdentity: resolveExecutionCredentialIdentity('export_evidence_bundle'),
    },
    approvalDependencies,
  );
  assert.equal(await decideApproval(request.id, 'approved', 'gisbench.operator', approvalDependencies), true);
  return request;
}

async function executeExportBundleTask(
  task: z.infer<typeof ExportBundleTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const agentRunId = '00000000-0000-4000-8000-00000000001a';
  const previousIdentityEnv = process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
  const tempRoot = await mkdtemp(join(tmpdir(), `gisbench-${task.id}-`));
  const store = new InMemoryApprovalStore();
  const approvalDependencies: ApprovalDependencies = {
    store,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
    sleep: async () => undefined,
  };
  try {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({
      export_evidence_bundle: 'gisbench:synthetic-operator',
    });
    await mkdir(join(tempRoot, 'trusted'), { recursive: true });
    const previewInput = await loadExportBundleInput(task, roots, 'preview');
    const runPreview = async () => {
      const result = await runSkill(
        task.capability,
        previewInput,
        agentRunId,
        exportDependencies(task, operations, approvalDependencies, join(tempRoot, 'trusted')),
      );
      operations.add('canonicalize_json');
      operations.add('build_zip_store');
      if (result.ok) operations.add('hash_sha256');
      return result;
    };

    let result = await runPreview();
    let capabilityInput = previewInput;

    if (task.input.scenario === 'deterministic_repeat') {
      const second = await runPreview();
      assert.deepEqual(second.output, result.output, 'preview output must be deterministic across repeated execution');
      result = second;
    } else if (task.input.scenario === 'approved_persist_idempotent') {
      assert.ok(result.ok && result.output && typeof result.output === 'object', 'persist scenario requires successful preview');
      const target = String(((result.output as Record<string, unknown>).archive as Record<string, unknown>).sha256);
      const persistInput = await loadExportBundleInput(task, roots, 'persist', target);
      const firstApproval = await approveExportPersist(persistInput, agentRunId, approvalDependencies, operations);
      operations.add('approval_consume');
      const first = await runSkill(
        task.capability,
        persistInput,
        agentRunId,
        { ...exportDependencies(task, operations, approvalDependencies, join(tempRoot, 'trusted')), approvalRequest: firstApproval },
      );
      operations.add('canonicalize_json');
      operations.add('build_zip_store');
      if (first.ok) operations.add('hash_sha256');
      assert.equal((first.output as Record<string, unknown> | undefined)?.created, true, 'first approved persist must create the bundle');
      const secondApproval = await approveExportPersist(persistInput, agentRunId, approvalDependencies, operations);
      operations.add('approval_consume');
      result = await runSkill(
        task.capability,
        persistInput,
        agentRunId,
        { ...exportDependencies(task, operations, approvalDependencies, join(tempRoot, 'trusted')), approvalRequest: secondApproval },
      );
      operations.add('canonicalize_json');
      operations.add('build_zip_store');
      if (result.ok) operations.add('hash_sha256');
      assert.equal((result.output as Record<string, unknown> | undefined)?.created, false, 'second fresh-approval persist must be idempotent');
      assert.equal(
        ((result.output as Record<string, unknown>).archive as Record<string, unknown>).sha256,
        target,
        'idempotent persist must keep preview archive hash',
      );
      capabilityInput = persistInput;
    } else if (task.input.scenario === 'tamper_mismatch_reject') {
      assert.ok(result.ok && result.output && typeof result.output === 'object', 'tamper scenario requires successful preview');
      const target = String(((result.output as Record<string, unknown>).archive as Record<string, unknown>).sha256);
      const persistInput = await loadExportBundleInput(task, roots, 'persist', target);
      persistInput.report = { ...(persistInput.report as Record<string, unknown>), tampered_after_preview: true };
      result = await runSkill(
        task.capability,
        persistInput,
        agentRunId,
        exportDependencies(task, operations, approvalDependencies, join(tempRoot, 'trusted')),
      );
      operations.add('canonicalize_json');
      operations.add('build_zip_store');
      capabilityInput = persistInput;
      assert.equal(operations.has('approval_consume'), false, 'tamper mismatch must fail before approval consumption');
      assert.equal(operations.has('storage_publish'), false, 'tamper mismatch must fail before storage');
    } else if (task.input.scenario === 'storage_root_reject') {
      assert.ok(result.ok && result.output && typeof result.output === 'object', 'storage reject scenario requires successful preview');
      const target = String(((result.output as Record<string, unknown>).archive as Record<string, unknown>).sha256);
      const persistInput = await loadExportBundleInput(task, roots, 'persist', target);
      const outside = join(tempRoot, 'outside');
      await mkdir(outside, { recursive: true });
      const linkedRoot = join(tempRoot, 'linked-root');
      await symlink(outside, linkedRoot, 'dir');
      const approval = await approveExportPersist(persistInput, agentRunId, approvalDependencies, operations);
      operations.add('approval_consume');
      result = await runSkill(
        task.capability,
        persistInput,
        agentRunId,
        { ...exportDependencies(task, operations, approvalDependencies, linkedRoot), approvalRequest: approval },
      );
      operations.add('canonicalize_json');
      operations.add('build_zip_store');
      capabilityInput = persistInput;
      assert.equal(operations.has('storage_publish'), false, 'symlinked storage root must not publish bytes');
      assert.equal(operations.has('storage_reject'), true, 'symlinked storage root must reject at storage sink');
    }

    assertTaskExpectations(task, result.ok, operations);
    return {
      normalized: normalizeResult(
        result,
        task.tolerances.normalized_fields,
        roots.workspace,
        roots.fixtures,
        task.capability,
        capabilityInput,
      ),
      operations: [...operations],
    };
  } finally {
    if (previousIdentityEnv === undefined) delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
    else process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = previousIdentityEnv;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function executeArcgisTask(
  task:
    | z.infer<typeof ArcgisTaskSchema>
    | z.infer<typeof TraceTaskSchema>
    | z.infer<typeof QueryTaskSchema>,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  const operations = new Set<string>(['boundary_preflight']);
  const fixtureDir = resolve(roots.fixtures, task.input.fixture);
  const transport = await loadFixtureTransport(fixtureDir, operations);
  const dependencies: RunSkillDependencies = {
    recorder: {
      begin: async () => `gisbench:${task.id}`,
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: {
      audit: async () => undefined,
      // Offline, deterministic host resolution: DNS is never queried in GISBench.
      resolveHost: async () => ['93.184.216.34'],
    },
    capabilityContext: {
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      io: { arcgisTransport: transport },
    },
  };
  const result = await runSkill(
    task.capability,
    task.input.capability_input as Record<string, unknown>,
    '00000000-0000-0000-0000-000000000001',
    dependencies,
  );
  if (result.ok) {
    operations.add(
      task.capability === 'inspect_arcgis_org'
        ? 'derive_inventory'
        : task.capability === 'trace_arcgis_dependencies'
          ? 'derive_graph'
          : 'derive_features',
    );
    operations.add('hash_sha256');
  }
  assertTaskExpectations(task, result.ok, operations);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
      task.capability,
    ),
    operations: [...operations],
  };
}

function assertTaskExpectations(task: TaskDefinition, ok: boolean, operations: Set<string>): void {
  assert.equal(ok, task.expected.outcome === 'success', `${task.id}: unexpected outcome`);
  if (task.expected_approval.required) {
    assert.equal(task.expected_approval.decision, 'approved', `${task.id}: GISBench only auto-drives approved Phase 1G approvals`);
    assert.equal(operations.has('approval_request'), true, `${task.id}: expected approval request`);
    assert.equal(operations.has('approval_consume'), task.expected_approval.consumed, `${task.id}: approval consumption mismatch`);
  } else {
    assert.equal(task.expected_approval.decision, 'not-requested');
    assert.equal(operations.has('approval_request'), false, `${task.id}: approval must not be requested`);
    assert.equal(operations.has('approval_consume'), false, `${task.id}: approval must not be consumed`);
  }
  const disallowed = [...operations].filter((operation) => !task.allowed_operations.includes(operation as never));
  assert.deepEqual(disallowed, [], `${task.id}: disallowed operations`);
}

async function executeTask(
  task: TaskDefinition,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  if (task.capability === 'inspect_dataset') return executeDatasetTask(task, roots);
  if (task.capability === 'validate_spatial_data') return executeValidateTask(task, roots);
  if (task.capability === 'generate_map_artifact') return executeMapArtifactTask(task, roots);
  if (task.capability === 'run_vector_analysis') return executeVectorAnalysisTask(task, roots);
  if (task.capability === 'export_evidence_bundle') return executeExportBundleTask(task, roots);
  if (
    task.capability === 'inspect_arcgis_org' ||
    task.capability === 'trace_arcgis_dependencies' ||
    task.capability === 'query_feature_service'
  ) {
    return executeArcgisTask(task, roots);
  }
  throw new Error('unsupported GISBench capability');
}

export async function runGisBench(updateGoldens = false): Promise<GisBenchResult> {
  const benchmark = benchmarkRoot();
  const fixtures = join(benchmark, 'fixtures');
  const workspace = resolve(benchmark, '..');
  process.env.DYMAXION_CONFIG_DIR ??= join(workspace, 'config');
  process.env.DYMAXION_WORKSPACE_ROOT = fixtures;

  const taskFiles = (await readdir(join(benchmark, 'tasks')))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.equal(
    taskFiles.length,
    TASK_COUNT,
    `GISBench must contain exactly ${TASK_COUNT} tasks (5 each for Phases 0, 1A, 1B, 1C, 1D, 1E, 1F, and 1G)`,
  );
  if (updateGoldens) await mkdir(join(benchmark, 'golden'), { recursive: true });

  const results: GisBenchResult['tasks'] = [];
  for (const taskFile of taskFiles) {
    let taskId = basename(taskFile, '.json');
    try {
      const task = TaskSchema.parse(JSON.parse(await readFile(join(benchmark, 'tasks', taskFile), 'utf8')));
      taskId = task.id;
      const execution = await executeTask(task, { benchmark, fixtures, workspace });
      const goldenPath = join(benchmark, 'golden', task.expected.golden_file);
      if (updateGoldens) {
        await writeFile(goldenPath, `${JSON.stringify(execution.normalized, null, 2)}\n`, 'utf8');
      }
      const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
      compareWithTolerance(execution.normalized, golden, task.tolerances.numeric_absolute);
      results.push({ id: task.id, ok: true, operations: execution.operations });
    } catch (error) {
      results.push({ id: taskId, ok: false, operations: [], error: (error as Error).message });
    }
  }
  return {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    tasks: results,
  };
}

async function main(): Promise<void> {
  const result = await runGisBench(process.argv.includes('--update-goldens'));
  for (const task of result.tasks) {
    process.stdout.write(
      `${task.ok ? 'PASS' : 'FAIL'} ${task.id}${task.error ? ` — ${task.error}` : ''}\n`,
    );
  }
  process.stdout.write(`GISBench: ${result.passed} passed, ${result.failed} failed\n`);
  if (result.failed) process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  void main();
}
