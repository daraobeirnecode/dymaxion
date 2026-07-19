// Phase 1A native capability: deterministic, read-only ArcGIS organization
// inventory over the Portal REST API. Bounded users/groups/items/services
// retrieval with exact start/num/nextStart pagination, deterministic
// timestamp/sharing/item-type/staleness normalization, versioned evidence,
// and explicit partial-visibility and truncation caveats. No credential is
// ever accepted in the input schema; remote metadata is treated as untrusted
// data, never as instructions.

import { z } from 'zod';
import { canonicalJson, sha256Canonical } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema } from '../contracts/evidence.js';
import type { BoundaryOptions } from '../security/boundary.js';
import {
  fetchArcGisTransport,
  paginateArcGis,
  requestArcGisJson,
  type ArcGisRequestEvidence,
  type ArcGisRestTransport,
} from './arcgis-rest.js';

const CAPABILITY_VERSION = '1.0.0';
const MAX_RECORDS_PER_SECTION = 2_000;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_PAGE_SIZE = 100;
const ARCGIS_MAX_PAGE_SIZE = 100;
const DEFAULT_STALE_AFTER_DAYS = 365;
const MAX_STALE_AFTER_DAYS = 3_650;
const MAX_PAGES_PER_SECTION = 25;
const MAX_TOTAL_BYTES = 8_388_608;
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_DURATION_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MS_PER_DAY = 86_400_000;

const SECTION_ORDER = ['users', 'groups', 'items', 'services'] as const;
type Section = (typeof SECTION_ORDER)[number];

// Authoritative ArcGIS item types that are backed by a service endpoint.
// Classification uses the `type` field only — never title text.
const SERVICE_ITEM_TYPES = new Set([
  'Feature Service',
  'Map Service',
  'Image Service',
  'Scene Service',
  'Vector Tile Service',
  'Stream Service',
  'Geocoding Service',
  'Geometry Service',
  'Geoprocessing Service',
  'Network Analysis Service',
  'WMS',
  'WMTS',
  'WFS',
]);

const CREDENTIAL_FIELD = /(?:token|api[_-]?key|password|secret|credential|authorization)/i;

export const InspectArcgisOrgInputSchema = z
  .object({
    portal_url: z.string().min(1).max(2_048),
    org_id: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
    include: z
      .array(z.enum(SECTION_ORDER))
      .min(1)
      .max(SECTION_ORDER.length)
      .optional(),
    stale_after_days: z.number().int().min(1).max(MAX_STALE_AFTER_DAYS).optional(),
    page_size: z.number().int().min(1).max(ARCGIS_MAX_PAGE_SIZE).optional(),
    max_records: z.number().int().min(1).max(MAX_RECORDS_PER_SECTION).optional(),
    item_owner: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const problem = validatePortalUrl(input.portal_url);
    if (problem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_url'], message: problem });
    }
    const include = input.include ?? [];
    if (new Set(include).size !== include.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['include'],
        message: 'include sections must be unique',
      });
    }
    if (include.includes('services') && include.length > 0 && !include.includes('items')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['include'],
        message: "the 'services' section is derived from items; include 'items' as well",
      });
    }
    for (const key of Object.keys(input)) {
      if (CREDENTIAL_FIELD.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'credential-like input fields are never accepted',
        });
      }
    }
  });

function validatePortalUrl(raw: string): string | null {
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
function portalRoot(rawUrl: string): string {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

const IsoDate = z.string().datetime({ offset: true });
const SharingSchema = z.enum(['public', 'org', 'shared', 'private', 'unknown']);

const UserRecordSchema = z
  .object({
    username: z.string().min(1),
    full_name: z.string().nullable(),
    role: z.string().nullable(),
    created_at: IsoDate.nullable(),
    modified_at: IsoDate.nullable(),
    last_login_at: IsoDate.nullable(),
  })
  .strict();

const GroupRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    owner: z.string().nullable(),
    access: SharingSchema,
    created_at: IsoDate.nullable(),
    modified_at: IsoDate.nullable(),
  })
  .strict();

const ItemRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    owner: z.string().nullable(),
    type: z.string().nullable(),
    access: SharingSchema,
    created_at: IsoDate.nullable(),
    modified_at: IsoDate.nullable(),
    size_bytes: z.number().int().nonnegative().nullable(),
    service_backed: z.boolean(),
    service_url: z.string().url().nullable(),
    stale: z.boolean().nullable(),
    days_since_modified: z.number().int().nonnegative().nullable(),
  })
  .strict();

const ServiceRecordSchema = z
  .object({
    item_id: z.string().min(1),
    title: z.string().nullable(),
    owner: z.string().nullable(),
    type: z.string().min(1),
    service_url: z.string().url().nullable(),
    access: SharingSchema,
    stale: z.boolean().nullable(),
  })
  .strict();

function sectionSchema<T extends z.ZodTypeAny>(record: T) {
  return z
    .object({
      total_reported: z.number().int().nonnegative().nullable(),
      retrieved_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
      records: z.array(record),
    })
    .strict();
}

const OrgInventoryReportSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    portal: z
      .object({
        url: z.string().url(),
        org_id: z.string().min(1),
        name: z.string().nullable(),
        url_key: z.string().nullable(),
        access: SharingSchema,
        created_at: IsoDate.nullable(),
        modified_at: IsoDate.nullable(),
      })
      .strict(),
    retrieved_at: IsoDate,
    parameters: z
      .object({
        include: z.array(z.enum(SECTION_ORDER)),
        stale_after_days: z.number().int().positive(),
        page_size: z.number().int().positive(),
        max_records: z.number().int().positive(),
        item_owner: z.string().nullable(),
      })
      .strict(),
    caveats: z.array(z.string()),
    users: sectionSchema(UserRecordSchema).nullable(),
    groups: sectionSchema(GroupRecordSchema).nullable(),
    items: sectionSchema(ItemRecordSchema).nullable(),
    services: sectionSchema(ServiceRecordSchema).nullable(),
    ownership_summary: z
      .array(z.object({ owner: z.string().min(1), item_count: z.number().int().positive() }).strict())
      .nullable(),
    sharing_summary: z
      .object({
        public: z.number().int().nonnegative(),
        org: z.number().int().nonnegative(),
        shared: z.number().int().nonnegative(),
        private: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    staleness: z
      .object({
        threshold_days: z.number().int().positive(),
        evaluated_at: IsoDate,
        stale_item_count: z.number().int().nonnegative(),
        unknown_modified_count: z.number().int().nonnegative(),
        findings: z.array(
          z
            .object({
              item_id: z.string().min(1),
              title: z.string().nullable(),
              owner: z.string().nullable(),
              type: z.string().nullable(),
              modified_at: IsoDate.nullable(),
              days_since_modified: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    warnings: z.array(z.string()),
    truncation: z
      .object({ truncated: z.boolean(), reasons: z.array(z.string()) })
      .strict(),
  })
  .strict();

export const InspectArcgisOrgOutputSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    report: OrgInventoryReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type InspectArcgisOrgInput = z.infer<typeof InspectArcgisOrgInputSchema>;
export type InspectArcgisOrgOutput = z.infer<typeof InspectArcgisOrgOutputSchema>;
type OrgInventoryReport = z.infer<typeof OrgInventoryReportSchema>;
type Sharing = z.infer<typeof SharingSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** ArcGIS epoch-millisecond timestamps → ISO-8601; -1/0/absent → null. */
function normalizeEpochMs(value: unknown, label: string, warnings: string[]): string | null {
  if (value === undefined || value === null || value === -1 || value === 0) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 32_503_680_000_000 // year 3000 guard against nonsense epochs
  ) {
    warnings.push(`${label}: unrecognized timestamp value was treated as unknown`);
    return null;
  }
  return new Date(value).toISOString();
}

/** ArcGIS access values → sharing labels; anything else is 'unknown', never invented. */
function normalizeSharing(value: unknown, label: string, warnings: string[]): Sharing {
  if (value === 'public' || value === 'org' || value === 'shared' || value === 'private') return value;
  if (value !== undefined && value !== null) {
    warnings.push(`${label}: unrecognized sharing value was labelled 'unknown'`);
  }
  return 'unknown';
}

function normalizeServiceUrl(value: unknown, label: string, warnings: string[]): string | null {
  if (typeof value !== 'string' || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    warnings.push(`${label}: unparseable service URL was ignored`);
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    warnings.push(`${label}: non-HTTP service URL was ignored`);
    return null;
  }
  // Item metadata is untrusted: a credential-bearing URL must never reach
  // report output, evidence, warnings, or logs. The warning texts stay
  // URL-free by construction.
  if (url.username || url.password) {
    warnings.push(`${label}: credential-bearing service URL was removed`);
    return null;
  }
  if (url.search || url.hash) {
    // Service endpoint roots never need a query or fragment; dropping both
    // guarantees no secret parameter survives regardless of its name.
    url.search = '';
    url.hash = '';
    warnings.push(`${label}: service URL query/fragment was removed`);
  }
  return url.href;
}

interface StalenessInput {
  modifiedAt: string | null;
  nowMs: number;
  thresholdDays: number;
}

function staleness(input: StalenessInput): { stale: boolean | null; days: number | null } {
  if (input.modifiedAt === null) return { stale: null, days: null };
  const elapsed = input.nowMs - Date.parse(input.modifiedAt);
  const days = Math.max(0, Math.floor(elapsed / MS_PER_DAY));
  return { stale: days > input.thresholdDays, days };
}

interface RetrievalBudget {
  deadline: number;
  bytesUsed: number;
}

function requestTimeoutMs(budget: RetrievalBudget): number {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) throw new Error(`inspect_arcgis_org exceeded the ${MAX_DURATION_MS}ms duration ceiling`);
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function requestMaxBytes(budget: RetrievalBudget): number {
  const remaining = MAX_TOTAL_BYTES - budget.bytesUsed;
  if (remaining <= 0) throw new Error(`inspect_arcgis_org exceeded the ${MAX_TOTAL_BYTES}-byte response ceiling`);
  return Math.min(MAX_RESPONSE_BYTES, remaining);
}

interface Retrieval {
  transport: ArcGisRestTransport;
  boundary: BoundaryOptions;
  budget: RetrievalBudget;
  signal?: AbortSignal;
}

async function retrievePaginated(
  retrieval: Retrieval,
  name: string,
  buildUrl: (start: number, num: number) => URL,
  recordsKey: string,
  pageSize: number,
  maxRecords: number,
) {
  return paginateArcGis({
    name,
    buildUrl,
    recordsKey,
    transport: retrieval.transport,
    boundary: retrieval.boundary,
    pageSize,
    maxRecords,
    maxPages: MAX_PAGES_PER_SECTION,
    requestTimeoutMs: () => requestTimeoutMs(retrieval.budget),
    requestMaxBytes: () => requestMaxBytes(retrieval.budget),
    onResponseBytes: (bytes) => {
      retrieval.budget.bytesUsed += bytes;
    },
    signal: retrieval.signal,
  });
}

async function executeInspectArcgisOrg(
  input: InspectArcgisOrgInput,
  context: CapabilityExecutionContext,
): Promise<InspectArcgisOrgOutput> {
  if (context.signal?.aborted) throw new Error('inspect_arcgis_org cancelled before retrieval');
  const now = context.now ?? (() => new Date());
  const retrievedAt = now().toISOString();
  const nowMs = Date.parse(retrievedAt);

  const include = [...new Set(input.include ?? SECTION_ORDER)];
  const orderedInclude = SECTION_ORDER.filter((section) => include.includes(section));
  const staleAfterDays = input.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS;
  const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  const maxRecords = input.max_records ?? DEFAULT_MAX_RECORDS;
  const itemOwner = input.item_owner ?? null;

  const root = portalRoot(input.portal_url);
  const restBase = `${root}/sharing/rest`;
  const transport = (context.io?.arcgisTransport as ArcGisRestTransport | undefined) ?? fetchArcGisTransport;
  const boundary: BoundaryOptions = context.boundary ?? {};
  const retrieval: Retrieval = {
    transport,
    boundary,
    budget: { deadline: Date.now() + MAX_DURATION_MS, bytesUsed: 0 },
    signal: context.signal,
  };

  const warnings: string[] = [];
  const caveats: string[] = [
    'Inventory covers only content visible to the configured identity at the approved portal; it is not proof of a complete organization inventory.',
  ];
  const requests: ArcGisRequestEvidence[] = [];
  const truncationReasons: string[] = [];

  const jsonUrl = (path: string, params: Record<string, string> = {}): URL => {
    const url = new URL(`${restBase}${path}`);
    url.searchParams.set('f', 'json');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  };

  // Portal/organization identity from the portals endpoint.
  const portalSelf = await requestArcGisJson({
    name: 'portal_self',
    url: jsonUrl(`/portals/${input.org_id}`),
    transport,
    boundary,
    timeoutMs: requestTimeoutMs(retrieval.budget),
    maxBytes: requestMaxBytes(retrieval.budget),
    signal: context.signal,
  });
  retrieval.budget.bytesUsed += portalSelf.evidence.bytes;
  requests.push(portalSelf.evidence);
  const portalJson = portalSelf.json;
  const portalId = optionalString(portalJson.id);
  if (portalId !== null && portalId !== input.org_id) {
    throw new Error(
      `arcgis portal identity mismatch: requested organization '${input.org_id}' but the portal reported a different id`,
    );
  }
  if (portalId === null) {
    warnings.push('portal_self: response did not report an organization id');
  }

  let users: OrgInventoryReport['users'] = null;
  if (orderedInclude.includes('users')) {
    const page = await retrievePaginated(
      retrieval,
      'users',
      (start, num) =>
        jsonUrl(`/portals/${input.org_id}/users`, { start: String(start), num: String(num) }),
      'users',
      pageSize,
      maxRecords,
    );
    requests.push(...page.requests);
    truncationReasons.push(...page.truncationReasons);
    const records = page.records.flatMap((record, index) => {
      const username = optionalString(record.username);
      if (username === null) {
        warnings.push(`users record ${index}: missing username; record skipped as incomplete`);
        return [];
      }
      return [
        {
          username,
          full_name: optionalString(record.fullName),
          role: optionalString(record.role),
          created_at: normalizeEpochMs(record.created, `user '${username}' created`, warnings),
          modified_at: normalizeEpochMs(record.modified, `user '${username}' modified`, warnings),
          last_login_at: normalizeEpochMs(record.lastLogin, `user '${username}' lastLogin`, warnings),
        },
      ];
    });
    users = {
      total_reported: page.totalReported,
      retrieved_count: records.length,
      truncated: page.truncated,
      records,
    };
  }

  let groups: OrgInventoryReport['groups'] = null;
  if (orderedInclude.includes('groups')) {
    const page = await retrievePaginated(
      retrieval,
      'groups',
      (start, num) =>
        jsonUrl('/community/groups', {
          q: `orgid:${input.org_id}`,
          sortField: 'created',
          sortOrder: 'asc',
          start: String(start),
          num: String(num),
        }),
      'results',
      pageSize,
      maxRecords,
    );
    requests.push(...page.requests);
    truncationReasons.push(...page.truncationReasons);
    const records = page.records.flatMap((record, index) => {
      const id = optionalString(record.id);
      if (id === null) {
        warnings.push(`groups record ${index}: missing id; record skipped as incomplete`);
        return [];
      }
      return [
        {
          id,
          title: optionalString(record.title),
          owner: optionalString(record.owner),
          access: normalizeSharing(record.access, `group '${id}' access`, warnings),
          created_at: normalizeEpochMs(record.created, `group '${id}' created`, warnings),
          modified_at: normalizeEpochMs(record.modified, `group '${id}' modified`, warnings),
        },
      ];
    });
    groups = {
      total_reported: page.totalReported,
      retrieved_count: records.length,
      truncated: page.truncated,
      records,
    };
  }

  let items: OrgInventoryReport['items'] = null;
  let services: OrgInventoryReport['services'] = null;
  let ownershipSummary: OrgInventoryReport['ownership_summary'] = null;
  let sharingSummary: OrgInventoryReport['sharing_summary'] = null;
  let stalenessReport: OrgInventoryReport['staleness'] = null;
  if (orderedInclude.includes('items')) {
    const query = itemOwner === null ? `orgid:${input.org_id}` : `orgid:${input.org_id} AND owner:${itemOwner}`;
    const page = await retrievePaginated(
      retrieval,
      'items',
      (start, num) =>
        jsonUrl('/search', {
          q: query,
          sortField: 'created',
          sortOrder: 'asc',
          start: String(start),
          num: String(num),
        }),
      'results',
      pageSize,
      maxRecords,
    );
    requests.push(...page.requests);
    truncationReasons.push(...page.truncationReasons);
    const records = page.records.flatMap((record, index) => {
      const id = optionalString(record.id);
      if (id === null) {
        warnings.push(`items record ${index}: missing id; record skipped as incomplete`);
        return [];
      }
      const type = optionalString(record.type);
      const serviceBacked = type !== null && SERVICE_ITEM_TYPES.has(type);
      const serviceUrl = serviceBacked
        ? normalizeServiceUrl(record.url, `item '${id}' url`, warnings)
        : null;
      if (serviceBacked && serviceUrl === null) {
        warnings.push(`item '${id}': service-backed type '${type}' has no usable service URL`);
      }
      const modifiedAt = normalizeEpochMs(record.modified, `item '${id}' modified`, warnings);
      const stale = staleness({ modifiedAt, nowMs, thresholdDays: staleAfterDays });
      const sizeBytes =
        typeof record.size === 'number' && Number.isInteger(record.size) && record.size >= 0
          ? record.size
          : null;
      return [
        {
          id,
          title: optionalString(record.title),
          owner: optionalString(record.owner),
          type,
          access: normalizeSharing(record.access, `item '${id}' access`, warnings),
          created_at: normalizeEpochMs(record.created, `item '${id}' created`, warnings),
          modified_at: modifiedAt,
          size_bytes: sizeBytes,
          service_backed: serviceBacked,
          service_url: serviceUrl,
          stale: stale.stale,
          days_since_modified: stale.days,
        },
      ];
    });
    items = {
      total_reported: page.totalReported,
      retrieved_count: records.length,
      truncated: page.truncated,
      records,
    };

    if (orderedInclude.includes('services')) {
      const serviceRecords = records
        .filter((record) => record.service_backed)
        .map((record) => ({
          item_id: record.id,
          title: record.title,
          owner: record.owner,
          type: record.type as string,
          service_url: record.service_url,
          access: record.access,
          stale: record.stale,
        }));
      services = {
        total_reported: null,
        retrieved_count: serviceRecords.length,
        truncated: items.truncated,
        records: serviceRecords,
      };
    }

    const ownerCounts = new Map<string, number>();
    for (const record of records) {
      if (record.owner === null) continue;
      ownerCounts.set(record.owner, (ownerCounts.get(record.owner) ?? 0) + 1);
    }
    ownershipSummary = [...ownerCounts.entries()]
      .map(([owner, itemCount]) => ({ owner, item_count: itemCount }))
      .sort((a, b) => b.item_count - a.item_count || a.owner.localeCompare(b.owner, 'en'));

    sharingSummary = { public: 0, org: 0, shared: 0, private: 0, unknown: 0 };
    for (const record of records) sharingSummary[record.access] += 1;

    const findings = records
      .filter((record) => record.stale === true)
      .map((record) => ({
        item_id: record.id,
        title: record.title,
        owner: record.owner,
        type: record.type,
        modified_at: record.modified_at,
        days_since_modified: record.days_since_modified as number,
      }))
      .sort(
        (a, b) => b.days_since_modified - a.days_since_modified || a.item_id.localeCompare(b.item_id, 'en'),
      );
    stalenessReport = {
      threshold_days: staleAfterDays,
      evaluated_at: retrievedAt,
      stale_item_count: findings.length,
      unknown_modified_count: records.filter((record) => record.stale === null).length,
      findings,
    };
    if (stalenessReport.unknown_modified_count > 0) {
      caveats.push(
        `${stalenessReport.unknown_modified_count} item(s) have no usable modification timestamp; staleness is unknown for them.`,
      );
    }
    if (items.truncated) {
      caveats.push(
        'Item retrieval was truncated; ownership, sharing, staleness, and service summaries cover only the retrieved records.',
      );
    }
  }

  const truncated = truncationReasons.length > 0;
  if (truncated) {
    caveats.push('One or more sections hit a record or page ceiling; totals reflect the retrieved subset.');
  }

  const report = OrgInventoryReportSchema.parse({
    schema_version: CAPABILITY_VERSION,
    portal: {
      url: root,
      org_id: input.org_id,
      name: optionalString(portalJson.name),
      url_key: optionalString(portalJson.urlKey),
      access: normalizeSharing(portalJson.access, 'portal access', warnings),
      created_at: normalizeEpochMs(portalJson.created, 'portal created', warnings),
      modified_at: normalizeEpochMs(portalJson.modified, 'portal modified', warnings),
    },
    retrieved_at: retrievedAt,
    parameters: {
      include: orderedInclude,
      stale_after_days: staleAfterDays,
      page_size: pageSize,
      max_records: maxRecords,
      item_owner: itemOwner,
    },
    caveats,
    users,
    groups,
    items,
    services,
    ownership_summary: ownershipSummary,
    sharing_summary: sharingSummary,
    staleness: stalenessReport,
    warnings,
    truncation: { truncated, reasons: truncationReasons },
  });

  const canonicalParameters = {
    portal_url: root,
    org_id: input.org_id,
    include: orderedInclude,
    stale_after_days: staleAfterDays,
    page_size: pageSize,
    max_records: maxRecords,
    item_owner: itemOwner,
  };
  const retrievedRecords =
    (users?.retrieved_count ?? 0) + (groups?.retrieved_count ?? 0) + (items?.retrieved_count ?? 0);
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.1.0',
    bundle_id: `inspect_arcgis_org:${portalSelf.evidence.sha256.slice(0, 16)}`,
    generated_at: retrievedAt,
    requests,
    source: {
      uri: portalSelf.evidence.url,
      identity: { kind: 'arcgis_org', value: input.org_id },
      version: {},
      retrieved_at: retrievedAt,
      sha256: portalSelf.evidence.sha256,
    },
    gis_metadata: {
      format: 'ArcGIS Portal REST JSON',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: retrievedRecords,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: {
      canonical_json: canonicalJson(canonicalParameters),
      sha256: sha256Canonical(canonicalParameters),
    },
    execution: {
      capability: 'inspect_arcgis_org',
      capability_version: CAPABILITY_VERSION,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'arcgis_org_inventory',
        sha256: sha256Canonical(report),
        validation: {
          valid: true,
          checks: ['input_schema', 'boundary_preflight', 'arcgis_envelope', 'pagination', 'output_schema'],
          warnings,
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });

  return InspectArcgisOrgOutputSchema.parse({
    schema_version: CAPABILITY_VERSION,
    report,
    evidence,
  });
}

export const inspectArcgisOrgCapability: CapabilityDefinition<
  InspectArcgisOrgInput,
  InspectArcgisOrgOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'inspect_arcgis_org',
    name: 'Inspect ArcGIS organization',
    description:
      'Read-only deterministic inventory of the users, groups, items, and service-backed items visible at an approved ArcGIS Online/Enterprise portal, with ownership, sharing, and staleness summaries.',
    version: CAPABILITY_VERSION,
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: ['*.maps.arcgis.com', '*.arcgis.com'],
    allowed_sources: ['arcgis_portal'],
    resource_limits: {
      max_records: MAX_RECORDS_PER_SECTION,
      max_bytes: MAX_TOTAL_BYTES,
      max_duration_ms: MAX_DURATION_MS,
      max_cost_usd: 0,
    },
    idempotency: {
      mode: 'deterministic',
      key_fields: ['portal_url', 'org_id', 'include', 'stale_after_days', 'page_size', 'max_records', 'item_owner'],
    },
    dry_run: { supported: false, reason: 'Read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_each_request' },
    artifacts: [{ name: 'arcgis_org_inventory', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: {
      suite: 'gisbench',
      version: '0.1.0',
      supported_gis_versions: ['ArcGIS Online Portal REST', 'ArcGIS Enterprise Portal REST 10.9+'],
    },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: InspectArcgisOrgInputSchema,
  outputSchema: InspectArcgisOrgOutputSchema,
  inputSummary: [
    'portal_url*',
    'org_id*',
    'include',
    'stale_after_days',
    'page_size',
    'max_records',
    'item_owner',
  ],
  boundaryFields: ['portal_url'],
  execute: executeInspectArcgisOrg,
};
