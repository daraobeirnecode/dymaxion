import { timingSafeEqual } from 'node:crypto';

export type InternalApprovalAuthResult =
  | { ok: true; approverIdentity: string }
  | { ok: false; status: 400 | 401 | 503; error: string };

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue>;

function first(value: HeaderValue): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authenticate the admin-to-runtime approval decision channel. */
export function authenticateInternalApproval(
  headers: HeaderBag,
  expectedToken = process.env.RUNTIME_INTERNAL_TOKEN,
): InternalApprovalAuthResult {
  if (!expectedToken) {
    return { ok: false, status: 503, error: 'runtime internal approval token is not configured' };
  }
  const authorization = first(headers.authorization);
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token || !equalSecret(token, expectedToken)) {
    return { ok: false, status: 401, error: 'unauthorized approval decision' };
  }
  const approverIdentity = first(headers['x-dymaxion-approver-identity']).trim().toLowerCase();
  if (!/^tailscale:[a-z0-9][a-z0-9@._+-]{1,254}$/.test(approverIdentity)) {
    return { ok: false, status: 400, error: 'stable approver identity is required' };
  }
  return { ok: true, approverIdentity };
}
