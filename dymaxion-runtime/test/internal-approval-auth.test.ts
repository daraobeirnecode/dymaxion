import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateInternalApproval } from '../src/security/internal-approval-auth.js';

test('runtime approval endpoint requires its configured internal bearer token', () => {
  assert.deepEqual(authenticateInternalApproval({}, undefined), {
    ok: false,
    status: 503,
    error: 'runtime internal approval token is not configured',
  });
  assert.equal(
    authenticateInternalApproval(
      {
        authorization: 'Bearer wrong',
        'x-dymaxion-approver-identity': 'tailscale:operator@example.com',
      },
      'correct',
    ).ok,
    false,
  );
});

test('runtime approval endpoint ignores caller bodies and accepts only stable trusted identity headers', () => {
  const accepted = authenticateInternalApproval(
    {
      authorization: 'Bearer correct',
      'x-dymaxion-approver-identity': 'tailscale:Operator@example.com',
    },
    'correct',
  );
  assert.deepEqual(accepted, {
    ok: true,
    approverIdentity: 'tailscale:operator@example.com',
  });

  const mutableName = authenticateInternalApproval(
    {
      authorization: 'Bearer correct',
      'x-dymaxion-approver-identity': 'Dara',
    },
    'correct',
  );
  assert.equal(mutableName.ok, false);
});
