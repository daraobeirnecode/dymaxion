---
slug: arcgis-online-item-audit
name: ArcGIS Online Item Audit
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# ArcGIS Online Item Audit

## Purpose

Inventory the items in an ArcGIS Online organization (or one folder of it)
and report on ownership, sharing level, last-modified dates, and likely
duplicates, with a findings summary the operator can act on.

## When to use this skill

- User asks "what's in our org", "who owns what", "what's shared publicly",
  or "clean-up candidates"
- Periodic governance review of an org the user administers
- Before a migration, to establish the item baseline (pairs with
  `arcgis-online-webmap-clone`)

## When NOT to use this skill

- Auditing a single known item — fetch its metadata directly with
  `feature-service-schema-inspect` or a plain esri-mcp item call
- The org is not one the user administers or is not on the allowlist
- User wants usage/credit analytics — that data is not in item metadata

## Inputs

- `org_url` (string, required): ArcGIS Online org URL
- `folder` (string, optional): restrict the audit to one folder title
- `owner_filter` (string, optional): restrict to items owned by one username
- `max_items` (number, optional): page cap. Default 1000

## Outputs

- `audit_report` (object): per-item records (id, title, type, owner, access,
  modified, size) plus aggregate counts by type, owner, and sharing level
- `duplicates` (array): duplicate candidate groups with the matching rule
  that flagged them
- `summary` (string): operator-voice findings with concrete counts

## Tools required

- `esri-mcp` — org content search and item metadata

## Execution plan

1. Authenticate against `org_url`; confirm the account can enumerate content
2. Page through content search via esri-mcp, 100 items per page, up to
   `max_items`, applying `folder` / `owner_filter`
3. Collect per item: id, title, type, owner, access, modified, size,
   typeKeywords
4. Flag duplicate candidates: normalized title + same type, or identical
   backing service URL
5. Flag risk items: `access=public` AND modified > 18 months ago; items with
   no owner in the org
6. Workhorse LLM drafts the findings summary from the aggregates
7. Assemble `audit_report` and return all three outputs

## LLM prompts

### Findings summary (workhorse tier)

System: You write content-audit findings for a GIS administrator. Use
concrete numbers, item ids, and dates. Group findings: public-and-stale
first, then duplicates, then ownership gaps. Frame actions as
recommendations with tradeoffs, never commands.

User: Org {org_url}, scope: {scope}. {item_count} items inventoried.
Aggregates: {aggregates_json}. Duplicate groups: {duplicates_json}. Risk
items: {risks_json}. Write the findings summary.

## Failure modes

- Item count exceeds `max_items` — truncate, and state the coverage
  percentage in `summary` so the report is never mistaken for complete
- Account lacks admin privileges — degrade to auditing only the account's
  own items and say so explicitly in `summary`
- HTTP 429 rate limiting mid-pagination — back off 30 seconds and resume
  from the last completed page

## Cost + timeout

- Max cost per invocation: $0.30 (budget cap)
- Max duration: 300 seconds
- Typical actual cost: $0.15, typical duration: 60-120 seconds for a
  500-item org
