// Phase 1B native capability: deterministic, read-only ArcGIS dependency
// graph. Downstream traversal from validated root item IDs over the two
// portal-root item endpoints only (`/content/items/{id}` and
// `/content/items/{id}/data`), parsing a narrow allowlist of documented
// Web Mapping Application / Web Map JSON paths into a bounded in-memory
// graph. Item-provided service URLs are sanitized terminal references and
// are NEVER dispatched. Every remote value is untrusted data, never an
// instruction; no credential field exists in the input schema, and
// credential-bearing references are dropped before they can reach output,
// warnings, evidence, or errors. Traversal is canonical — roots, each
// breadth-first level, and parsed references are sorted before any ceiling
// applies — and nodes, edges, cycles, unresolved references, and warnings
// are canonically ordered, so the report, the output hash, AND the graph
// content selected under active node/edge/request ceilings are independent
// of root order, reference-array order, and object-key order. Request
// evidence records the actual dispatches in that canonical dispatch order.

import { z } from 'zod';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema } from '../contracts/evidence.js';
import type { BoundaryOptions } from '../security/boundary.js';
import {
  ArcGisRequestFailure,
  containsCredentialMaterial,
  fetchArcGisTransport,
  portalRoot,
  redactSecrets,
  requestArcGisJson,
  validatePortalUrl,
  type ArcGisRequestEvidence,
  type ArcGisRestTransport,
} from './arcgis-rest.js';

const CAPABILITY_VERSION = '1.0.0';

const MAX_ROOTS = 25;
const MAX_DEPTH_CEILING = 6;
const DEFAULT_MAX_DEPTH = 4;
const MAX_NODES_CEILING = 500;
const DEFAULT_MAX_NODES = 200;
const MAX_EDGES_CEILING = 1_000;
const DEFAULT_MAX_EDGES = 400;
const MAX_REQUESTS_CEILING = 1_000;
const DEFAULT_MAX_REQUESTS = 200;
const MAX_RESPONSE_BYTES_CEILING = 2_097_152;
const MAX_TOTAL_BYTES_CEILING = 8_388_608;
const MAX_DURATION_MS_CEILING = 30_000;
const MIN_DURATION_MS = 1_000;
const MIN_RESPONSE_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 10_000;

// Exactly two expandable item types are supported in this phase. Anything
// else — including service-backed item types — is a terminal item node.
const EXPANDABLE_ITEM_TYPES = new Set(['Web Mapping Application', 'Web Map']);

const ITEM_ID = /^[a-f0-9]{32}$/;
const RAW_ITEM_ID = /^[A-Fa-f0-9]{32}$/;
const CREDENTIAL_FIELD = /(?:token|api[_-]?key|password|secret|credential|authorization)/i;

