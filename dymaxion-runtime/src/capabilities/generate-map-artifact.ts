// Phase 1E deterministic inline SVG map artifact generation. Read-only local
// GeoJSON input, no network, no filesystem artifact writes, no basemap/labels
// or statistical analysis. Produces bounded self-contained UTF-8 SVG inline.

import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { containsCredentialMaterial } from './arcgis-rest.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../contracts/canonical.js';
import {
  CapabilityManifestSchema,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
} from '../contracts/capability.js';
import { EvidenceBundleSchema, GisMetadataSchema, type GisMetadata } from '../contracts/evidence.js';
import { assertPathAllowed, canonicalBoundaryPath } from '../security/boundary.js';

export const MAX_BYTES = 1_048_576;
export const MAX_FEATURES = 10_000;
export const MAX_COORDINATE_POSITIONS = 100_000;
export const MAX_GEOMETRY_COLLECTION_DEPTH = 4;
export const MAX_DURATION_MS = 5_000;
export const MAX_SVG_BYTES = 200_000;
export const MIN_WIDTH_PX = 320;
export const MAX_WIDTH_PX = 1_600;
export const MIN_HEIGHT_PX = 240;
export const MAX_HEIGHT_PX = 1_200;
export const MAX_TITLE_CHARS = 120;
export const MAX_PURPOSE_CHARS = 240;
export const MAX_AUDIENCE_CHARS = 240;
const CHECKPOINT_INTERVAL = 128;
const MAX_SOURCE_URI_CHARS = 4_096;
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

type Coord = [number, number];
type Primitive =
  | { kind: 'point'; featureIndex: number; point: Coord }
  | { kind: 'line'; featureIndex: number; points: Coord[] }
  | { kind: 'polygon'; featureIndex: number; rings: Coord[][] };

interface FileStat {
  size: number;
}

interface MapIo {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SourceUriSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_URI_CHARS)
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: 'source_uri must not contain control characters',
  })
  .refine((value) => !URI_SCHEME_PREFIX.test(value), {
    message: 'source_uri must be a local filesystem path; URI/URL schemes are not accepted',
  })
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message: 'source_uri must not contain URL query or fragment delimiters',
  })
  .refine((value) => !value.includes('%'), {
    message: 'source_uri must use a raw local filesystem path without percent escapes',
  })
  .refine((value) => value.toLowerCase().endsWith('.geojson'), {
    message: 'unsupported dataset format: source_uri must be a bounded local .geojson filesystem path',
  })
  .refine((value) => !containsCredentialMaterial(value), {
    message: 'source_uri must not contain credential-shaped path text',
  })
  .transform((value) =>
    value.startsWith('/') || value.startsWith('./') || value.startsWith('../') ? value : `./${value}`,
  );

const SafeTextSchema = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .refine((value) => !CONTROL_CHARS.test(value), { message: 'text fields must not contain control characters' })
    .refine((value) => !containsCredentialMaterial(value), {
      message: 'text fields must not contain credential-shaped material',
    });

export const GenerateMapArtifactInputSchema = z
  .object({
    source_uri: SourceUriSchema,
    target_format: z.literal('svg').optional().default('svg'),
    title: SafeTextSchema(MAX_TITLE_CHARS).optional().default('Local GeoJSON map artifact'),
    purpose: SafeTextSchema(MAX_PURPOSE_CHARS).optional().default('Deterministic inline preview of local GeoJSON geometry.'),
    audience: SafeTextSchema(MAX_AUDIENCE_CHARS).optional().default('GIS operator'),
    width: z.number().int().min(MIN_WIDTH_PX).max(MAX_WIDTH_PX).optional().default(800),
    height: z.number().int().min(MIN_HEIGHT_PX).max(MAX_HEIGHT_PX).optional().default(600),
    style: z.enum(['dymaxion', 'monochrome', 'blueprint']).optional().default('dymaxion'),
    point_symbol: z.enum(['circle', 'square']).optional().default('circle'),
  })
  .strict();

const CountSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ExtentSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const MapReportSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    source_uri: z.string().min(1),
    source_handle: z.string().min(1),
    source_attribution: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            kind: z.literal('local-file'),
            attribution: z.string().min(1),
            sha256: Sha256Schema,
          })
          .strict(),
      )
      .length(1),
    retrieved_at: z.string().datetime({ offset: true }),
    file_sha256: Sha256Schema,
    file_size_bytes: CountSchema,
    format: z.literal('GeoJSON'),
    artifact: z
      .object({
        target_format: z.literal('svg'),
        media_type: z.literal('image/svg+xml; charset=utf-8'),
        bytes: CountSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    crs: z
      .object({
        effective: z.literal('OGC:CRS84'),
        axis_order: z.literal('longitude,latitude'),
        units: z.literal('degrees'),
      })
      .strict(),
    extent: z
      .object({
        source: ExtentSchema.nullable(),
        viewport: ExtentSchema,
        antimeridian_crosses: z.boolean(),
        empty: z.boolean(),
      })
      .strict(),
    viewport: z
      .object({ width: CountSchema, height: CountSchema, padding: CountSchema, fit: z.string().min(1) })
      .strict(),
    geometry_counts: z
      .object({
        features: CountSchema,
        coordinate_positions: CountSchema,
        Point: CountSchema,
        MultiPoint: CountSchema,
        LineString: CountSchema,
        MultiLineString: CountSchema,
        Polygon: CountSchema,
        MultiPolygon: CountSchema,
        GeometryCollection: CountSchema,
        null_geometry: CountSchema,
      })
      .strict(),
    style_spec: z
      .object({
        style: z.enum(['dymaxion', 'monochrome', 'blueprint']),
        point_symbol: z.enum(['circle', 'square']),
        polygon_fill: z.string().min(1),
        line_stroke: z.string().min(1),
        point_fill: z.string().min(1),
      })
      .strict(),
    legend: z
      .object({
        title: z.literal('Rendered geometry families'),
        entries: z.array(
          z
            .object({
              family: z.enum(['polygon', 'line', 'point']),
              label: z.string().min(1),
              geometry_count: CountSchema,
              fill: z.string().min(1).nullable(),
              stroke: z.string().min(1).nullable(),
              marker: z.enum(['circle', 'square']).nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    qa: z
      .object({ checks: z.array(z.string().min(1)), warnings: z.array(z.string()), limitations: z.array(z.string().min(1)) })
      .strict(),
  })
  .strict();

export const GenerateMapArtifactOutputSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    artifact: z
      .object({
        format: z.literal('svg'),
        media_type: z.literal('image/svg+xml; charset=utf-8'),
        content: z.string().min(1),
        bytes: CountSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    report: MapReportSchema,
    evidence: EvidenceBundleSchema,
  })
  .strict();

export type GenerateMapArtifactInput = z.infer<typeof GenerateMapArtifactInputSchema>;
export type GenerateMapArtifactOutput = z.infer<typeof GenerateMapArtifactOutputSchema>;

type GeometryCounts = GenerateMapArtifactOutput['report']['geometry_counts'];

type Style = {
  background: string;
  grid: string;
  polygonFill: string;
  polygonStroke: string;
  lineStroke: string;
  pointFill: string;
  text: string;
};

const STYLES: Record<GenerateMapArtifactInput['style'], Style> = {
  dymaxion: {
    background: '#f8fafc',
    grid: '#d1d5db',
    polygonFill: '#bfdbfe',
    polygonStroke: '#2563eb',
    lineStroke: '#0f766e',
    pointFill: '#b91c1c',
    text: '#111827',
  },
  monochrome: {
    background: '#ffffff',
    grid: '#d4d4d4',
    polygonFill: '#e5e5e5',
    polygonStroke: '#171717',
    lineStroke: '#404040',
    pointFill: '#000000',
    text: '#111111',
  },
  blueprint: {
    background: '#0f172a',
    grid: '#334155',
    polygonFill: '#1e3a8a',
    polygonStroke: '#93c5fd',
    lineStroke: '#67e8f9',
    pointFill: '#fef08a',
    text: '#e0f2fe',
  },
};

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function fmt(value: number): string {
  const normalized = Math.abs(value) < 0.000_000_1 ? 0 : value;
  return normalized.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function reportNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function normalizeLon360(lon: number): number {
  const value = ((lon % 360) + 360) % 360;
  return value === 360 ? 0 : value;
}

function wrapLon180(lon: number): number {
  const value = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(value, -180) ? 180 : value;
}

function wrapViewportLon180(lon: number, bound: 'lower' | 'upper'): number {
  const value = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(value, -180) && bound === 'upper' ? 180 : value;
}

type LongitudeInterval = {
  minX: number;
  maxX: number;
  sourceMinX: number;
  sourceMaxX: number;
  crosses: boolean;
};

function computeLongitudeInterval(lons: number[], checkpoint: (stage: string) => void): LongitudeInterval {
  if (lons.length === 0) {
    return { minX: -180, maxX: 180, sourceMinX: -180, sourceMaxX: 180, crosses: false };
  }
  if (lons.length === 1) {
    const sourceLon = lons[0];
    const lon = normalizeLon360(sourceLon);
    return { minX: lon, maxX: lon, sourceMinX: sourceLon, sourceMaxX: sourceLon, crosses: false };
  }
  const sourceByNormalized = new Map<number, number>();
  for (const sourceLon of lons) {
    checkpoint('longitude interval collection');
    const normalizedLon = normalizeLon360(sourceLon);
    const current = sourceByNormalized.get(normalizedLon);
    if (current === undefined || sourceLon === wrapLon180(normalizedLon)) {
      sourceByNormalized.set(normalizedLon, sourceLon);
    }
  }
  const sorted = [...sourceByNormalized.keys()].sort((a, b) => a - b);
  checkpoint('longitude interval sort');
  if (sorted.length === 1) {
    const lon = sorted[0];
    const sourceLon = sourceByNormalized.get(lon) ?? wrapLon180(lon);
    return { minX: lon, maxX: lon, sourceMinX: sourceLon, sourceMaxX: sourceLon, crosses: false };
  }
  let largestGap = -1;
  let gapIndex = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    checkpoint('longitude interval scan');
    const current = sorted[i];
    const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }
  const start = sorted[(gapIndex + 1) % sorted.length];
  const endRaw = sorted[gapIndex];
  const end = endRaw < start ? endRaw + 360 : endRaw;
  const sourceMinX = sourceByNormalized.get(start) ?? wrapLon180(start);
  const sourceMaxX = sourceByNormalized.get(endRaw) ?? wrapLon180(endRaw);
  return {
    minX: start,
    maxX: end,
    sourceMinX,
    sourceMaxX,
    crosses: sourceMinX > sourceMaxX,
  };
}

function unwrapLon(lon: number, minX: number): number {
  let value = normalizeLon360(lon);
  while (value < minX) value += 360;
  while (value > minX + 360) value -= 360;
  return value;
}

function cloneCounts(features: number): GeometryCounts {
  return {
    features,
    coordinate_positions: 0,
    Point: 0,
    MultiPoint: 0,
    LineString: 0,
    MultiLineString: 0,
    Polygon: 0,
    MultiPolygon: 0,
    GeometryCollection: 0,
    null_geometry: 0,
  };
}

function parsePosition(value: unknown, path: string, checkpoint: (stage: string) => void): Coord {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`malformed GeoJSON: ${path} must be a position`);
  for (const ordinate of value) {
    checkpoint('coordinate parsing');
    if (typeof ordinate !== 'number' || !Number.isFinite(ordinate)) {
      throw new Error(`malformed GeoJSON: ${path} ordinates must all be finite numbers`);
    }
  }
  const lon = value[0] as number;
  const lat = value[1] as number;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error('generate_map_artifact rejected GeoJSON: coordinates must be in CRS84 longitude/latitude ranges');
  }
  return [lon, lat];
}

function collectGeometry(
  geometry: unknown,
  featureIndex: number,
  depth: number,
  counts: GeometryCounts,
  primitives: Primitive[],
  lons: number[],
  lats: number[],
  checkpoint: (stage: string) => void,
  allowNull = false,
): void {
  checkpoint('geometry traversal');
  if (depth > MAX_GEOMETRY_COLLECTION_DEPTH) {
    throw new Error(
      `generate_map_artifact resource limit exceeded: GeometryCollection depth ${depth} > ${MAX_GEOMETRY_COLLECTION_DEPTH}`,
    );
  }
  if (geometry === null) {
    if (!allowNull) throw new Error('malformed GeoJSON: GeometryCollection members must be Geometry objects');
    counts.null_geometry += 1;
    return;
  }
  if (!isObject(geometry) || typeof geometry.type !== 'string') throw new Error('malformed GeoJSON: geometry must have a type');
  const type = geometry.type;
  if (!(type in counts) || type === 'features' || type === 'coordinate_positions' || type === 'null_geometry') {
    throw new Error('unsupported GeoJSON geometry type for generate_map_artifact');
  }
  counts[type as keyof Omit<GeometryCounts, 'features' | 'coordinate_positions' | 'null_geometry'>] += 1;
  const addPoint = (point: Coord): void => {
    checkpoint('coordinate traversal');
    counts.coordinate_positions += 1;
    if (counts.coordinate_positions > MAX_COORDINATE_POSITIONS) {
      throw new Error(
        `generate_map_artifact resource limit exceeded: coordinate positions > ${MAX_COORDINATE_POSITIONS}`,
      );
    }
    lons.push(point[0]);
    lats.push(point[1]);
  };
  const parseLine = (value: unknown, path: string, minimumPositions = 2, requireClosed = false): Coord[] => {
    if (!Array.isArray(value)) throw new Error(`malformed GeoJSON: ${path} must be a coordinate array`);
    if (value.length !== 0 && value.length < minimumPositions) {
      throw new Error(`malformed GeoJSON: ${path} has too few positions`);
    }
    const line: Coord[] = [];
    for (let index = 0; index < value.length; index += 1) {
      checkpoint('coordinate parsing');
      const point = parsePosition(value[index], `${path}[${index}]`, checkpoint);
      addPoint(point);
      line.push(point);
    }
    if (
      requireClosed &&
      line.length > 0 &&
      (line[0][0] !== line[line.length - 1][0] || line[0][1] !== line[line.length - 1][1])
    ) {
      throw new Error(`malformed GeoJSON: ${path} must be a closed linear ring`);
    }
    return line;
  };
  const parsePolygon = (value: unknown, path: string): Coord[][] => {
    if (!Array.isArray(value)) throw new Error(`malformed GeoJSON: ${path} must be a polygon coordinate array`);
    return value.map((ring, index) => parseLine(ring, `${path}[${index}]`, 4, true));
  };

  if (type === 'Point') {
    const point = parsePosition(geometry.coordinates, 'coordinates', checkpoint);
    addPoint(point);
    primitives.push({ kind: 'point', featureIndex, point });
    return;
  }
  if (type === 'MultiPoint') {
    if (!Array.isArray(geometry.coordinates)) throw new Error('malformed GeoJSON: MultiPoint coordinates must be an array');
    for (let index = 0; index < geometry.coordinates.length; index += 1) {
      checkpoint('coordinate parsing');
      const point = parsePosition(geometry.coordinates[index], `coordinates[${index}]`, checkpoint);
      addPoint(point);
      primitives.push({ kind: 'point', featureIndex, point });
    }
    return;
  }
  if (type === 'LineString') {
    primitives.push({ kind: 'line', featureIndex, points: parseLine(geometry.coordinates, 'coordinates') });
    return;
  }
  if (type === 'MultiLineString') {
    if (!Array.isArray(geometry.coordinates)) throw new Error('malformed GeoJSON: MultiLineString coordinates must be an array');
    geometry.coordinates.forEach((line, index) => {
      primitives.push({ kind: 'line', featureIndex, points: parseLine(line, `coordinates[${index}]`) });
    });
    return;
  }
  if (type === 'Polygon') {
    primitives.push({ kind: 'polygon', featureIndex, rings: parsePolygon(geometry.coordinates, 'coordinates') });
    return;
  }
  if (type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) throw new Error('malformed GeoJSON: MultiPolygon coordinates must be an array');
    geometry.coordinates.forEach((polygon, index) => {
      primitives.push({ kind: 'polygon', featureIndex, rings: parsePolygon(polygon, `coordinates[${index}]`) });
    });
    return;
  }
  if (type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) {
      throw new Error('malformed GeoJSON: GeometryCollection geometries must be an array');
    }
    geometry.geometries.forEach((child) =>
      collectGeometry(child, featureIndex, depth + 1, counts, primitives, lons, lats, checkpoint),
    );
  }
}

function pointToSvg(point: Coord, minX: number, minY: number, xScale: number, yScale: number, height: number, padding: number): [number, number] {
  const x = padding + (unwrapLon(point[0], minX) - minX) * xScale;
  const y = height - padding - (point[1] - minY) * yScale;
  return [x, y];
}

function renderSvg(
  input: GenerateMapArtifactInput,
  primitives: Primitive[],
  extent: { minX: number; maxX: number; minY: number; maxY: number; crosses: boolean; empty: boolean },
  antimeridianCrosses: boolean,
  counts: GeometryCounts,
  warnings: string[],
  sourceAttribution: string,
  checkpoint: (stage: string) => void,
): string {
  const style = STYLES[input.style];
  const padding = 48;
  const width = input.width;
  const height = input.height;
  const spanX = Math.max(extent.maxX - extent.minX, Number.EPSILON);
  const spanY = Math.max(extent.maxY - extent.minY, Number.EPSILON);
  const drawableW = Math.max(width - padding * 2, 1);
  const drawableH = Math.max(height - padding * 2, 1);
  const scale = Math.min(drawableW / spanX, drawableH / spanY);
  const xScale = scale;
  const yScale = scale;
  const projectedW = spanX * scale;
  const projectedH = spanY * scale;
  const xOffset = padding + (drawableW - projectedW) / 2;
  const yOffset = padding + (drawableH - projectedH) / 2;
  const project = (point: Coord): [number, number] => {
    const [x, y] = pointToSvg(point, extent.minX, extent.minY, xScale, yScale, height, padding);
    return [x + (xOffset - padding), y - (yOffset - padding)];
  };
  const lines: string[] = [];
  let renderedBytes = 0;
  const pushLine = (line: string): void => {
    checkpoint('SVG rendering');
    renderedBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (renderedBytes > MAX_SVG_BYTES) {
      throw new Error(
        `generate_map_artifact resource limit exceeded: SVG output > ${MAX_SVG_BYTES} bytes`,
      );
    }
    lines.push(line);
  };
  pushLine('<?xml version="1.0" encoding="UTF-8"?>');
  pushLine(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="map-title map-desc">`,
  );
  pushLine(`<title id="map-title">${xmlEscape(input.title)}</title>`);
  pushLine(
    `<desc id="map-desc">${xmlEscape(input.purpose)} Audience: ${xmlEscape(input.audience)}. CRS OGC:CRS84 longitude/latitude. Inline deterministic SVG; no basemap, labels, scale, scripts, or external resources.</desc>`,
  );
  pushLine(`<rect x="0" y="0" width="${width}" height="${height}" fill="${style.background}"/>`);
  pushLine(`<rect x="${fmt(xOffset)}" y="${fmt(yOffset)}" width="${fmt(projectedW)}" height="${fmt(projectedH)}" fill="none" stroke="${style.grid}" stroke-width="1"/>`);
  if (extent.empty) {
    pushLine(
      `<text x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle" fill="${style.text}" font-family="system-ui, sans-serif" font-size="14">Empty FeatureCollection: no drawable geometries</text>`,
    );
  }
  pushLine('<g id="geojson-primitives">');
  for (const primitive of primitives) {
    checkpoint('SVG polygon rendering');
    if (primitive.kind === 'polygon') {
      const d = primitive.rings
        .filter((ring) => ring.length > 0)
        .map((ring) =>
          ring
            .map((point, index) => {
              checkpoint('SVG polygon coordinate rendering');
              const [x, y] = project(point);
              return `${index === 0 ? 'M' : 'L'} ${fmt(x)} ${fmt(y)}`;
            })
            .join(' ') + ' Z',
        )
        .join(' ');
      if (d) {
        pushLine(
          `<path d="${d}" fill="${style.polygonFill}" fill-opacity="0.55" fill-rule="evenodd" stroke="${style.polygonStroke}" stroke-width="1.5"/>`,
        );
      }
    }
  }
  for (const primitive of primitives) {
    checkpoint('SVG line rendering');
    if (primitive.kind === 'line' && primitive.points.length > 0) {
      const points = primitive.points
        .map((point) => {
          checkpoint('SVG line coordinate rendering');
          const [x, y] = project(point);
          return `${fmt(x)},${fmt(y)}`;
        })
        .join(' ');
      pushLine(`<polyline points="${points}" fill="none" stroke="${style.lineStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  for (const primitive of primitives) {
    checkpoint('SVG point rendering');
    if (primitive.kind === 'point') {
      const [x, y] = project(primitive.point);
      if (input.point_symbol === 'square') {
        pushLine(`<rect x="${fmt(x - 3)}" y="${fmt(y - 3)}" width="6" height="6" fill="${style.pointFill}"/>`);
      } else {
        pushLine(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="3.5" fill="${style.pointFill}"/>`);
      }
    }
  }
  pushLine('</g>');
  pushLine('<g id="legend">');
  pushLine(`<rect x="${fmt(width - 248)}" y="16" width="232" height="86" rx="6" fill="${style.background}" stroke="${style.grid}"/>`);
  pushLine(`<text x="${fmt(width - 232)}" y="38" fill="${style.text}" font-family="system-ui, sans-serif" font-size="12">GeoJSON geometry counts</text>`);
  pushLine(`<text x="${fmt(width - 232)}" y="58" fill="${style.text}" font-family="system-ui, sans-serif" font-size="11">Features ${counts.features}; Positions ${counts.coordinate_positions}</text>`);
  pushLine(`<text x="${fmt(width - 232)}" y="76" fill="${style.text}" font-family="system-ui, sans-serif" font-size="11">Pt ${counts.Point + counts.MultiPoint}; Line ${counts.LineString + counts.MultiLineString}; Poly ${counts.Polygon + counts.MultiPolygon}</text>`);
  pushLine(`<text x="${fmt(width - 232)}" y="94" fill="${style.text}" font-family="system-ui, sans-serif" font-size="11">${xmlEscape(antimeridianCrosses ? 'Antimeridian-aware extent' : 'CRS84 extent')}</text>`);
  pushLine('</g>');
  pushLine(
    `<text x="16" y="${height - 16}" fill="${style.text}" font-family="system-ui, sans-serif" font-size="10">Source: ${xmlEscape(sourceAttribution)}. ${warnings.length} warning(s). No scale or basemap.</text>`,
  );
  pushLine('</svg>');
  return `${lines.join('\n')}\n`;
}

