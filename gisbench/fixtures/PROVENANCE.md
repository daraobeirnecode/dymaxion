# GISBench fixtures

All files in this directory are small synthetic datasets created for Dymaxion
Phase 0/1A/1B/1C/1D/1E/1F tests. They contain no City of Sacramento, client,
employer, private ArcGIS, or production-system data, no real usernames or PII,
and no real tokens or credentials.

## Phase 0 GeoJSON fixtures

- `synthetic-points.geojson`: two fictional monitoring sites in generic Colorado coordinates; CC0 test fixture.
- `synthetic-mixed.geojson`: fictional point/line/null geometry mix near Paris; CC0 test fixture.
- `malformed.geojson`: deliberately truncated synthetic JSON for parser failure coverage.
- `unsupported.csv`: synthetic CSV used to prove unsupported formats fail honestly.

## Phase 1A ArcGIS Portal REST fixtures (`arcgis/`)

Each subdirectory is one synthetic organization served by the GISBench
fixture transport via `routes.json` (exact URL → committed JSON body). The
response shapes follow the public ArcGIS Portal REST API documentation
(`portals/{id}`, `portals/{id}/users`, `community/groups`, `search` with
`f=json`, `start`, `num`, `nextStart`); the content — organization
`DEMOORG123` at `demo-org.maps.arcgis.com`, users `ada.analyst`/`greg.gis`/
`ops.admin`/`legacy.user`, and every item — is invented. No request was made
to any real ArcGIS endpoint to author them; CC0 test fixtures.

- `arcgis/small-org/`: two users, one group, three items (one service-backed, one stale, one with unknown access and a service-like title that must not classify as a service).
- `arcgis/paginated-org/`: five items across three search pages (`nextStart` 3 → 5 → -1).
- `arcgis/governance-org/`: governance normalization coverage — fresh/stale services, a service item without a URL, an unrecognized sharing value, a record missing its id.
- `arcgis/error-envelope-org/`: HTTP 200 ArcGIS error envelope (code 499) whose message embeds the fake string `token=SYNTHETICFAKEVALUE000` to prove redaction; not a real credential.
- `arcgis/denied-org/`: intentionally empty route set for the denied-hostname boundary task; any request against it fails the task.

## Phase 1B ArcGIS dependency fixtures (`arcgis/dependency-*`)

Each subdirectory serves synthetic item metadata/data responses for the
`trace_arcgis_dependencies` capability via the same exact-URL fixture
transport (`/sharing/rest/content/items/{id}` and `.../{id}/data` with
`f=json`). Every 32-hex item ID, title, owner, and service URL is invented;
no request was made to any real ArcGIS endpoint to author them; CC0 test
fixtures.

- `arcgis/dependency-app/`: a Web Mapping Application referencing a Web Map that references a Feature Service item, a table item, an operational-layer service URL, and a basemap service URL.
- `arcgis/dependency-cycle/`: two Web Maps referencing each other, with one reference duplicated to prove canonical edge deduplication.
- `arcgis/dependency-missing/`: a Web Map with a missing-item reference (HTTP 200 error envelope), a malformed item id, a credential-bearing URL, an `ftp://` URL, and a query-bearing URL. The embedded `SYNTHETICFAKEVALUE111`/`222`/`333` strings are fake redaction canaries, not real credentials.
- `arcgis/dependency-ceiling/`: a Web Map with three item references traversed under a two-node ceiling to prove honest truncation.
- `arcgis/dependency-denied/`: intentionally empty route set for the denied-portal boundary task; any request against it fails the task.

## Phase 1C ArcGIS Feature Service fixtures (`arcgis/query-*`)

Each subdirectory serves synthetic FeatureServer layer metadata and
POST-form `/query` responses for the `query_feature_service` capability via
the exact-match fixture transport (`routes.json` entries carry `method` and
canonical `form` fields for POST routes; GET metadata remains exact-URL).
The synthetic organization `synthorg` at `services.arcgis.com`, the
`Hydrants` layer, and every object ID, attribute value, and coordinate are
invented. The response shapes follow the public ArcGIS Feature Service REST
API documentation (`FeatureServer/<layer-id>` metadata with `f=json`, and
`/query` with `returnIdsOnly`/`objectIds`/`outFields`/`returnGeometry`/
`outSR`, including the `exceededTransferLimit` flag). No request was made to
any real ArcGIS endpoint to author them; CC0 test fixtures.

- `arcgis/query-basic/`: three hydrants retrieved with canonical object-ID paging under `maxRecordCount` 2; the server returns unsorted IDs and shuffled page order to prove canonical normalization.
- `arcgis/query-geometry/`: two hydrants with Esri JSON point geometry in the requested output WKID 3857.
- `arcgis/query-split/`: a four-ID batch that reports `exceededTransferLimit`, retrieved by deterministic halves with shuffled response order.
- `arcgis/query-ceiling/`: six matched object IDs with `max_records` 3 selecting the lowest three.
- `arcgis/query-denied/`: intentionally empty route set for the denied-hostname feature query boundary task; any request against it fails the task.

## Phase 1D spatial-validation GeoJSON fixtures (`spatial-validation/`)

