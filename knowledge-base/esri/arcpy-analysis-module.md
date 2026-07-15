---
title: arcpy.analysis Module Reference
category: esri
topic_tags: [arcpy, analysis, buffer, clip, intersect, spatial-join]
status: stub
---

# arcpy.analysis Module Reference

Summarizes the Analysis toolbox (`arcpy.analysis.*`) — vector overlay, proximity, and statistics tools. Proximity: `Buffer(in_features, out_fc, "500 Meters", dissolve_option="ALL"|"NONE"|"LIST")` (buffer distance can also be a field), `MultipleRingBuffer`, `Near` (adds NEAR_FID/NEAR_DIST to the input), and `GenerateNearTable`. Overlay: `Clip(in_features, clip_features, out_fc)` cuts features to a boundary keeping input attributes; `Intersect([[fc1,""],[fc2,""]], out_fc)` keeps only overlapping geometry with combined attributes; `Union` keeps all geometry; `Erase` removes areas covered by the erase features; `Identity` and `SymDiff` round out the overlay set. `SpatialJoin(target, join_features, out_fc, join_operation="JOIN_ONE_TO_ONE", match_option="INTERSECT")` transfers attributes by spatial relationship and is often the right answer instead of manual cursor logic. Statistics: `Statistics` (summary stats with case fields), `Frequency`, and `TabulateIntersection(in_zone_features, zone_fields, in_class_features, out_table)` for area/length cross-tabulation between two layers. Covers pairwise variants (`PairwiseBuffer`, `PairwiseClip`, `PairwiseIntersect`, `PairwiseDissolve`) which parallelize better and honor `parallelProcessingFactor`, plus `Select` for simple attribute extraction. Notes licensing: these tools are Basic-level except a few (e.g. Erase historically required Advanced; pairwise tools relaxed this).

TODO: expand from authoritative source (pro.arcgis.com Analysis toolbox arcpy tool reference).