export const TraceArcgisDependenciesInputSchema = z
  .object({
    portal_url: z.string().min(1).max(2_048),
    root_item_ids: z.array(z.string().regex(RAW_ITEM_ID)).min(1).max(MAX_ROOTS),
    max_depth: z.number().int().min(1).max(MAX_DEPTH_CEILING).optional(),
    max_nodes: z.number().int().min(1).max(MAX_NODES_CEILING).optional(),
    max_edges: z.number().int().min(1).max(MAX_EDGES_CEILING).optional(),
    max_requests: z.number().int().min(1).max(MAX_REQUESTS_CEILING).optional(),
    max_response_bytes: z.number().int().min(MIN_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES_CEILING).optional(),
    max_total_response_bytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_BYTES)
      .max(MAX_TOTAL_BYTES_CEILING)
      .optional(),
    max_duration_ms: z.number().int().min(MIN_DURATION_MS).max(MAX_DURATION_MS_CEILING).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const problem = validatePortalUrl(input.portal_url);
    if (problem) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['portal_url'], message: problem });
    }
    const normalized = input.root_item_ids.map((id) => id.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root_item_ids'],
        message: 'root_item_ids must be unique',
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

const SharingSchema = z.enum(['public', 'org', 'shared', 'private', 'unknown']);
const IsoDate = z.string().datetime({ offset: true });

// Service node IDs use the FULL SHA-256 of the sanitized URL — no truncated
// prefix — so two different sanitized URLs can never share a node identity.
const NodeIdSchema = z.string().regex(/^(item:[a-f0-9]{32}|service:[a-f0-9]{64})$/);
const SupportSchema = z.enum(['expandable', 'terminal', 'service_reference', 'missing', 'unfetched']);
const RelationshipSchema = z.enum(['web_map', 'operational_layer', 'table', 'basemap_layer']);
const LocatorSchema = z.enum([
  'map.itemId',
  'values.webmap',
  'operationalLayers[].itemId',
  'operationalLayers[].url',
  'tables[].itemId',
  'tables[].url',
  'baseMap.baseMapLayers[].itemId',
  'baseMap.baseMapLayers[].url',
]);
type Relationship = z.infer<typeof RelationshipSchema>;
type Locator = z.infer<typeof LocatorSchema>;

const GraphNodeSchema = z
  .object({
    id: NodeIdSchema,
    kind: z.enum(['item', 'service']),
    item_id: z.string().regex(ITEM_ID).nullable(),
    service_url: z.string().url().nullable(),
    type: z.string().nullable(),
    title: z.string().nullable(),
    owner: z.string().nullable(),
    access: SharingSchema,
    support: SupportSchema,
    expanded: z.boolean(),
    depth: z.number().int().nonnegative(),
    is_root: z.boolean(),
    impact: z
      .object({
        upstream_count: z.number().int().nonnegative(),
        downstream_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const GraphEdgeSchema = z
  .object({
    from: NodeIdSchema,
    to: NodeIdSchema,
    relationship: RelationshipSchema,
    locator: LocatorSchema,
  })
  .strict();

const UnresolvedReferenceSchema = z
  .object({
    from: NodeIdSchema,
    locator: LocatorSchema,
    kind: z.enum(['item_id', 'service_url']),
    reason: z.enum([
      'malformed_item_id',
      'unparseable_url',
      'unsupported_url_scheme',
      'credential_bearing_url',
    ]),
  })
  .strict();

const DependencyGraphReportSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    portal: z.object({ url: z.string().url() }).strict(),
    retrieved_at: IsoDate,
    parameters: z
      .object({
        root_item_ids: z.array(z.string().regex(ITEM_ID)).min(1),
        max_depth: z.number().int().positive(),
        max_nodes: z.number().int().positive(),
        max_edges: z.number().int().positive(),
        max_requests: z.number().int().positive(),
        max_response_bytes: z.number().int().positive(),
        max_total_response_bytes: z.number().int().positive(),
        max_duration_ms: z.number().int().positive(),
      })
      .strict(),
    roots: z.array(NodeIdSchema),
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    cycles: z.array(z.array(NodeIdSchema).min(1)),
    unresolved_references: z.array(UnresolvedReferenceSchema),
    totals: z
      .object({
        node_count: z.number().int().nonnegative(),
        edge_count: z.number().int().nonnegative(),
        item_node_count: z.number().int().nonnegative(),
        service_node_count: z.number().int().nonnegative(),
        request_count: z.number().int().nonnegative(),
      })
      .strict(),
    truncation: z.object({ truncated: z.boolean(), reasons: z.array(z.string()) }).strict(),
    caveats: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export const TraceArcgisDependenciesOutputSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_VERSION),
    report: DependencyGraphReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type TraceArcgisDependenciesInput = z.infer<typeof TraceArcgisDependenciesInputSchema>;
export type TraceArcgisDependenciesOutput = z.infer<typeof TraceArcgisDependenciesOutputSchema>;
type Sharing = z.infer<typeof SharingSchema>;
type GraphNode = z.infer<typeof GraphNodeSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const MAX_METADATA_CHARS = 300;

/** Untrusted item metadata strings (type/title/owner) are redacted and
 * length-capped before they can reach output, evidence, warnings, or errors.
 * Legitimate ArcGIS type names contain no credential pairs and pass through
 * unchanged, so type classification still works on the sanitized value. */
function sanitizeMetadataString(value: unknown): string | null {
  const raw = optionalString(value);
  if (raw === null) return null;
  const redacted = redactSecrets(raw);
  return redacted.length > MAX_METADATA_CHARS ? `${redacted.slice(0, MAX_METADATA_CHARS)}…` : redacted;
}

/** ArcGIS access values → sharing labels; anything else is 'unknown', never invented. */
function normalizeSharing(value: unknown, label: string, warn: (message: string) => void): Sharing {
  if (value === 'public' || value === 'org' || value === 'shared' || value === 'private') return value;
  if (value !== undefined && value !== null) {
    warn(`${label}: unrecognized sharing value was labelled 'unknown'`);
  }
  return 'unknown';
}

// Tolerated per-item failures: an ArcGIS error envelope (any code) or an HTTP
// 4xx on one item marks that node missing/unavailable instead of failing the
// whole trace. Everything else (boundary violations, redirects, byte limits,
// unexpected content types, malformed JSON, 5xx, timeouts) still fails the
// run closed. The typed ArcGisRequestFailure carries the received response's
// evidence, so even tolerated failures are byte-accounted and recorded.
function isItemLevelFailure(error: unknown): error is ArcGisRequestFailure {
  return (
    error instanceof ArcGisRequestFailure &&
    (error.kind === 'error_envelope' ||
      (error.kind === 'http_error' && error.status >= 400 && error.status < 500))
  );
}

interface MutableNode {
  id: string;
  kind: 'item' | 'service';
  itemId: string | null;
  serviceUrl: string | null;
  type: string | null;
  title: string | null;
  owner: string | null;
  access: Sharing;
  support: z.infer<typeof SupportSchema>;
  expanded: boolean;
  depth: number;
  isRoot: boolean;
}

type ParsedReference =
  | { kind: 'item'; itemId: string; relationship: Relationship; locator: Locator }
  | { kind: 'service'; url: string; relationship: Relationship; locator: Locator };

/** Total order over parsed references so ceiling selection is canonical. */
function referenceSortKey(ref: ParsedReference): string {
  return ref.kind === 'item'
    ? `item ${ref.itemId} ${ref.relationship} ${ref.locator}`
    : `service ${ref.url} ${ref.relationship} ${ref.locator}`;
}

interface ReferenceSink {
  refs: ParsedReference[];
  unresolved(locator: Locator, kind: 'item_id' | 'service_url', reason: z.infer<typeof UnresolvedReferenceSchema>['reason']): void;
  warn(message: string): void;
}

function acceptItemReference(
  value: unknown,
  relationship: Relationship,
  locator: Locator,
  itemLabel: string,
  sink: ReferenceSink,
): void {
  if (typeof value === 'string' && RAW_ITEM_ID.test(value)) {
    sink.refs.push({ kind: 'item', itemId: value.toLowerCase(), relationship, locator });
    return;
  }
  // The raw value is untrusted and may embed anything; it never appears in
  // warnings, unresolved records, or errors.
  sink.unresolved(locator, 'item_id', 'malformed_item_id');
  sink.warn(`item '${itemLabel}': malformed item id reference at ${locator} was ignored`);
}

const MAX_PATH_DECODE_PASSES = 3;

/** Bounded stable-point pathname decoding with a credential check after
 * EVERY pass, so multi-encoded assignments (`token%253D…` → `token%3D…` →
 * `token=…`) cannot hide behind one level of encoding. Malformed percent
 * encoding or nesting deeper than the explicit ceiling fails closed; the raw
 * value is never echoed. */
function classifyServicePath(pathname: string): 'credential' | 'malformed' | 'nested' | null {
  let current = pathname;
  if (containsCredentialMaterial(current)) return 'credential';
  for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return 'malformed';
    }
    if (containsCredentialMaterial(decoded)) return 'credential';
    if (decoded === current) return null; // stable — fully decoded and clean
    current = decoded;
  }
  return 'nested'; // still changing after the ceiling — refuse to trust it
}

/** Sanitize an item-provided service URL into a terminal reference: https/http
 * only, no userinfo, query and fragment dropped. The URL is never dispatched. */
function acceptServiceReference(
  value: unknown,
  relationship: Relationship,
  locator: Locator,
  itemLabel: string,
  sink: ReferenceSink,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    sink.unresolved(locator, 'service_url', 'unparseable_url');
    sink.warn(`item '${itemLabel}': unparseable service URL at ${locator} was ignored`);
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    sink.unresolved(locator, 'service_url', 'unparseable_url');
    sink.warn(`item '${itemLabel}': unparseable service URL at ${locator} was ignored`);
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    sink.unresolved(locator, 'service_url', 'unsupported_url_scheme');
    sink.warn(`item '${itemLabel}': non-HTTP service URL at ${locator} was ignored`);
    return;
  }
  if (url.username || url.password) {
    sink.unresolved(locator, 'service_url', 'credential_bearing_url');
    sink.warn(`item '${itemLabel}': credential-bearing service URL at ${locator} was removed`);
    return;
  }
  // Credential-shaped material can also be smuggled inside the PATH itself
  // ('/token=…/FeatureServer' or narrow '/apikey/{value}' pairs, singly or
  // multiply percent-encoded), where query stripping cannot reach it. Decode
  // to a stable point (bounded) and check after every pass; never echo values.
  const pathVerdict = classifyServicePath(url.pathname);
  if (pathVerdict === 'credential') {
    sink.unresolved(locator, 'service_url', 'credential_bearing_url');
    sink.warn(`item '${itemLabel}': credential-bearing service URL at ${locator} was removed`);
    return;
  }
  if (pathVerdict !== null) {
    sink.unresolved(locator, 'service_url', 'unparseable_url');
    sink.warn(
      pathVerdict === 'nested'
        ? `item '${itemLabel}': service URL with excessive encoding nesting at ${locator} was ignored`
        : `item '${itemLabel}': unparseable service URL at ${locator} was ignored`,
    );
    return;
  }
  if (url.search || url.hash) {
    // Dropping the whole query guarantees no secret parameter survives
    // regardless of its name; service roots never need one.
    url.search = '';
    url.hash = '';
    sink.warn(`item '${itemLabel}': service URL query/fragment at ${locator} was removed`);
  }
  sink.refs.push({ kind: 'service', url: url.href, relationship, locator });
}

/** Web Mapping Application item data: only the documented web map item-ID
 * fields `map.itemId` and `values.webmap` (string or array of strings). */
function parseWebMappingApplicationData(
  data: Record<string, unknown>,
  itemLabel: string,
  sink: ReferenceSink,
): void {
  let found = false;
  const map = data.map;
  if (isPlainObject(map) && map.itemId !== undefined) {
    found = true;
    acceptItemReference(map.itemId, 'web_map', 'map.itemId', itemLabel, sink);
  }
  const values = data.values;
  if (isPlainObject(values) && values.webmap !== undefined) {
    const webmap = values.webmap;
    const candidates = Array.isArray(webmap) ? webmap : [webmap];
    for (const candidate of candidates) {
      found = true;
      acceptItemReference(candidate, 'web_map', 'values.webmap', itemLabel, sink);
    }
    if (Array.isArray(webmap) && webmap.length === 0) {
      sink.warn(`item '${itemLabel}': values.webmap is an empty array`);
    }
  }
  if (!found) {
    sink.warn(`item '${itemLabel}': no supported web map reference found in application data`);
  }
}

interface WebMapSection {
  layers: unknown;
  relationship: Relationship;
  itemLocator: Locator;
  urlLocator: Locator;
  label: string;
}

/** Web Map item data: only `operationalLayers[]`, `tables[]`, and
 * `baseMap.baseMapLayers[]` entries' `itemId`/`url` fields. */
function parseWebMapData(data: Record<string, unknown>, itemLabel: string, sink: ReferenceSink): void {
  const baseMap = data.baseMap;
  const sections: WebMapSection[] = [
    {
      layers: data.operationalLayers,
      relationship: 'operational_layer',
      itemLocator: 'operationalLayers[].itemId',
      urlLocator: 'operationalLayers[].url',
      label: 'operationalLayers',
    },
    {
      layers: data.tables,
      relationship: 'table',
      itemLocator: 'tables[].itemId',
      urlLocator: 'tables[].url',
      label: 'tables',
    },
    {
      layers: isPlainObject(baseMap) ? baseMap.baseMapLayers : undefined,
      relationship: 'basemap_layer',
      itemLocator: 'baseMap.baseMapLayers[].itemId',
      urlLocator: 'baseMap.baseMapLayers[].url',
      label: 'baseMap.baseMapLayers',
    },
  ];
  if (baseMap !== undefined && !isPlainObject(baseMap)) {
    sink.warn(`item '${itemLabel}': baseMap is not an object; ignored`);
  }
  for (const section of sections) {
    if (section.layers === undefined) continue;
    if (!Array.isArray(section.layers)) {
      sink.warn(`item '${itemLabel}': ${section.label} is not an array; ignored`);
      continue;
    }
    for (const entry of section.layers) {
      if (!isPlainObject(entry)) {
        sink.warn(`item '${itemLabel}': a ${section.label} entry is not an object; ignored`);
        continue;
      }
      if (entry.itemId !== undefined) {
        acceptItemReference(entry.itemId, section.relationship, section.itemLocator, itemLabel, sink);
      }
      if (entry.url !== undefined) {
        acceptServiceReference(entry.url, section.relationship, section.urlLocator, itemLabel, sink);
      }
    }
  }
}

interface TraceBudget {
  deadline: number;
  bytesUsed: number;
  requestCount: number;
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxDurationMs: number;
}

function requestTimeoutMs(budget: TraceBudget): number {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`trace_arcgis_dependencies exceeded the ${budget.maxDurationMs}ms duration ceiling`);
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function requestMaxBytes(budget: TraceBudget): number {
  const remaining = budget.maxTotalBytes - budget.bytesUsed;
  if (remaining <= 0) {
    throw new Error(
      `trace_arcgis_dependencies exceeded the ${budget.maxTotalBytes}-byte total response ceiling`,
    );
  }
  return Math.min(budget.maxResponseBytes, remaining);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Iterative Tarjan strongly connected components over the item/service graph. */
function stronglyConnectedComponents(
  nodeIds: string[],
  successors: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of nodeIds) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; iterator: Iterator<string> }> = [];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    work.push({ node: start, iterator: (successors.get(start) ?? new Set<string>()).values() });
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const next = frame.iterator.next();
      if (!next.done) {
        const child = next.value;
        if (!index.has(child)) {
          index.set(child, counter);
          lowlink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, iterator: (successors.get(child) ?? new Set<string>()).values() });
        } else if (onStack.has(child)) {
          frame && lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

function reachableCount(start: string, successors: Map<string, Set<string>>): number {
  const seen = new Set<string>();
  const queue = [...(successors.get(start) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of successors.get(node) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  seen.delete(start);
  return seen.size;
}

async function executeTraceArcgisDependencies(
  input: TraceArcgisDependenciesInput,
  context: CapabilityExecutionContext,
): Promise<TraceArcgisDependenciesOutput> {
  if (context.signal?.aborted) throw new Error('trace_arcgis_dependencies cancelled before retrieval');
  const now = context.now ?? (() => new Date());
  const retrievedAt = now().toISOString();

  const maxDepth = input.max_depth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = input.max_nodes ?? DEFAULT_MAX_NODES;
  const maxEdges = input.max_edges ?? DEFAULT_MAX_EDGES;
  const budget: TraceBudget = {
    deadline: Date.now() + (input.max_duration_ms ?? MAX_DURATION_MS_CEILING),
    bytesUsed: 0,
    requestCount: 0,
    maxRequests: input.max_requests ?? DEFAULT_MAX_REQUESTS,
    maxResponseBytes: input.max_response_bytes ?? MAX_RESPONSE_BYTES_CEILING,
    maxTotalBytes: input.max_total_response_bytes ?? MAX_TOTAL_BYTES_CEILING,
    maxDurationMs: input.max_duration_ms ?? MAX_DURATION_MS_CEILING,
  };

  const root = portalRoot(input.portal_url);
  const restBase = `${root}/sharing/rest`;
  const transport = (context.io?.arcgisTransport as ArcGisRestTransport | undefined) ?? fetchArcGisTransport;
  const boundary: BoundaryOptions = context.boundary ?? {};

  // Traversal itself is canonical: roots, every breadth-first level, and
  // parsed references are sorted BEFORE any node/edge/request ceiling is
  // applied, so ceiling-selected graph content — and the resulting dispatch
  // order recorded in evidence — is independent of input root order and
  // remote reference-array order.
  const canonicalRootIds = [...new Set(input.root_item_ids.map((raw) => raw.toLowerCase()))].sort(
    compareStrings,
  );

  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, z.infer<typeof GraphEdgeSchema>>();
  const unresolved = new Map<string, z.infer<typeof UnresolvedReferenceSchema>>();
  const warnings = new Set<string>();
  const truncationReasons = new Set<string>();
  const requests: ArcGisRequestEvidence[] = [];

  const ensureItemNode = (itemId: string, depth: number, isRoot: boolean): MutableNode | null => {
    const nodeId = `item:${itemId}`;
    const existing = nodes.get(nodeId);
    if (existing) return existing;
    if (nodes.size >= maxNodes) {
      truncationReasons.add(`node ceiling: stopped adding nodes at the ${maxNodes}-node ceiling`);
      return null;
    }
    const node: MutableNode = {
      id: nodeId,
      kind: 'item',
      itemId,
      serviceUrl: null,
      type: null,
      title: null,
      owner: null,
      access: 'unknown',
      support: 'unfetched',
      expanded: false,
      depth,
      isRoot,
    };
    nodes.set(nodeId, node);
    return node;
  };

  const serviceNodeId = (sanitizedUrl: string): string => `service:${sha256Text(sanitizedUrl)}`;

  const ensureServiceNode = (sanitizedUrl: string): MutableNode | null => {
    const nodeId = serviceNodeId(sanitizedUrl);
    const existing = nodes.get(nodeId);
    if (existing) {
      // Full-SHA-256 identities cannot collide in practice; if one ever did,
      // merging two different URLs would silently corrupt the graph, so fail
      // closed instead.
      if (existing.serviceUrl !== sanitizedUrl) {
        throw new Error(
          'service node identity collision: two different sanitized service URLs produced the same node id',
        );
      }
      return existing;
    }
    if (nodes.size >= maxNodes) {
      truncationReasons.add(`node ceiling: stopped adding nodes at the ${maxNodes}-node ceiling`);
      return null;
    }
    const node: MutableNode = {
      id: nodeId,
      kind: 'service',
      itemId: null,
      serviceUrl: sanitizedUrl,
      type: null,
      title: null,
      owner: null,
      access: 'unknown',
      support: 'service_reference',
      expanded: false,
      depth: 0, // set on first edge below
      isRoot: false,
    };
    nodes.set(nodeId, node);
    return node;
  };

  const addEdge = (
    from: string,
    to: string,
    relationship: Relationship,
    locator: Locator,
  ): boolean => {
    const key = `${from}\u0000${to}\u0000${relationship}\u0000${locator}`;
    if (edges.has(key)) return true; // duplicate references collapse canonically
    if (edges.size >= maxEdges) {
      truncationReasons.add(`edge ceiling: stopped adding edges at the ${maxEdges}-edge ceiling`);
      return false;
    }
    edges.set(key, { from, to, relationship, locator });
    return true;
  };

  const itemUrl = (itemId: string, dataSuffix: boolean): URL => {
    // Only validated portal root + validated 32-hex item id ever reach the
    // transport; item-provided URLs are never dispatched.
    const url = new URL(`${restBase}/content/items/${itemId}${dataSuffix ? '/data' : ''}`);
    url.searchParams.set('f', 'json');
    return url;
  };

  let successfulRequests = 0;
  const traceRequest = async (name: string, url: URL) => {
    budget.requestCount += 1; // dispatched attempts count against the ceiling
    try {
      const result = await requestArcGisJson({
        name,
        url,
        transport,
        boundary,
        timeoutMs: requestTimeoutMs(budget),
        maxBytes: requestMaxBytes(budget),
        signal: context.signal,
      });
      budget.bytesUsed += result.evidence.bytes;
      requests.push(result.evidence);
      successfulRequests += 1;
      return result;
    } catch (error) {
      if (error instanceof ArcGisRequestFailure) {
        // A response WAS received: its bytes count against the total ceiling
        // and its sanitized evidence is recorded in dispatch order — exactly
        // once — whether or not the failure is tolerated by the caller.
        budget.bytesUsed += error.evidence.bytes;
        requests.push(error.evidence);
      }
      throw error;
    }
  };

  // Level-order traversal: depth is the minimum distance from any root, so
  // node depths and expansion decisions are independent of root order.
  let level: MutableNode[] = [];
  for (const id of canonicalRootIds) {
    const node = ensureItemNode(id, 0, true);
    if (node) level.push(node);
  }
  let depth = 0;
  while (level.length > 0) {
    // Canonical processing order within every level, before request ceilings.
    level.sort((a, b) => compareStrings(a.id, b.id));
    const next: MutableNode[] = [];
    for (const node of level) {
      if (context.signal?.aborted) {
        throw new Error('trace_arcgis_dependencies cancelled during traversal');
      }
      const itemId = node.itemId!;
      if (budget.requestCount >= budget.maxRequests) {
        truncationReasons.add(
          `request ceiling: stopped dispatching at the ${budget.maxRequests}-request ceiling`,
        );
        continue; // node stays 'unfetched'
      }
      let metadata: Record<string, unknown>;
      try {
        metadata = (await traceRequest(`item_meta:${itemId}`, itemUrl(itemId, false))).json;
      } catch (error) {
        if (!isItemLevelFailure(error)) throw error;
        node.support = 'missing';
        warnings.add(`item '${itemId}': item metadata was unavailable; node marked missing`);
        continue;
      }
      const echoedId = optionalString(metadata.id);
      if (echoedId !== null && echoedId.toLowerCase() !== itemId) {
        throw new Error(
          `arcgis item identity mismatch: requested item '${itemId}' but the portal reported a different id`,
        );
      }
      if (echoedId === null) {
        warnings.add(`item '${itemId}': metadata response did not echo the item id`);
      }
      node.type = sanitizeMetadataString(metadata.type);
      node.title = sanitizeMetadataString(metadata.title);
      node.owner = sanitizeMetadataString(metadata.owner);
      node.access = normalizeSharing(metadata.access, `item '${itemId}' access`, (message) =>
        warnings.add(message),
      );
      const expandable = node.type !== null && EXPANDABLE_ITEM_TYPES.has(node.type);
      node.support = expandable ? 'expandable' : 'terminal';
      if (!expandable) continue;
      if (depth >= maxDepth) {
        truncationReasons.add(
          `depth ceiling: item '${itemId}' at depth ${depth} was not expanded (max_depth ${maxDepth})`,
        );
        continue;
      }
      if (budget.requestCount >= budget.maxRequests) {
        truncationReasons.add(
          `request ceiling: stopped dispatching at the ${budget.maxRequests}-request ceiling`,
        );
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = (await traceRequest(`item_data:${itemId}`, itemUrl(itemId, true))).json;
      } catch (error) {
        if (!isItemLevelFailure(error)) throw error;
        warnings.add(`item '${itemId}': item data was unavailable; references were not traversed`);
        continue;
      }
      const sink: ReferenceSink = {
        refs: [],
        unresolved: (locator, kind, reason) => {
          const record = { from: node.id, locator, kind, reason };
          unresolved.set(`${node.id}\u0000${locator}\u0000${kind}\u0000${reason}`, record);
        },
        warn: (message) => warnings.add(message),
      };
      if (node.type === 'Web Mapping Application') {
        parseWebMappingApplicationData(data, itemId, sink);
      } else {
        parseWebMapData(data, itemId, sink);
      }
      node.expanded = true;
      // Canonical reference order BEFORE node/edge ceilings: when a ceiling
      // binds, the surviving nodes/edges are the canonically smallest, not
      // whichever the remote array order listed first.
      sink.refs.sort((a, b) => compareStrings(referenceSortKey(a), referenceSortKey(b)));
      for (const ref of sink.refs) {
        if (ref.kind === 'item') {
          const targetId = `item:${ref.itemId}`;
          const existing = nodes.get(targetId);
          if (!existing && edges.size >= maxEdges) {
            // A node that cannot be connected is not added.
            truncationReasons.add(`edge ceiling: stopped adding edges at the ${maxEdges}-edge ceiling`);
            continue;
          }
          const target = existing ?? ensureItemNode(ref.itemId, depth + 1, false);
          if (!target) continue; // node ceiling
          if (addEdge(node.id, target.id, ref.relationship, ref.locator) && !existing) {
            next.push(target);
          }
        } else {
          const targetId = serviceNodeId(ref.url);
          const existing = nodes.get(targetId);
          if (!existing && edges.size >= maxEdges) {
            truncationReasons.add(`edge ceiling: stopped adding edges at the ${maxEdges}-edge ceiling`);
            continue;
          }
          const target = existing ?? ensureServiceNode(ref.url);
          if (!target) continue;
          if (!existing) target.depth = depth + 1;
          addEdge(node.id, target.id, ref.relationship, ref.locator);
        }
      }
    }
    level = next;
    depth += 1;
  }

  if (successfulRequests === 0 || requests.length === 0) {
    throw new Error('trace_arcgis_dependencies: no ArcGIS request succeeded for any root item');
  }

  // Canonical graph: nodes by id, edges by (from, to, relationship, locator),
  // unresolved references and warnings sorted and deduplicated.
  const sortedNodes = [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
  const sortedEdges = [...edges.values()].sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.relationship, b.relationship) ||
      compareStrings(a.locator, b.locator),
  );
  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const edge of sortedEdges) {
    if (!successors.has(edge.from)) successors.set(edge.from, new Set());
    successors.get(edge.from)!.add(edge.to);
    if (!predecessors.has(edge.to)) predecessors.set(edge.to, new Set());
    predecessors.get(edge.to)!.add(edge.from);
  }

  const nodeIds = sortedNodes.map((node) => node.id);
  const cycles = stronglyConnectedComponents(nodeIds, successors)
    .filter(
      (component) =>
        component.length > 1 ||
        (component.length === 1 && successors.get(component[0])?.has(component[0]) === true),
    )
    .map((component) => [...component].sort(compareStrings))
    .sort((a, b) => compareStrings(a.join(','), b.join(',')));

  const reportNodes: GraphNode[] = sortedNodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    item_id: node.itemId,
    service_url: node.serviceUrl,
    type: node.type,
    title: node.title,
    owner: node.owner,
    access: node.access,
    support: node.support,
    expanded: node.expanded,
    depth: node.depth,
    is_root: node.isRoot,
    impact: {
      upstream_count: reachableCount(node.id, predecessors),
      downstream_count: reachableCount(node.id, successors),
    },
  }));

  const sortedUnresolved = [...unresolved.values()].sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.locator, b.locator) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.reason, b.reason),
  );
  const sortedWarnings = [...warnings].sort(compareStrings);
  const sortedTruncationReasons = [...truncationReasons].sort(compareStrings);
  const truncated = sortedTruncationReasons.length > 0;

  const caveats = [
    'The graph covers only content visible to the configured identity at the approved portal; it is not proof of a complete dependency inventory.',
    'Only explicitly supported Web Mapping Application and Web Map JSON paths are traversed; references outside those paths are not discovered.',
    'Service URLs are sanitized terminal references; the services themselves were never contacted or verified.',
  ];
  if (truncated) {
    caveats.push('One or more traversal ceilings were reached; the graph reflects the retrieved subset only.');
  }
  if (reportNodes.some((node) => node.support === 'missing') || sortedUnresolved.length > 0) {
    caveats.push('Missing or unresolved references mean downstream impact counts may understate real dependencies.');
  }

  const rootNodeIds = canonicalRootIds
    .map((id) => `item:${id}`)
    .filter((nodeId) => nodes.has(nodeId));

  const report = DependencyGraphReportSchema.parse({
    schema_version: CAPABILITY_VERSION,
    portal: { url: root },
    retrieved_at: retrievedAt,
    parameters: {
      root_item_ids: canonicalRootIds,
      max_depth: maxDepth,
      max_nodes: maxNodes,
      max_edges: maxEdges,
      max_requests: budget.maxRequests,
      max_response_bytes: budget.maxResponseBytes,
      max_total_response_bytes: budget.maxTotalBytes,
      max_duration_ms: budget.maxDurationMs,
    },
    roots: rootNodeIds,
    nodes: reportNodes,
    edges: sortedEdges,
    cycles,
    unresolved_references: sortedUnresolved,
    totals: {
      node_count: reportNodes.length,
      edge_count: sortedEdges.length,
      item_node_count: reportNodes.filter((node) => node.kind === 'item').length,
      service_node_count: reportNodes.filter((node) => node.kind === 'service').length,
      request_count: budget.requestCount,
    },
    truncation: { truncated, reasons: sortedTruncationReasons },
    caveats,
    warnings: sortedWarnings,
  });

  const canonicalParameters = {
    portal_url: root,
    root_item_ids: canonicalRootIds,
    max_depth: maxDepth,
    max_nodes: maxNodes,
    max_edges: maxEdges,
    max_requests: budget.maxRequests,
    max_response_bytes: budget.maxResponseBytes,
    max_total_response_bytes: budget.maxTotalBytes,
    max_duration_ms: budget.maxDurationMs,
  };
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.1.0',
    bundle_id: `trace_arcgis_dependencies:${requests[0].sha256.slice(0, 16)}`,
    generated_at: retrievedAt,
    requests,
    source: {
      uri: requests[0].url,
      identity: { kind: 'arcgis_dependency_roots', value: canonicalRootIds.join(',') },
      version: {},
      retrieved_at: retrievedAt,
      sha256: requests[0].sha256,
    },
    gis_metadata: {
      format: 'ArcGIS Portal REST JSON',
      crs: null,
      axis_order: null,
      units: null,
      extent: null,
      schema: [],
      row_count: reportNodes.length,
      geometry_types: [],
      temporal_fields: [],
    },
    parameters: {
      canonical_json: canonicalJson(canonicalParameters),
      sha256: sha256Canonical(canonicalParameters),
    },
    execution: {
      capability: 'trace_arcgis_dependencies',
      capability_version: CAPABILITY_VERSION,
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'arcgis_dependency_graph',
        sha256: sha256Canonical(report),
        validation: {
          valid: true,
          checks: [
            'input_schema',
            'boundary_preflight',
            'arcgis_envelope',
            'graph_ceilings',
            'canonical_ordering',
            'output_schema',
          ],
          warnings: sortedWarnings,
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });

  return TraceArcgisDependenciesOutputSchema.parse({
    schema_version: CAPABILITY_VERSION,
    report,
    evidence,
  });
}

