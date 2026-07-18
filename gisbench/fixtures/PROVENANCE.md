# GISBench fixtures

All files in this directory are small synthetic datasets created for Dymaxion Phase 0 tests. They contain no City of Sacramento, client, employer, private ArcGIS, or production-system data.

- `synthetic-points.geojson`: two fictional monitoring sites in generic Colorado coordinates; CC0 test fixture.
- `synthetic-mixed.geojson`: fictional point/line/null geometry mix near Paris; CC0 test fixture.
- `malformed.geojson`: deliberately truncated synthetic JSON for parser failure coverage.
- `unsupported.csv`: synthetic CSV used to prove unsupported formats fail honestly.

The coordinates and attributes are invented. They are not suitable for operational decisions.
