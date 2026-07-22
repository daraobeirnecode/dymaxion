import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Text } from '../src/contracts/canonical.js';
import { EvidenceBundleSchema, type EvidenceBundle } from '../src/contracts/evidence.js';
import { executeCapability } from '../src/capabilities/registry.js';
import {
  ExportEvidenceBundleInputSchema,
  ExportEvidenceBundleOutputSchema,
  MAX_ARTIFACT_BYTES,
  MAX_REPORT_BYTES,
  exportEvidenceBundleCapability,
  type ExportEvidenceBundleInput,
  type ExportEvidenceBundleOutput,
} from '../src/capabilities/export-evidence-bundle.js';
import { createProjectArtifactStorage } from '../src/capabilities/artifact-storage.js';
import {
  InMemoryApprovalStore,
  claimConsumedApprovalReceipt,
  consumeApproval,
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
  verifyConsumedApprovalReceipt,
  type ConsumedApprovalReceipt,
} from '../src/security/approval.js';

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const RUN_ID = 'phase-1g-run';
const IDENTITY = 'svc-dymaxion-export';
const FIXED_TIME = '2026-07-21T20:00:00.000Z';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';

function upstreamEvidence(content = SVG, outputName = 'useful_map'): EvidenceBundle {
  const bytes = Buffer.byteLength(content, 'utf8');
  return EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: 'generate_map_artifact:fixture',
    generated_at: FIXED_TIME,
    source: {
      uri: 'file:///workspace/fixtures/useful.geojson',
      identity: { kind: 'file', value: '/workspace/fixtures/useful.geojson' },
      version: {},
      retrieved_at: FIXED_TIME,
      sha256: 'a'.repeat(64),
      bytes: 123,
    },
    gis_metadata: {
      format: 'GeoJSON',
      crs: 'OGC:CRS84',
      axis_order: 'longitude,latitude',
      units: 'degrees',
      extent: [-121.5, 38.4, -121.4, 38.6],
      schema: [{ name: 'id', types: ['number'], nullable: false }],
      row_count: 1,
      geometry_types: ['LineString'],
      temporal_fields: [],
    },
    parameters: { canonical_json: '{"style":"dymaxion"}', sha256: 'b'.repeat(64) },
    execution: {
      capability: 'generate_map_artifact',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: outputName,
        sha256: sha256Text(content),
        bytes,
        validation: { valid: true, checks: ['SVG UTF-8 output validated'], warnings: [] },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
}

function previewInput(): ExportEvidenceBundleInput {
  return ExportEvidenceBundleInputSchema.parse({
    operation: 'preview',
    project_id: PROJECT_ID,
    bundle_slug: 'useful-map-evidence',
    report: {
      summary: 'One useful map artifact exported with source-faithful evidence.',
      metrics: { feature_count: 1, source_count: 1 },
    },
    evidence: upstreamEvidence(),
    artifact: {
      output_name: 'useful_map',
      file_name: 'useful-map.svg',
      media_type: 'image/svg+xml; charset=utf-8',
      content: SVG,
    },
  });
}

const context = {
  now: () => new Date(FIXED_TIME),
  monotonicNow: () => 100,
};

async function preview(input: ExportEvidenceBundleInput = previewInput()): Promise<ExportEvidenceBundleOutput> {
  return ExportEvidenceBundleOutputSchema.parse(await executeCapability('export_evidence_bundle', input, context));
}

function persistInput(input: ExportEvidenceBundleInput, hash: string): ExportEvidenceBundleInput {
  return ExportEvidenceBundleInputSchema.parse({ ...structuredClone(input), operation: 'persist', target_bundle_sha256: hash });
}

async function approvedReceipt(input: ExportEvidenceBundleInput, store: InMemoryApprovalStore): Promise<ConsumedApprovalReceipt> {
  const target = deriveApprovalTarget('export_evidence_bundle', input as Record<string, unknown>);
  const approval = await createApprovalRequest(
    RUN_ID,
    'Persist evidence bundle',
    input as Record<string, unknown>,
    { timeoutMinutes: 30, target, credentialIdentity: IDENTITY },
    { store, now: () => new Date(FIXED_TIME) },
  );
  assert.equal(await decideApproval(approval.id, 'approved', 'operator-a', { store, now: () => new Date(FIXED_TIME) }), true);
  return consumeApproval(approval, input as Record<string, unknown>, target, IDENTITY, {
    store,
    now: () => new Date(FIXED_TIME),
  });
}

function parseZipNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    names.push(Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8'));
    offset = nameStart + nameLength + extraLength + size;
  }
  return names;
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'dymaxion-export-'));
  const root = join(parent, 'trusted');
  await mkdir(root, { mode: 0o700 });
  try {
    return await fn(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('preview is pure, strict, and deterministic across equivalent object key order', async () => {
  let storageCalls = 0;
  const first = ExportEvidenceBundleOutputSchema.parse(
    await executeCapability('export_evidence_bundle', previewInput(), {
      ...context,
      io: { artifactStorage: { storeBundle: async () => { storageCalls += 1; throw new Error('preview called storage'); } } },
    }),
  );
  const reordered = previewInput();
  reordered.report = { metrics: { source_count: 1, feature_count: 1 }, summary: 'One useful map artifact exported with source-faithful evidence.' };
  const second = await preview(reordered);

  assert.equal(storageCalls, 0);
  assert.equal(first.persisted, false);
  assert.equal(first.created, false);
  assert.equal(first.archive.read_back_verified, false);
  assert.equal(first.archive.entries, 4);
  assert.equal(first.archive.sha256, second.archive.sha256);
  assert.equal(first.archive.bytes, second.archive.bytes);
  assert.deepEqual(first.export_evidence.approvals, []);
  assert.equal(first.manifest.entries.manifest.path, 'manifest.json');
  assert.equal('sha256' in first.manifest.entries.manifest, false);
  assert.equal(first.manifest.raw_sources_included, false);
  assert.equal(first.handle, `artifact://project/${PROJECT_ID}/bundle/${first.archive.sha256}`);
});

test('every archive-affecting input changes the preview hash or fails exact evidence binding', async () => {
  const base = previewInput();
  const baseline = await preview(base);

  const reportChanged = structuredClone(base);
  reportChanged.report = { changed: true };
  assert.notEqual((await preview(reportChanged)).archive.sha256, baseline.archive.sha256);

  const evidenceChanged = structuredClone(base);
  evidenceChanged.evidence.source.version = { version: '2' };
  assert.notEqual((await preview(evidenceChanged)).archive.sha256, baseline.archive.sha256);

  const renamed = structuredClone(base);
  renamed.artifact.file_name = 'renamed.svg';
  assert.notEqual((await preview(renamed)).archive.sha256, baseline.archive.sha256);

  const outputRenamed = structuredClone(base);
  outputRenamed.artifact.output_name = 'renamed_output';
  outputRenamed.evidence.outputs[0]!.name = 'renamed_output';
  assert.notEqual((await preview(outputRenamed)).archive.sha256, baseline.archive.sha256);

  const contentChanged = structuredClone(base);
  contentChanged.artifact.content = `${SVG}\n`;
  contentChanged.evidence = upstreamEvidence(contentChanged.artifact.content);
  assert.notEqual((await preview(contentChanged)).archive.sha256, baseline.archive.sha256);

  const mismatched = structuredClone(base);
  mismatched.artifact.content = `${SVG}tampered`;
  assert.throws(() => ExportEvidenceBundleInputSchema.parse(mismatched), /sha256 mismatch|bytes mismatch/i);
});

test('strict validation rejects unsafe names, operation/hash misuse, UTF-8 errors and byte ceilings', () => {
  const base = previewInput();
  assert.throws(() => ExportEvidenceBundleInputSchema.parse({ ...base, surprise: true }), /unrecognized/i);
  assert.throws(() => ExportEvidenceBundleInputSchema.parse({ ...base, target_bundle_sha256: '0'.repeat(64) }), /only valid for persist/i);
  assert.throws(() => ExportEvidenceBundleInputSchema.parse({ ...base, operation: 'persist' }), /required for persist/i);
  assert.throws(() => ExportEvidenceBundleInputSchema.parse({ ...base, bundle_slug: '../escape' }), /invalid|unsafe/i);
  assert.throws(
    () => ExportEvidenceBundleInputSchema.parse({ ...base, artifact: { ...base.artifact, file_name: '../map.svg' } }),
    /invalid|unsafe/i,
  );
  assert.throws(
    () => ExportEvidenceBundleInputSchema.parse({ ...base, artifact: { ...base.artifact, media_type: 'application/geo+json; charset=utf-8' } }),
    /extension.*media_type/i,
  );
  assert.throws(
    () => ExportEvidenceBundleInputSchema.parse({ ...base, artifact: { ...base.artifact, content: '\uD800' }, evidence: upstreamEvidence('\uD800') }),
    /round-trip UTF-8/i,
  );
  assert.throws(
    () => ExportEvidenceBundleInputSchema.parse({ ...base, report: 'x'.repeat(MAX_REPORT_BYTES + 1) }),
    /report exceeds byte ceiling/i,
  );
  const huge = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
  assert.throws(
    () => ExportEvidenceBundleInputSchema.parse({ ...base, artifact: { ...base.artifact, content: huge }, evidence: upstreamEvidence(huge) }),
    /artifact content exceeds byte ceiling/i,
  );
});

test('persist rejects hash mismatch, absent identity, missing receipt and forged receipt before storage', async () => {
  const base = previewInput();
  const previewed = await preview(base);
  const validPersist = persistInput(base, previewed.archive.sha256);
  let storageCalls = 0;
  const io = { artifactStorage: { storeBundle: async () => { storageCalls += 1; throw new Error('must not store'); } } };

  const mismatch = persistInput(base, '0'.repeat(64));
  await assert.rejects(() => exportEvidenceBundleCapability.execute(mismatch, { ...context, agentRunId: RUN_ID, io }), /target_bundle_sha256 mismatch/i);
  const mismatchReceipt = await approvedReceipt(mismatch, new InMemoryApprovalStore());
  await assert.rejects(
    () => executeCapability('export_evidence_bundle', mismatch, {
      ...context,
      agentRunId: RUN_ID,
      approvalReceipt: mismatchReceipt,
      io,
    }),
    /target_bundle_sha256 mismatch/i,
  );
  assert.ok(claimConsumedApprovalReceipt(mismatchReceipt, {
    agentRunId: RUN_ID,
    skill: 'export_evidence_bundle',
    payload: mismatch,
    credentialIdentity: IDENTITY,
  }));

  delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
  await assert.rejects(() => exportEvidenceBundleCapability.execute(validPersist, { ...context, agentRunId: RUN_ID, io }), /no trusted execution identity/i);

  process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({ export_evidence_bundle: IDENTITY });
  await assert.rejects(() => exportEvidenceBundleCapability.execute(validPersist, { ...context, agentRunId: RUN_ID, io }), /approval receipt/i);
  await assert.rejects(
    () => exportEvidenceBundleCapability.execute(validPersist, { ...context, agentRunId: RUN_ID, approvalReceipt: { snapshot: {} } as never, io }),
    /approval receipt/i,
  );
  assert.equal(storageCalls, 0);
});

test('approved persist writes exact four-entry archive, reports verification, and is idempotent only with a new receipt', async () => {
  await withTempRoot(async (root) => {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({ export_evidence_bundle: IDENTITY });
    const base = previewInput();
    const previewed = await preview(base);
    const input = persistInput(base, previewed.archive.sha256);
    const storeOne = new InMemoryApprovalStore();
    const receiptOne = await approvedReceipt(input, storeOne);
    const authorizeOne = (): void => {
      verifyConsumedApprovalReceipt(receiptOne, {
        agentRunId: RUN_ID,
        skill: 'export_evidence_bundle',
        payload: input as Record<string, unknown>,
        credentialIdentity: IDENTITY,
      });
    };
    const storageOne = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: authorizeOne });
    const first = ExportEvidenceBundleOutputSchema.parse(await executeCapability('export_evidence_bundle', input, {
      ...context,
      agentRunId: RUN_ID,
      approvalReceipt: receiptOne,
      io: { artifactStorage: storageOne },
    }));
    assert.equal(first.persisted, true);
    assert.equal(first.created, true);
    assert.equal(first.archive.read_back_verified, true);
    assert.deepEqual(first.export_evidence.approvals, []);
    const forgedApproval = structuredClone(first);
    forgedApproval.export_evidence.approvals.push({
      approval_id: 'forged-approval',
      payload_hash: '0'.repeat(64),
      target: `capability:export_evidence_bundle|project:${PROJECT_ID}|bundle:${previewed.archive.sha256}`,
      credential_identity: IDENTITY,
      decision: 'approved',
      decided_by: 'forged-operator',
      decided_at: '2026-07-21T00:00:00.000Z',
    });
    assert.throws(
      () => ExportEvidenceBundleOutputSchema.parse(forgedApproval),
      /must not serialize unverifiable approval claims/i,
    );

    const archivePath = join(root, 'projects', PROJECT_ID, 'artifacts', previewed.archive.sha256, 'bundle.zip');
    const archiveBytes = await readFile(archivePath);
    assert.equal(sha256Text(archiveBytes), previewed.archive.sha256);
    assert.deepEqual(parseZipNames(archiveBytes), ['manifest.json', 'report.json', 'evidence.json', 'useful-map.svg']);
    assert.equal(archiveBytes.byteLength, previewed.archive.bytes);

    await assert.rejects(
      () => executeCapability('export_evidence_bundle', input, {
        ...context,
        agentRunId: RUN_ID,
        approvalReceipt: receiptOne,
        io: { artifactStorage: storageOne },
      }),
      /approval receipt|already consumed|not consumable/i,
    );

    const storeTwo = new InMemoryApprovalStore();
    const receiptTwo = await approvedReceipt(input, storeTwo);
    const storageTwo = createProjectArtifactStorage({
      trustedRoot: root,
      authorizeSink: () => {
        verifyConsumedApprovalReceipt(receiptTwo, {
          agentRunId: RUN_ID,
          skill: 'export_evidence_bundle',
          payload: input as Record<string, unknown>,
          credentialIdentity: IDENTITY,
        });
      },
    });
    const second = ExportEvidenceBundleOutputSchema.parse(await executeCapability('export_evidence_bundle', input, {
      ...context,
      agentRunId: RUN_ID,
      approvalReceipt: receiptTwo,
      io: { artifactStorage: storageTwo },
    }));
    assert.equal(second.created, false);
    assert.equal(second.archive.sha256, first.archive.sha256);
    assert.deepEqual(await readFile(archivePath), archiveBytes);

    const receiptThree = await approvedReceipt(input, new InMemoryApprovalStore());
    const approvalExecutionGrant = claimConsumedApprovalReceipt(receiptThree, {
      agentRunId: RUN_ID,
      skill: 'export_evidence_bundle',
      payload: input,
      credentialIdentity: IDENTITY,
    });
    process.env.DYMAXION_ARTIFACT_ROOT = root;
    try {
      const grantOnly = ExportEvidenceBundleOutputSchema.parse(await exportEvidenceBundleCapability.execute(input, {
        ...context,
        agentRunId: RUN_ID,
        approvalExecutionGrant,
      }));
      assert.equal(grantOnly.created, false);
      assert.equal(grantOnly.archive.read_back_verified, true);
    } finally {
      delete process.env.DYMAXION_ARTIFACT_ROOT;
    }
  });
});

