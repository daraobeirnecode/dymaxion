import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OutgoingAttachment } from '../src/gateways/common.js';
import { CliGateway } from '../src/gateways/cli/index.js';
import { TelegramGateway } from '../src/gateways/telegram/index.js';
import {
  decodeArtifactDownloadToken,
  encodeArtifactDownloadToken,
  publicArtifactFileName,
  verifiedWebArtifactAttachmentMetadata,
  webArtifactAttachmentMetadata,
  WebGateway,
} from '../src/gateways/web/index.js';
import { deliverableHandle } from '../src/workflows/deliverable-storage.js';

const PROJECT_ID = '519e8c7c-5176-5de6-a8cf-52b7772e0e34';
const NOW = Date.parse('2026-07-22T16:00:00.000Z');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function attachment(
  entry: 'bundle.zip' | 'change-ticket.md' | 'dependency-map.svg',
  path: string,
  bytes: Buffer,
  bundleSha256: string,
): OutgoingAttachment {
  const mime = entry === 'bundle.zip'
    ? 'application/zip'
    : entry === 'change-ticket.md'
      ? 'text/markdown; charset=utf-8'
      : 'image/svg+xml; charset=utf-8';
  return {
    handle: deliverableHandle({ projectId: PROJECT_ID, bundleSha256, entry }),
    path,
    original_name: entry === 'bundle.zip' ? 'evidence-bundle.zip' : entry,
    mime,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
}

test('Web artifact tokens are path-private, identity-bound, authenticated, and finite-lived', () => {
  const previousSecret = process.env.RUNTIME_INTERNAL_TOKEN;
  process.env.RUNTIME_INTERNAL_TOKEN = 'test-artifact-secret-with-adequate-entropy';
  const bundleSha = 'a'.repeat(64);
  const outgoing = attachment('bundle.zip', '/private/runtime/path/bundle.zip', Buffer.from('zip'), bundleSha);
  try {
    const token = encodeArtifactDownloadToken(outgoing, NOW);
    assert.ok(!token.includes('/private/runtime/path'));
    const decodedPayload = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    assert.ok(!decodedPayload.includes(outgoing.path));

    assert.deepEqual(decodeArtifactDownloadToken(token, NOW + 299_000), {
      handle: outgoing.handle,
      sha256: outgoing.sha256,
      bytes: outgoing.bytes,
      expiresAt: Math.floor(NOW / 1000) + 300,
    });
    const markdown = attachment(
      'change-ticket.md',
      '/private/runtime/path/change-ticket.md',
      Buffer.from('# ticket'),
      bundleSha,
    );
    const metadata = webArtifactAttachmentMetadata(markdown, NOW);
    assert.equal(metadata.mime, 'text/markdown');
    assert.equal(metadata.original_name, 'change-ticket.md');
    assert.ok(!JSON.stringify(metadata).includes(markdown.path));
    assert.match(metadata.download_url, /^\/api\/artifacts\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.throws(
      () => webArtifactAttachmentMetadata({ ...markdown, mime: 'text/html' }, NOW),
      /unsupported artifact media type/i,
    );
    assert.throws(() => decodeArtifactDownloadToken(token, NOW + 300_000), /invalid artifact token/i);

    const [payload, signature] = token.split('.');
    const forgedSignature = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    assert.throws(() => decodeArtifactDownloadToken(`${payload}.${forgedSignature}`, NOW), /invalid artifact token/i);

    process.env.RUNTIME_INTERNAL_TOKEN = 'different-authentication-secret';
    assert.throws(() => decodeArtifactDownloadToken(token, NOW), /invalid artifact token/i);
  } finally {
    if (previousSecret === undefined) delete process.env.RUNTIME_INTERNAL_TOKEN;
    else process.env.RUNTIME_INTERNAL_TOKEN = previousSecret;
  }
});

test('Web final delivery re-verifies trusted bytes and keeps the exact public ZIP name', async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'dymaxion-web-delivery-'));
  const root = await realpath(createdRoot);
  const previousRoot = process.env.DYMAXION_ARTIFACT_ROOT;
  const previousSecret = process.env.RUNTIME_INTERNAL_TOKEN;
  const bundleSha = 'd'.repeat(64);
  const bytes = Buffer.from('verified deterministic archive');
  const directory = join(root, 'projects', PROJECT_ID, 'artifacts', bundleSha);
  const path = join(directory, 'bundle.zip');
  try {
    process.env.DYMAXION_ARTIFACT_ROOT = root;
    process.env.RUNTIME_INTERNAL_TOKEN = 'test-web-delivery-authentication-secret';
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    const outgoing = attachment('bundle.zip', path, bytes, bundleSha);

    const metadata = await verifiedWebArtifactAttachmentMetadata(outgoing, NOW);
    assert.equal(metadata.original_name, 'evidence-bundle.zip');
    assert.equal(publicArtifactFileName('bundle.zip'), 'evidence-bundle.zip');

    await writeFile(path, Buffer.from('tampered'));
    await assert.rejects(
      () => new WebGateway().sendFinal({ gateway: 'web', source_id: 'test' }, 'Packet complete.', [outgoing]),
      /deliverable/i,
    );

    await unlink(path);
    await assert.rejects(
      () => verifiedWebArtifactAttachmentMetadata(outgoing, NOW),
      /deliverable/i,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DYMAXION_ARTIFACT_ROOT;
    else process.env.DYMAXION_ARTIFACT_ROOT = previousRoot;
    if (previousSecret === undefined) delete process.env.RUNTIME_INTERNAL_TOKEN;
    else process.env.RUNTIME_INTERNAL_TOKEN = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI final delivery verifies bytes and exposes only the opaque handle', async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'dymaxion-cli-delivery-'));
  const root = await realpath(createdRoot);
  const previousRoot = process.env.DYMAXION_ARTIFACT_ROOT;
  const originalWrite = process.stdout.write;
  const bundleSha = 'c'.repeat(64);
  const bytes = Buffer.from('deterministic zip bytes');
  const directory = join(root, 'projects', PROJECT_ID, 'artifacts', bundleSha);
  const path = join(directory, 'bundle.zip');
  let output = '';
  try {
    process.env.DYMAXION_ARTIFACT_ROOT = root;
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    const outgoing = attachment('bundle.zip', path, bytes, bundleSha);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    const gateway = new CliGateway();
    await gateway.sendFinal({ gateway: 'cli', source_id: 'test' }, 'Packet complete.', [outgoing]);

    assert.match(output, /Packet complete\./);
    assert.ok(output.includes(`handle ${outgoing.handle}`));
    assert.ok(!output.includes(root));
    assert.ok(!output.includes(path));
  } finally {
    process.stdout.write = originalWrite;
    if (previousRoot === undefined) delete process.env.DYMAXION_ARTIFACT_ROOT;
    else process.env.DYMAXION_ARTIFACT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('Telegram final delivery verifies and uploads exactly three workflow documents', async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'dymaxion-telegram-delivery-'));
  const root = await realpath(createdRoot);
  const previousRoot = process.env.DYMAXION_ARTIFACT_ROOT;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: BodyInit | null | undefined }> = [];
  const bundleSha = 'b'.repeat(64);
  const entries = [
    ['bundle.zip', Buffer.from('deterministic zip bytes')],
    ['change-ticket.md', Buffer.from('# Change ticket\n')],
    ['dependency-map.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ] as const;
  try {
    process.env.DYMAXION_ARTIFACT_ROOT = root;
    const outgoing: OutgoingAttachment[] = [];
    for (const [entry, bytes] of entries) {
      const branch = entry === 'bundle.zip' ? 'artifacts' : 'deliverables';
      const directory = join(root, 'projects', PROJECT_ID, branch, bundleSha);
      await mkdir(directory, { recursive: true });
      const path = join(directory, entry);
      await writeFile(path, bytes);
      outgoing.push(attachment(entry, path, bytes, bundleSha));
    }

    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const gateway = new TelegramGateway('test-bot-token', '123');
    await gateway.sendFinal({ gateway: 'telegram', source_id: '123' }, 'Packet complete.', outgoing);

    assert.equal(calls.filter((call) => call.url.endsWith('/sendMessage')).length, 1);
    const documentCalls = calls.filter((call) => call.url.endsWith('/sendDocument'));
    assert.equal(documentCalls.length, 3);
    for (const call of documentCalls) {
      assert.ok(call.body instanceof FormData);
      assert.equal((call.body as FormData).get('chat_id'), '123');
      assert.match(String((call.body as FormData).get('caption')), /sha256 [a-f0-9]{64}$/);
    }

    await writeFile(outgoing[1]!.path, 'tampered', 'utf8');
    calls.length = 0;
    await assert.rejects(
      () => gateway.sendFinal({ gateway: 'telegram', source_id: '123' }, 'Retry.', [outgoing[1]!]),
      /byte count mismatch|integrity verification failed/i,
    );
    assert.equal(calls.filter((call) => call.url.endsWith('/sendDocument')).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRoot === undefined) delete process.env.DYMAXION_ARTIFACT_ROOT;
    else process.env.DYMAXION_ARTIFACT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
