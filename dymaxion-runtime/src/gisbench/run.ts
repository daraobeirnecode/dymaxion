import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runSkill, type RunSkillDependencies } from '../skills/executor.js';
import { sha256Canonical, sha256Text } from '../contracts/canonical.js';

const TaskSchema = z
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
    expected: z
      .object({
        outcome: z.enum(['success', 'error']),
        golden_file: z.string().regex(/^[a-z0-9-]+\.json$/),
      })
      .strict(),
    tolerances: z
      .object({
        numeric_absolute: z.number().nonnegative(),
        normalized_fields: z.array(z.string()),
      })
      .strict(),
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
    expected_approval: z
      .object({ required: z.literal(false), decision: z.literal('not-requested') })
      .strict(),
  })
  .strict();

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

function validateEvidenceHashes(normalized: Record<string, unknown>): void {
  if (normalized.ok !== true) return;
  assert.ok(normalized.output && typeof normalized.output === 'object', 'successful result requires output');
  const output = normalized.output as Record<string, unknown>;
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

export function normalizeResult(
  result: { ok: boolean; output?: unknown; error?: string; costUsd: number },
  normalizedFields: string[],
  workspaceRoot: string,
  fixtureRoot: string,
): unknown {
  const normalized = JSON.parse(
    JSON.stringify({
      ok: result.ok,
      output: result.output,
      error: result.error,
      cost_usd: result.costUsd,
    }),
  ) as Record<string, unknown>;
  validateEvidenceHashes(normalized);
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

async function executeTask(
  task: TaskDefinition,
  roots: { benchmark: string; fixtures: string; workspace: string },
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
  assert.equal(result.ok, task.expected.outcome === 'success', `${task.id}: unexpected outcome`);
  assert.equal(task.expected_approval.required, false);
  assert.equal(task.expected_approval.decision, 'not-requested');
  const disallowed = [...operations].filter((operation) => !task.allowed_operations.includes(operation as never));
  assert.deepEqual(disallowed, [], `${task.id}: disallowed operations`);
  return {
    normalized: normalizeResult(
      result,
      task.tolerances.normalized_fields,
      roots.workspace,
      roots.fixtures,
    ),
    operations: [...operations],
  };
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
  assert.equal(taskFiles.length, 5, 'GISBench Phase 0 must contain exactly five tasks');
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
