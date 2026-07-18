import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  readTelegramFileLimited,
  sanitizeTelegramFilename,
  secureAttachmentPath,
  telegramApproverIdentity,
  writeTelegramAttachment,
} from '../src/gateways/telegram/index.js';

test('Telegram approval callbacks require the stable configured operator ID', () => {
  assert.equal(telegramApproverIdentity('12345', 12345), 'telegram:12345');
  assert.throws(() => telegramApproverIdentity('12345', 99999), /unauthorized/);
  assert.throws(() => telegramApproverIdentity('', 12345), /unauthorized/);
});

test('Telegram filenames cannot traverse the attachment directory', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dymaxion-telegram-'));
  try {
    const unsafe = 'x/../../../../tmp/proof.txt';
    const name = sanitizeTelegramFilename(unsafe);
    assert.equal(name, 'proof.txt');
    const target = secureAttachmentPath(root, 'abc123', unsafe);
    const rel = relative(realpathSync(root), target);
    assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`));
    assert.equal(target, resolve(realpathSync(root), 'abc123-proof.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Telegram attachment writes refuse a pre-existing symlink target', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dymaxion-telegram-'));
  const outside = resolve(root, '..', `dymaxion-outside-${Date.now()}.txt`);
  try {
    writeFileSync(outside, 'unchanged');
    const target = secureAttachmentPath(root, 'deadbeef', 'proof.txt');
    symlinkSync(outside, target);
    assert.throws(
      () => writeTelegramAttachment(root, 'deadbeef', 'proof.txt', Buffer.from('overwritten')),
      /EEXIST|symbolic link|exists/i,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('Telegram attachment streaming enforces the byte limit without trusting Content-Length', async () => {
  const response = new Response(Buffer.from('123456'));
  await assert.rejects(() => readTelegramFileLimited(response, 5), /exceeds 5 byte limit/);
});
