---
title: "pgvector Index Types: HNSW vs IVFFlat"
category: oss
topic_tags: [pgvector, hnsw, ivfflat, ann-index, vector-search, performance]
status: stub
---

# pgvector Index Types: HNSW vs IVFFlat

pgvector offers two approximate-nearest-neighbor index types; without one, every query is an exact sequential scan. HNSW (`CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);`) builds a hierarchical navigable small-world graph — better recall/speed tradeoff, no training step, can be created on an empty table, but slower to build and more memory-hungry; tune with `m` (default 16) and `ef_construction` (default 64) at build time and `SET hnsw.ef_search = 100;` at query time. IVFFlat (`CREATE INDEX ON items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1000);`) clusters vectors into inverted lists — faster build and smaller footprint, but requires representative data present at creation (train on ~rows/1000 lists, rule of thumb `lists = rows/1000` up to 1M rows, then `sqrt(rows)`), and query recall depends on `SET ivfflat.probes = 10;`. The operator class must match the query operator: `vector_l2_ops` for `<->`, `vector_cosine_ops` for `<=>`, `vector_ip_ops` for `<#>` — an index on cosine ops will not serve an L2 query. Default recommendation: HNSW for read-heavy workloads and datasets that grow incrementally (like Dymaxion's message memory); IVFFlat when build time or RAM is the constraint. Both index types only kick in for `ORDER BY embedding <op> value LIMIT k` queries. Reindex after bulk deletes or major distribution shifts, and monitor recall by comparing against exact-scan results on a sample.

TODO: expand from authoritative source (github.com/pgvector/pgvector README — Indexing section).
