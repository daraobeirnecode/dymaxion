import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  BoundaryViolation,
  assertExecutionBoundary,
  assertPathAllowed,
  assertUrlAllowed,
} from '../src/security/boundary.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

const noAudit = async () => undefined;
const publicResolver = async () => ['8.8.8.8'];

async function expectBoundaryViolation(action: () => Promise<unknown>, kind: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof BoundaryViolation);
    assert.equal(error.kind, kind);
    return true;
  });
}

test('recursive preflight blocks nested denied and non-allowlisted URLs', async () => {
  await expectBoundaryViolation(
    () =>
      assertExecutionBoundary(
        { options: [{ innocent: { endpoint: 'https://maps.cityofsacramento.org/arcgis/rest' } }] },
        { audit: noAudit, resolveHost: publicResolver },
      ),
    'hostname',
  );
  await expectBoundaryViolation(
    () =>
      assertExecutionBoundary(
        { nested: { link: 'https://example.com/data.geojson' } },
        { audit: noAudit, resolveHost: publicResolver },
      ),
    'source',
  );
});

test('URL enforcement rejects credentials, private addresses, and unknown schemes', async () => {
  await expectBoundaryViolation(
    () => assertUrlAllowed('https://user:pass@example.maps.arcgis.com/x', { audit: noAudit, resolveHost: publicResolver }),
    'source',
  );
  await expectBoundaryViolation(
    () => assertUrlAllowed('https://127.0.0.1/x', { audit: noAudit, resolveHost: async () => ['127.0.0.1'] }),
    'hostname',
  );
  await expectBoundaryViolation(
    () =>
      assertUrlAllowed('https://example.maps.arcgis.com/x', {
        audit: noAudit,
        resolveHost: async () => ['100.64.0.1'],
      }),
    'hostname',
  );
  await expectBoundaryViolation(
    () =>
      assertUrlAllowed('https://example.maps.arcgis.com/x', {
        audit: noAudit,
        resolveHost: async () => ['203.0.113.10'],
      }),
    'hostname',
  );
  await expectBoundaryViolation(
    () => assertExecutionBoundary({ source_uri: 'ftp://example.com/data' }, { audit: noAudit }),
    'source',
  );
});

test('path enforcement canonicalizes traversal and blocks symlink escape', async () => {
  const allowed = join(repoRoot, 'gisbench', 'fixtures', 'points.geojson');
  await assertPathAllowed(allowed, { audit: noAudit });
  await expectBoundaryViolation(
    () => assertPathAllowed(join(repoRoot, '..', 'outside.geojson'), { audit: noAudit }),
    'path',
  );

  const sandbox = await mkdtemp(join(tmpdir(), 'dymaxion-boundary-'));
  const outside = join(sandbox, 'outside.geojson');
  const fixturesDir = join(repoRoot, 'gisbench', 'fixtures');
  await mkdir(fixturesDir, { recursive: true });
  const link = join(fixturesDir, '.escape-link.geojson');
  await writeFile(outside, '{}');
  await symlink(outside, link);
  try {
    await expectBoundaryViolation(() => assertPathAllowed(link, { audit: noAudit }), 'path');
  } finally {
    await rm(link, { force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('recursive preflight fails closed on cycles and excessive depth', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expectBoundaryViolation(() => assertExecutionBoundary(cyclic, { audit: noAudit }), 'source');

  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 40; i += 1) {
    deep.child = {};
    deep = deep.child as Record<string, unknown>;
  }
  await expectBoundaryViolation(() => assertExecutionBoundary(root, { audit: noAudit }), 'source');
});
