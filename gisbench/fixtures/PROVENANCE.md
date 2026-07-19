# GISBench fixtures

All files in this directory are small synthetic datasets created for Dymaxion
Phase 0/1A tests. They contain no City of Sacramento, client, employer,
private ArcGIS, or production-system data, no real usernames or PII, and no
real tokens or credentials.

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

The coordinates, attributes, identifiers, and timestamps are invented. They
are not suitable for operational decisions.
