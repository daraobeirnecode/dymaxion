export type AdminApprovalAuthResult =
  | { ok: true; identity: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Resolve the stable identity injected by Tailscale Serve. The admin container
 * must remain bound to localhost and be reached only through Tailscale Serve;
 * direct tailnet binding would make this header caller-spoofable.
 */
export function authenticateAdminApprover(
  headers: Headers,
  configuredIdentities = process.env.DYMAXION_ADMIN_IDENTITIES,
): AdminApprovalAuthResult {
  const allowed = (configuredIdentities ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) {
    return { ok: false, status: 503, error: 'DYMAXION_ADMIN_IDENTITIES is not configured' };
  }
  const login = headers.get('tailscale-user-login')?.trim().toLowerCase();
  if (!login) return { ok: false, status: 401, error: 'Tailscale identity is required' };
  if (!allowed.includes(login)) {
    return { ok: false, status: 403, error: 'Tailscale identity is not authorized for approvals' };
  }
  return { ok: true, identity: `tailscale:${login}` };
}