test('output schema rejects mutated duplicate integrity claims', async () => {
  const output = await preview();
  const mutate = (change: (candidate: ExportEvidenceBundleOutput) => void): ExportEvidenceBundleOutput => {
    const candidate = structuredClone(output);
    change(candidate);
    return candidate;
  };
  const cases = [
    mutate((candidate) => { candidate.handle = candidate.handle.replace(candidate.archive.sha256, '0'.repeat(64)); }),
    mutate((candidate) => { candidate.export_report.archive_sha256 = '0'.repeat(64); }),
    mutate((candidate) => { candidate.manifest.entries.report.sha256 = '0'.repeat(64); }),
    mutate((candidate) => { candidate.manifest.entries.evidence.bytes += 1; }),
    mutate((candidate) => { candidate.manifest.entries.artifact.path = 'different.svg'; }),
    mutate((candidate) => { candidate.manifest.entries.artifact.output_name = 'different'; }),
    mutate((candidate) => { candidate.export_report.artifact.sha256 = '0'.repeat(64); }),
    mutate((candidate) => { candidate.export_evidence.source.bytes += 1; }),
    mutate((candidate) => { candidate.export_evidence.source.uri = 'dymaxion:inline-evidence:wrong'; }),
    mutate((candidate) => { candidate.export_evidence.parameters.sha256 = '0'.repeat(64); }),
    mutate((candidate) => {
      candidate.export_evidence.parameters.canonical_json = '{}';
      candidate.export_evidence.parameters.sha256 = sha256Text('{}');
    }),
    mutate((candidate) => { candidate.export_evidence.bundle_id = 'wrong'; }),
    mutate((candidate) => {
      candidate.export_evidence.outputs = [{ ...candidate.export_evidence.outputs[0]!, bytes: candidate.archive.bytes + 1 }];
    }),
  ];
  for (const mutated of cases) {
    assert.throws(() => ExportEvidenceBundleOutputSchema.parse(mutated), /mismatch|does not match/i);
  }
  assert.equal(canonicalJson(output.manifest).includes('archive_sha256'), false);
});
