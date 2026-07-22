import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { promises as nodeFs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_ARTIFACT_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_BUNDLE_FILES = 100;

const MAX_SCAN_DIRECTORIES = 256;
const MAX_SCAN_DIRENT_COUNT = 512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TEMP_PREFIX = '.tmp-';
const BUNDLE_NAME = 'bundle.zip';

type AuthorizeSink = () => void | Promise<void>;

export interface ArtifactFileHandle {
  write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number }>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ArtifactStorageFs {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { mode: number }): Promise<void | string | undefined>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  open(path: string, flags: number, mode?: number): Promise<ArtifactFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ProjectArtifactStorageDependencies {
  trustedRoot: string;
  authorizeSink: AuthorizeSink;
  fs?: ArtifactStorageFs;
  randomSuffix?: () => string;
}

export interface StoreProjectBundleRequest {
  projectId: string;
  bundleSha256: string;
  archiveBytes: Uint8Array;
  signal?: AbortSignal;
}

export interface StoredProjectBundle {
  handle: string;
  sha256: string;
  bytes: number;
  created: boolean;
  readbackVerified: true;
}

export interface ProjectArtifactStorage {
  storeBundle(request: StoreProjectBundleRequest): Promise<StoredProjectBundle>;
}

interface VerifiedDirectory {
  path: string;
  realpath: string;
}

interface ProjectQuota {
  bundleFiles: number;
  bytes: number;
}

export const nodeArtifactStorageFs: ArtifactStorageFs = {
  lstat: (path) => nodeFs.lstat(path),
  realpath: (path) => nodeFs.realpath(path),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  readdir: (path, options) => nodeFs.readdir(path, options),
  open: async (path, flags, mode) => nodeFs.open(path, flags, mode) as Promise<FileHandle>,
  link: (existingPath, newPath) => nodeFs.link(existingPath, newPath),
  unlink: (path) => nodeFs.unlink(path),
};

const projectLocks = new Map<string, Promise<void>>();

function fail(message: string): never {
  throw new Error(message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function isFilesystemError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('code' in error || 'path' in error || 'syscall' in error || 'dest' in error)
  );
}

function sanitizeFilesystemError(error: unknown): never {
  if (isFilesystemError(error)) {
    fail('artifact storage filesystem operation failed');
  }
  throw error;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    fail('artifact storage cancelled');
  }
}

async function awaitChecked<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancelled(signal);
  const value = await operation;
  checkCancelled(signal);
  return value;
}

async function authorizeChecked(authorizeSink: AuthorizeSink, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  await authorizeSink();
  checkCancelled(signal);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function assertRequestShape(request: StoreProjectBundleRequest): void {
  if (!UUID_RE.test(request.projectId) || !SHA256_RE.test(request.bundleSha256) || !(request.archiveBytes instanceof Uint8Array)) {
    fail('invalid artifact request');
  }
}

function assertArchiveHashAndSize(request: StoreProjectBundleRequest): void {
  if (request.archiveBytes.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    fail('artifact archive too large');
  }
  if (sha256(request.archiveBytes) !== request.bundleSha256) {
    fail('artifact hash mismatch');
  }
}

function assertContained(rootRealpath: string, childRealpath: string): void {
  const fromRoot = relative(rootRealpath, childRealpath);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    return;
  }
  fail('artifact directory containment check failed');
}

async function verifyExistingDirectory(fsImpl: ArtifactStorageFs, path: string, rootRealpath: string, signal?: AbortSignal): Promise<VerifiedDirectory> {
  const stat = await awaitChecked(fsImpl.lstat(path), signal);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('artifact directory is not a real directory');
  }
  const real = resolve(await awaitChecked(fsImpl.realpath(path), signal));
  assertContained(rootRealpath, real);
  return { path, realpath: real };
}

async function verifyTrustedRoot(fsImpl: ArtifactStorageFs, trustedRoot: string, signal?: AbortSignal): Promise<VerifiedDirectory> {
  const rootPath = resolve(trustedRoot);
  const stat = await awaitChecked(fsImpl.lstat(rootPath), signal).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) {
      fail('trusted root is not a real directory');
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('trusted root is not a real directory');
  }
  const real = resolve(await awaitChecked(fsImpl.realpath(rootPath), signal));
  return { path: rootPath, realpath: real };
}

