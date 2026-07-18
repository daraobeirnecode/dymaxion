// Deny-by-default employer boundary enforcement. Every capability/tool adapter
// must call this module before external dispatch or dataset filesystem I/O.

import { existsSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { auditEvent, type AuditEventType } from './audit.js';

export class BoundaryViolation extends Error {
  constructor(
    public readonly kind: 'hostname' | 'path' | 'source',
    public readonly target: string,
    public readonly reason = 'not_allowed',
  ) {
    super(`Employer boundary violation (${kind}/${reason}): ${target}`);
    this.name = 'BoundaryViolation';
  }
}

type AuditFn = (
  eventType: AuditEventType,
  payload: Record<string, unknown>,
  agentRunId?: string,
) => Promise<void>;

type HostResolver = (hostname: string) => Promise<string[]>;

export interface BoundaryOptions {
  agentRunId?: string;
  audit?: AuditFn;
  resolveHost?: HostResolver;
}

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const URL_FIELD = /(?:^|_)(?:url|uri|endpoint)(?:$|_)/i;
const PATH_FIELD = /(?:^|_)(?:path|paths|file|files|directory|dir)(?:$|_)/i;

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');
  return re.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function optionsWithDefaults(options: BoundaryOptions = {}): Required<BoundaryOptions> {
  return {
    agentRunId: options.agentRunId ?? '',
    audit: options.audit ?? auditEvent,
    resolveHost:
      options.resolveHost ??
      (async (hostname: string) =>
        (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)),
  };
}

async function block(
  kind: BoundaryViolation['kind'],
  target: string,
  reason: string,
  options: Required<BoundaryOptions>,
): Promise<never> {
  await options.audit(
    'boundary_block',
    { kind, target, reason },
    options.agentRunId || undefined,
  );
  throw new BoundaryViolation(kind, target, reason);
}

export function isHostnameDenied(hostname: string): boolean {
  return loadConfig().boundary.denied_hostnames.some((pattern) => globMatch(pattern, hostname));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('ff')
    );
  }
  return true;
}

function allowedUrlPatterns(): string[] {
  return loadConfig().boundary.allowed_data_sources
    .map((source) => source.url_pattern)
    .filter((value): value is string => Boolean(value));
}

/** Validate a URL against protocol, credentials, denylist, allowlist, and resolved IPs. */
export async function assertUrlAllowed(rawUrl: string, supplied: BoundaryOptions = {}): Promise<void> {
  const options = optionsWithDefaults(supplied);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return block('source', rawUrl, 'malformed_url', options);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return block('source', rawUrl, 'unsupported_url_scheme', options);
  }
  if (url.username || url.password) {
    return block('source', rawUrl, 'embedded_credentials', options);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    return block('hostname', hostname || rawUrl, 'local_hostname', options);
  }
  if (isHostnameDenied(hostname)) {
    return block('hostname', hostname, 'denied_hostname', options);
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    return block('hostname', hostname, 'private_or_reserved_address', options);
  }
  if (!allowedUrlPatterns().some((pattern) => globMatch(pattern, url.href))) {
    return block('source', rawUrl, 'url_not_allowlisted', options);
  }
  const addresses = isIP(hostname) ? [hostname] : await options.resolveHost(hostname).catch(() => []);
  if (!addresses.length) return block('hostname', hostname, 'dns_resolution_failed', options);
  if (addresses.some(isPrivateAddress)) {
    return block('hostname', hostname, 'private_or_reserved_address', options);
  }
  if (loadConfig().boundary.audit_all_external_requests) {
    await options.audit(
      'data_query',
      { url: url.href, hostname, boundary: 'allowed' },
      options.agentRunId || undefined,
    );
  }
}

function nearestRealPath(input: string): string {
  const absolute = resolve(input);
  let cursor = absolute;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function rootFromPattern(pattern: string): string {
  const wildcard = pattern.indexOf('*');
  const prefix = wildcard >= 0 ? pattern.slice(0, wildcard) : pattern;
  return nearestRealPath(prefix.replace(/[\\/]$/, '') || sep);
}

function allowedFilesystemRoots(): string[] {
  const roots = loadConfig().boundary.allowed_data_sources.flatMap((source) => {
    const configured = source.path_pattern ? [rootFromPattern(source.path_pattern)] : [];
    const envRoot = source.root_env ? process.env[source.root_env] : undefined;
    return envRoot ? [...configured, nearestRealPath(envRoot)] : configured;
  });
  return [...new Set(roots)];
}

function containedBy(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function canonicalBoundaryPath(input: string): string {
  if (input.startsWith('file:')) return nearestRealPath(fileURLToPath(new URL(input)));
  return nearestRealPath(input);
}

export function isPathDenied(input: string): boolean {
  const path = canonicalBoundaryPath(input);
  return loadConfig().boundary.denied_paths.some((pattern) => {
    const root = rootFromPattern(pattern);
    return containedBy(path, root);
  });
}

export function isPathAllowed(input: string): boolean {
  const path = canonicalBoundaryPath(input);
  return !isPathDenied(path) && allowedFilesystemRoots().some((root) => containedBy(path, root));
}

/** Validate a path after traversal/symlink canonicalization. */
export async function assertPathAllowed(input: string, supplied: BoundaryOptions = {}): Promise<void> {
  const options = optionsWithDefaults(supplied);
  let path: string;
  try {
    path = canonicalBoundaryPath(input);
  } catch {
    return block('path', input, 'malformed_path', options);
  }
  if (!isPathAllowed(path)) return block('path', path, 'path_not_allowlisted', options);
}

function pathLike(value: string, field: string): boolean {
  return (
    value.startsWith('file:') ||
    isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    (PATH_FIELD.test(field) && value.length > 0)
  );
}

/** Recursively enforce all URL/path references in untrusted capability arguments. */
export async function assertExecutionBoundary(
  payload: unknown,
  supplied: BoundaryOptions = {},
): Promise<void> {
  const options = optionsWithDefaults(supplied);
  const seen = new Set<object>();
  let visited = 0;

  const visit = async (value: unknown, field: string, depth: number): Promise<void> => {
    visited += 1;
    if (depth > MAX_DEPTH || visited > MAX_NODES) {
      return block('source', field, 'boundary_structure_limit', options);
    }
    if (typeof value === 'string') {
      if (value.startsWith('file:')) return assertPathAllowed(value, options);
      if (URI_SCHEME.test(value)) {
        if (value.startsWith('http://') || value.startsWith('https://')) {
          return assertUrlAllowed(value, options);
        }
        return block('source', value, 'unsupported_uri_scheme', options);
      }
      if (pathLike(value, field)) return assertPathAllowed(value, options);
      if (URL_FIELD.test(field)) return block('source', value, 'url_field_not_url', options);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return block('source', field, 'cyclic_boundary_payload', options);
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) await visit(item, field, depth + 1);
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        await visit(item, key, depth + 1);
      }
    }
    seen.delete(value);
  };

  await visit(payload, '$', 0);
}
