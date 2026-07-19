import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ArcGisRestTransport } from '../capabilities/arcgis-rest.js';
import { runSkill, type RunSkillDependencies } from '../skills/executor.js';
import { sha256Canonical, sha256Text } from '../contracts/canonical.js';

const TASK_COUNT = 10; // 5 Phase 0 inspect_dataset + 5 Phase 1A inspect_arcgis_org

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

const ApprovalExpectationSchema = z
  .object({ required: z.literal(false), decision: z.literal('not-requested') })
  .strict();

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

const TaskSchema = z.discriminatedUnion('capability', [DatasetTaskSchema, ArcgisTaskSchema]);

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
  '$.output.evidence.source.uri': () => '<FIXTURE_URI>',
  '$.output.evidence.source.identity.value': () => '<FIXTURE_PATH>',
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

function validateEvidenceHashes(normalized: Record<string, unknown>, capability: TaskDefinition['capability']): void {
  if (normalized.ok !== true) return;
  assert.ok(normalized.output && typeof normalized.output === 'object', 'successful result requires output');
  const output = normalized.output as Record<string, unknown>;
  if (capability === 'inspect_dataset') validateDatasetEvidenceHashes(output);
  else validateArcgisEvidenceHashes(output);
}

export function normalizeResult(
  result: { ok: boolean; output?: unknown; error?: string; costUsd: number },
  normalizedFields: string[],
  workspaceRoot: string,
  fixtureRoot: string,
  capability: TaskDefinition['capability'] = 'inspect_dataset',
): unknown {
  const normalized = JSON.parse(
    JSON.stringify({
      ok: result.ok,
      output: result.output,
      error: result.error,
      cost_usd: result.costUsd,
    }),
  ) as Record<string, unknown>;
  validateEvidenceHashes(normalized, capability);
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
          status: z.number().int().optional(),
          content_type: z.string().min(1).optional(),
          body_file: z.string().regex(/^[a-z0-9.-]+\.json$/),
        })
        .strict(),
    ),
  })
  .strict();

/** Fixture-backed transport: exact-URL matching, no network, fail closed. */
async function loadFixtureTransport(
  fixtureDir: string,
  operations: Set<string>,
): Promise<ArcGisRestTransport> {
  const manifest = RouteManifestSchema.parse(
    JSON.parse(await readFile(join(fixtureDir, 'routes.json'), 'utf8')),
  );
  const routes = new Map<string, { status: number; contentType: string; bodyText: string }>();
  for (const route of manifest.routes) {
    routes.set(route.url, {
      status: route.status ?? 200,
      contentType: route.content_type ?? 'application/json; charset=utf-8',
      bodyText: await readFile(join(fixtureDir, route.body_file), 'utf8'),
    });
  }
  return {
    async get(request) {
      operations.add('arcgis_request');
      const start = Number(request.url.searchParams.get('start') ?? '1');
      if (Number.isFinite(start) && start > 1) operations.add('paginate');
      const route = routes.get(request.url.href);
      if (!route) throw new Error(`fixture transport has no route for ${request.url.href}`);
      return { status: route.status, contentType: route.contentType, bodyText: route.bodyText };
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

async function executeArcgisTask(
  task: z.infer<typeof ArcgisTaskSchema>,
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
    operations.add('derive_inventory');
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
  assert.equal(task.expected_approval.required, false);
  assert.equal(task.expected_approval.decision, 'not-requested');
  const disallowed = [...operations].filter((operation) => !task.allowed_operations.includes(operation as never));
  assert.deepEqual(disallowed, [], `${task.id}: disallowed operations`);
}

async function executeTask(
  task: TaskDefinition,
  roots: TaskRoots,
): Promise<{ normalized: unknown; operations: string[] }> {
  return task.capability === 'inspect_dataset'
    ? executeDatasetTask(task, roots)
    : executeArcgisTask(task, roots);
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
    `GISBench must contain exactly ${TASK_COUNT} tasks (5 Phase 0 + 5 Phase 1A)`,
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
