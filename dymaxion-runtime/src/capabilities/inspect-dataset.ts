import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema, GisMetadataSchema, type GisMetadata } from '../contracts/evidence.js';
import { canonicalBoundaryPath } from '../security/boundary.js';

const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 10_000;

export const InspectDatasetInputSchema = z
  .object({
    source_uri: z.string().min(1),
    max_bytes: z.number().int().positive().max(MAX_BYTES).optional(),
  })
  .strict();

const DatasetPassportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    source_uri: z.string().min(1),
    source_handle: z.string().min(1),
    retrieved_at: z.string().datetime({ offset: true }),
    file_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    file_size_bytes: z.number().int().nonnegative(),
    format: z.literal('GeoJSON'),
    crs: z.string().min(1).nullable(),
    axis_order: z.string().min(1).nullable(),
    units: z.string().min(1).nullable(),
    extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    schema: GisMetadataSchema.shape.schema,
    feature_count: z.number().int().nonnegative(),
    geometry_types: z.array(z.string().min(1)),
    temporal_fields: GisMetadataSchema.shape.temporal_fields,
    warnings: z.array(z.string()),
  })
  .strict();

export const InspectDatasetOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    passport: DatasetPassportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type InspectDatasetInput = z.infer<typeof InspectDatasetInputSchema>;
export type InspectDatasetOutput = z.infer<typeof InspectDatasetOutputSchema>;

type FileStat = { size: number; mtime: Date };
type InspectIo = {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function inspectFields(features: JsonObject[]): GisMetadata['schema'] {
  const names = new Set<string>();
  for (const feature of features) {
    const properties = feature.properties;
    if (isObject(properties)) Object.keys(properties).forEach((name) => names.add(name));
  }
  return [...names]
    .sort()
    .map((name) => {
      const types = new Set<string>();
      let nullable = false;
      for (const feature of features) {
        const properties = isObject(feature.properties) ? feature.properties : {};
        if (!(name in properties) || properties[name] === null) nullable = true;
        else types.add(valueType(properties[name]));
      }
      return { name, types: [...types].sort(), nullable };
    });
}

function inspectTemporalFields(features: JsonObject[]): GisMetadata['temporal_fields'] {
  const candidates = inspectFields(features)
    .map((field) => field.name)
    .filter((name) => /(?:date|time|timestamp|_at)$/i.test(name));
  return candidates.flatMap((name) => {
    const parsed = features.flatMap((feature) => {
      const properties = isObject(feature.properties) ? feature.properties : {};
      const value = properties[name];
      if (typeof value !== 'string') return [];
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) ? [milliseconds] : [];
    });
    if (!parsed.length) return [];
    return [
      {
        name,
        min: new Date(Math.min(...parsed)).toISOString(),
        max: new Date(Math.max(...parsed)).toISOString(),
        parsed_count: parsed.length,
      },
    ];
  });
}

function inspectGeometries(features: JsonObject[]): {
  geometryTypes: string[];
  extent: [number, number, number, number] | null;
  nullGeometries: number;
} {
  const geometryTypes = new Set<string>();
  let nullGeometries = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const coordinates = (value: unknown): void => {
    if (!Array.isArray(value)) throw new Error('malformed GeoJSON: coordinates must be arrays');
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
        throw new Error('malformed GeoJSON: coordinate values must be finite');
      }
      minX = Math.min(minX, value[0]);
      minY = Math.min(minY, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    for (const item of value) coordinates(item);
  };

  const geometry = (value: unknown): void => {
    if (value === null) {
      nullGeometries += 1;
      return;
    }
    if (!isObject(value) || typeof value.type !== 'string') {
      throw new Error('malformed GeoJSON: every geometry must have a type');
    }
    const supported = new Set([
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
    ]);
    if (!supported.has(value.type)) throw new Error(`malformed GeoJSON: unsupported geometry type '${value.type}'`);
    geometryTypes.add(value.type);
    if (value.type === 'GeometryCollection') {
      if (!Array.isArray(value.geometries)) throw new Error('malformed GeoJSON: geometries must be an array');
      value.geometries.forEach(geometry);
    } else {
      coordinates(value.coordinates);
    }
  };

  for (const feature of features) geometry(feature.geometry);
  return {
    geometryTypes: [...geometryTypes].sort(),
    extent: Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null,
    nullGeometries,
  };
}

function crsMetadata(collection: JsonObject): {
  crs: string | null;
  axisOrder: string | null;
  units: string | null;
  warning?: string;
} {
  if (!('crs' in collection)) {
    return { crs: 'OGC:CRS84', axisOrder: 'longitude,latitude', units: 'degrees' };
  }
  const crs = collection.crs;
  const properties = isObject(crs) && isObject(crs.properties) ? crs.properties : null;
  const name = properties && typeof properties.name === 'string' ? properties.name : null;
  return {
    crs: name,
    axisOrder: null,
    units: null,
    warning: 'GeoJSON crs member is deprecated by RFC 7946; axis order and units were not inferred.',
  };
}

