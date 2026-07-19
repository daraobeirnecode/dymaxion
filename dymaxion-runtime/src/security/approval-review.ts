import { canonicalJson, sha256Canonical } from '../contracts/canonical.js';
import type { ApprovalRequest } from '../gateways/common.js';

export interface ApprovalReview {
  approval_id: string;
  description_untrusted: string;
  target: string;
  credential_identity: string;
  expires_at: string;
  payload_sha256: string;
  canonical_payload: string;
}

/** Exact human-review material shown before any approval control is exposed. */
export function approvalReview(req: ApprovalRequest): ApprovalReview {
  const canonicalPayload = canonicalJson(req.payload);
  if (sha256Canonical(req.payload) !== req.payload_hash) {
    throw new Error('approval review payload hash mismatch');
  }
  return {
    approval_id: req.id,
    description_untrusted: req.step_description,
    target: req.target,
    credential_identity: req.credential_identity,
    expires_at: req.expires_at,
    payload_sha256: req.payload_hash,
    canonical_payload: canonicalPayload,
  };
}

export function formatApprovalReview(req: ApprovalRequest): string {
  const review = approvalReview(req);
  return [
    'APPROVAL REQUIRED',
    `Approval ID: ${review.approval_id}`,
    `Description (untrusted summary): ${review.description_untrusted}`,
    `Exact target: ${review.target}`,
    `Trusted credential identity: ${review.credential_identity}`,
    `Expires at: ${review.expires_at}`,
    `Canonical payload SHA-256: ${review.payload_sha256}`,
    'Canonical payload:',
    review.canonical_payload,
  ].join('\n');
}

/** Split without dropping or rewriting any payload character. */
export function chunkApprovalReview(text: string, maxCharacters = 3500): string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('approval review chunk size must be a positive safe integer');
  }
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + maxCharacters, text.length);
    const finalCodeUnit = text.charCodeAt(end - 1);
    const nextCodeUnit = text.charCodeAt(end);
    if (
      end < text.length &&
      finalCodeUnit >= 0xd800 &&
      finalCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks.length ? chunks : [''];
}
