import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createBoundedDownloadStream,
  handleUpload,
  safeJoin,
} from '../dist/file-shuttler.js';
import { phase0RouteDisabled } from '../dist/phase0-policy.js';

function responseRecorder() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    end(body = '') {
      this.body = String(body);
      return this;
    },
  };
}

test('Phase 0 exposes neither execution nor file-shuttle routes', () => {
  for (const route of [
    'POST /arcpy/run',
    'POST /pro-cli/run',
    'POST /files/upload',
    'GET /files/download',
  ]) {
    assert.equal(phase0RouteDisabled(route), true, route);
  }
  assert.equal(phase0RouteDisabled('GET /health'), false);
});

test('safeJoin rejects traversal and sibling-prefix paths', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'dymaxion-worker-'));
  const root = resolve(parent, 'shared');
  const sibling = resolve(parent, 'shared-evil');
  mkdirSync(root);
  mkdirSync(sibling);
  process.env.SHARED_DIR = root;
  try {
    assert.throws(() => safeJoin('..', basename(sibling), 'proof.txt'), /escapes shared dir/);
    assert.throws(() => safeJoin('input', '..', '..', 'proof.txt'), /escapes shared dir/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('safeJoin rejects symlink or junction escape through an existing ancestor', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'dymaxion-worker-'));
  const root = resolve(parent, 'shared');
  const outside = resolve(parent, 'outside');
  const runDir = resolve(root, 'input', 'run-1');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, resolve(runDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  process.env.SHARED_DIR = root;
  try {
    assert.throws(() => safeJoin('input', 'run-1', 'link', 'proof.txt'), /symlink or junction/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('upload limit is enforced while streaming and partial files are removed', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'dymaxion-worker-'));
  const root = resolve(parent, 'shared');
  process.env.SHARED_DIR = root;
  process.env.WORKER_MAX_UPLOAD_BYTES = '5';
  const req = Readable.from([Buffer.from('123'), Buffer.from('456')]);
  req.headers = {};
  const res = responseRecorder();
  try {
    await handleUpload(req, res, new URLSearchParams({ run_id: 'run-1', name: 'proof.txt' }));
    assert.equal(res.statusCode, 413);
    assert.equal(existsSync(resolve(root, 'input', 'run-1', 'proof.txt')), false);
  } finally {
    delete process.env.WORKER_MAX_UPLOAD_BYTES;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a failed exclusive upload never deletes a pre-existing destination', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'dymaxion-worker-'));
  const root = resolve(parent, 'shared');
  const destination = resolve(root, 'input', 'run-1', 'proof.txt');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, 'preserve-me');
  process.env.SHARED_DIR = root;
  const req = Readable.from([Buffer.from('replacement')]);
  req.headers = {};
  const res = responseRecorder();
  try {
    await assert.rejects(
      () => handleUpload(req, res, new URLSearchParams({ run_id: 'run-1', name: 'proof.txt' })),
      /EEXIST|exists/i,
    );
    assert.equal(readFileSync(destination, 'utf8'), 'preserve-me');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('download stream cannot exceed the descriptor size approved before file growth', async () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'dymaxion-worker-'));
  const target = resolve(parent, 'growing.bin');
  writeFileSync(target, 'abc');
  const fd = openSync(target, 'r');
  try {
    const stream = createBoundedDownloadStream(target, fd, 3);
    appendFileSync(target, 'defghijkl');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'abc');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