async function executeInspectDataset(
  input: InspectDatasetInput,
  context: CapabilityExecutionContext,
): Promise<InspectDatasetOutput> {
  if (context.signal?.aborted) throw new Error('inspect_dataset cancelled before file read');
  const path = canonicalBoundaryPath(input.source_uri);
  if (extname(path).toLowerCase() !== '.geojson') {
    throw new Error(`unsupported dataset format '${extname(path) || '(none)'}'; Phase 0 supports .geojson only`);
  }
  const io = context.io as InspectIo | undefined;
  if (!io?.stat || !io.readFile) throw new Error('inspect_dataset filesystem adapter unavailable');
  const limit = input.max_bytes ?? MAX_BYTES;
  const fileStat = await io.stat(path);
  if (fileStat.size > limit) {
    throw new Error(`inspect_dataset resource limit exceeded: ${fileStat.size} bytes > ${limit} bytes`);
  }
  const bytes = await io.readFile(path);
  if (bytes.byteLength > limit) {
    throw new Error(`inspect_dataset resource limit exceeded while reading: ${bytes.byteLength} bytes > ${limit} bytes`);
  }
  if (context.signal?.aborted) throw new Error('inspect_dataset cancelled after file read');

  let collection: unknown;
  try {
    collection = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('malformed GeoJSON: invalid JSON syntax');
  }
  if (!isObject(collection) || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('malformed GeoJSON: root must be a FeatureCollection with a features array');
  }
  if (collection.features.length > MAX_RECORDS) {
    throw new Error(`inspect_dataset resource limit exceeded: ${collection.features.length} features > ${MAX_RECORDS}`);
  }
  const features = collection.features.map((feature, index) => {
    if (!isObject(feature) || feature.type !== 'Feature') {
      throw new Error(`malformed GeoJSON: feature ${index} is not a Feature`);
    }
    if (feature.properties !== null && !isObject(feature.properties)) {
      throw new Error(`malformed GeoJSON: feature ${index} properties must be an object or null`);
    }
    if (!('geometry' in feature)) throw new Error(`malformed GeoJSON: feature ${index} has no geometry member`);
    return feature;
  });

  const geometry = inspectGeometries(features);
  const crs = crsMetadata(collection);
  const temporalFields = inspectTemporalFields(features);
  const schema = inspectFields(features);
  const warnings: string[] = [];
  if (!features.length) warnings.push('Dataset contains no features.');
  if (geometry.geometryTypes.length > 1) warnings.push('Dataset contains mixed geometry types.');
  if (geometry.nullGeometries) warnings.push(`${geometry.nullGeometries} feature(s) have null geometry.`);
  if (crs.warning) warnings.push(crs.warning);

  const retrievedAt = (context.now ?? (() => new Date()))().toISOString();
  const sha256 = sha256Text(bytes);
  const sourceUri = pathToFileURL(path).href;
  const metadata: GisMetadata = {
    format: 'GeoJSON',
    crs: crs.crs,
    axis_order: crs.axisOrder,
    units: crs.units,
    extent: geometry.extent,
    schema,
    row_count: features.length,
    geometry_types: geometry.geometryTypes,
    temporal_fields: temporalFields,
  };
  const passport = DatasetPassportSchema.parse({
    schema_version: '1.0.0',
    source_uri: sourceUri,
    source_handle: path,
    retrieved_at: retrievedAt,
    file_sha256: sha256,
    file_size_bytes: bytes.byteLength,
    format: metadata.format,
    crs: metadata.crs,
    axis_order: metadata.axis_order,
    units: metadata.units,
    extent: metadata.extent,
    schema: metadata.schema,
    feature_count: metadata.row_count,
    geometry_types: metadata.geometry_types,
    temporal_fields: metadata.temporal_fields,
    warnings,
  });
  const parameters = { source_uri: sourceUri, max_bytes: limit };
  const passportHash = sha256Canonical(passport);
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `inspect_dataset:${sha256.slice(0, 16)}`,
    generated_at: retrievedAt,
    source: {
      uri: sourceUri,
      identity: { kind: 'file', value: path },
      version: { modified_at: fileStat.mtime.toISOString() },
      retrieved_at: retrievedAt,
      sha256,
    },
    gis_metadata: metadata,
    parameters: { canonical_json: canonicalJson(parameters), sha256: sha256Canonical(parameters) },
    execution: {
      capability: 'inspect_dataset',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'dataset_passport',
        sha256: passportHash,
        validation: { valid: true, checks: ['input_schema', 'geojson_structure', 'output_schema'], warnings },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
  return InspectDatasetOutputSchema.parse({ schema_version: '1.0.0', passport, evidence });
}

export const inspectDatasetCapability: CapabilityDefinition<InspectDatasetInput, InspectDatasetOutput> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'inspect_dataset',
    name: 'Inspect dataset',
    description: 'Read-only deterministic inspection of one allowlisted local GeoJSON dataset.',
    version: '1.0.0',
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: [],
    allowed_sources: ['filesystem'],
    resource_limits: {
      max_records: MAX_RECORDS,
      max_bytes: MAX_BYTES,
      max_duration_ms: 5_000,
      max_cost_usd: 0,
    },
    idempotency: { mode: 'deterministic', key_fields: ['source_uri', 'sha256'] },
    dry_run: { supported: false, reason: 'Read-only capability.' },
    cancellation: { supported: true, checkpoint: 'before_file_read' },
    artifacts: [{ name: 'dataset_passport', media_type: 'application/json', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability.' },
    validation: { suite: 'gisbench', version: '0.1.0', supported_gis_versions: ['GeoJSON RFC 7946'] },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: InspectDatasetInputSchema,
  outputSchema: InspectDatasetOutputSchema,
  inputSummary: ['source_uri*', 'max_bytes'],
  boundaryFields: ['source_uri'],
  execute: executeInspectDataset,
};
