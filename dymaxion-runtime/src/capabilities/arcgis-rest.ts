// Reusable ArcGIS REST retrieval layer for native read-only capabilities.
// Every request is boundary-checked immediately before transport dispatch,
// size/time bounded, and validated against the ArcGIS error envelope (which
// can arrive with HTTP 200). The transport is injectable so tests exercise
// real request construction and pagination without any network access; it is
// not a generic HTTP escape hatch — callers build URLs from validated parts
// and this module never serializes credentials.

import { createHash } from 'node:crypto';
import { sha256Text } from '../contracts/canonical.js';
import { assertUrlAllowed, type BoundaryOptions } from '../security/boundary.js';

export interface ArcGisTransportRequest {
  url: URL;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ArcGisTransportPostRequest extends ArcGisTransportRequest {
  /** Canonical application/x-www-form-urlencoded body. It may carry query
   * predicates and object IDs; it is dispatched, hashed, and then never
   * serialized into evidence, logs, or errors. */
  body: string;
}

export interface ArcGisTransportResponse {
  status: number;
  contentType: string | null;
  bodyText: string;
}

/** A production streamed response crossed its byte ceiling after an HTTP
 * response had already been received. Keep only the bounded partial body in
 * memory so requestArcGisJson can emit typed, hash-only request evidence and
 * callers can account the actual bytes read exactly once. */
class ArcGisTransportByteLimitFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly sha256: string,
    public readonly bytes: number,
  ) {
    super('ArcGIS streamed response exceeded its byte limit');
    this.name = 'ArcGisTransportByteLimitFailure';
  }
}

export interface ArcGisRestTransport {
  get(request: ArcGisTransportRequest): Promise<ArcGisTransportResponse>;
  /** Optional bounded POST-form support (additive since Phase 1C). A
   * transport without it fails closed when a POST is requested. */
  postForm?(request: ArcGisTransportPostRequest): Promise<ArcGisTransportResponse>;
}

export interface ArcGisRequestEvidence {
  name: string;
  url: string;
  status: number;
  sha256: string;
  bytes: number;
  /** Present for POST-form requests (additive since evidence 1.2.0). */
  method?: 'GET' | 'POST';
  /** SHA-256 of the canonical form body; the body itself is never recorded. */
  request_sha256?: string;
}

/** Canonical application/x-www-form-urlencoded body: entries sorted by key
 * (then value), so logically identical forms hash identically. */
export function canonicalFormBody(form: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form).sort(([a, av], [b, bv]) =>
    a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  )) {
    params.append(key, value);
  }
  return params.toString();
}

/**
 * Typed failure for a dispatched ArcGIS request whose HTTP response WAS
 * received: it carries sanitized request evidence (constructed URL, status,
 * body hash, byte count — never body content) so callers that tolerate
 * per-item failures can still count the received bytes against their total
 * ceiling and record truthful dispatch-order evidence. Requests that never
 * produced a response (boundary blocks, transport failures, aborts) throw
 * plain errors without evidence and must stay fail-closed.
 */
export class ArcGisRequestFailure extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'redirect'
      | 'http_error'
      | 'byte_limit'
      | 'content_type'
      | 'invalid_json'
      | 'error_envelope',
    public readonly status: number,
    public readonly evidence: ArcGisRequestEvidence,
  ) {
    super(message);
    this.name = 'ArcGisRequestFailure';
  }
}

