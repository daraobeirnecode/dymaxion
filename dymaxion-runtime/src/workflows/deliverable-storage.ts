// Create-only, approval-reverified sidecar deliverable storage plus the
// shared read-verification used by every delivery surface (CLI print,
// Telegram upload, Web download endpoint).
//
// Layout under the trusted artifact root:
//   projects/<project-uuid>/artifacts/<zip-sha256>/bundle.zip        (export_evidence_bundle)
//   projects/<project-uuid>/deliverables/<zip-sha256>/change-ticket.md
//   projects/<project-uuid>/deliverables/<zip-sha256>/dependency-map.svg
//
// Sidecars live outside artifacts/ so export_evidence_bundle's strict quota
// scan of the artifacts tree never sees them.

import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256Text } from '../contracts/canonical.js';

export const MAX_DELIVERABLE_BYTES = 5 * 1024 * 1024;
export const DELIVERABLE_ENTRIES = ['bundle.zip', 'change-ticket.md', 'dependency-map.svg'] as const;
export type DeliverableEntry = (typeof DELIVERABLE_ENTRIES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TEMP_PREFIX = '.tmp-';

type AuthorizeSink = () => void | Promise<void>;

function fail(message: string): never {
  throw new Error(message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function noFollowFlag(): number {
  return (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function assertContained(rootRealpath: string, childPath: string): void {
  const fromRoot = relative(rootRealpath, childPath);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    fail('deliverable path containment check failed');
  }
}

/** Operator-configured trusted artifact root; identical resolution rule to
 * export_evidence_bundle's storage default. Never accepted from callers. */
export function trustedArtifactRootFromEnv(): string {
  const configured = process.env.DYMAXION_ARTIFACT_ROOT?.trim() || process.env.DYMAXION_WORKSPACE_ROOT?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '/workspace';
  throw new Error('trusted artifact root is not configured');
}

export interface ParsedDeliverableHandle {
  projectId: string;
  bundleSha256: string;
  entry: DeliverableEntry;
}

const ARTIFACT_HANDLE_RE = /^artifact:\/\/project\/([0-9a-f-]{36})\/bundle\/([a-f0-9]{64})$/;
const DELIVERABLE_HANDLE_RE = /^deliverable:\/\/project\/([0-9a-f-]{36})\/bundle\/([a-f0-9]{64})\/(change-ticket\.md|dependency-map\.svg)$/;

/** Strict opaque-handle parser. Unknown shapes, traversal, encodings, and
 * unexpected entries fail closed. */
export function parseDeliverableHandle(handle: string): ParsedDeliverableHandle {
  if (handle.includes('%') || handle.includes('..') || handle.includes('\\')) {
    fail('deliverable handle contains forbidden characters');
  }
  const artifact = ARTIFACT_HANDLE_RE.exec(handle);
  if (artifact) {
    const [, projectId, bundleSha256] = artifact;
    if (!UUID_RE.test(projectId!)) fail('deliverable handle project id is invalid');
    return { projectId: projectId!, bundleSha256: bundleSha256!, entry: 'bundle.zip' };
  }
  const deliverable = DELIVERABLE_HANDLE_RE.exec(handle);
  if (deliverable) {
    const [, projectId, bundleSha256, entry] = deliverable;
    if (!UUID_RE.test(projectId!)) fail('deliverable handle project id is invalid');
    return { projectId: projectId!, bundleSha256: bundleSha256!, entry: entry as DeliverableEntry };
  }
  fail('unknown deliverable handle');
}

export function deliverableHandle(parsed: ParsedDeliverableHandle): string {
  return parsed.entry === 'bundle.zip'
    ? `artifact://project/${parsed.projectId}/bundle/${parsed.bundleSha256}`
    : `deliverable://project/${parsed.projectId}/bundle/${parsed.bundleSha256}/${parsed.entry}`;
}

export function deliverablePath(trustedRootRealpath: string, parsed: ParsedDeliverableHandle): string {
  const branch = parsed.entry === 'bundle.zip' ? 'artifacts' : 'deliverables';
  const path = resolve(
    join(trustedRootRealpath, 'projects', parsed.projectId, branch, parsed.bundleSha256, parsed.entry),
  );
  if (!path.startsWith(`${trustedRootRealpath}${sep}`)) fail('deliverable path containment check failed');
  return path;
}

async function verifyTrustedRoot(trustedRoot: string): Promise<string> {
  const rootPath = resolve(trustedRoot);
  const info = await fs.lstat(rootPath).catch(() => fail('trusted root is not a real directory'));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('trusted root is not a real directory');
  return resolve(await fs.realpath(rootPath));
}

async function verifyAncestorChain(rootRealpath: string, filePath: string): Promise<void> {
  let current = dirname(resolve(filePath));
  assertContained(rootRealpath, current);
  while (current !== rootRealpath) {
    const info = await fs.lstat(current).catch(() => fail('deliverable ancestor is missing'));
    if (!info.isDirectory() || info.isSymbolicLink()) fail('deliverable ancestor is not a real directory');
    const real = resolve(await fs.realpath(current));
    if (real !== current) fail('deliverable ancestor changed during verification');
    assertContained(rootRealpath, real);
    current = dirname(current);
  }
}

async function ensureDirectoryComponent(
  authorize: AuthorizeSink,
  parentPath: string,
  component: string,
  rootRealpath: string,
): Promise<string> {
  if (component.includes('/') || component.includes('\\') || component === '.' || component === '..' || component.length === 0) {
    fail('invalid deliverable path component');
  }
  const nextPath = join(parentPath, component);
  await authorize();
  try {
    await fs.mkdir(nextPath, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const stat = await fs.lstat(nextPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('deliverable directory is not a real directory');
  const real = resolve(await fs.realpath(nextPath));
  assertContained(rootRealpath, real);
  return nextPath;
}

export interface StoreDeliverableRequest {
  projectId: string;
  bundleSha256: string;
  entry: Exclude<DeliverableEntry, 'bundle.zip'>;
  content: string;
  expectedSha256: string;
  expectedBytes: number;
}

export interface StoredDeliverable {
  path: string;
  sha256: string;
  bytes: number;
  created: boolean;
}

/**
 * Create-only publication of one sidecar deliverable. `authorize` re-verifies
 * the same consumed approval authority immediately before every filesystem
 * sink (each mkdir, the temp create, and the hard-link publish). Existing
 * exact-byte content is idempotent; any other pre-existing state fails closed.
 */
export async function storeDeliverable(
  request: StoreDeliverableRequest,
  dependencies: { trustedRoot: string; authorize: AuthorizeSink },
): Promise<StoredDeliverable> {
  if (!UUID_RE.test(request.projectId) || !SHA256_RE.test(request.bundleSha256)) {
    fail('invalid deliverable request');
  }
  if (request.entry !== 'change-ticket.md' && request.entry !== 'dependency-map.svg') {
    fail('invalid deliverable request');
  }
  const bytes = Buffer.from(request.content, 'utf8');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DELIVERABLE_BYTES) fail('deliverable exceeds byte ceiling');
  if (bytes.byteLength !== request.expectedBytes || sha256Text(bytes) !== request.expectedSha256) {
    fail('deliverable content does not match its approved identity');
  }

  const rootRealpath = await verifyTrustedRoot(dependencies.trustedRoot);
  let current = rootRealpath;
  for (const component of ['projects', request.projectId, 'deliverables', request.bundleSha256]) {
    current = await ensureDirectoryComponent(dependencies.authorize, current, component, rootRealpath);
  }
  const targetPath = join(current, request.entry);
  await verifyAncestorChain(rootRealpath, targetPath);

  const existing = await readVerifiedDeliverableIfPresent(targetPath, rootRealpath, request.expectedSha256, request.expectedBytes);
  if (existing) {
    return { path: targetPath, sha256: request.expectedSha256, bytes: bytes.byteLength, created: false };
  }

  const suffix = randomBytes(16).toString('hex');
  const tempPath = join(current, `${TEMP_PREFIX}${process.pid}-${suffix}`);
  await verifyAncestorChain(rootRealpath, tempPath);
  await dependencies.authorize();
  const handle = await fs.open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(), 0o600);
  let published = false;
  try {
    const tempPathStat = await fs.lstat(tempPath);
    const tempDescriptorStat = await handle.stat();
    const tempRealpath = resolve(await fs.realpath(tempPath));
    if (
      tempRealpath !== tempPath
      || !tempPathStat.isFile()
      || tempPathStat.isSymbolicLink()
      || tempPathStat.dev !== tempDescriptorStat.dev
      || tempPathStat.ino !== tempDescriptorStat.ino
    ) {
      fail('deliverable temp file changed during verification');
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await dependencies.authorize();
    await verifyAncestorChain(rootRealpath, tempPath);
    await verifyAncestorChain(rootRealpath, targetPath);
    if (resolve(await fs.realpath(tempPath)) !== tempPath) fail('deliverable temp path escaped its trusted root');
    try {
      await fs.link(tempPath, targetPath);
      published = true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        const raced = await readVerifiedDeliverableIfPresent(targetPath, rootRealpath, request.expectedSha256, request.expectedBytes);
        if (!raced) fail('deliverable target conflict');
        return { path: targetPath, sha256: request.expectedSha256, bytes: bytes.byteLength, created: false };
      }
      throw error;
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
  const readBack = await readVerifiedDeliverableIfPresent(targetPath, rootRealpath, request.expectedSha256, request.expectedBytes);
  if (!readBack) fail('deliverable read-back verification failed');
  return { path: targetPath, sha256: request.expectedSha256, bytes: bytes.byteLength, created: published };
}

async function readVerifiedDeliverableIfPresent(
  path: string,
  rootRealpath: string,
  expectedSha256: string,
  expectedBytes: number,
): Promise<Buffer | null> {
  try {
    return await readVerifiedDeliverable({
      path,
      trustedRoot: rootRealpath,
      expectedSha256,
      expectedBytes,
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (error instanceof Error && error.message === 'deliverable is missing') return null;
    throw error;
  }
}

export interface ReadVerifiedDeliverableRequest {
  path: string;
  trustedRoot: string;
  expectedSha256: string;
  expectedBytes: number;
  maxBytes?: number;
}

/**
 * Read one deliverable with full revalidation immediately before use:
 * trusted-root containment, lstat regular-file/no-symlink, O_NOFOLLOW open
 * with same-inode verification, byte ceiling, exact byte count, and exact
 * SHA-256. Every delivery surface calls this right before reading/sending.
 */
export async function readVerifiedDeliverable(request: ReadVerifiedDeliverableRequest): Promise<Buffer> {
  const maxBytes = request.maxBytes ?? MAX_DELIVERABLE_BYTES;
  if (!SHA256_RE.test(request.expectedSha256) || !Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 0) {
    fail('invalid deliverable verification request');
  }
  if (request.expectedBytes > maxBytes) fail('deliverable exceeds byte ceiling');
  const rootRealpath = await verifyTrustedRoot(request.trustedRoot);
  const resolved = resolve(request.path);
  assertContained(rootRealpath, resolved);
  await verifyAncestorChain(rootRealpath, resolved);

  let pathStat;
  try {
    pathStat = await fs.lstat(resolved);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail('deliverable is missing');
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail('deliverable is not a regular file');
  if (pathStat.size !== request.expectedBytes || pathStat.size > maxBytes) {
    fail('deliverable byte count mismatch');
  }
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollowFlag());
  try {
    await verifyAncestorChain(rootRealpath, resolved);
    const finalRealpath = resolve(await fs.realpath(resolved));
    if (finalRealpath !== resolved) fail('deliverable path changed during verification');
    const postOpenPathStat = await fs.lstat(resolved);
    const descriptorStat = await handle.stat();
    if (
      !postOpenPathStat.isFile() ||
      postOpenPathStat.isSymbolicLink() ||
      postOpenPathStat.dev !== descriptorStat.dev ||
      postOpenPathStat.ino !== descriptorStat.ino ||
      !descriptorStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      descriptorStat.size !== request.expectedBytes
    ) {
      fail('deliverable changed during verification');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== request.expectedBytes || sha256Text(bytes) !== request.expectedSha256) {
      fail('deliverable hash mismatch');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