Hand-authored synthetic RFC 7946 FeatureCollections exercising the
`validate_spatial_data` capability. Every coordinate, feature ID, property
name/value, and CRS string is invented; canary strings (`ID_CANARY_*`,
`TYPE_CANARY_*`, `SECRET_PROPERTY_VALUE`) exist solely to prove untrusted
values never leak into reports. CC0 test fixtures.

- `valid-polygon.geojson`: clean two-feature collection with an enclosing root bbox.
- `geometry-findings.geojson`: unclosed ring, asymmetric bow-tie self-intersection, control square, duplicate vertices, short LineString, zero-area collinear ring, out-of-range point, interior canary vertex, mixed 2D/3D LineString.
- `identifier-findings.geojson`: missing/duplicate/typed/invalid feature IDs, null geometry, property null/missing patterns.
- `legacy-crs.geojson`: deprecated `crs` member naming an unrecognized CRS with Web-Mercator-scale coordinates.
- `bbox-mismatch.geojson` / `bbox-invalid.geojson`: non-enclosing and structurally invalid root bboxes.
- `antimeridian-enclosing.geojson` / `antimeridian-nonenclosing.geojson` / `antimeridian-unverified.geojson`: antimeridian-crossing declared bboxes (CRS84 enclosing, CRS84 violated, non-CRS84 unverifiable).
- `deep-collection.geojson`: GeometryCollection nested past the depth ceiling.
- `sort-truncation.geojson`: encounter order chosen so stable severity sorting must decide `max_issues` survivors.
- `empty-geometries.geojson`: empty MultiPoint/MultiLineString/Polygon/MultiPolygon containers plus a null-geometry control.
- `value-canaries.geojson`: duplicate canary IDs and a canary geometry type for leak canaries.
- `crs-canary.geojson`: legacy `crs` name shaped like credential material (`client_secret=CRSCANARY_…`) proving unrecognized CRS names are never serialized.
- `property-canaries.geojson`: credential-shaped, control-bearing, and overlong property keys plus a safe control field, proving unsafe field names surface only as deterministic surrogates.
- `empty-property-name.geojson`: a feature with an empty-string property key exercising the surrogate path instead of an internal failure.
- `surrogate-collision.geojson`: an empty property key plus a literal raw key shaped like the reserved surrogate namespace, proving generated display names stay unique and raw surrogate-shaped names are themselves surrogated.
- `gc-mixed-dimensions.geojson` / `gc-child-mixed-dimensions.geojson`: GeometryCollections with 2D/3D children and an internally mixed child LineString for collection-scope dimension-consistency findings.
- `bbox-dim-2d-6.geojson` / `bbox-dim-3d-4.geojson`: declared bboxes whose 6/4-value lengths contradict the observed 2D/3D coordinate dimensionality.
- `bbox-crs84-out-of-range.geojson`: a declared bbox with longitude/latitude values outside CRS84 ranges.
- `bbox-3d-enclosing.geojson` / `bbox-3d-nonenclosing.geojson`: 6-value bboxes over 3D points where the Z range encloses / excludes a coordinate.
- `bbox-4d-enclosing.geojson`: an 8-value bbox enclosing a 4-ordinate position (RFC-style 2*n support).
- `nested-bboxes.geojson`: Feature-level non-enclosing, geometry-level structurally invalid, and GeometryCollection-member non-enclosing bboxes.
- `not-a-collection.geojson` / `bad-feature.geojson`: malformed envelopes for fail-closed coverage.

## Phase 1E map-artifact GeoJSON fixtures (`map-artifact/`)

Hand-authored synthetic RFC 7946 FeatureCollections used only by the offline
`generate_map_artifact` GISBench tasks. Every geometry and coordinate is
invented; source properties are synthetic controls and are not rendered. CC0
test fixtures.

- `useful-geometry.geojson`: mixed Point/MultiPoint, LineString/MultiLineString,
  Polygon with an interior ring, and GeometryCollection coverage.
- `antimeridian.geojson`: a synthetic LineString crossing from positive to
  negative longitude near 180 degrees.
- `empty.geojson`: an empty FeatureCollection proving the explicit no-drawable
  output contract.
- `out-of-range.geojson`: a synthetic longitude outside CRS84 bounds for
  deterministic rejection.

## Phase 1F vector-analysis GeoJSON fixtures (`vector-analysis/`)

Hand-authored synthetic RFC 7946 Point FeatureCollections used only by the
offline `run_vector_analysis` GISBench tasks. Every coordinate, feature ID,
and property is invented; candidate properties are controls proving omission
from the output artifact. CC0 test fixtures.

- `nearest-primary.geojson` / `nearest-candidates.geojson`: normal nearest-point
  ordering, rounded distances, primary property preservation, and candidate
  property omission.
- `tie-primary.geojson` / `tie-candidates.geojson`: equal rounded distances
  where the lower candidate source index wins.
- `antimeridian-primary.geojson` / `antimeridian-candidates.geojson`: nearest
  selection across the antimeridian using normalized longitude deltas.
- `max-distance-primary.geojson` / `max-distance-candidates.geojson`: a
  thresholded nearest candidate that becomes an unmatched primary feature.
- `empty-candidate-primary.geojson` / `empty-candidates.geojson`: non-empty
  primary features with an empty candidate FeatureCollection.

The coordinates, attributes, identifiers, and timestamps are invented. They
are not suitable for operational decisions.
