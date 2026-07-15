---
slug: feature-service-schema-inspect
name: Feature Service Schema Inspect
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Feature Service Schema Inspect

## Purpose

Read a Feature Service layer's metadata and return its field list (names,
types, aliases, nullability), coded-value and range domains, and basic layer
facts: geometry type, spatial reference, editability, record limits.

## When to use this skill

- User asks "what fields does this layer have" or "what are the valid values
  for STATUS"
- A downstream skill (feature-service-edit, dashboard-scaffold,
  permit-monitor) needs to validate field names before acting
- User is deciding whether a layer supports editing or attachments

## When NOT to use this skill

- User wants the actual feature data — use `feature-service-query`
- User wants an org-wide inventory of items — use `arcgis-online-item-audit`
- The target is an enterprise geodatabase table, not a service — use
  `enterprise-gdb-connect`

## Inputs

- `service_url` (string, required): Feature Service root URL
- `layer_id` (number, required): layer index within the service
- `include_domains` (boolean, optional): resolve coded-value and range
  domains, including subtype-specific domains. Default true

## Outputs

- `fields` (array): one entry per field — name, type, alias, length,
  nullable, editable, domain name, inferred role
- `domains` (object): domain name → {type, codedValues | range}
- `layer_info` (object): geometryType, spatialReference (wkid),
  capabilities, maxRecordCount, supportsAttachments, editingInfo.lastEditDate

## Tools required

- `esri-mcp` — layer metadata resource (`f=json`)

## Execution plan

1. Check `service_url` against the employer-boundary allowlist
2. GET the layer resource via esri-mcp (`/{layer_id}?f=json`)
3. Parse `fields[]`; capture name, type, alias, length, nullable, editable
4. If `include_domains`, collect field-level domains plus subtype overrides
   from `types[]` and `subtypes[]`
5. Assemble `layer_info` from geometryType, extent.spatialReference,
   capabilities, maxRecordCount, supportsAttachments, editingInfo
6. One classification-tier LLM call to tag each field with a role
   (identifier / measure / category / date / geometry-support)
7. Return `fields`, `domains`, `layer_info`

## LLM prompts

### Field role tagging (classification tier)

System: You classify GIS attribute fields. For each field, output exactly one
role from: identifier, measure, category, date, freetext, geometry-support.
Output JSON only: {"FIELD_NAME": "role", ...}. No commentary.

User: Layer geometry type: {geometry_type}. Fields (name, type, alias,
domain): {fields_json}. Tag each field.

## Failure modes

- `layer_id` not present in the service — fail with the list of available
  layer ids and names from the service root resource
- 401/499 token required — fail immediately with a message naming the portal
  and the credential needed; never retry unauthenticated
- Subtype references a domain that is missing from the layer JSON — return
  `fields` with the domain name only and add a warning key in `layer_info`

## Cost + timeout

- Max cost per invocation: $0.05 (budget cap)
- Max duration: 60 seconds
- Typical actual cost: $0.01, typical duration: 3 seconds
