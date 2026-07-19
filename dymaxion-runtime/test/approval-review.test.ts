import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Canonical } from '../src/contracts/canonical.js';
import type { ApprovalRequest } from '../src/gateways/common.js';
import {
  approvalReview,
  chunkApprovalReview,
  formatApprovalReview,
} from '../src/security/approval-review.js';

const payload = {
  z_change: { value: 'new' },
  service_url: 'https://example.test/FeatureServer/0',
  edits: [{ objectId: 7, status: 'closed' }],
};

const request: ApprovalRequest = {
  id: 'approval-123',
  agent_run_id: 'run-123',
  step_description: 'Model says this is harmless',
  payload,
  payload_hash: sha256Canonical(payload),
  target: 'skill:edit|[{"path":"$.service_url","value":"https://example.test/FeatureServer/0"}]',
  credential_identity: 'arcgis:operator-42',
  requested_at: '2026-07-18T12:00:00.000Z',
  expires_at: '2026-07-18T12:30:00.000Z',
};

test('approval review exposes every bound fact and labels model description untrusted', () => {
  const review = approvalReview(request);
  assert.deepEqual(review, {
    approval_id: request.id,
    description_untrusted: request.step_description,
    target: request.target,
    credential_identity: request.credential_identity,
    expires_at: request.expires_at,
    payload_sha256: request.payload_hash,
    canonical_payload:
      '{"edits":[{"objectId":7,"status":"closed"}],"service_url":"https://example.test/FeatureServer/0","z_change":{"value":"new"}}',
  });

  const text = formatApprovalReview(request);
  for (const exactValue of [
    request.id,
    request.step_description,
    request.target,
    request.credential_identity,
    request.expires_at,
    request.payload_hash,
    review.canonical_payload,
  ]) {
    assert.ok(text.includes(exactValue), exactValue);
  }
  assert.match(text, /untrusted summary/i);
});

test('chunked approval reviews reassemble byte-for-byte before controls are exposed', () => {
  const largePayload = { ...payload, exact_diff: 'x'.repeat(9000) };
  const text = formatApprovalReview({
    ...request,
    payload: largePayload,
    payload_hash: sha256Canonical(largePayload),
  });
  const chunks = chunkApprovalReview(text, 257);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 257));
  assert.equal(chunks.join(''), text);

  const unicodeText = `${'a'.repeat(256)}😀tail`;
  const unicodeChunks = chunkApprovalReview(unicodeText, 257);
  assert.equal(unicodeChunks.join(''), unicodeText);
  assert.ok(unicodeChunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
});