function assertSafeSvg(svg: string): void {
  const lower = svg.toLowerCase();
  const forbidden = ['<script', 'javascript:', '<!doctype', '<!entity', '<foreignobject', 'xlink:href=', ' href=', 'url('];
  if (forbidden.some((needle) => lower.includes(needle))) {
    throw new Error('generate_map_artifact SVG safety check failed');
  }
  if (/\son[a-z]+\s*=/.test(lower)) throw new Error('generate_map_artifact SVG event handler check failed');
}

async function executeGenerateMapArtifact(
  input: GenerateMapArtifactInput,
  context: CapabilityExecutionContext,
): Promise<GenerateMapArtifactOutput> {
  if (context.signal?.aborted) throw new Error('generate_map_artifact cancelled before file read');
  const path = canonicalBoundaryPath(input.source_uri);
  if (extname(path).toLowerCase() !== '.geojson') {
    throw new Error('unsupported dataset format: the canonical source path must end in .geojson');
  }
  const io = context.io as MapIo | undefined;
  if (!io?.stat || !io.readFile) throw new Error('generate_map_artifact filesystem adapter unavailable');
  const nowFn = context.now ?? ((): Date => new Date());
  const startedMs = nowFn().getTime();
  const timestamp = nowFn().toISOString();
  let checkpointCounter = 0;
  const checkpoint = (stage: string): void => {
    if (context.signal?.aborted) throw new Error(`generate_map_artifact cancelled during ${stage}`);
    if (nowFn().getTime() - startedMs > MAX_DURATION_MS) {
      throw new Error(
        `generate_map_artifact resource limit exceeded: duration > ${MAX_DURATION_MS} ms during ${stage}`,
      );
    }
  };
  const pacedCheckpoint = (stage: string): void => {
    checkpointCounter += 1;
    if (checkpointCounter >= CHECKPOINT_INTERVAL) {
      checkpointCounter = 0;
      checkpoint(stage);
    }
  };

  await assertPathAllowed(path, context.boundary);
  let fileStat: FileStat;
  try {
    fileStat = await io.stat(path);
  } catch {
    throw new Error('generate_map_artifact file stat failed for the requested local dataset');
  }
  checkpoint('file stat');
  if (fileStat.size > MAX_BYTES) {
    throw new Error(`generate_map_artifact resource limit exceeded: ${fileStat.size} bytes > ${MAX_BYTES} bytes`);
  }
  await assertPathAllowed(path, context.boundary);
  checkpoint('file read');
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch {
    throw new Error('generate_map_artifact file read failed for the requested local dataset');
  }
  checkpoint('file read');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `generate_map_artifact resource limit exceeded while reading: ${bytes.byteLength} bytes > ${MAX_BYTES} bytes`,
    );
  }

  let sourceText: string;
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('malformed GeoJSON: source is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new Error('malformed GeoJSON: invalid JSON syntax');
  }
  checkpoint('json parse');
  if (!isObject(parsed) || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error('malformed GeoJSON: root must be a FeatureCollection with a features array');
  }
  if ('crs' in parsed) {
    throw new Error('generate_map_artifact rejected GeoJSON: legacy crs members are not RFC 7946 CRS84');
  }
  if (parsed.features.length > MAX_FEATURES) {
    throw new Error(
      `generate_map_artifact resource limit exceeded: ${parsed.features.length} features > ${MAX_FEATURES}`,
    );
  }

  const counts = cloneCounts(parsed.features.length);
  const primitives: Primitive[] = [];
  const lons: number[] = [];
  const lats: number[] = [];
  const warnings: string[] = [];
  parsed.features.forEach((feature, index) => {
    pacedCheckpoint('feature envelope validation');
    if (!isObject(feature) || feature.type !== 'Feature') {
      throw new Error(`malformed GeoJSON: feature ${index} is not a Feature`);
    }
    if (!('geometry' in feature)) throw new Error(`malformed GeoJSON: feature ${index} has no geometry member`);
    if (
      !('properties' in feature) ||
      (feature.properties !== null && (!isObject(feature.properties) || Array.isArray(feature.properties)))
    ) {
      throw new Error(`malformed GeoJSON: feature ${index} properties must be an object or null`);
    }
    collectGeometry(feature.geometry, index, 0, counts, primitives, lons, lats, pacedCheckpoint, true);
  });
  checkpoint('geometry traversal');

  if (counts.null_geometry > 0) warnings.push('Null geometries are skipped and counted; they are not rendered.');
  if (counts.coordinate_positions === 0) warnings.push('Empty FeatureCollection or no drawable coordinates; SVG uses a documented full-world viewport.');
  const sourceLonInterval = computeLongitudeInterval(lons, pacedCheckpoint);
  let minLatRaw = -90;
  let maxLatRaw = 90;
  if (lats.length > 0) {
    minLatRaw = Number.POSITIVE_INFINITY;
    maxLatRaw = Number.NEGATIVE_INFINITY;
    for (const lat of lats) {
      pacedCheckpoint('latitude extent scan');
      minLatRaw = Math.min(minLatRaw, lat);
      maxLatRaw = Math.max(maxLatRaw, lat);
    }
  }
  const minX = lons.length && sourceLonInterval.minX === sourceLonInterval.maxX
    ? sourceLonInterval.minX - 0.5
    : sourceLonInterval.minX;
  const maxX = lons.length && sourceLonInterval.minX === sourceLonInterval.maxX
    ? sourceLonInterval.maxX + 0.5
    : sourceLonInterval.maxX;
  const minY = lats.length && minLatRaw === maxLatRaw ? minLatRaw - 0.5 : minLatRaw;
  const maxY = lats.length && minLatRaw === maxLatRaw ? maxLatRaw + 0.5 : maxLatRaw;
  const extent = {
    minX,
    maxX,
    minY,
    maxY,
    crosses: sourceLonInterval.crosses,
    empty: counts.coordinate_positions === 0,
  };
  const wrappedViewportMinX = wrapViewportLon180(extent.minX, 'lower');
  const wrappedViewportMaxX = wrapViewportLon180(extent.maxX, 'upper');
  const rawPaddedViewportCrosses = extent.crosses || wrappedViewportMinX > wrappedViewportMaxX;
  const viewportExtent: [number, number, number, number] = extent.empty
    ? [-180, -90, 180, 90]
    : [
        reportNumber(rawPaddedViewportCrosses ? extent.minX : wrappedViewportMinX),
        reportNumber(extent.minY),
        reportNumber(rawPaddedViewportCrosses ? extent.maxX : wrappedViewportMaxX),
        reportNumber(extent.maxY),
      ];
  const antimeridianCrosses =
    extent.crosses || viewportExtent[0] < -180 || viewportExtent[2] > 180 || viewportExtent[0] > viewportExtent[2];
  if (antimeridianCrosses) warnings.push('Antimeridian-aware minimal longitude interval used for viewport fitting.');

  const sourceHash = sha256Text(bytes);
  const sourceAttribution = `local GeoJSON source; sha256 ${sourceHash.slice(0, 12)}`;
  const sourceUri = pathToFileURL(path).href;
  const svg = renderSvg(input, primitives, extent, antimeridianCrosses, counts, warnings, sourceAttribution, pacedCheckpoint);
  checkpoint('SVG rendering');
  assertSafeSvg(svg);
  const svgBytes = Buffer.byteLength(svg, 'utf8');
  if (svgBytes > MAX_SVG_BYTES) {
    throw new Error(`generate_map_artifact resource limit exceeded: SVG output ${svgBytes} bytes > ${MAX_SVG_BYTES} bytes`);
  }
  const svgHash = sha256Text(svg);
  const sourceExtent: [number, number, number, number] | null = counts.coordinate_positions
    ? [sourceLonInterval.sourceMinX, minLatRaw, sourceLonInterval.sourceMaxX, maxLatRaw]
    : null;
  const legendEntries: GenerateMapArtifactOutput['report']['legend']['entries'] = [];
  const polygonCount = counts.Polygon + counts.MultiPolygon;
  const lineCount = counts.LineString + counts.MultiLineString;
  const pointCount = counts.Point + counts.MultiPoint;
  if (polygonCount > 0) {
    legendEntries.push({
      family: 'polygon',
      label: 'Polygon and MultiPolygon geometries',
      geometry_count: polygonCount,
      fill: STYLES[input.style].polygonFill,
      stroke: STYLES[input.style].polygonStroke,
      marker: null,
    });
  }
  if (lineCount > 0) {
    legendEntries.push({
      family: 'line',
      label: 'LineString and MultiLineString geometries',
      geometry_count: lineCount,
      fill: null,
      stroke: STYLES[input.style].lineStroke,
      marker: null,
    });
  }
  if (pointCount > 0) {
    legendEntries.push({
      family: 'point',
      label: 'Point and MultiPoint geometries',
      geometry_count: pointCount,
      fill: STYLES[input.style].pointFill,
      stroke: null,
      marker: input.point_symbol,
    });
  }
  const report = MapReportSchema.parse({
    schema_version: '1.0.0',
    source_uri: sourceUri,
    source_handle: path,
    source_attribution: sourceAttribution,
    sources: [{ kind: 'local-file', attribution: sourceAttribution, sha256: sourceHash }],
    retrieved_at: timestamp,
    file_sha256: sourceHash,
    file_size_bytes: bytes.byteLength,
    format: 'GeoJSON',
    artifact: { target_format: 'svg', media_type: 'image/svg+xml; charset=utf-8', bytes: svgBytes, sha256: svgHash },
    crs: { effective: 'OGC:CRS84', axis_order: 'longitude,latitude', units: 'degrees' },
    extent: { source: sourceExtent, viewport: viewportExtent, antimeridian_crosses: antimeridianCrosses, empty: extent.empty },
    viewport: { width: input.width, height: input.height, padding: 48, fit: 'fit-to-extent with fixed padding; degenerate extents expanded deterministically' },
    geometry_counts: counts,
    style_spec: {
      style: input.style,
      point_symbol: input.point_symbol,
      polygon_fill: STYLES[input.style].polygonFill,
      line_stroke: STYLES[input.style].lineStroke,
      point_fill: STYLES[input.style].pointFill,
    },
    legend: { title: 'Rendered geometry families', entries: legendEntries },
    qa: {
      checks: [
        'input_schema',
        'raw_local_path_no_percent',
        'boundary_before_stat',
        'boundary_before_read_file',
        'geojson_featurecollection_structure',
        'crs84_coordinate_range',
        'geometry_family_support',
        'antimeridian_minimal_interval',
        'svg_safety_static_primitives',
        'svg_output_hash_exact_bytes',
      ],
      warnings,
      limitations: [
        'Inline SVG only; no durable storage or filesystem artifact is written.',
        'No basemap, map labels, representative fraction, scale bar, projection transform, geocoding, classification, statistics, or publication.',
        'Only RFC 7946 CRS84 longitude/latitude GeoJSON coordinates are supported; source properties and feature names are not rendered.',
        'Geometry drawing is a deterministic preview, not an OGC/GEOS topology validation or cartographic generalization.',
      ],
    },
  });
  const gisMetadata: GisMetadata = GisMetadataSchema.parse({
    format: 'GeoJSON',
    crs: 'OGC:CRS84',
    axis_order: 'longitude,latitude',
    units: 'degrees',
    extent: sourceExtent,
    schema: [],
    row_count: counts.features,
    geometry_types: ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].filter(
      (type) => counts[type as keyof GeometryCounts] > 0,
    ),
    temporal_fields: [],
  });
  const parameters = {
    audience: input.audience,
    height: input.height,
    point_symbol: input.point_symbol,
    purpose: input.purpose,
    source_uri: sourceUri,
    style: input.style,
    target_format: input.target_format,
    title: input.title,
    width: input.width,
  };
  const evidence = EvidenceBundleSchema.parse({
    schema_version: '1.0.0',
    bundle_id: `generate_map_artifact:${svgHash.slice(0, 16)}`,
    generated_at: timestamp,
    source: {
      uri: sourceUri,
      identity: { kind: 'file', value: path },
      version: {},
      retrieved_at: timestamp,
      sha256: sourceHash,
    },
    gis_metadata: gisMetadata,
    parameters: { canonical_json: canonicalJson(parameters), sha256: sha256Canonical(parameters) },
    execution: {
      capability: 'generate_map_artifact',
      capability_version: '1.0.0',
      mode: 'deterministic',
      model_planning: [],
    },
    outputs: [
      {
        name: 'map_svg',
        sha256: svgHash,
        bytes: svgBytes,
        validation: {
          valid: true,
          checks: ['input_schema', 'geojson_parse', 'svg_safety', 'exact_utf8_output_hash', 'output_schema'],
          warnings,
        },
      },
    ],
    approvals: [],
    rollback: { required: false, strategy: 'none', artifacts: [] },
  });
  return GenerateMapArtifactOutputSchema.parse({
    schema_version: '1.0.0',
    artifact: { format: 'svg', media_type: 'image/svg+xml; charset=utf-8', content: svg, bytes: svgBytes, sha256: svgHash },
    report,
    evidence,
  });
}

