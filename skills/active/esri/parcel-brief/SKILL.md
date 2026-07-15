---
slug: parcel-brief
name: Parcel Brief
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Parcel Brief

## Purpose

Given a parcel APN and an ArcGIS portal URL, produce a one-page PDF brief
containing parcel attributes, adjacent parcels, zoning designation, and
permit history within the last 24 months.

## When to use this skill

- User asks about a specific parcel by APN
- User asks for a "brief" or "summary" of a parcel
- User asks about zoning or recent permits for an address (do an address→APN
  lookup first, then invoke this skill)

## When NOT to use this skill

- User asks about a general area or neighborhood — use area-analysis skills
- Portal doesn't expose the required layers (parcels + zoning at minimum) —
  fail with a layer inventory rather than fabricating sections
- User wants live monitoring of permits on the parcel — use `permit-monitor`

## Inputs

- `apn` (string, required): the parcel APN in format `###-###-###`
- `portal_url` (string, required): the ArcGIS portal URL where parcel data
  lives
- `output_path` (string, optional): destination for the PDF. Default:
  `/workspace/data/parcel-briefs/{apn}-{date}.pdf`

## Outputs

- `brief_pdf_path` (string): absolute path to the generated PDF
- `parcel_summary_json` (object): structured summary — attributes, adjacent
  APNs, zoning code, permit list

## Tools required

- `esri-mcp` — feature service queries against parcel, zoning, permit layers
- `filesystem-mcp` — writing the rendered PDF

## Execution plan

1. Validate APN format (`###-###-###`); validate portal is on the allowlist
2. Discover the parcel, zoning, and permit layers on the portal (cached in
   `dymaxion.datasets` after first run)
3. Query the parcel layer for geometry + attributes by APN
4. Query adjacent parcels: intersect a 10 ft buffer of the parcel boundary
5. Query zoning: intersect the parcel centroid with the zoning layer
6. Query permits: spatial join to the parcel, filter to the last 24 months
7. Workhorse LLM drafts the 3-paragraph narrative from the collected data
8. Render the PDF with the WeasyPrint template via filesystem-mcp
9. Return `brief_pdf_path` + `parcel_summary_json`

## LLM prompts

### Draft narrative (workhorse tier)

System: You are a concise parcel-brief writer. Produce factual, dated
observations. Cite the source layer for every claim. No adjectives.

User: Parcel {apn}. Attributes: {attrs}. Adjacent parcels: {adjacent}.
Zoning: {zoning}. Permits (24 months): {permits}. Write a 3-paragraph brief:
(1) parcel + attributes, (2) context (adjacency, zoning), (3) permit
activity.

## Failure modes

- Feature service unreachable — wait 30s, retry once, then fail with a clear
  error pointing to the portal status page
- APN not found — return a brief containing only the "not found" note and an
  empty `parcel_summary_json`; do not guess a nearby APN
- No permit layer available on the portal — skip the permits section and
  state its absence in the brief
- PDF render fails (template error) — return `parcel_summary_json` anyway
  with `brief_pdf_path` empty and the render error in the run log

## Cost + timeout

- Max cost per invocation: $0.40 (budget cap)
- Max duration: 120 seconds
- Typical actual cost: $0.20, typical duration: 25 seconds
