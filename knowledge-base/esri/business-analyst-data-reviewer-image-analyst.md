---
title: Business Analyst, Data Reviewer, and Image Analyst Extensions
category: esri
topic_tags: [business-analyst, data-reviewer, image-analyst, deep-learning, qa-validation, demographics]
status: stub
---

# Business Analyst, Data Reviewer, and Image Analyst Extensions

Surveys three specialist extensions Dymaxion should recognize in requirements conversations. Business Analyst layers market-planning workflows over the GeoEnrichment data stack: trade areas (rings, drive times, threshold trade areas), Tapestry segmentation profiles, benchmark comparison reports, suitability analysis, and territory design — available as a Pro extension (`arcpy.ba` with `GenerateTradeAreaRings`, `EnrichLayer`, `GenerateSuitabilityAnalysis`), a web app, and BA data bundles (US and international datasets installed locally or consumed online for credits). Data Reviewer is the QA/QC framework: attribute (domain, regex, unique-ID) and spatial (overlap, gap, dangle, duplicate geometry) checks assembled into batch jobs (.rbj legacy) or, in the modern model, attribute rule–based validation (`arcpy.management.EvaluateRules`, error inspector workflows, ready-to-use checks like Feature on Feature and Polyline Must Not Self-Overlap) that write results to error layers for review lifecycles (review/correct/verify). Image Analyst unlocks advanced imagery exploitation in Pro: the deep learning toolset (`ExportTrainingDataForDeepLearning`, `TrainDeepLearningModel`, `DetectObjectsUsingDeepLearning`, `ClassifyPixelsUsingDeepLearning` with .dlpk model packages, PyTorch under the hood via arcgis.learn), pixel/segment classification (`SupportVectureMachine`-style classifiers, ISO clusters), change detection (`ComputeChangeRaster`), motion imagery, SAR tools, and stereo/ortho mapping. Notes license boundaries: Image Analyst overlaps with Spatial Analyst on some raster functions but the deep learning and full-motion-video tools are Image Analyst-only; Business Analyst consumes credits online; modern Data Reviewer capabilities require ArcGIS Data Reviewer licensing on Pro and Enterprise.

TODO: expand from authoritative source (pro.arcgis.com extension documentation for Business Analyst, Data Reviewer, and Image Analyst toolboxes).
