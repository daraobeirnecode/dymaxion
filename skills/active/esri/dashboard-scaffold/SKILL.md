---
slug: dashboard-scaffold
name: Dashboard Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Dashboard Scaffold

## Purpose

Generate an ArcGIS Dashboard configuration from a Feature Service and a
requested widget list, validate every widget against the layer schema, and
save it as a draft dashboard item in the org.

## When to use this skill

- User asks for "a dashboard showing X, Y, Z" over a known Feature Service
- Standing up a monitoring view to pair with `permit-monitor`

## When NOT to use this skill

- Narrative storytelling with maps and images — use `story-map-scaffold`
- The data isn't in a Feature Service yet — publish it first with
  `feature-layer-publish`
- Custom web-app requirements (auth flows, bespoke UI) — use the Category C
  app-scaffold skills

## Inputs

- `service_url` (string, required): backing Feature Service root URL
- `title` (string, required): dashboard title
- `widgets` (array, required): list of `{type, field, statistic, title}`
  intents; `type` is one of `indicator`, `serial-chart`, `pie-chart`,
  `list`, `map`, `gauge`
- `target_folder` (string, optional): destination folder in the org

## Outputs

- `dashboard_item_id` (string): item id of the created draft dashboard
- `dashboard_config` (object): the full Dashboard JSON that was saved

## Tools required

- `esri-mcp` — layer schema read, addItem for the dashboard item

## Execution plan

1. Inspect the layer schema (same call path as
   `feature-service-schema-inspect`) to get fields and types
2. Validate every widget: the field exists and its type suits the widget
   (serial-chart needs a date or numeric axis; indicator statistics need
   numeric fields or count)
3. Fail before creating anything if any widget is invalid, listing each
   invalid widget and the reason
4. Workhorse LLM maps the validated widget intents to Dashboard widget JSON
   with data-source bindings and a 12-column layout
5. Validate the LLM output is well-formed Dashboard JSON; re-prompt once
   with validator errors if not
6. Create the draft dashboard item via addItem in `target_folder`
7. GET the item data back to confirm it loads; return both outputs

## LLM prompts

### Widget config generation (workhorse tier)

System: You emit ArcGIS Dashboard JSON. Bind each widget to the given layer
and use only field names from the provided schema. Choose sensible
statistics and date grouping. Output only the JSON config: header, a
12-column layout, and the widgets array.

User: Layer: {service_url} layer {layer_id}. Fields (name, type):
{fields_json}. Dashboard title: {title}. Requested widgets: {widgets_json}.
Emit the dashboard config.

## Failure modes

- Widget references a missing or type-incompatible field — fail before item
  creation with the per-widget reasons (never silently drop a widget)
- LLM emits invalid Dashboard JSON — re-prompt once with the validator
  errors appended; if still invalid, fail and attach both attempts to the
  run log
- addItem rejected for missing privilege — fail naming the exact privilege
  (`portal:user:createItem`) and the org that refused it

## Cost + timeout

- Max cost per invocation: $0.60 (budget cap)
- Max duration: 300 seconds
- Typical actual cost: $0.30, typical duration: 30-60 seconds
