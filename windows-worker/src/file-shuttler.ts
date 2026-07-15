// POST /files/upload  +  GET /files/download — move files between the
// runtime and the worker. Uploads land in <SHARED_DIR>/input/<run-id>/,
// downloads pull from <SHARED_DIR>/output/<run-id>/. Paths are confined to
// the shared dir; traversal is rejected.

import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './logger.js';

function sharedDir(): string {
  return process.env.SHARED_DIR ?? 'C:\\dymaxion-shared';
}

function safeJoin(...parts: string[]): string {
  const base = resolve(sharedDir());
  const target = resolve(normalize(join(base, ...parts)));
  if (!target.startsWith(base)) {
    throw new Error('path escapes shared dir');
  }
  return target;
}

/** POST /files/upload?run_id=<id>&name=<filename> — raw body is the file. */
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const target = safeJoin('input', runId, name);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, Buffer.concat(chunks));
  log.info('file uploaded', { target, bytes: chunks.reduce((n, c) => n + c.length, 0) });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: target }));
}

/** GET /files/download?run_id=<id>&name=<filename> — streams the file back. */
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
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  createReadStream(target).pipe(res);
}
