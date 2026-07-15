---
title: pgvector Setup and Distance Operators
category: oss
topic_tags: [pgvector, embeddings, postgres, similarity-search, vector-database]
status: stub
---

# pgvector Setup and Distance Operators

Install pgvector with `CREATE EXTENSION vector;`, then declare columns like `embedding vector(1536)` where the dimension must match the embedding model (1536 for OpenAI text-embedding-3-small, 1024 for Cohere embed-v3, 768 for many sentence-transformers). Three distance operators drive similarity search: `<->` is Euclidean/L2 distance, `<=>` is cosine distance (1 - cosine similarity), and `<#>` is negative inner product — pick the operator matching how the model was trained, cosine being the common default for text embeddings. A typical query is `SELECT id, content FROM dymaxion.messages ORDER BY embedding <=> $1 LIMIT 10;`. pgvector also ships `halfvec` (16-bit floats, half the storage), `sparsevec`, and `bit` types, plus `vector_dims()`, `l2_normalize()`, and aggregate `avg(vector)`. Combine vector search with SQL filters (`WHERE project_id = ...`) for hybrid retrieval, and with `tsvector` full-text search for reciprocal-rank-fusion patterns. In the Dymaxion memory schema, `dymaxion.messages` rows are embedded on write and retrieved by cosine distance. For spatial workflows, image-patch embeddings enable remote-sensing similarity search ("find tiles that look like this") stored alongside PostGIS geometries in the same row.

TODO: expand from authoritative source (github.com/pgvector/pgvector README).
