// Employer boundary — structural enforcement of the allow/deny lists in
// config/employer-boundary.yaml. Called by the skill executor before any
// external request, file access, or LLM tool dispatch (middleware step 1).
// There is NO runtime override: changing the boundary means editing the YAML.

import { loadConfig } from '../config/loader.js';
import { auditEvent } from './audit.js';

export class BoundaryViolation extends Error {
  constructor(
    public readonly kind: 'hostname' | 'path' | 'source',
    public readonly target: string,
  ) {
    super(`Employer boundary violation (${kind}): ${target}`);
    this.name = 'BoundaryViolation';
  }
}

/** Glob-ish match: '*' spans any run of characters (case-insensitive). */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*') + '$',
    'i',
  );
  return re.test(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isHostnameDenied(hostname: string): boolean {
  const { boundary } = { boundary: loadConfig().boundary };
  return boundary.denied_hostnames.some((p) => globMatch(p, hostname));
}

export function isPathDenied(path: string): boolean {
  const { denied_paths } = loadConfig().boundary;
  return denied_paths.some((p) => globMatch(p.replace(/\*\*/g, '*'), path));
}

export function isPathAllowed(path: string): boolean {
  if (isPathDenied(path)) return false;
  const sources = loadConfig().boundary.allowed_data_sources;
  return sources
    .filter((s) => s.type === 'filesystem' && s.path_pattern)
    .some((s) => globMatch(s.path_pattern!.replace(/\*\*/g, '*'), path));
}

/** Throws BoundaryViolation (and audits) if a URL may not be touched. */
export async function assertUrlAllowed(url: string, agentRunId?: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new BoundaryViolation('hostname', url);
  }
  if (isHostnameDenied(hostname)) {
    await auditEvent('boundary_block', { url, hostname, reason: 'denied_hostname' }, agentRunId);
    throw new BoundaryViolation('hostname', hostname);
  }
  if (loadConfig().boundary.audit_all_external_requests) {
    await auditEvent('data_query', { url, hostname, boundary: 'allowed' }, agentRunId);
  }
}

/** Throws BoundaryViolation (and audits) if a filesystem path may not be touched. */
export async function assertPathAllowed(path: string, agentRunId?: string): Promise<void> {
  if (!isPathAllowed(path)) {
    await auditEvent('boundary_block', { path, reason: 'path_not_allowlisted' }, agentRunId);
    throw new BoundaryViolation('path', path);
  }
}
