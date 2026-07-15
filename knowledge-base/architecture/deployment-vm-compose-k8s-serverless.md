---
title: "Deployment: Single VM vs Docker Compose vs Kubernetes vs Serverless"
category: architecture
topic_tags: [deployment, docker-compose, kubernetes, serverless, infrastructure, sizing]
status: stub
---

# Deployment: Single VM vs Docker Compose vs Kubernetes vs Serverless

For GIS stacks the deployment ladder is: single VM with systemd services (simplest ops, one failure domain), Docker Compose on one host (reproducible, easy upgrades, still one host — the Dymaxion default on a Mac Mini or Hetzner box), Kubernetes (horizontal scaling, rolling deploys, self-healing — worth it only with multiple nodes and someone to own the cluster), and serverless (per-request billing, zero idle cost, cold starts and package-size limits). A Compose stack of PostGIS + GeoServer/pg_tileserv + nginx on an 8 vCPU/32 GB VM comfortably serves most county-scale workloads; measure before assuming you need more. Kubernetes earns its complexity when you need independent scaling of tile renderers vs databases, multi-tenant isolation via namespaces, or GitOps deployment (ArgoCD/Flux) across environments — GeoServer, pg_tileserv, Martin, and TiTiler all publish Helm charts or container images. Serverless fits stateless, bursty geo-APIs: TiTiler on AWS Lambda for COG tiling, protomaps/PMTiles served straight from S3/Cloudflare R2 with range requests (no server at all), and Cloud Run for containerized OGC API Features services; it fits poorly for PostGIS itself, long-running geoprocessing, and anything needing large in-memory graphs (routing). Databases stay stateful regardless: managed Postgres (RDS/Cloud SQL with PostGIS) or a pinned VM volume with pgBackRest, never an ephemeral container without a volume. ArcGIS Enterprise constrains choices: it supports specific patterns (base deployment on VMs, ArcGIS Enterprise on Kubernetes as a distinct product) and does not decompose into arbitrary containers. Decision heuristic: start at Compose, move up only when a measured limit (CPU on tile render, single-host availability SLA, tenant isolation) forces it — each rung roughly triples operational surface area.

TODO: expand from authoritative source (Docker Compose and Kubernetes production guidance; Esri ArcGIS Enterprise on Kubernetes docs; TiTiler/PMTiles serverless deployment guides).
