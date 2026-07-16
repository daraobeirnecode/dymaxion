// Knowledge-base loader — chunks every doc in knowledge-base/ into
// ~800-token segments (100-token overlap, paragraph-boundary aware), embeds
// with voyage-3-large, and inserts into dymaxion.messages under
// gateway 'system-seed' / direction 'reference'. With --refresh, only files
// whose mtime is newer than their last-embedded timestamp are re-embedded.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { embed } from '../memory/embedding.js';
import { logger } from '../observability/logger.js';

const CHUNK_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4; // cheap heuristic; Voyage tokenization is close enough for chunk sizing

interface KbDoc {
  path: string;
  relPath: string;
  mtime: Date;
  category: string;
  topicTags: string[];
  body: string;
}

function kbRoot(): string {
  return process.env.KNOWLEDGE_BASE_DIR ?? '/workspace/knowledge-base';
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkMarkdown(full);
    else if (entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md') yield full;
  }
}

function parseDoc(path: string): KbDoc {
  const raw = readFileSync(path, 'utf8');
  const relPath = relative(kbRoot(), path);
  let topicTags: string[] = [];
  let category = relPath.split('/')[0] ?? 'general';
  let body = raw;

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const tagsMatch = fm[1].match(/topic_tags:\s*\[([^\]]*)\]/);
    if (tagsMatch) topicTags = tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean);
    const catMatch = fm[1].match(/^category:\s*(\S+)/m);
    if (catMatch) category = catMatch[1];
  }
  return { path, relPath, mtime: statSync(path).mtime, category, topicTags, body };
}

/** Paragraph-boundary chunking with overlap. */
export function chunkText(text: string): string[] {
  const maxChars = CHUNK_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current.length + p.length + 2 > maxChars && current) {
      chunks.push(current);
      current = current.slice(-overlapChars) + '\n\n' + p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface PendingChunk {
  doc: KbDoc;
  chunkIndex: number;
  text: string;
}

// Voyage keys without a payment method are capped at 10K tokens/min, so keep
// each batch comfortably under that; embed() handles 429 backoff between
// batches.
const BATCH_TOKEN_BUDGET = 8_000;

export async function loadKnowledgeBase(refresh = false): Promise<{ files: number; chunks: number }> {
  const root = kbRoot();
  if (!existsSync(root)) {
    logger.warn({ root }, 'knowledge-base dir not found');
    return { files: 0, chunks: 0 };
  }

  // Pass 1: collect every chunk that needs (re-)embedding.
  const pending: PendingChunk[] = [];
  const filesTouched = new Set<string>();
  for (const path of walkMarkdown(root)) {
    const doc = parseDoc(path);

    if (refresh) {
      const existing = (await db.execute(dsql`
        SELECT max(received_at) AS embedded_at FROM dymaxion.messages
        WHERE gateway = 'system-seed' AND attachments->>'source_file' = ${doc.relPath}
      `)) as unknown as Array<{ embedded_at: Date | null }>;
      const embeddedAt = existing[0]?.embedded_at;
      if (embeddedAt && new Date(embeddedAt) >= doc.mtime) continue;
    }

    const parts = chunkText(doc.body);
    if (!parts.length) continue;
    parts.forEach((text, chunkIndex) => pending.push({ doc, chunkIndex, text: text.slice(0, 8000) }));
    filesTouched.add(doc.relPath);
  }

  // Replace prior chunks for touched files (idempotent reload).
  for (const relPath of filesTouched) {
    await db.execute(dsql`
      DELETE FROM dymaxion.messages
      WHERE gateway = 'system-seed' AND attachments->>'source_file' = ${relPath}
    `);
  }

  // Pass 2: embed in token-bounded batches (one API call per batch).
  let done = 0;
  while (done < pending.length) {
    const batch: PendingChunk[] = [];
    let budget = 0;
    while (done + batch.length < pending.length) {
      const next = pending[done + batch.length];
      const estTokens = Math.ceil(next.text.length / 4);
      if (batch.length > 0 && budget + estTokens > BATCH_TOKEN_BUDGET) break;
      batch.push(next);
      budget += estTokens;
    }

    const vectors = await embed(batch.map((c) => c.text));
    for (let i = 0; i < batch.length; i++) {
      const { doc, chunkIndex, text } = batch[i];
      await db.insert(schema.messages).values({
        gateway: 'system-seed',
        sourceId: doc.relPath,
        direction: 'reference',
        body: text,
        embedding: vectors[i],
        attachments: {
          source_file: doc.relPath,
          topic_tags: doc.topicTags,
          category: doc.category,
          chunk: chunkIndex,
        },
      });
    }
    done += batch.length;
    logger.info({ embedded: done, total: pending.length }, 'knowledge batch embedded');
  }

  return { files: filesTouched.size, chunks: pending.length };
}
