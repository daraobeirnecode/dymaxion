---
title: MapLibre Expressions and Data-Driven Styling
category: oss
topic_tags: [maplibre, expressions, data-driven-styling, interpolate, filters]
status: stub
---

# MapLibre Expressions and Data-Driven Styling

MapLibre expressions are Lisp-like JSON arrays evaluated per feature on the GPU-bound style layer, replacing the legacy `stops`/`property` functions. Read attributes with `["get", "population"]`, feature metadata with `["zoom"]`, `["id"]`, and `["geometry-type"]`, and feature-state with `["feature-state", "hover"]`. Continuous ramps use `["interpolate", ["linear"], ["zoom"], 5, 1, 12, 4]` (also `exponential` with base, and `cubic-bezier`), while categorical styling uses `["match", ["get","zone"], "R1", "#8dd3c7", "C2", "#fb8072", "#ccc"]` and threshold classing uses `["step", ["get","density"], "#eee", 100, "#9ecae1", 1000, "#3182bd"]` — the standard choropleth pattern. Boolean logic (`all`, `any`, `!`, `==`, `>`, `in`) powers both `filter` properties and conditional `["case", cond1, val1, ..., fallback]` paint values. String/format helpers (`concat`, `upcase`, `number-format`, `format` for mixed-font labels) drive `text-field`, e.g. `["format", ["get","name"], {}, "\n", {}, ["number-format", ["get","pop"], {"locale":"en"}], {"font-scale":0.8}]`. Zoom-and-property interplay: an `interpolate` on zoom whose outputs are themselves `get`-based expressions gives per-feature, per-zoom styling (e.g., population-scaled circles that grow with zoom). `feature-state` expressions enable hover/selection styling without re-uploading data — set via `map.setFeatureState({source, id}, {hover: true})`, requiring stable feature ids (`promoteId` or `generateId` on the source). Expressions are typed; wrap uncertain inputs with `to-number`/`to-string`/`coalesce` to avoid runtime evaluation errors that silently drop features.

TODO: expand from authoritative source (maplibre.org/maplibre-style-spec/expressions).