async function ensureDirectoryComponent(
  fsImpl: ArtifactStorageFs,
  authorizeSink: AuthorizeSink,
  parent: VerifiedDirectory,
  component: string,
  rootRealpath: string,
  signal?: AbortSignal,
): Promise<VerifiedDirectory> {
  if (component.includes('/') || component.includes('\\') || component === '.' || component === '..' || component.length === 0) {
    fail('invalid artifact request');
  }
  const nextPath = join(parent.path, component);
  await authorizeChecked(authorizeSink, signal);
  try {
    await awaitChecked(fsImpl.mkdir(nextPath, { mode: 0o700 }), signal);
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error;
    }
  }
  const verified = await verifyExistingDirectory(fsImpl, nextPath, rootRealpath, signal);
  if (!verified.realpath.startsWith(parent.realpath === rootRealpath ? `${rootRealpath}${sep}` : `${parent.realpath}${sep}`) && verified.realpath !== parent.realpath) {
    assertContained(rootRealpath, verified.realpath);
  }
  return verified;
}

async function ensureArtifactDirectories(
  fsImpl: ArtifactStorageFs,
  authorizeSink: AuthorizeSink,
  root: VerifiedDirectory,
  projectId: string,
  bundleSha256: string,
  signal?: AbortSignal,
): Promise<VerifiedDirectory> {
  let current = root;
  for (const component of ['projects', projectId, 'artifacts', bundleSha256]) {
    current = await ensureDirectoryComponent(fsImpl, authorizeSink, current, component, root.realpath, signal);
  }
  return current;
}

interface OpenedRegularFile {
  handle: ArtifactFileHandle;
  stat: Stats;
}

function noFollowFlag(): number {
  return (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

async function openVerifiedRegularFile(
  fsImpl: ArtifactStorageFs,
  path: string,
  maxBytes: number,
  conflictMessage: string,
  allowMissing: boolean,
  signal?: AbortSignal,
): Promise<OpenedRegularFile | undefined> {
  let pathStat: Stats;
  try {
    pathStat = await awaitChecked(fsImpl.lstat(path), signal);
  } catch (error) {
    if (allowMissing && isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size < 0 || pathStat.size > maxBytes) {
    fail(conflictMessage);
  }

  let handle: ArtifactFileHandle | undefined;
  try {
    checkCancelled(signal);
    handle = await fsImpl.open(path, fsConstants.O_RDONLY | noFollowFlag());
    checkCancelled(signal);
    const descriptorStat = await awaitChecked(handle.stat(), signal);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.size < 0 ||
      descriptorStat.size > maxBytes ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      descriptorStat.size !== pathStat.size
    ) {
      fail(conflictMessage);
    }
    return { handle, stat: descriptorStat };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the verification failure.
      }
    }
    if (allowMissing && isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readExistingTargetIfExact(
  fsImpl: ArtifactStorageFs,
  targetPath: string,
  expectedBytes: Uint8Array,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const opened = await openVerifiedRegularFile(
    fsImpl,
    targetPath,
    MAX_ARTIFACT_ARCHIVE_BYTES,
    'artifact target conflict',
    true,
    signal,
  );
  if (!opened) return false;

  try {
    const bytes = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await awaitChecked(
        opened.handle.read(bytes, offset, bytes.byteLength - offset, offset),
        signal,
      );
      if (bytesRead <= 0) fail('artifact target conflict');
      offset += bytesRead;
    }
    const finalStat = await awaitChecked(opened.handle.stat(), signal);
    if (
      !finalStat.isFile() ||
      finalStat.dev !== opened.stat.dev ||
      finalStat.ino !== opened.stat.ino ||
      finalStat.size !== opened.stat.size ||
      bytes.byteLength !== expectedBytes.byteLength ||
      sha256(bytes) !== expectedSha256 ||
      !constantTimeEqualBytes(bytes, expectedBytes)
    ) {
      fail('artifact target conflict');
    }
    return true;
  } finally {
    await opened.handle.close();
  }
}

function assertHashDirectoryName(name: string): void {
  if (!SHA256_RE.test(name)) {
    fail('project artifact tree has unexpected structure');
  }
}

async function scanProjectQuota(fsImpl: ArtifactStorageFs, artifactsPath: string, signal?: AbortSignal): Promise<ProjectQuota> {
  let directoriesSeen = 1;
  let direntsSeen = 0;
  let bundleFiles = 0;
  let bytes = 0;
  const artifactDirs = await awaitChecked(fsImpl.readdir(artifactsPath, { withFileTypes: true }), signal);
  direntsSeen += artifactDirs.length;
  if (direntsSeen > MAX_SCAN_DIRENT_COUNT || artifactDirs.length > MAX_SCAN_DIRECTORIES) {
    fail('project artifact tree exceeds scan bounds');
  }

  for (const entry of artifactDirs) {
    checkCancelled(signal);
    assertHashDirectoryName(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('project artifact tree has unexpected structure');
    }
    directoriesSeen += 1;
    if (directoriesSeen > MAX_SCAN_DIRECTORIES) {
      fail('project artifact tree exceeds scan bounds');
    }
    const hashDir = join(artifactsPath, entry.name);
    const hashStat = await awaitChecked(fsImpl.lstat(hashDir), signal);
    if (!hashStat.isDirectory() || hashStat.isSymbolicLink()) {
      fail('project artifact tree has unexpected structure');
    }
    const files = await awaitChecked(fsImpl.readdir(hashDir, { withFileTypes: true }), signal);
    direntsSeen += files.length;
    if (direntsSeen > MAX_SCAN_DIRENT_COUNT || files.length > 1) {
      fail('project artifact tree has unexpected structure');
    }
    for (const file of files) {
      if (file.name !== BUNDLE_NAME || !file.isFile() || file.isSymbolicLink()) {
        fail('project artifact tree has unexpected structure');
      }
      const bundlePath = join(hashDir, BUNDLE_NAME);
      const opened = await openVerifiedRegularFile(
        fsImpl,
        bundlePath,
        MAX_PROJECT_ARTIFACT_BYTES,
        'project artifact tree has unexpected structure',
        false,
        signal,
      );
      if (!opened) fail('project artifact tree has unexpected structure');
      try {
        bundleFiles += 1;
        bytes += opened.stat.size;
      } finally {
        await opened.handle.close();
      }
      if (bundleFiles > MAX_PROJECT_BUNDLE_FILES || bytes > MAX_PROJECT_ARTIFACT_BYTES) {
        fail('project artifact quota exceeded');
      }
    }
  }

  return { bundleFiles, bytes };
}

async function fsyncDirectoryBestEffort(fsImpl: ArtifactStorageFs, dirPath: string, signal?: AbortSignal): Promise<void> {
  let handle: ArtifactFileHandle | undefined;
  try {
    checkCancelled(signal);
    handle = await fsImpl.open(dirPath, fsConstants.O_RDONLY);
    checkCancelled(signal);
    await awaitChecked(handle.sync(), signal);
  } catch {
    // Directory fsync is platform/filesystem dependent; best effort only.
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best effort only
      }
    }
  }
}

