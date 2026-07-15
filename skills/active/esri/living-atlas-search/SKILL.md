---
slug: living-atlas-search
name: Living Atlas Search
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Living Atlas Search

## Purpose

Search the Esri Living Atlas by keyword, filtered by item type, license
tier, and geographic extent, and return ranked candidate items the user (or
a downstream skill) can pull into a map or analysis.

## When to use this skill

- User asks "is there an authoritative layer for X" or "find imagery /
  demographics / hydrology data for this area"
- A scaffold skill (`dashboard-scaffold`, `story-map-scaffold`,
  `nextjs-map-app-scaffold`) needs a reference layer candidate list

## When NOT to use this skill

- Searching the user's own org content — use `arcgis-online-item-audit` or
  a direct item lookup
- Searching open imagery catalogs by scene (bbox + date + cloud cover) —
  use `stac-catalog-search`
- The user already has the item id — fetch it directly, no search needed

## Inputs

- `keywords` (string, required): search terms
- `item_type` (string, optional): e.g. `Feature Service`, `Imagery Layer`,
  `Web Map`
- `license_filter` (string, optional): `public`, `subscriber`, or `premium`
- `extent` (object, optional): `{xmin, ymin, xmax, ymax}` in WGS84 to bias
  results geographically
- `max_results` (number, optional): default 10

## Outputs

- `items` (array): candidates — id, title, owner, type, snippet, license
  tier, relevance note
- `search_summary` (string): one line citing the query, filters, and count

## Tools required

- `esri-mcp` — content search where available
- `http` — direct calls to `www.arcgis.com/sharing/rest/search` with Living
  Atlas group/contentstatus filters

## Execution plan

1. Build the search query: keywords + Living Atlas scoping
   (`contentstatus:public_authoritative` / Living Atlas group filter)
2. Apply `item_type` as a type filter and `extent` as the bbox parameter
3. Map `license_filter` to typeKeywords/contentstatus terms (`subscriber`,
   `premium`); leave unfiltered if not given
4. Fetch up to `max_results` items with metadata: id, title, owner, type,
   snippet, typeKeywords
5. Classification-tier LLM ranks the candidates for relevance to the
   keywords and writes a one-clause relevance note per item
6. Return `items` (ranked) + `search_summary`

## LLM prompts

### Relevance ranking (classification tier)

System: You rank GIS catalog search results. Order items by relevance to
the stated need. For each, one clause on why it fits or does not. Mark
subscriber/premium items so cost is visible. Output JSON only:
[{"id": ..., "rank": ..., "note": ...}].

User: Need: {keywords}{type_and_extent_note}. Candidates (id, title,
snippet, typeKeywords): {candidates_json}. Rank them.

## Failure modes

- Zero results — relax once by dropping the `item_type` filter, rerun, and
  state the relaxation in `search_summary`; if still zero, return empty
- HTTP 429 from arcgis.com — back off 15 seconds and retry once
- License metadata ambiguous or missing on an item — report the license as
  `unverified` rather than guessing a tier

## Cost + timeout

- Max cost per invocation: $0.05 (budget cap)
- Max duration: 60 seconds
- Typical actual cost: $0.02, typical duration: 5 seconds
