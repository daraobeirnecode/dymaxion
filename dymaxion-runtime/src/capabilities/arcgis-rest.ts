// Reusable ArcGIS REST retrieval layer for native read-only capabilities.
// Every request is boundary-checked immediately before transport dispatch,
// size/time bounded, and validated against the ArcGIS error envelope (which
// can arrive with HTTP 200). The transport is injectable so tests exercise
// real request construction and pagination without any network access; it is
// not a generic HTTP escape hatch — callers build URLs from validated parts
// and this module never serializes credentials.

import { sha256Text } from '../contracts/canonical.js';
import { assertUrlAllowed, type BoundaryOptions } from '../security/boundary.js';

export interface ArcGisTransportRequest {
  url: URL;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ArcGisTransportResponse {
  status: number;
  contentType: string | null;
  bodyText: string;
}

export interface ArcGisRestTransport {
  get(request: ArcGisTransportRequest): Promise<ArcGisTransportResponse>;
}

export interface ArcGisRequestEvidence {
  name: string;
  url: string;
  status: number;
  sha256: string;
  bytes: number;
}

const SECRET_PARAM = /((?:^|[?&"'\s,{])(?:token|apikey|api[_-]key|password|secret|authorization|signature|code|refresh[_-]?token|access[_-]?token)(?:=|"\s*:\s*"))([^&\s"']+)/gi;
const MAX_ERROR_DETAIL_CHARS = 240;

const URL_USERINFO = /(https?:\/\/)[^/\s@"']+@/gi;

/** Redact token-like values and URL userinfo so secrets never reach errors, logs, or evidence. */
export function redactSecrets(text: string): string {
  return text.replace(URL_USERINFO, '$1<redacted>@').replace(SECRET_PARAM, '$1<redacted>');
}

function sanitizeErrorDetail(text: string): string {
  const redacted = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return redacted.length > MAX_ERROR_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : redacted;
}

/** Production transport: Node fetch, no redirect following, streamed byte cap. */
export const fetchArcGisTransport: ArcGisRestTransport = {
  async get(request: ArcGisTransportRequest): Promise<ArcGisTransportResponse> {
    const signals = [AbortSignal.timeout(request.timeoutMs)];
    if (request.signal) signals.push(request.signal);
    const response = await fetch(request.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.any(signals),
      headers: { accept: 'application/json' },
    });
    if (!response.body) {
      return { status: response.status, contentType: response.headers.get('content-type'), bodyText: '' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > request.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `arcgis response exceeded ${request.maxBytes} byte limit for ${request.url.host}${request.url.pathname}`,
        );
      }
      chunks.push(value);
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bodyText: Buffer.concat(chunks).toString('utf8'),
    };
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
}

export interface ArcGisJsonResult {
  json: Record<string, unknown>;
  evidence: ArcGisRequestEvidence;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One bounded, boundary-preflighted ArcGIS REST JSON request. */
export async function requestArcGisJson(options: ArcGisJsonRequestOptions): Promise<ArcGisJsonResult> {
  if (options.signal?.aborted) {
    throw new Error(`inspect cancelled before request '${options.name}'`);
  }
  // Boundary check immediately before dispatch — every URL, every page.
  await assertUrlAllowed(options.url.href, options.boundary);
  const response = await options.transport.get({
    url: options.url,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
  });
  const target = `${options.url.host}${options.url.pathname}`;
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`arcgis request '${options.name}' returned redirect ${response.status} for ${target}; redirects are not followed`);
  }
  if (response.status !== 200) {
    throw new Error(`arcgis request '${options.name}' failed with HTTP ${response.status} for ${target}`);
  }
  const bytes = Buffer.byteLength(response.bodyText, 'utf8');
  if (bytes > options.maxBytes) {
    throw new Error(`arcgis response exceeded ${options.maxBytes} byte limit for ${target}`);
  }
  const contentType = (response.contentType ?? '').toLowerCase();
  // ArcGIS REST serves f=json as application/json or (older releases) text/plain.
  if (!contentType.includes('application/json') && !contentType.startsWith('text/plain')) {
    throw new Error(
      `arcgis request '${options.name}' returned unexpected content type '${sanitizeErrorDetail(contentType || '(none)')}' for ${target}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch {
    throw new Error(`arcgis request '${options.name}' returned invalid JSON for ${target}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`arcgis request '${options.name}' returned a non-object JSON body for ${target}`);
  }
  if ('error' in parsed) {
    const envelope = isPlainObject(parsed.error) ? parsed.error : {};
    const code = typeof envelope.code === 'number' ? envelope.code : 'unknown';
    const message = typeof envelope.message === 'string' ? envelope.message : 'no message';
    throw new Error(
      `arcgis request '${options.name}' returned error envelope (code ${code}): ${sanitizeErrorDetail(message)}`,
    );
  }
  return {
    json: parsed,
    evidence: {
      name: options.name,
      url: options.url.href,
      status: response.status,
      sha256: sha256Text(response.bodyText),
      bytes,
    },
  };
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

  if (!truncated && totalReported !== null && totalReported > records.length) {
    truncated = true;
    truncationReasons.push(
      `${options.name}: server reports ${totalReported} records but ${records.length} were retrieved`,
    );
  }
  return { records, totalReported, pages, truncated, truncationReasons, requests };
}