export const generateMapArtifactCapability: CapabilityDefinition<
  GenerateMapArtifactInput,
  GenerateMapArtifactOutput
> = {
  manifest: CapabilityManifestSchema.parse({
    schema_version: '1.0.0',
    slug: 'generate_map_artifact',
    name: 'Generate map artifact',
    description:
      'Read-only deterministic rendering of one bounded local RFC 7946 GeoJSON file into a self-contained inline UTF-8 SVG artifact with reproducible evidence; no writes, network, basemap, labels, scale, or analysis.',
    version: '1.0.0',
    classification: 'read',
    identity: { required: false, permissions: [] },
    allowed_hosts: [],
    allowed_sources: ['filesystem'],
    resource_limits: {
      max_records: MAX_FEATURES,
      max_bytes: MAX_BYTES,
      max_duration_ms: MAX_DURATION_MS,
      max_cost_usd: 0,
      max_coordinate_positions: MAX_COORDINATE_POSITIONS,
      max_geometry_collection_depth: MAX_GEOMETRY_COLLECTION_DEPTH,
      max_svg_bytes: MAX_SVG_BYTES,
      max_width_px: MAX_WIDTH_PX,
      max_height_px: MAX_HEIGHT_PX,
      max_title_chars: MAX_TITLE_CHARS,
      max_purpose_chars: MAX_PURPOSE_CHARS,
      max_audience_chars: MAX_AUDIENCE_CHARS,
    },
    idempotency: { mode: 'deterministic', key_fields: ['source_uri', 'target_format', 'sha256'] },
    dry_run: { supported: false, reason: 'Read-only capability returns the inline artifact without writes.' },
    cancellation: { supported: true, checkpoint: 'before_stat_before_read_and_geometry_traversal' },
    artifacts: [{ name: 'map_svg', media_type: 'image/svg+xml; charset=utf-8', required: true }],
    rollback: { supported: false, strategy: 'none', reason: 'Read-only capability; no writes to roll back.' },
    validation: { suite: 'gisbench', version: '0.1.0', supported_gis_versions: ['GeoJSON RFC 7946', 'SVG 1.1 static primitives'] },
    input_schema_version: '1.0.0',
    output_schema_version: '1.0.0',
  }),
  inputSchema: GenerateMapArtifactInputSchema as unknown as z.ZodType<GenerateMapArtifactInput>,
  outputSchema: GenerateMapArtifactOutputSchema,
  inputSummary: ['source_uri*', 'target_format=svg', 'title', 'purpose', 'audience', 'width', 'height', 'style', 'point_symbol'],
  boundaryFields: ['source_uri'],
  execute: executeGenerateMapArtifact,
};
