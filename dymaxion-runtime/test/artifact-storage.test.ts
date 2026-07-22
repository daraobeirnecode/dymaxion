import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_BUNDLE_FILES,
  createProjectArtifactStorage,
  nodeArtifactStorageFs,
  type ArtifactStorageFs,
} from '../src/capabilities/artifact-storage.js';

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipPath(root: string, projectId: string, hash: string): string {
  return join(root, 'projects', projectId, 'artifacts', hash, 'bundle.zip');
}

async function withTempRoot<T>(fn: (root: string, parent: string) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'dymaxion-artifacts-'));
  const root = join(parent, 'trusted-root');
  await mkdir(root, { mode: 0o700 });
  try {
    return await fn(root, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function authorizer(denyAt = Number.POSITIVE_INFINITY): { authorizeSink: () => void; count: () => number } {
  let count = 0;
  return {
    authorizeSink: () => {
      count += 1;
      if (count === denyAt) {
        throw new Error('denied by test receipt');
      }
    },
    count: () => count,
  };
}

async function store(root: string, bytes: Uint8Array, overrides: Partial<Parameters<typeof createProjectArtifactStorage>[0]> = {}) {
  const auth = overrides.authorizeSink ? undefined : authorizer();
  const storage = createProjectArtifactStorage({
    trustedRoot: root,
    authorizeSink: auth?.authorizeSink ?? (() => undefined),
    randomSuffix: () => 'fixed-temp-suffix',
    ...overrides,
  });
  const result = await storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes });
  return { result, authCount: auth?.count() ?? 0 };
}

async function seedBundle(root: string, projectId: string, hash: string, bytes: Uint8Array): Promise<void> {
  const dir = join(root, 'projects', projectId, 'artifacts', hash);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'bundle.zip'), bytes, { mode: 0o600 });
}

