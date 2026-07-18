import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateAdminApprover } from '../lib/approval-auth';

test('admin approval authentication requires configured stable Tailscale identities', () => {
  assert.deepEqual(authenticateAdminApprover(new Headers(), ''), {
    ok: false,
    status: 503,
    error: 'DYMAXION_ADMIN_IDENTITIES is not configured',
  });
  assert.deepEqual(authenticateAdminApprover(new Headers(), 'operator@example.com'), {
    ok: false,
    status: 401,
    error: 'Tailscale identity is required',
  });
});

test('admin approval authentication allowlists the injected Tailscale login', () => {
  const allowedHeaders = new Headers({ 'Tailscale-User-Login': 'Operator@Example.com' });
  assert.deepEqual(
    authenticateAdminApprover(allowedHeaders, 'operator@example.com,other@example.com'),
    { ok: true, identity: 'tailscale:operator@example.com' },
  );

  const deniedHeaders = new Headers({ 'Tailscale-User-Login': 'attacker@example.com' });
  assert.deepEqual(authenticateAdminApprover(deniedHeaders, 'operator@example.com'), {
    ok: false,
    status: 403,
    error: 'Tailscale identity is not authorized for approvals',
  });
});
