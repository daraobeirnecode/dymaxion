# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64 + linux/arm64): base images are multi-arch and no
# stage does arch-specific work, so `docker buildx build --platform
# linux/amd64,linux/arm64` produces both natively.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# This exact lockfile-resolved production tree is copied into the final image.
# CI builds and audits this stage independently, avoiding the heavyweight GIS
# system packages while proving the Node dependency boundary actually shipped.
FROM node:22-slim AS production-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim AS runtime

# --- OS + geospatial CLI stack -----------------------------------------
# Fiona currently falls back to a source build on linux/arm64, so both GDAL
# and Python development headers are runtime-image build prerequisites.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ca-certificates \
    python3 python3-dev python3-pip python3-venv python3-gdal \
    postgresql-client \
    gdal-bin libgdal-dev proj-bin \
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

# uv — launches Python MCP servers (esri-mcp needs python >=3.12; uv
# provisions its own interpreter on first run)
RUN pip3 install --break-system-packages --no-cache-dir uv

# ArcGIS Pro CLI + arcpy are Windows-only — proxied via the Windows Worker
# (windows-worker/), never installed here.

WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./

# `docker exec -it dymaxion-runtime dymaxion` → REPL
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/dymaxion && \
    chmod +x /usr/local/bin/dymaxion

ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