test('creates a project-scoped content-addressed artifact with opaque handle, exact readback and POSIX modes', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from('deterministic zip bytes');
    const { result, authCount } = await store(root, bytes);

    assert.deepEqual(result, {
      handle: `artifact://project/${PROJECT_ID}/bundle/${sha256(bytes)}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      created: true,
      readbackVerified: true,
    });
    assert.equal(authCount, 6);
    assert.deepEqual(await readFile(zipPath(root, PROJECT_ID, sha256(bytes))), bytes);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(zipPath(root, PROJECT_ID, sha256(bytes)))).mode & 0o777, 0o600);
      assert.equal((await lstat(join(root, 'projects'))).mode & 0o777, 0o700);
    }
  });
});

test('is create-only and idempotent only for an exact pre-existing target', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from('same archive');
    const first = await store(root, bytes);
    const second = await store(root, bytes);
    assert.equal(first.result.created, true);
    assert.equal(second.result.created, false);
    assert.equal(second.authCount, 4);
    assert.deepEqual(await readFile(zipPath(root, PROJECT_ID, sha256(bytes))), bytes);

    const conflicting = Buffer.from('conflicting archive');
    await seedBundle(root, PROJECT_ID, sha256(conflicting), Buffer.from('different bytes'));
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: () => undefined });
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(conflicting), archiveBytes: conflicting }),
      /artifact target conflict/i,
    );
  });
});

test('rejects bad schemas, hash mismatches and archive byte ceilings before authorization or mutation', async () => {
  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('zip');
    const auth = authorizer();
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: auth.authorizeSink });

    await assert.rejects(
      () => storage.storeBundle({ projectId: '../escape', bundleSha256: sha256(bytes), archiveBytes: bytes }),
      /invalid artifact request/i,
    );
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: 'A'.repeat(64), archiveBytes: bytes }),
      /invalid artifact request/i,
    );
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: '0'.repeat(64), archiveBytes: bytes }),
      /artifact hash mismatch/i,
    );
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(new Uint8Array(5 * 1024 * 1024 + 1)), archiveBytes: new Uint8Array(5 * 1024 * 1024 + 1) }),
      /artifact archive too large/i,
    );
    assert.equal(auth.count(), 0);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual((await readdir(parent)).sort(), ['trusted-root']);
  });
});

test('authorization gates each externally visible create and denial leaves no unauthorized target', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from('authorized later');
    const firstMutationDenied = authorizer(1);
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: firstMutationDenied.authorizeSink });
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
      /denied by test receipt/,
    );
    assert.equal(firstMutationDenied.count(), 1);
    assert.deepEqual(await readdir(root), []);

    const openDenied = authorizer(5);
    const second = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: openDenied.authorizeSink, randomSuffix: () => 'open-denied' });
    await assert.rejects(
      () => second.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
      /denied by test receipt/,
    );
    assert.equal(openDenied.count(), 5);
    assert.equal(await lstat(join(root, 'projects', PROJECT_ID, 'artifacts', sha256(bytes))).then((stat) => stat.isDirectory()), true);
    await assert.rejects(() => lstat(zipPath(root, PROJECT_ID, sha256(bytes))), /ENOENT/);
  });
});

test('rejects trusted-root, project, artifact, hash and final-target symlinks or non-directories without outside writes', async (t) => {
  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('symlink check');
    const outside = join(parent, 'outside');
    await mkdir(outside);
    const rootLink = join(parent, 'root-link');
    await symlink(root, rootLink, 'dir');
    await assert.rejects(
      () => createProjectArtifactStorage({ trustedRoot: rootLink, authorizeSink: () => undefined }).storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
      /trusted root/i,
    );

    await symlink(outside, join(root, 'projects'), 'dir');
    await assert.rejects(() => store(root, bytes), /artifact directory/i);
    assert.deepEqual(await readdir(outside), []);
  });

  await withTempRoot(async (root) => {
    const bytes = Buffer.from('non-dir');
    await mkdir(join(root, 'projects'), { mode: 0o700 });
    await writeFile(join(root, 'projects', PROJECT_ID), 'not a directory');
    await assert.rejects(() => store(root, bytes), /artifact directory/i);
  });

  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('artifacts symlink');
    const outside = join(parent, 'outside-artifacts');
    await mkdir(outside);
    await mkdir(join(root, 'projects', PROJECT_ID), { recursive: true });
    await symlink(outside, join(root, 'projects', PROJECT_ID, 'artifacts'), 'dir');
    await assert.rejects(() => store(root, bytes), /artifact directory/i);
    assert.deepEqual(await readdir(outside), []);
  });

  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('hash symlink');
    const hash = sha256(bytes);
    const outside = join(parent, 'outside-hash');
    await mkdir(outside);
    await mkdir(join(root, 'projects', PROJECT_ID, 'artifacts'), { recursive: true });
    await symlink(outside, join(root, 'projects', PROJECT_ID, 'artifacts', hash), 'dir');
    await assert.rejects(() => store(root, bytes), /artifact directory/i);
    assert.deepEqual(await readdir(outside), []);
  });

  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('final symlink');
    const hash = sha256(bytes);
    await mkdir(join(root, 'projects', PROJECT_ID, 'artifacts', hash), { recursive: true });
    const outsideTarget = join(parent, 'outside-final.zip');
    await writeFile(outsideTarget, 'outside');
    await symlink(outsideTarget, zipPath(root, PROJECT_ID, hash));
    await assert.rejects(() => store(root, bytes), /artifact target conflict/i);
    assert.equal(await readFile(outsideTarget, 'utf8'), 'outside');
  });
});

test('rejects lstat-to-open substitution races for exact-target and quota inspection', async () => {
  await withTempRoot(async (root, parent) => {
    const bytes = Buffer.from('existing exact target');
    const hash = sha256(bytes);
    const target = zipPath(root, PROJECT_ID, hash);
    const outside = join(parent, 'outside-exact.zip');
    await seedBundle(root, PROJECT_ID, hash, bytes);
    await writeFile(outside, bytes);
    let raced = false;
    const racingFs: ArtifactStorageFs = {
      ...nodeArtifactStorageFs,
      open: async (path, flags, mode) => {
        if (!raced && path === target) {
          raced = true;
          await unlink(target);
          await symlink(outside, target);
        }
        return nodeArtifactStorageFs.open(path, flags, mode);
      },
    };
    await assert.rejects(
      () => store(root, bytes, { fs: racingFs }),
      /artifact target conflict|filesystem operation failed/i,
    );
    assert.equal(raced, true);
    assert.deepEqual(await readFile(outside), bytes);
  });

  await withTempRoot(async (root, parent) => {
    const existing = Buffer.from('quota existing');
    const existingHash = sha256(existing);
    const existingTarget = zipPath(root, PROJECT_ID, existingHash);
    const outside = join(parent, 'outside-quota.zip');
    await seedBundle(root, PROJECT_ID, existingHash, existing);
    await writeFile(outside, existing);
    let raced = false;
    const racingFs: ArtifactStorageFs = {
      ...nodeArtifactStorageFs,
      open: async (path, flags, mode) => {
        if (!raced && path === existingTarget) {
          raced = true;
          await unlink(existingTarget);
          await symlink(outside, existingTarget);
        }
        return nodeArtifactStorageFs.open(path, flags, mode);
      },
    };
    const next = Buffer.from('quota next');
    await assert.rejects(
      () => store(root, next, { fs: racingFs }),
      /unexpected structure|filesystem operation failed/i,
    );
    assert.equal(raced, true);
    assert.deepEqual(await readFile(outside), existing);
  });
});

test('enforces bounded project bundle count and byte quotas before writing new targets', async () => {
  await withTempRoot(async (root) => {
    for (let index = 0; index < MAX_PROJECT_BUNDLE_FILES; index += 1) {
      const bytes = Buffer.from(`bundle-${index}`);
      await seedBundle(root, PROJECT_ID, sha256(bytes), bytes);
    }
    const next = Buffer.from('one-too-many');
    await assert.rejects(() => store(root, next), /project artifact quota/i);
  });

  await withTempRoot(async (root) => {
    const existingHash = 'a'.repeat(64);
    await seedBundle(root, PROJECT_ID, existingHash, new Uint8Array());
    await truncate(zipPath(root, PROJECT_ID, existingHash), MAX_PROJECT_ARTIFACT_BYTES);
    const next = Buffer.from('too many bytes');
    await assert.rejects(() => store(root, next), /project artifact quota/i);
  });
});

test('honors cancellation before sinks and cleans temp files after injected partial-write failure', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from('cancelled');
    const controller = new AbortController();
    controller.abort();
    const auth = authorizer();
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: auth.authorizeSink });
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes, signal: controller.signal }),
      /artifact storage cancelled/i,
    );
    assert.equal(auth.count(), 0);
    assert.deepEqual(await readdir(root), []);
  });

  await withTempRoot(async (root) => {
    const bytes = Buffer.from('cancel during directory fsync');
    const controller = new AbortController();
    const hashDir = join(root, 'projects', PROJECT_ID, 'artifacts', sha256(bytes));
    let closes = 0;
    const cancellingFs: ArtifactStorageFs = {
      ...nodeArtifactStorageFs,
      open: async (path, flags, mode) => {
        const handle = await nodeArtifactStorageFs.open(path, flags, mode);
        if (path !== hashDir) return handle;
        controller.abort();
        return {
          write: handle.write.bind(handle),
          read: handle.read.bind(handle),
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          close: async () => {
            closes += 1;
            await handle.close();
          },
        };
      },
    };
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: () => undefined, fs: cancellingFs });
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes, signal: controller.signal }),
      /artifact storage cancelled/i,
    );
    assert.equal(closes, 1);
    assert.deepEqual(await readdir(hashDir), []);
  });

  await withTempRoot(async (root) => {
    const bytes = Buffer.from('cancel after temp creation');
    const controller = new AbortController();
    const cancellingFs: ArtifactStorageFs = {
      ...nodeArtifactStorageFs,
      open: async (path, flags, mode) => {
        const handle = await nodeArtifactStorageFs.open(path, flags, mode);
        if (String(path).includes('.tmp-')) controller.abort();
        return handle;
      },
    };
    const storage = createProjectArtifactStorage({
      trustedRoot: root,
      authorizeSink: () => undefined,
      randomSuffix: () => 'cancel-after-open',
      fs: cancellingFs,
    });
    await assert.rejects(
      () => storage.storeBundle({
        projectId: PROJECT_ID,
        bundleSha256: sha256(bytes),
        archiveBytes: bytes,
        signal: controller.signal,
      }),
      /artifact storage cancelled/i,
    );
    const hashDir = join(root, 'projects', PROJECT_ID, 'artifacts', sha256(bytes));
    assert.deepEqual(await readdir(hashDir), []);
  });

  await withTempRoot(async (root) => {
    const bytes = Buffer.from('partial failure');
    const fsImpl = nodeArtifactStorageFs;
    const faultingFs: ArtifactStorageFs = {
      ...fsImpl,
      open: async (path, flags, mode) => {
        const handle = await fsImpl.open(path, flags, mode);
        if (String(path).includes('.tmp-')) {
          return {
            write: async () => {
              throw new Error('injected partial-write failure');
            },
            read: handle.read.bind(handle),
            stat: handle.stat.bind(handle),
            sync: handle.sync.bind(handle),
            close: handle.close.bind(handle),
          };
        }
        return handle;
      },
    };
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: () => undefined, randomSuffix: () => 'partial', fs: faultingFs });
    await assert.rejects(
      () => storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
      /injected partial-write failure/,
    );
    const hashDir = join(root, 'projects', PROJECT_ID, 'artifacts', sha256(bytes));
    assert.deepEqual(await readdir(hashDir), []);
  });
});

test('verified publish success is not reversed by post-commit cleanup authorization', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from('commit then cleanup');
    const auth = authorizer(7);
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: auth.authorizeSink, randomSuffix: () => 'cleanup' });
    const result = await storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes });
    assert.equal(result.created, true);
    assert.equal(result.readbackVerified, true);
    assert.equal(auth.count(), 6);
    const hashDir = join(root, 'projects', PROJECT_ID, 'artifacts', sha256(bytes));
    assert.deepEqual(await readFile(join(hashDir, 'bundle.zip')), bytes);
    assert.deepEqual(await readdir(hashDir), ['bundle.zip']);
  });
});

test('serializes per-project concurrent writes: same target is one create and one exact existing; quota sees prior writes', async () => {
  await withTempRoot(async (root) => {
    const bytes = randomBytes(64);
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: () => undefined });
    const results = await Promise.all([
      storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
      storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(bytes), archiveBytes: bytes }),
    ]);
    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(await readFile(zipPath(root, PROJECT_ID, sha256(bytes))), bytes);
  });

  await withTempRoot(async (root) => {
    for (let index = 0; index < MAX_PROJECT_BUNDLE_FILES - 1; index += 1) {
      const bytes = Buffer.from(`existing-${index}`);
      await seedBundle(root, PROJECT_ID, sha256(bytes), bytes);
    }
    const storage = createProjectArtifactStorage({ trustedRoot: root, authorizeSink: () => undefined });
    const one = Buffer.from('new-one');
    const two = Buffer.from('new-two');
    const settled = await Promise.allSettled([
      storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(one), archiveBytes: one }),
      storage.storeBundle({ projectId: PROJECT_ID, bundleSha256: sha256(two), archiveBytes: two }),
    ]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
  });
});