async function writeFull(handle: ArtifactFileHandle, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await awaitChecked(handle.write(bytes, offset, bytes.byteLength - offset, offset), signal);
    if (result.bytesWritten <= 0) {
      fail('artifact write failed');
    }
    offset += result.bytesWritten;
  }
}

async function verifyPublishedTarget(
  fsImpl: ArtifactStorageFs,
  targetPath: string,
  expectedBytes: Uint8Array,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const exact = await readExistingTargetIfExact(fsImpl, targetPath, expectedBytes, expectedSha256, signal);
  if (!exact) {
    fail('artifact publish verification failed');
  }
}

async function runWithProjectMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  projectLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(key) === tail) {
      projectLocks.delete(key);
    }
  }
}

function opaqueHandle(projectId: string, bundleSha256: string): string {
  return `artifact://project/${projectId}/bundle/${bundleSha256}`;
}

export function createProjectArtifactStorage(dependencies: ProjectArtifactStorageDependencies): ProjectArtifactStorage {
  const fsImpl = dependencies.fs ?? nodeArtifactStorageFs;
  const randomSuffix = dependencies.randomSuffix ?? (() => randomBytes(16).toString('hex'));
  const authorizeSink = dependencies.authorizeSink;

  if (typeof authorizeSink !== 'function') {
    fail('artifact storage requires sink authorization');
  }

  return {
    async storeBundle(request: StoreProjectBundleRequest): Promise<StoredProjectBundle> {
      try {
        checkCancelled(request.signal);
        assertRequestShape(request);
        assertArchiveHashAndSize(request);
        const trustedRoot = await verifyTrustedRoot(fsImpl, dependencies.trustedRoot, request.signal);
        const lockKey = `${trustedRoot.realpath}:${request.projectId}`;

        return await runWithProjectMutex(lockKey, async () => {
        checkCancelled(request.signal);
        const hashDir = await ensureArtifactDirectories(
          fsImpl,
          authorizeSink,
          trustedRoot,
          request.projectId,
          request.bundleSha256,
          request.signal,
        );
        assertContained(trustedRoot.realpath, hashDir.realpath);
        const targetPath = join(hashDir.path, BUNDLE_NAME);

        if (await readExistingTargetIfExact(fsImpl, targetPath, request.archiveBytes, request.bundleSha256, request.signal)) {
          return {
            handle: opaqueHandle(request.projectId, request.bundleSha256),
            sha256: request.bundleSha256,
            bytes: request.archiveBytes.byteLength,
            created: false,
            readbackVerified: true,
          };
        }

        const quota = await scanProjectQuota(fsImpl, join(trustedRoot.path, 'projects', request.projectId, 'artifacts'), request.signal);
        if (
          quota.bundleFiles >= MAX_PROJECT_BUNDLE_FILES ||
          quota.bytes + request.archiveBytes.byteLength > MAX_PROJECT_ARTIFACT_BYTES
        ) {
          fail('project artifact quota exceeded');
        }

        const suffix = randomSuffix();
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(suffix)) {
          fail('artifact storage internal temp name rejected');
        }
        const tempPath = join(hashDir.path, `${TEMP_PREFIX}${process.pid}-${suffix}`);
        const openFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag();
        let handle: ArtifactFileHandle | undefined;
        let tempCreated = false;
        let successfulResult = false;
        try {
          await verifyExistingDirectory(fsImpl, hashDir.path, trustedRoot.realpath, request.signal);
          await authorizeChecked(authorizeSink, request.signal);
          checkCancelled(request.signal);
          handle = await fsImpl.open(tempPath, openFlags, 0o600);
          tempCreated = true;
          checkCancelled(request.signal);
          await writeFull(handle, request.archiveBytes, request.signal);
          await awaitChecked(handle.sync(), request.signal);
          await handle.close();
          handle = undefined;
          await fsyncDirectoryBestEffort(fsImpl, hashDir.path, request.signal);

          await verifyExistingDirectory(fsImpl, hashDir.path, trustedRoot.realpath, request.signal);
          await authorizeChecked(authorizeSink, request.signal);
          try {
            checkCancelled(request.signal);
            await fsImpl.link(tempPath, targetPath);
          } catch (error) {
            if (isErrno(error, 'EEXIST')) {
              await verifyPublishedTarget(fsImpl, targetPath, request.archiveBytes, request.bundleSha256, request.signal);
              successfulResult = true;
              return {
                handle: opaqueHandle(request.projectId, request.bundleSha256),
                sha256: request.bundleSha256,
                bytes: request.archiveBytes.byteLength,
                created: false,
                readbackVerified: true,
              };
            }
            throw error;
          }

          // The create-only hard link is the commit point. After it succeeds, finish
          // integrity verification even if cancellation arrives; reporting cancellation
          // after a durable write would falsely imply that no artifact was published.
          await fsyncDirectoryBestEffort(fsImpl, hashDir.path);
          await verifyPublishedTarget(fsImpl, targetPath, request.archiveBytes, request.bundleSha256);
          successfulResult = true;
          return {
            handle: opaqueHandle(request.projectId, request.bundleSha256),
            sha256: request.bundleSha256,
            bytes: request.archiveBytes.byteLength,
            created: true,
            readbackVerified: true,
          };
        } finally {
          if (handle) {
            try {
              await handle.close();
            } catch {
              // close best effort before cleanup
            }
          }
          if (tempCreated) {
            // Cleanup is compensating safety work: it must not be skipped merely
            // because the caller cancelled after the temp file was created. After
            // a verified success, the publish authorization also covers immediate
            // removal of the private temp link and cleanup cannot reverse success.
            try {
              await verifyExistingDirectory(fsImpl, hashDir.path, trustedRoot.realpath);
              if (!successfulResult) await authorizeSink();
              await fsImpl.unlink(tempPath);
            } catch (error) {
              if (!successfulResult && !isErrno(error, 'ENOENT')) {
                throw error;
              }
            }
          }
        }
        });
      } catch (error) {
        sanitizeFilesystemError(error);
      }
    },
  };
}
