import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deliverableHandle,
  parseDeliverableHandle,
  readVerifiedDeliverable,
  storeDeliverable,
} from '../src/workflows/deliverable-storage.js';

const PROJECT_ID = '519e8c7c-5176-5de6-a8cf-52b7772e0e34';
const BUNDLE_SHA = 'a'.repeat(64);

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withRoots(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dymaxion-storage-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'dymaxion-storage-outside-'));
  try {
    await run(root, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('deliverable storage persists and reopens exact bytes, then rejects tampering', async () => {
  await withRoots(async (root) => {
    const content = 'approval-bound change ticket\n';
    let authorizationChecks = 0;
    const stored = await storeDeliverable(
      {
        projectId: PROJECT_ID,
        bundleSha256: BUNDLE_SHA,
        entry: 'change-ticket.md',
        expectedSha256: sha256(content),
        expectedBytes: Buffer.byteLength(content),
        content,
      },
      {
        trustedRoot: root,
        authorize: async () => { authorizationChecks += 1; },
      },
    );

    assert.ok(authorizationChecks >= 6);
    const verified = await readVerifiedDeliverable({
      path: stored.path,
      trustedRoot: root,
      expectedSha256: stored.sha256,
      expectedBytes: stored.bytes,
    });
    assert.equal(verified.toString('utf8'), content);

    await writeFile(stored.path, 'tampered\n', 'utf8');
    await assert.rejects(
      () => readVerifiedDeliverable({
        path: stored.path,
        trustedRoot: root,
        expectedSha256: stored.sha256,
        expectedBytes: stored.bytes,
      }),
      /byte count mismatch|integrity verification failed/i,
    );
  });
});

test('deliverable storage rejects symlinked project ancestry and trusted-root symlinks', async () => {
  await withRoots(async (root, outside) => {
    await mkdir(join(root, 'projects'));
    await symlink(outside, join(root, 'projects', PROJECT_ID));
    const content = 'must remain inside root';
    await assert.rejects(
      () => storeDeliverable(
        {
          projectId: PROJECT_ID,
          bundleSha256: BUNDLE_SHA,
          entry: 'change-ticket.md',
          expectedSha256: sha256(content),
          expectedBytes: Buffer.byteLength(content),
          content,
        },
        { trustedRoot: root, authorize: async () => undefined },
      ),
      /real directory|trusted artifact tree|secure deliverable storage worker failed/i,
    );

    const linkedRoot = `${root}-link`;
    await symlink(root, linkedRoot);
    try {
      await assert.rejects(
        () => readVerifiedDeliverable({
          path: join(root, 'missing'),
          trustedRoot: linkedRoot,
          expectedSha256: BUNDLE_SHA,
          expectedBytes: 1,
        }),
        /trusted root is not a real directory/i,
      );
    } finally {
      await rm(linkedRoot, { force: true });
    }
  });
});

for (const attackedStage of ['temp-create', 'hard-link'] as const) {
  test(`deliverable storage defeats ancestor replacement before ${attackedStage}`, async () => {
    await withRoots(async (root, outside) => {
      const content = `approved content for ${attackedStage}\n`;
      const projectsPath = join(root, 'projects');
      const originalProjectsPath = join(root, `projects-original-${attackedStage}`);
      const outsideTargetDir = join(outside, PROJECT_ID, 'deliverables', BUNDLE_SHA);
      let attacked = false;

      await assert.rejects(
        () => storeDeliverable(
          {
            projectId: PROJECT_ID,
            bundleSha256: BUNDLE_SHA,
            entry: 'change-ticket.md',
            expectedSha256: sha256(content),
            expectedBytes: Buffer.byteLength(content),
            content,
          },
          {
            trustedRoot: root,
            authorize: async (stage) => {
              if (stage !== attackedStage || attacked) return;
              attacked = true;
              await rename(projectsPath, originalProjectsPath);
              await mkdir(outsideTargetDir, { recursive: true });
              await symlink(outside, projectsPath);
            },
          },
        ),
        /secure deliverable storage worker failed/i,
      );

      assert.equal(attacked, true);
      assert.equal(await pathExists(join(outsideTargetDir, 'change-ticket.md')), false);
      const originalTargetDir = join(originalProjectsPath, PROJECT_ID, 'deliverables', BUNDLE_SHA);
      const entries = await readdir(originalTargetDir);
      assert.equal(entries.some((entry) => entry.startsWith('.tmp-')), false);
      assert.equal(entries.includes('change-ticket.md'), false);
    });
  });
}

for (const attackedStage of ['temp-create', 'hard-link'] as const) {
  test(`deliverable storage defeats trusted-root replacement before ${attackedStage}`, async () => {
    await withRoots(async (root, outside) => {
      const content = `approved root-bound content for ${attackedStage}\n`;
      const detachedRoot = `${root}-detached-${attackedStage}`;
      const detachedTarget = join(
        detachedRoot,
        'projects',
        PROJECT_ID,
        'deliverables',
        BUNDLE_SHA,
        'change-ticket.md',
      );
      const outsideTarget = join(
        outside,
        'projects',
        PROJECT_ID,
        'deliverables',
        BUNDLE_SHA,
        'change-ticket.md',
      );
      let attacked = false;

      try {
        await assert.rejects(
          () => storeDeliverable(
            {
              projectId: PROJECT_ID,
              bundleSha256: BUNDLE_SHA,
              entry: 'change-ticket.md',
              expectedSha256: sha256(content),
              expectedBytes: Buffer.byteLength(content),
              content,
            },
            {
              trustedRoot: root,
              authorize: async (stage) => {
                if (stage !== attackedStage || attacked) return;
                attacked = true;
                await rename(root, detachedRoot);
                await symlink(outside, root);
              },
            },
          ),
          /secure deliverable storage worker failed/i,
        );

        assert.equal(attacked, true);
        assert.equal(await pathExists(outsideTarget), false);
        assert.equal(await pathExists(detachedTarget), false);
      } finally {
        if (attacked) {
          await rm(root, { force: true });
          await rename(detachedRoot, root);
        }
      }
    });
  });
}

test('deliverable handles are strict and path-free', () => {
  const parsed = { projectId: PROJECT_ID, bundleSha256: BUNDLE_SHA, entry: 'bundle.zip' as const };
  const handle = deliverableHandle(parsed);
  assert.deepEqual(parseDeliverableHandle(handle), parsed);
  assert.throws(() => parseDeliverableHandle('/tmp/bundle.zip'), /deliverable handle/i);
  assert.throws(
    () => parseDeliverableHandle(`deliverable://project/${PROJECT_ID}/bundle/${BUNDLE_SHA}/../change-ticket.md`),
    /deliverable handle/i,
  );
});

test('deliverable storage rejects oversized content before authorization or persistence', async () => {
  await withRoots(async (root) => {
    const content = 'a'.repeat(5 * 1024 * 1024 + 1);
    let authorized = false;
    await assert.rejects(
      () => storeDeliverable(
        {
          projectId: PROJECT_ID,
          bundleSha256: BUNDLE_SHA,
          entry: 'change-ticket.md',
          expectedSha256: sha256(content),
          expectedBytes: Buffer.byteLength(content),
          content,
        },
        { trustedRoot: root, authorize: async () => { authorized = true; } },
      ),
      /byte ceiling/i,
    );
    assert.equal(authorized, false);
    assert.deepEqual(await readdir(root), []);
  });
});