export const traceArcgisDependenciesCapability: CapabilityDefinition<
  TraceArcgisDependenciesInput,
  TraceArcgisDependenciesOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'trace_arcgis_dependencies',
    name: 'Trace ArcGIS dependencies',
    description:
      'Read-only deterministic downstream dependency graph from approved ArcGIS portal items: Web Mapping Application → Web Map → item/service references over explicitly supported JSON paths, with cycles, unresolved references, impact summaries, and honest truncation.',
    version: CAPABILITY_VERSION,
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: ['*.maps.arcgis.com', '*.arcgis.com'],
    allowed_sources: ['arcgis_portal'],
    resource_limits: {
      // Honest output ceiling: at most max_nodes nodes plus max_edges edges.
      max_records: MAX_NODES_CEILING + MAX_EDGES_CEILING,
      max_bytes: MAX_TOTAL_BYTES_CEILING,
      max_duration_ms: MAX_DURATION_MS_CEILING,
      max_cost_usd: 0,
    },
    idempotency: {
      mode: 'deterministic',
      key_fields: [
        'portal_url',
        'root_item_ids',
        'max_depth',
        'max_nodes',
        'max_edges',
        'max_requests',
        'max_response_bytes',
        'max_total_response_bytes',
        'max_duration_ms',
      ],
    },
    dry_run: { supported: false, reason: 'Read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_each_request' },
    artifacts: [{ name: 'arcgis_dependency_graph', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: {
      suite: 'gisbench',
      version: '0.1.0',
      supported_gis_versions: ['ArcGIS Online Portal REST', 'ArcGIS Enterprise Portal REST 10.9+'],
    },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: TraceArcgisDependenciesInputSchema,
  outputSchema: TraceArcgisDependenciesOutputSchema,
  inputSummary: [
    'portal_url*',
    'root_item_ids*',
    'max_depth',
    'max_nodes',
    'max_edges',
    'max_requests',
    'max_response_bytes',
    'max_total_response_bytes',
    'max_duration_ms',
  ],
  boundaryFields: ['portal_url'],
  execute: executeTraceArcgisDependencies,
};
