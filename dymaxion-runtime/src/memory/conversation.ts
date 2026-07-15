// Conversation memory: every inbound/outbound message persisted and
// embedded; recall = recent window + vector-similar history + knowledge-base
// seeds (gateway 'system-seed').

import { and, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { embedOne } from './embedding.js';
import { logger } from '../observability/logger.js';
import type { IncomingMessage } from '../gateways/common.js';

export async function persistIncoming(msg: IncomingMessage, projectId?: string): Promise<string> {
  let embedding: number[] | undefined;
  try {
    embedding = await embedOne(msg.body.slice(0, 8000));
  } catch (err) {
    logger.warn({ err }, 'embedding failed for incoming message (stored without vector)');
  }
  const [row] = await db
    .insert(schema.messages)
    .values({
      gateway: msg.gateway,
      sourceId: msg.source_id,
      direction: 'inbound',
      body: msg.body,
      attachments: msg.attachments.length ? msg.attachments : null,
      embedding,
      receivedAt: msg.received_at,
      projectId: projectId ?? null,
    })
    .returning({ id: schema.messages.id });
  return row.id;
}

export async function persistOutgoing(
  gateway: string,
  sourceId: string,
  body: string,
  projectId?: string,
): Promise<void> {
  await db.insert(schema.messages).values({
    gateway,
    sourceId,
    direction: 'outbound',
    body,
    projectId: projectId ?? null,
  });
}

export interface RecalledContext {
  recent: Array<{ direction: string; body: string }>;
  similar: Array<{ body: string; gateway: string }>;
  knowledge: Array<{ body: string }>;
}

/** Load conversational + knowledge context relevant to a new message. */
export async function loadRelevant(msg: IncomingMessage): Promise<RecalledContext> {
  const recent = await db
    .select({ direction: schema.messages.direction, body: schema.messages.body })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.gateway, msg.gateway),
        eq(schema.messages.sourceId, msg.source_id),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.receivedAt))
    .limit(10);

  let similar: RecalledContext['similar'] = [];
  let knowledge: RecalledContext['knowledge'] = [];
  try {
    const vector = await embedOne(msg.body.slice(0, 8000));
    const vectorLiteral = `[${vector.join(',')}]`;
    similar = (await db.execute(dsql`
      SELECT body, gateway FROM dymaxion.messages
      WHERE embedding IS NOT NULL AND gateway <> 'system-seed' AND deleted_at IS NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector LIMIT 5
    `)) as unknown as RecalledContext['similar'];
    knowledge = (await db.execute(dsql`
      SELECT body FROM dymaxion.messages
      WHERE embedding IS NOT NULL AND gateway = 'system-seed'
      ORDER BY embedding <=> ${vectorLiteral}::vector LIMIT 5
    `)) as unknown as RecalledContext['knowledge'];
  } catch (err) {
    logger.warn({ err }, 'similarity recall unavailable');
  }
  return { recent: recent.reverse(), similar, knowledge };
}
