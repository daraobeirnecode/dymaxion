# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64 + linux/arm64): base images are multi-arch and no
# stage does arch-specific work, so `docker buildx build --platform
# linux/amd64,linux/arm64` produces both natively.

FROM node:20-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim

# --- OS + geospatial CLI stack -----------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ca-certificates \
    python3 python3-pip python3-venv python3-gdal \
    postgresql-client \
    gdal-bin proj-bin \
    osmium-tool \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# QGIS Server / qgis_process via ubuntugis-unstable is Debian-incompatible in
# this base image; cli-anything-qgis degrades gracefully when qgis_process is
# absent. For full QGIS support, extend this image from ubuntu:24.04 +
# ubuntugis-unstable (documented in README).

# --- Python spatial stack ----------------------------------------------
RUN pip3 install --break-system-packages --no-cache-dir \
    arcgis \
    geopandas shapely pyproj rasterio fiona \
    xarray rioxarray stackstac pystac-client \
    dask-geopandas \
    apache-sedona \
    duckdb \
    ibis-framework \
    weasyprint

# QGIS CLI wrapper (from opengeos)
RUN pip3 install --break-system-packages --no-cache-dir cli-anything-qgis || \
    (git clone https://github.com/opengeos/cli-anything-qgis /opt/qgis-cli && \
     pip3 install --break-system-packages --no-cache-dir /opt/qgis-cli) || \
    echo "cli-anything-qgis unavailable at build time — qgis skills degrade"

# ArcGIS Pro CLI + arcpy are Windows-only — proxied via the Windows Worker
# (windows-worker/), never installed here.

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# `docker exec -it dymaxion-runtime dymaxion` → REPL
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/dymaxion && \
    chmod +x /usr/local/bin/dymaxion

ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
