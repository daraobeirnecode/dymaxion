import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApprovalReview, parseArtifactAttachments } from '../app/(chat)/chat/chat-contract.js';

const approval = {
  approval_id: '00000000-0000-4000-8000-000000000001',
  description_untrusted: 'Persist the exact reviewed packet',
  payload: { mode: 'persist', expected_preview_sha256: 'a'.repeat(64) },
  payload_sha256: 'b'.repeat(64),
  target: 'project:00000000-0000-4000-8000-000000000001:artifact:bundle',
  credential_identity: 'service-account:dymaxion-runtime',
  expires_at: '2026-07-23T04:00:00.000Z',
  canonical_payload: '{"expected_preview_sha256":"aaaaaaaa"}',
};

test('chat approval review requires every exact bound fact', () => {
  assert.deepEqual(parseApprovalReview(approval), approval);
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
    assert.equal(parseApprovalReview(incomplete), null, `missing ${key} must fail closed`);
  }
  assert.equal(parseApprovalReview({ ...approval, approval_id: 'not-a-uuid' }), null);
  assert.equal(parseApprovalReview({ ...approval, payload_sha256: 'not-a-hash' }), null);
  assert.equal(parseApprovalReview({ ...approval, expires_at: 'not-a-date' }), null);
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
    sha256: String(index + 1).repeat(64),
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
    parseArtifactAttachments([
      { ...valid[1], original_name: 'subject-change-ticket.md' },
      { ...valid[2], mime: 'image/svg+xml; charset=utf-8' },
      { ...valid[0], bytes: 5 * 1024 * 1024 + 1 },
    ]),
    [],
  );
});
