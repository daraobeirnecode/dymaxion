---
title: "Analysis: Spatial Clustering with DBSCAN and HDBSCAN"
category: workflow-patterns
topic_tags: [clustering, dbscan, hdbscan, kmeans, postgis, hotspots]
status: stub
---

# Analysis: Spatial Clustering with DBSCAN and HDBSCAN

Density-based clustering finds arbitrary-shaped clusters and labels sparse points as noise — usually the right model for incident, crime, or customer point patterns, unlike k-means which forces every point into a convex cluster and needs k up front. PostGIS ships it as the window function `ST_ClusterDBSCAN(geom, eps := 100, minpoints := 5) OVER ()`, returning a cluster id (NULL for noise); run it on projected geometry so `eps` is in meters, and pair with `ST_ClusterKMeans` when a fixed cluster count is genuinely wanted. DBSCAN's weakness is a single global `eps` — datasets with varying density (urban vs rural Sacramento County) fragment or over-merge; HDBSCAN removes `eps`, extracting clusters across density scales with `min_cluster_size` as the main knob, available via the `hdbscan` package or `sklearn.cluster.HDBSCAN` (scikit-learn >= 1.3). For lat/lon inputs in scikit-learn, use `metric='haversine'` on radians rather than raw degrees. Esri equivalents: Density-based Clustering (`arcpy.stats.DensityBasedClustering` with DBSCAN/HDBSCAN/OPTICS methods) and, for statistically-tested hotspots rather than clusters, Hot Spot Analysis (Getis-Ord Gi*, `arcpy.stats.HotSpots`). Choose parameters from the data: a k-distance plot (distance to the minpoints-th neighbor) exposes the natural `eps` elbow. Post-process clusters into polygons with `ST_ConcaveHull(ST_Collect(geom), 0.8)` per cluster id for mapping, and always report the noise fraction — a 60%-noise result usually means the phenomenon is not clustered at the chosen scale.

TODO: expand from authoritative source (PostGIS ST_ClusterDBSCAN docs; hdbscan library documentation; Esri Density-based Clustering tool reference).
