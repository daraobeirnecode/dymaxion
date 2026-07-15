---
slug: arcgis-online-webmap-clone
name: ArcGIS Online Web Map Clone
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# ArcGIS Online Web Map Clone

## Purpose

Clone a Web Map item from a source ArcGIS Online org into a target org,
remapping the operational-layer and basemap data source URLs so the clone
points at the target org's services. Creates a new item in the target org —
destructive, approval required per source.

## When to use this skill

- Org migration: "move this web map to our new org"
- Promoting a map from a dev/staging org to a production org
- Re-pointing a map at replatformed services (with `url_remap` supplied)

## When NOT to use this skill

- Copying a map within the same org — use the portal's native copy; no
  remapping needed
- Cloning apps, dashboards, or StoryMaps that reference the map — those need
  their own clone pass; this skill handles the Web Map item only
- The target services don't exist yet — publish them first
  (`feature-layer-publish`), then clone

## Inputs

- `webmap_item_id` (string, required): 32-char item id in the source org
- `source_org_url` (string, required): source org URL
- `target_org_url` (string, required): target org URL
- `url_remap` (object, optional): explicit source URL → target URL overrides;
  wins over automatic matching
- `target_folder` (string, optional): destination folder in the target org

## Outputs

- `cloned_item_id` (string): item id of the new Web Map in the target org
- `remap_report` (object): every source URL, the target URL used, how it was
  resolved (override / matched / unresolved), and post-clone reachability

## Tools required

- `esri-mcp` — item data fetch (source), content search (target), addItem
  (target)

## Execution plan

1. Fetch the Web Map JSON from the source org; verify both orgs are on the
   allowlist
2. Enumerate every URL: operationalLayers, baseMap layers, tables
3. Build the remap table: apply `url_remap` overrides first, then search the
   target org for items with matching titles/service names
4. Workhorse LLM resolves ambiguous matches and drafts the approval summary:
   one line per URL, source → target, unresolved URLs flagged
5. Approval gate — operator approves the remap table per source URL
6. `addItem` in the target org with the rewritten Web Map JSON, into
   `target_folder`
7. Verify each remapped layer answers a metadata request from the target
   org's context
8. Return `cloned_item_id` + `remap_report`

## LLM prompts

### Remap resolution + approval summary (workhorse tier)

System: You match GIS service URLs between orgs. For each source URL, pick
the best target candidate or mark it UNRESOLVED — never invent a URL. Then
draft an approval summary: one line per URL, `source -> target (method)`.
Flag every UNRESOLVED line at the top.

User: Source Web Map layers: {layer_urls_json}. Explicit overrides:
{url_remap_json}. Target org candidates (title, url, type):
{candidates_json}. Resolve and draft the summary.

## Failure modes

- One or more URLs unresolved — proceed only if the operator approves; the
  clone keeps the original URL and `remap_report` marks the layer as likely
  broken in the target org
- addItem title collision in the target folder — suffix the title with
  `-clone-YYYYMMDD` rather than overwriting anything
- Source map uses private layers the target org cannot reach — reachability
  check fails; listed per layer in `remap_report`; clone still created
- Approval denied or timed out — abort; nothing is created in the target org

## Cost + timeout

- Max cost per invocation: $0.20 (budget cap)
- Max duration: 300 seconds (excluding operator approval wait)
- Typical actual cost: $0.10, typical duration: 30 seconds + approval wait
