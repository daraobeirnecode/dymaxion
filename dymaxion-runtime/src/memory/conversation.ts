// Conversation memory: every inbound/outbound message persisted and
// embedded; recall = recent window + vector-similar history + knowledge-base
// seeds (gateway 'system-seed').

import { and, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { embedOne } from './embedding.js';
import { logger } from '../observability/logger.js';
import type { IncomingMessage } from '../gateways/common.js';

export interface PersistIncomingOptions {
  embedInBackground?: boolean;
}

export async function persistIncoming(
  msg: IncomingMessage,
  projectId?: string,
  options: PersistIncomingOptions = {},
): Promise<string> {
  // Persist first. Embedding is useful for future recall but must not delay the
  // current response, especially on Voyage's low-RPM tier.
  const [row] = await db
    .insert(schema.messages)
    .values({
      gateway: msg.gateway,
      sourceId: msg.source_id,
      direction: 'inbound',
      body: msg.body,
      attachments: msg.attachments.length ? msg.attachments : null,
      receivedAt: msg.received_at,
      projectId: projectId ?? null,
    })
    .returning({ id: schema.messages.id });

  if (options.embedInBackground === true) {
    void embedOne(msg.body.slice(0, 8000))
      .then((embedding) =>
        db.update(schema.messages).set({ embedding }).where(eq(schema.messages.id, row.id)),
      )
      .catch((err) =>
        logger.warn({ err, messageId: row.id }, 'background message embedding failed'),
      );
  }
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

/** Load the recent conversation without any external embedding request. */
export async function loadRecent(msg: IncomingMessage): Promise<RecalledContext['recent']> {
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
  return recent.reverse();
}

/** Load recent conversation plus semantic knowledge for an actionable request. */
export async function loadRelevant(
  msg: IncomingMessage,
  messageId?: string,
): Promise<RecalledContext> {
  const recent = await loadRecent(msg);
  const similar: RecalledContext['similar'] = [];
  let knowledge: RecalledContext['knowledge'] = [];
  try {
    // Interactive recall gets one short, bounded embedding attempt. Message
    // persistence embeds separately in the background for future searches.
    const vector = await embedOne(msg.body.slice(0, 8000), {
      maxRetries: 2,
      timeoutMs: 10_000,
      maxWaitMs: 4_000,
    });
    if (messageId) {
      await db
        .update(schema.messages)
        .set({ embedding: vector })
        .where(eq(schema.messages.id, messageId));
    }
    const vectorLiteral = `[${vector.join(',')}]`;
    knowledge = (await db.execute(dsql`
      SELECT body FROM dymaxion.messages
      WHERE embedding IS NOT NULL AND gateway = 'system-seed'
      ORDER BY embedding <=> ${vectorLiteral}::vector LIMIT 5
    `)) as unknown as RecalledContext['knowledge'];
  } catch (err) {
    logger.warn({ err }, 'knowledge recall unavailable');
  }
  return { recent, similar, knowledge };
}