// Any key=value or "key":"value" pair; the key is tested against
// isCredentialKey so compound conventional names (client_secret, oauth_token,
// private_key, …) are caught without redacting ordinary prose.
const KEY_VALUE_PAIR = /(^|[?&"'\s,{(])([A-Za-z0-9_.-]+)(=|"\s*:\s*")([^&\s"']+)/g;
const EXACT_CREDENTIAL_KEYS = new Set([
  'token',
  'secret',
  'key',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'apikey',
  'signature',
  'sig',
  'code',
]);
// Compound names: any separator-delimited suffix of a credential word, e.g.
// client_secret, oauth_token, refresh_token, id_token, private_key, api_key,
// access_key, db_password, x-api-key, session.token.
const CREDENTIAL_SUFFIX = /(?:^|[_.-])(?:token|secret|key|password|passwd|credential|credentials|apikey|auth|authorization|signature|sig)$/;
// `code` is too broad as a generic suffix (`postal_code`, `status_code`).
// Restrict OAuth-style authorization codes to conventional credential names.
const TARGETED_CODE_KEY = /^(?:oauth|auth|authorization|client|verification)[_.-]?code$/;
// Reviewed allowlist of conventional collapsed/camelCase compound credential
// names that survive lowercasing without a separator (kept narrow on purpose:
// no broad endsWith matching that would redact ordinary keys like 'monkey').
const COLLAPSED_CREDENTIAL_KEYS = new Set([
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'privatekey',
  'accesskeyid',
  'secretaccesskey',
  'sessiontoken',
  'authtoken',
  'apitoken',
  'appsecret',
  'secretkey',
  'xsignature',
]);

function isCredentialKey(name: string): boolean {
  const normalized = name.toLowerCase();
  if (EXACT_CREDENTIAL_KEYS.has(normalized) || COLLAPSED_CREDENTIAL_KEYS.has(normalized)) {
    return true;
  }
  if (TARGETED_CODE_KEY.test(normalized)) return true;
  if (CREDENTIAL_SUFFIX.test(normalized)) return true;
  // camelCase compounds: split case boundaries, then re-test the suffix rule
  // (clientSecret → client_secret). Names without case boundaries ('monkey')
  // are unaffected.
  const decompounded = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return decompounded !== normalized && CREDENTIAL_SUFFIX.test(decompounded);
}

const MAX_ERROR_DETAIL_CHARS = 240;

const URL_USERINFO = /(https?:\/\/)[^/\s@"']+@/gi;
// RFC 6750 b64token / RFC 7617 token68 character run. Single shared source
// for BOTH the global redaction replacement and the non-global path detector
// so the two grammars cannot drift. ANY non-empty value after a Bearer/Basic
// scheme marker counts — no minimum length, short tokens are still secrets.
// A bare 'bearer'/'basic' word with no following token68 value (segment end,
// '/', non-token characters) never matches, so ordinary names containing
// those words are unaffected.
const TOKEN68_RUN = String.raw`[A-Za-z0-9+/=._~-]+`;
// Header-style credentials: "Authorization: Bearer <v>", "Authorization: Basic <v>",
// bare "Bearer/Basic <v>" scheme values, and "X-Api-Key: <v>" style headers.
const AUTH_HEADER = /\b((?:proxy-)?authorization\s*:\s*)(?:(bearer|basic)\s+)?[^\s"',;}]+/gi;
// Global: used only with String.replace (never .test, which would be
// stateful on a /g regex).
const AUTH_SCHEME = new RegExp(String.raw`\b(bearer|basic)\s+${TOKEN68_RUN}`, 'gi');
const API_KEY_HEADER = /\b((?:x-)?api[-_]?key\s*:\s*)[^\s"',;}]+/gi;

// Assignment pairs inside URL path text: unlike KEY_VALUE_PAIR above, the key
// may directly follow a '/' segment boundary ('/token=abc/FeatureServer').
const PATH_ASSIGNMENT = /([A-Za-z0-9_.-]+)\s*[=:]\s*[^\s/]+/g;
// Some service providers place credentials in adjacent path segments rather
// than assignments (`/apikey/{value}`). Keep this list intentionally narrow
// so legitimate service names such as `/services/token/FeatureServer` remain
// valid while unambiguous key/value path conventions fail closed.
const PATH_VALUE_CREDENTIAL_KEYS = new Set([
  'apikey',
  'api-key',
  'api_key',
  'access-token',
  'access_token',
  'accesstoken',
  'client-secret',
  'client_secret',
  'clientsecret',
]);
// Non-global: safe for .test() detection; same shared token68 grammar.
const AUTH_MATERIAL = new RegExp(String.raw`\b(?:bearer|basic)\s+${TOKEN68_RUN}`, 'i');

/** True when decoded URL path (or similar) text carries credential-shaped
 * key/value assignments (`token=…`, `api_key:…`) or authorization material
 * (Bearer/Basic tokens). Used to reject service references whose PATH
 * smuggles secrets past query stripping. Plain names without an assignment
 * ('/Hydrants', '/token/', '/FeatureServer') never match, so ordinary
 * service names are unaffected. */
export function containsCredentialMaterial(text: string): boolean {
  // Scan every assignment key independently. A zero-width lookahead avoids an
  // outer SQL assignment consuming a nested literal such as
  // `STATUS = 'token=secret'` before the credential key can be inspected.
  for (const match of text.matchAll(/(?=(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)["']?\s*[=:])/g)) {
    if (isCredentialKey(match[1])) return true;
  }
  for (const match of text.matchAll(PATH_ASSIGNMENT)) {
    if (isCredentialKey(match[1])) return true;
  }
  const pathSegments = text.split('/');
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (
      PATH_VALUE_CREDENTIAL_KEYS.has(pathSegments[index]!.toLowerCase()) &&
      pathSegments[index + 1]!.length > 0
    ) {
      return true;
    }
  }
  return AUTH_MATERIAL.test(text);
}

/** Redact token-like values, URL userinfo, and header-style credentials so
 * secrets never reach errors, logs, or evidence. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_USERINFO, '$1<redacted>@')
    .replace(AUTH_HEADER, (_match, prefix: string, scheme?: string) =>
      `${prefix}${scheme ? `${scheme} ` : ''}<redacted>`)
    .replace(AUTH_SCHEME, '$1 <redacted>')
    .replace(API_KEY_HEADER, '$1<redacted>')
    .replace(KEY_VALUE_PAIR, (match, prefix: string, name: string, separator: string) =>
      isCredentialKey(name) ? `${prefix}${name}${separator}<redacted>` : match);
}

/** Validate a portal root URL string; returns a problem description or null.
 * Shared by every ArcGIS capability so portal inputs are rejected identically. */
export function validatePortalUrl(raw: string): string | null {
  // Inspect the raw string before WHATWG URL normalization can silently
  // rewrite traversal segments, backslashes, or encoded characters.
  if (/\.\.|%|\\/.test(raw)) {
    return 'portal_url must not contain traversal, encoded, or backslash segments';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'portal_url must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'portal_url must use https';
  if (url.username || url.password) return 'portal_url must not embed credentials';
  if (url.search || url.hash) return 'portal_url must not contain a query string or fragment';
  if (!url.hostname) return 'portal_url must include a hostname';
  if (url.pathname.includes('//')) return 'portal_url path must not contain empty segments';
  return null;
}

/** Approved portal root: origin plus normalized path, no trailing slash. */
export function portalRoot(rawUrl: string): string {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function sanitizeErrorDetail(text: string): string {
  const redacted = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return redacted.length > MAX_ERROR_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : redacted;
}

/** Streamed bounded read shared by the GET and POST production paths. */
async function readBoundedResponse(
  response: Response,
  request: ArcGisTransportRequest,
): Promise<ArcGisTransportResponse> {
  if (!response.body) {
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText: '' };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const responseHash = createHash('sha256');
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    responseHash.update(value);
    if (received > request.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ArcGisTransportByteLimitFailure(
        response.status,
        responseHash.digest('hex'),
        received,
      );
    }
    chunks.push(value);
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyText: Buffer.concat(chunks).toString('utf8'),
  };
}

function combinedSignal(request: ArcGisTransportRequest): AbortSignal {
  const signals = [AbortSignal.timeout(request.timeoutMs)];
  if (request.signal) signals.push(request.signal);
  return AbortSignal.any(signals);
}

/** Production transport: Node fetch, no redirect following, streamed byte cap. */
export const fetchArcGisTransport: ArcGisRestTransport = {
  async get(request: ArcGisTransportRequest): Promise<ArcGisTransportResponse> {
    const response = await fetch(request.url, {
      method: 'GET',
      redirect: 'manual',
      signal: combinedSignal(request),
      headers: { accept: 'application/json' },
    });
    return readBoundedResponse(response, request);
  },
  async postForm(request: ArcGisTransportPostRequest): Promise<ArcGisTransportResponse> {
    const response = await fetch(request.url, {
      method: 'POST',
      redirect: 'manual',
      signal: combinedSignal(request),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: request.body,
    });
    return readBoundedResponse(response, request);
  },
};

export interface ArcGisJsonRequestOptions {
  name: string;
  url: URL;
  transport: ArcGisRestTransport;
  boundary: BoundaryOptions;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Presence selects a POST-form dispatch. Entries are canonicalized before
   * hashing and dispatch; the target URL must carry no query string so no
   * form value can appear in evidence URLs or error text. */
  form?: Readonly<Record<string, string>>;
}

export interface ArcGisJsonResult {
  json: Record<string, unknown>;
  evidence: ArcGisRequestEvidence;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One bounded, boundary-preflighted ArcGIS REST JSON request (GET, or
 * POST form when `form` is provided). */
export async function requestArcGisJson(options: ArcGisJsonRequestOptions): Promise<ArcGisJsonResult> {
  if (options.signal?.aborted) {
    throw new Error(`inspect cancelled before request '${options.name}'`);
  }
  let body: string | null = null;
  if (options.form !== undefined) {
    if (options.url.search || options.url.hash) {
      throw new Error(
        `arcgis POST request '${options.name}' must not carry a query string or fragment in its URL`,
      );
    }
    if (typeof options.transport.postForm !== 'function') {
      throw new Error(`arcgis transport does not support POST for request '${options.name}'`);
    }
    body = canonicalFormBody(options.form);
  }
  // Boundary check immediately before dispatch — every URL, every page.
  await assertUrlAllowed(options.url.href, options.boundary);
  // The boundary check awaits DNS resolution and audit sinks; a cancellation
  // that lands during that window must still prevent the dispatch.
  if (options.signal?.aborted) {
    throw new Error(`inspect cancelled before request '${options.name}'`);
  }
  const transportRequest = {
    url: options.url,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
  };
  const target = `${options.url.host}${options.url.pathname}`;
  let response: ArcGisTransportResponse;
  try {
    response =
      body === null
        ? await options.transport.get(transportRequest)
        : await options.transport.postForm!({ ...transportRequest, body });
  } catch (error) {
    if (error instanceof ArcGisTransportByteLimitFailure) {
      const evidence: ArcGisRequestEvidence = {
        name: options.name,
        url: options.url.href,
        status: error.status,
        sha256: error.sha256,
        bytes: error.bytes,
        ...(body === null ? {} : { method: 'POST' as const, request_sha256: sha256Text(body) }),
      };
      throw new ArcGisRequestFailure(
        `arcgis response exceeded ${options.maxBytes} byte limit for ${target}`,
        'byte_limit',
        error.status,
        evidence,
      );
    }
    throw error;
  }
  // A response was received: every failure below carries sanitized request
  // evidence so callers can account the received bytes and record the request.
  const bytes = Buffer.byteLength(response.bodyText, 'utf8');
  const evidence: ArcGisRequestEvidence = {
    name: options.name,
    url: options.url.href,
    status: response.status,
    sha256: sha256Text(response.bodyText),
    bytes,
    ...(body === null ? {} : { method: 'POST' as const, request_sha256: sha256Text(body) }),
  };
  const fail = (kind: ArcGisRequestFailure['kind'], message: string): never => {
    throw new ArcGisRequestFailure(message, kind, response.status, evidence);
  };
  // Byte ceiling first, before any status classification: an oversized
  // response must fail closed as 'byte_limit' even when its status (e.g. a
  // tolerated 4xx) would otherwise be treated as a per-item failure.
  if (bytes > options.maxBytes) {
    fail('byte_limit', `arcgis response exceeded ${options.maxBytes} byte limit for ${target}`);
  }
  if (response.status >= 300 && response.status < 400) {
    fail('redirect', `arcgis request '${options.name}' returned redirect ${response.status} for ${target}; redirects are not followed`);
  }
  if (response.status !== 200) {
    fail('http_error', `arcgis request '${options.name}' failed with HTTP ${response.status} for ${target}`);
  }
  const contentType = (response.contentType ?? '').toLowerCase();
  // ArcGIS REST serves f=json as application/json or (older releases) text/plain.
  if (!contentType.includes('application/json') && !contentType.startsWith('text/plain')) {
    fail(
      'content_type',
      `arcgis request '${options.name}' returned unexpected content type '${sanitizeErrorDetail(contentType || '(none)')}' for ${target}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    fail('invalid_json', `arcgis request '${options.name}' returned invalid JSON for ${target}`);
  }
  if (!isPlainObject(parsed)) {
    fail('invalid_json', `arcgis request '${options.name}' returned a non-object JSON body for ${target}`);
  }
  const json = parsed as Record<string, unknown>;
  if ('error' in json) {
    const envelope = isPlainObject(json.error) ? json.error : {};
    const code = typeof envelope.code === 'number' ? envelope.code : 'unknown';
    const message = typeof envelope.message === 'string' ? envelope.message : 'no message';
    fail(
      'error_envelope',
      `arcgis request '${options.name}' returned error envelope (code ${code}): ${sanitizeErrorDetail(message)}`,
    );
  }
  return { json, evidence };
}

export interface ArcGisPageEnvelope {
  records: Array<Record<string, unknown>>;
  total: number | null;
  nextStart: number;
}

/** Parse the shared {total, nextStart, <records>} ArcGIS pagination envelope. */
export function parseArcGisPageEnvelope(
  json: Record<string, unknown>,
  recordsKey: string,
  name: string,
): ArcGisPageEnvelope {
  const rawRecords = json[recordsKey];
  if (!Array.isArray(rawRecords)) {
    throw new Error(`arcgis request '${name}' is missing the '${recordsKey}' array`);
  }
  const records = rawRecords.map((record, index) => {
    if (!isPlainObject(record)) {
      throw new Error(`arcgis request '${name}' record ${index} is not an object`);
    }
    return record;
  });
  const nextStart = json.nextStart;
  if (typeof nextStart !== 'number' || !Number.isInteger(nextStart)) {
    throw new Error(`arcgis request '${name}' returned a malformed nextStart cursor`);
  }
  const total = typeof json.total === 'number' && Number.isInteger(json.total) && json.total >= 0 ? json.total : null;
  return { records, total, nextStart };
}

export interface ArcGisPaginationOptions {
  name: string;
  buildUrl(start: number, num: number): URL;
  recordsKey: string;
  transport: ArcGisRestTransport;
  boundary: BoundaryOptions;
  pageSize: number;
  maxRecords: number;
  maxPages: number;
  requestTimeoutMs(): number;
  requestMaxBytes(): number;
  onResponseBytes(bytes: number): void;
  signal?: AbortSignal;
}

export interface ArcGisPaginationResult {
  records: Array<Record<string, unknown>>;
  totalReported: number | null;
  pages: number;
  truncated: boolean;
  truncationReasons: string[];
  requests: ArcGisRequestEvidence[];
}

/**
 * Exact ArcGIS REST pagination: `start` begins at 1, a positive strictly
 * advancing `nextStart` continues, `-1` terminates. Repeated or backwards
 * cursors fail closed; record and page ceilings truncate honestly.
 */
export async function paginateArcGis(options: ArcGisPaginationOptions): Promise<ArcGisPaginationResult> {
  const records: Array<Record<string, unknown>> = [];
  const requests: ArcGisRequestEvidence[] = [];
  const truncationReasons: string[] = [];
  let totalReported: number | null = null;
  let start = 1;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= options.maxPages) {
      truncated = true;
      truncationReasons.push(`${options.name}: stopped at the ${options.maxPages}-page ceiling`);
      break;
    }
    const remaining = options.maxRecords - records.length;
    if (remaining <= 0) {
      truncated = true;
      truncationReasons.push(`${options.name}: stopped at the ${options.maxRecords}-record ceiling`);
      break;
    }
    const num = Math.min(options.pageSize, remaining);
    const page = await requestArcGisJson({
      name: `${options.name}:page${pages + 1}`,
      url: options.buildUrl(start, num),
      transport: options.transport,
      boundary: options.boundary,
      timeoutMs: options.requestTimeoutMs(),
      maxBytes: options.requestMaxBytes(),
      signal: options.signal,
    });
    requests.push(page.evidence);
    options.onResponseBytes(page.evidence.bytes);
    pages += 1;
    const envelope = parseArcGisPageEnvelope(page.json, options.recordsKey, options.name);
    if (envelope.total !== null) totalReported = envelope.total;
    if (envelope.records.length > num) {
      throw new Error(`arcgis request '${options.name}' returned more records than requested`);
    }
    records.push(...envelope.records);
    if (envelope.nextStart === -1) break;
    if (envelope.nextStart <= start || envelope.nextStart < 1) {
      throw new Error(
        `arcgis request '${options.name}' returned a repeated or non-advancing pagination cursor (start ${start} → nextStart ${envelope.nextStart})`,
      );
    }
    if (envelope.records.length === 0) {
      throw new Error(`arcgis request '${options.name}' returned an empty page with a continuing cursor`);
    }
    start = envelope.nextStart;
  }

  if (totalReported !== null && totalReported < records.length) {
    throw new Error(
      `arcgis request '${options.name}' reported total ${totalReported} lower than the ${records.length} records retrieved; inconsistent pagination is not trusted`,
    );
  }
  if (!truncated && totalReported !== null && totalReported > records.length) {
    truncated = true;
    truncationReasons.push(
      `${options.name}: server reports ${totalReported} records but ${records.length} were retrieved`,
    );
  }
  return { records, totalReported, pages, truncated, truncationReasons, requests };
}
