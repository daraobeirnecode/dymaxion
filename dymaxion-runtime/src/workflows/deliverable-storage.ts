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

import { constants as fsConstants, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256Text } from '../contracts/canonical.js';

export const MAX_DELIVERABLE_BYTES = 5 * 1024 * 1024;
export const DELIVERABLE_ENTRIES = ['bundle.zip', 'change-ticket.md', 'dependency-map.svg'] as const;
export type DeliverableEntry = (typeof DELIVERABLE_ENTRIES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type DeliverableSinkStage = 'mkdir' | 'temp-create' | 'hard-link';
type AuthorizeSink = (stage: DeliverableSinkStage) => void | Promise<void>;

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

interface StorageWorkerRequest {
  type: 'store';
  expectedRoot: { dev: string; ino: string };
  rootComponents: string[];
  components: [string, string, string, string];
  entry: Exclude<DeliverableEntry, 'bundle.zip'>;
  contentBase64: string;
  expectedSha256: string;
  expectedBytes: number;
}

interface StorageWorkerResult {
  type: 'result';
  created: boolean;
}

function storageWorkerPath(): string {
  const worker = fileURLToPath(new URL('./deliverable-storage-worker.py', import.meta.url));
  if (existsSync(worker)) return worker;
  fail('secure deliverable storage worker is unavailable');
}

async function runStorageWorker(
  request: Omit<StorageWorkerRequest, 'expectedRoot' | 'rootComponents'>,
  rootRealpath: string,
  authorize: AuthorizeSink,
): Promise<boolean> {
  const rootStat = await fs.lstat(rootRealpath, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('trusted root is not a real directory');
  const workerRequest: StorageWorkerRequest = {
    ...request,
    expectedRoot: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
    rootComponents: rootRealpath.split('/').filter((component) => component.length > 0),
  };

  return await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/python3', [storageWorkerPath()], {
      cwd: rootRealpath,
      env: { PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let result: StorageWorkerResult | null = null;
    let authorizationError: unknown;
    let stdout = '';
    const timer = setTimeout(() => {
      authorizationError = new Error('secure deliverable storage worker timed out');
      child.kill('SIGTERM');
    }, 30_000);
    timer.unref();

    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else if (result) resolvePromise(result.created);
      else rejectPromise(new Error('secure deliverable storage worker failed'));
    };

    const send = (message: object): void => {
      if (!child.stdin.writable) {
        authorizationError = new Error('secure deliverable storage worker closed unexpectedly');
        child.kill('SIGTERM');
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        authorizationError = new Error('secure deliverable storage worker returned an invalid response');
        child.kill('SIGTERM');
        return;
      }
      const typed = message as Record<string, unknown>;
      if (typed.type === 'authorize') {
        const stage = typed.stage;
        if (stage !== 'mkdir' && stage !== 'temp-create' && stage !== 'hard-link') {
          authorizationError = new Error('secure deliverable storage worker requested an invalid sink');
          child.kill('SIGTERM');
          return;
        }
        void Promise.resolve(authorize(stage)).then(
          () => send({ type: 'authorization', stage, allowed: true }),
          (error: unknown) => {
            authorizationError = error;
            send({ type: 'authorization', stage, allowed: false });
          },
        );
        return;
      }
      if (typed.type === 'result' && typeof typed.created === 'boolean') {
        result = { type: 'result', created: typed.created };
        return;
      }
      if (typed.type !== 'error') {
        authorizationError = new Error('secure deliverable storage worker returned an invalid response');
        child.kill('SIGTERM');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 65_536) {
        authorizationError = new Error('secure deliverable storage worker exceeded its response ceiling');
        child.kill('SIGTERM');
        return;
      }
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          handleMessage(JSON.parse(line) as unknown);
        } catch {
          authorizationError = new Error('secure deliverable storage worker returned invalid JSON');
          child.kill('SIGTERM');
          return;
        }
      }
    });
    child.once('error', (error) => finish(authorizationError ?? error));
    child.once('exit', (code) => {
      if (authorizationError) finish(authorizationError);
      else if (code === 0 && result) finish();
      else finish(new Error('secure deliverable storage worker failed'));
    });
    send(workerRequest);
  });
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
  const targetPath = deliverablePath(rootRealpath, {
    projectId: request.projectId,
    bundleSha256: request.bundleSha256,
    entry: request.entry,
  });
  const created = await runStorageWorker(
    {
      type: 'store',
      components: ['projects', request.projectId, 'deliverables', request.bundleSha256],
      entry: request.entry,
      contentBase64: bytes.toString('base64'),
      expectedSha256: request.expectedSha256,
      expectedBytes: request.expectedBytes,
    },
    rootRealpath,
    dependencies.authorize,
  );
  const readBack = await readVerifiedDeliverableIfPresent(
    targetPath,
    rootRealpath,
    request.expectedSha256,
    request.expectedBytes,
  );
  if (!readBack) fail('deliverable read-back verification failed');
  return { path: targetPath, sha256: request.expectedSha256, bytes: bytes.byteLength, created };
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
