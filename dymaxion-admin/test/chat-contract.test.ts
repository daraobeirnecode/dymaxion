import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseApprovalReview, parseArtifactAttachments } from '../app/(chat)/chat/chat-contract.js';

const approvalPayload = { mode: 'persist', expected_preview_sha256: 'a'.repeat(64) };
const canonicalApprovalPayload = `{"expected_preview_sha256":"${'a'.repeat(64)}","mode":"persist"}`;
const approval = {
  approval_id: '00000000-0000-4000-8000-000000000001',
  description_untrusted: 'Persist the exact reviewed packet',
  payload: approvalPayload,
  payload_sha256: createHash('sha256').update(canonicalApprovalPayload).digest('hex'),
  target: 'project:00000000-0000-4000-8000-000000000001:artifact:bundle',
  credential_identity: 'service-account:dymaxion-runtime',
  expires_at: '2026-07-23T04:00:00.000Z',
  canonical_payload: canonicalApprovalPayload,
};

test('chat approval review requires cryptographic agreement between displayed facts', async () => {
  assert.deepEqual(await parseApprovalReview(approval), approval);
  for (const key of [
    'approval_id',
    'description_untrusted',
    'payload',
    'payload_sha256',
    'target',
    'credential_identity',
    'expires_at',
    'canonical_payload',
  ] as const) {
    const incomplete = { ...approval } as Record<string, unknown>;
    delete incomplete[key];
    assert.equal(await parseApprovalReview(incomplete), null, `missing ${key} must fail closed`);
  }
  assert.equal(await parseApprovalReview({ ...approval, approval_id: 'not-a-uuid' }), null);
  assert.equal(await parseApprovalReview({ ...approval, payload_sha256: 'not-a-hash' }), null);
  assert.equal(await parseApprovalReview({ ...approval, expires_at: 'not-a-date' }), null);
  assert.equal(await parseApprovalReview({ ...approval, payload: { ...approvalPayload, mode: 'preview' } }), null);
  assert.equal(await parseApprovalReview({ ...approval, canonical_payload: '{}' }), null);
  assert.equal(await parseApprovalReview({ ...approval, payload_sha256: 'b'.repeat(64) }), null);
});

test('chat accepts only one complete, identity-bound three-deliverable set', () => {
  const token = `${'A'.repeat(12)}.${'B'.repeat(43)}`;
  const projectId = '00000000-0000-4000-8000-000000000001';
  const bundleSha256 = 'a'.repeat(64);
  const valid = [
    {
      original_name: 'evidence-bundle.zip',
      mime: 'application/zip',
      handle: `artifact://project/${projectId}/bundle/${bundleSha256}`,
    },
    {
      original_name: 'change-ticket.md',
      mime: 'text/markdown',
      handle: `deliverable://project/${projectId}/bundle/${bundleSha256}/change-ticket.md`,
    },
    {
      original_name: 'dependency-map.svg',
      mime: 'image/svg+xml',
      handle: `deliverable://project/${projectId}/bundle/${bundleSha256}/dependency-map.svg`,
    },
  ].map((identity, index) => ({
    ...identity,
    sha256: index === 0 ? bundleSha256 : String(index + 1).repeat(64),
    bytes: index + 1,
    download_url: `/api/artifacts/${token}`,
  }));

  assert.deepEqual(parseArtifactAttachments(valid), valid);
  assert.deepEqual(parseArtifactAttachments([valid[0]]), [], 'partial set must fail closed');
  assert.deepEqual(parseArtifactAttachments([valid[0], valid[0], valid[2]]), [], 'duplicate must fail closed');
  assert.deepEqual(parseArtifactAttachments([valid[0], valid[2]]), [], 'missing attachment must fail closed');
  assert.deepEqual(
    parseArtifactAttachments([{ ...valid[0], handle: '/tmp/secret/bundle.zip' }, valid[1], valid[2]]),
    [],
    'path-shaped handle must fail closed',
  );
  assert.deepEqual(
    parseArtifactAttachments([{ ...valid[0], handle: 'https://example.invalid/bundle.zip' }, valid[1], valid[2]]),
    [],
    'URL-shaped handle must fail closed',
  );
  assert.deepEqual(
    parseArtifactAttachments([valid[0], { ...valid[1], handle: valid[2]!.handle }, valid[2]]),
    [],
    'handle entry must match the public filename',
  );
  assert.deepEqual(
    parseArtifactAttachments([valid[0], { ...valid[1], mime: 'application/zip' }, valid[2]]),
    [],
    'MIME type must match the public filename',
  );
  assert.deepEqual(
    parseArtifactAttachments([
      valid[0],
      {
        ...valid[1],
        handle: `deliverable://project/${projectId}/bundle/${'b'.repeat(64)}/change-ticket.md`,
      },
      valid[2],
    ]),
    [],
    'all handles must identify one approved bundle',
  );
  assert.deepEqual(
    parseArtifactAttachments([{ ...valid[0], sha256: 'f'.repeat(64) }, valid[1], valid[2]]),
    [],
    'archive hash must equal the bundle identity in every handle',
  );
  assert.deepEqual(
    parseArtifactAttachments([
      { ...valid[0], path: '/tmp/secret.zip', token: 'must-not-enter-client-state' },
      valid[1],
      valid[2],
    ]),
    [],
    'unexpected path or secret metadata keys must fail closed',
  );
  assert.deepEqual(
    parseArtifactAttachments([
      { ...valid[1], original_name: 'subject-change-ticket.md' },
      { ...valid[2], mime: 'image/svg+xml; charset=utf-8' },
      { ...valid[0], bytes: 5 * 1024 * 1024 + 1 },
    ]),
    [],
  );
});
