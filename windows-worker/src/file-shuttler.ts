// Authenticated Phase 0 file shuttle. Every lexical path and every resolved
// existing ancestor must remain inside SHARED_DIR. Uploads are bounded and use
// exclusive no-follow file creation so junction/symlink swaps fail closed.

import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './logger.js';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function sharedDir(): string {
  return process.env.SHARED_DIR ?? 'C:\\dymaxion-shared';
}

function containedBy(target: string, base: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function nearestRealPath(input: string): string {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(input);
    missing.unshift(relative(parent, cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

/** Resolve a shuttle path and reject traversal, sibling-prefix, symlink and junction escape. */
export function safeJoin(...parts: string[]): string {
  const lexicalBase = resolve(sharedDir());
  mkdirSync(lexicalBase, { recursive: true });
  const lexicalTarget = resolve(lexicalBase, ...parts);
  if (!containedBy(lexicalTarget, lexicalBase)) throw new Error('path escapes shared dir');

  const canonicalBase = realpathSync(lexicalBase);
  const canonicalTarget = nearestRealPath(lexicalTarget);
  if (!containedBy(canonicalTarget, canonicalBase)) {
    throw new Error('path escapes shared dir through symlink or junction');
  }
  return canonicalTarget;
}

function configuredLimit(name: 'WORKER_MAX_UPLOAD_BYTES' | 'WORKER_MAX_DOWNLOAD_BYTES'): number {
  const value = Number(process.env[name] ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

class UploadTooLarge extends Error {}

/** Read at most the descriptor size approved before response headers were sent. */
export function createBoundedDownloadStream(target: string, fd: number, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('bounded download stream requires a positive safe-integer size');
  }
  return createReadStream(target, { fd, autoClose: true, start: 0, end: size - 1 });
}

/** POST /files/upload?run_id=<id>&name=<filename> — bounded raw body upload. */
export async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const runId = query.get('run_id') ?? 'adhoc';
  const name = query.get('name');
  if (!name) {
    res.writeHead(400).end(JSON.stringify({ error: 'name query param required' }));
    return;
  }

  const maxBytes = configuredLimit('WORKER_MAX_UPLOAD_BYTES');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    res.writeHead(413).end(JSON.stringify({ error: `upload exceeds ${maxBytes} byte limit` }));
    return;
  }

  let target = safeJoin('input', runId, name);
  mkdirSync(dirname(target), { recursive: true });
  target = safeJoin('input', runId, name); // re-check newly created ancestors/junctions

  let fd: number | undefined;
  let created = false;
  let bytes = 0;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) throw new UploadTooLarge(`upload exceeds ${maxBytes} byte limit`);
      writeSync(fd, chunk);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created && existsSync(target)) unlinkSync(target);
    if (error instanceof UploadTooLarge) {
      res.writeHead(413).end(JSON.stringify({ error: error.message }));
      return;
    }
    throw error;
  }
  closeSync(fd);

  log.info('file uploaded', { target, bytes });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: target }));
}

/** GET /files/download?run_id=<id>&name=<filename> — bounded no-follow stream. */
export async function handleDownload(
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const runId = query.get('run_id') ?? 'adhoc';
  const name = query.get('name');
  if (!name) {
    res.writeHead(400).end(JSON.stringify({ error: 'name query param required' }));
    return;
  }

  const target = safeJoin('output', runId, name);
  if (!existsSync(target)) {
    res.writeHead(404).end(JSON.stringify({ error: 'file not found' }));
    return;
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  const size = fstatSync(fd).size;
  const maxBytes = configuredLimit('WORKER_MAX_DOWNLOAD_BYTES');
  if (size > maxBytes) {
    closeSync(fd);
    res.writeHead(413).end(JSON.stringify({ error: `download exceeds ${maxBytes} byte limit` }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
  });
  if (size === 0) {
    closeSync(fd);
    res.end();
    return;
  }
  createBoundedDownloadStream(target, fd, size).pipe(res);
}
