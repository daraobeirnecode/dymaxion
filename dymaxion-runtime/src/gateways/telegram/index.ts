// Telegram gateway — Sprint 1 default. Long-polling (no public ingress),
// admin-chat-ID gate, voice memos via whisper, photo/document download to
// /workspace/data/attachments/, inline-keyboard approvals, 20s progress
// pings during long steps, markdown replies.

import { closeSync, constants, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type Attachment,
  type Gateway,
  type IncomingHandler,
  type IncomingMessage,
  type MessageTarget,
  type OutgoingAttachment,
  type OutgoingMessage,
  type Plan,
  type PlanStep,
  type StepResult,
} from '../common.js';
import { decideApproval, awaitDecision } from '../../security/approval.js';
import {
  chunkApprovalReview,
  formatApprovalReview,
} from '../../security/approval-review.js';
import { logger } from '../../observability/logger.js';
import { readVerifiedDeliverable, trustedArtifactRootFromEnv } from '../../workflows/deliverable-storage.js';

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string };
    data?: string;
  };
}

interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number };
  photo?: Array<{ file_id: string; width: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR ?? '/workspace/data/attachments';
const MAX_ATTACHMENT_BYTES = Number(process.env.TELEGRAM_MAX_ATTACHMENT_BYTES ?? 25 * 1024 * 1024);
const PROGRESS_INTERVAL_MS = 20_000;

export function sanitizeTelegramFilename(name: string): string {
  const leaf = basename(name.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return leaf || 'attachment';
}

export function secureAttachmentPath(root: string, hash: string, name: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, `${hash}-${sanitizeTelegramFilename(name)}`);
  const rel = relative(canonicalRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('telegram attachment path escapes configured directory');
  }
  return target;
}

export async function readTelegramFileLimited(response: Response, maxBytes = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`telegram attachment exceeds ${maxBytes} byte limit`);
  if (!response.body) throw new Error('telegram file response had no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`telegram attachment exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export function writeTelegramAttachment(root: string, hash: string, name: string, data: Buffer): string {
  const target = secureAttachmentPath(root, hash, name);
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return target;
}

export function telegramApproverIdentity(adminChatId: string, fromId: number): string {
  if (!adminChatId || String(fromId) !== String(adminChatId)) {
    throw new Error('unauthorized Telegram approval callback');
  }
  return `telegram:${fromId}`;
}

export class TelegramGateway implements Gateway {
  readonly name = 'telegram';
  private handler: IncomingHandler | null = null;
  private running = false;
  private offset = 0;
  private readonly pendingApprovals = new Map<
    string,
    { request: ApprovalRequest; resolve: (response: ApprovalResponse) => void }
  >();

  constructor(
    private readonly botToken: string,
    private readonly adminChatId: string,
    private readonly pollIntervalMs = 1000,
    private readonly whisperUrl = process.env.WHISPER_URL ?? 'http://dymaxion-whisper:8000',
  ) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  private async sendVerifiedDocument(target: MessageTarget, attachment: OutgoingAttachment): Promise<void> {
    const bytes = await readVerifiedDeliverable({
      path: attachment.path,
      trustedRoot: trustedArtifactRootFromEnv(),
      expectedSha256: attachment.sha256,
      expectedBytes: attachment.bytes,
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    const filename = sanitizeTelegramFilename(attachment.original_name);
    const payload = Uint8Array.from(bytes);
    const form = new FormData();
    form.append('chat_id', target.source_id);
    form.append('document', new Blob([payload.buffer], { type: attachment.mime }), filename);
    form.append('caption', `${filename} | ${attachment.bytes} bytes | sha256 ${attachment.sha256}`);
    const response = await fetch(this.api('sendDocument'), { method: 'POST', body: form });
    const data = (await response.json()) as { ok: boolean; description?: string };
    if (!response.ok || !data.ok) {
      throw new Error(`telegram sendDocument failed: ${data.description ?? `HTTP ${response.status}`}`);
    }
  }

  async start(): Promise<void> {
    if (!this.botToken) throw new Error('TELEGRAM_BOT_TOKEN not set');
    this.running = true;
    logger.info('telegram gateway: long-polling started');
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  onMessage(handler: IncomingHandler): void {
    this.handler = handler;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TgUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update).catch((err) =>
            logger.error({ err }, 'telegram update handling failed'),
          );
        }
      } catch (err) {
        logger.warn({ err }, 'telegram poll error — backing off 5s');
        await sleep(5000);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return;

    // Private-bot gate
    if (String(msg.chat.id) !== String(this.adminChatId)) {
      await this.call('sendMessage', { chat_id: msg.chat.id, text: 'This bot is private.' });
      return;
    }

    let body = msg.text ?? msg.caption ?? '';
    const attachments: Attachment[] = [];

    if (msg.voice) {
      body = await this.transcribeVoice(msg.voice.file_id);
    }
    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      attachments.push(await this.downloadFile(best.file_id, 'photo.jpg'));
    }
    if (msg.document) {
      attachments.push(
        await this.downloadFile(msg.document.file_id, msg.document.file_name ?? 'document', msg.document.mime_type),
      );
    }
    if (!body && !attachments.length) return;

    const incoming: IncomingMessage = {
      gateway: this.name,
      source_id: String(msg.chat.id),
      from: {
        id: String(msg.from?.id ?? msg.chat.id),
        display_name: msg.from?.first_name ?? msg.from?.username ?? 'operator',
      },
      body,
      attachments,
      received_at: new Date(),
      metadata: { message_id: msg.message_id, voice: Boolean(msg.voice) },
    };
    await this.handler?.(incoming);
  }

  private async handleCallback(cb: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    // callback data: "approve:<approvalId>" | "reject:<approvalId>"
    const [action, approvalId] = (cb.data ?? '').split(':');
    if ((action === 'approve' || action === 'reject') && approvalId) {
      let decidedBy: string;
      try {
        decidedBy = telegramApproverIdentity(this.adminChatId, cb.from.id);
      } catch {
        await this.call('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: 'unauthorized',
        });
        return;
      }
      const decision = action === 'approve' ? 'approved' : 'rejected';
      const accepted = await decideApproval(approvalId, decision, decidedBy);
      const pending = this.pendingApprovals.get(approvalId);
      if (pending) {
        const response: ApprovalResponse = accepted
          ? {
              approval_id: approvalId,
              approved: decision === 'approved',
              decision,
              decided_by: decidedBy,
            }
          : await awaitDecision(pending.request);
        pending.resolve(response);
        this.pendingApprovals.delete(approvalId);
      }
      await this.call('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: accepted ? decision : 'already decided or expired',
      });
    }
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    const attachment = await this.downloadFile(fileId, 'voice.oga', 'audio/ogg');
    const form = new FormData();
    const { readFileSync } = await import('node:fs');
    form.append('file', new Blob([readFileSync(attachment.path)]), 'voice.oga');
    const res = await fetch(`${this.whisperUrl}/transcribe`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`whisper transcription failed: HTTP ${res.status}`);
    const data = (await res.json()) as { text: string };
    return data.text;
  }

  private async downloadFile(fileId: string, name: string, mime?: string): Promise<Attachment> {
    const file = await this.call<{ file_path: string }>('getFile', { file_id: fileId });
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
    const buf = await readTelegramFileLimited(res);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const path = writeTelegramAttachment(ATTACHMENTS_DIR, hash, name, buf);
    return { path, mime, original_name: name };
  }

  async send(target: MessageTarget, msg: OutgoingMessage): Promise<void> {
    await this.call('sendMessage', {
      chat_id: target.source_id,
      text: msg.body.slice(0, 4000),
      parse_mode: 'Markdown',
    }).catch(async () => {
      // markdown parse failures fall back to plain text
      await this.call('sendMessage', { chat_id: target.source_id, text: msg.body.slice(0, 4000) });
    });
  }

  async sendPlan(target: MessageTarget, plan: Plan): Promise<void> {
    const lines = [
      `*Plan:* ${plan.summary}`,
      ...plan.steps.map(
        (s) => `${s.index + 1}. ${s.description}${s.destructive ? ' _(requires approval)_' : ''}`,
      ),
    ];
    await this.send(target, { body: lines.join('\n') });
  }

  async sendProgress(target: MessageTarget, step: PlanStep, result: StepResult): Promise<void> {
    const status = result.ok ? 'done' : `FAILED — ${result.error}`;
    await this.send(target, {
      body: `Step ${step.index + 1} (${step.skill}): ${status} [${Math.round(result.duration_ms / 1000)}s]`,
    });
  }

  async sendFinal(
    target: MessageTarget,
    narrative: string,
    attachments: OutgoingAttachment[] = [],
  ): Promise<void> {
    await this.send(target, { body: narrative });
    for (const attachment of attachments) {
      await this.sendVerifiedDocument(target, attachment);
    }
  }

  async requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResponse> {
    const chunks = chunkApprovalReview(formatApprovalReview(req));
    for (const [index, chunk] of chunks.entries()) {
      const isFinalChunk = index === chunks.length - 1;
      await this.call('sendMessage', {
        chat_id: target.source_id,
        text: chunk,
        ...(isFinalChunk
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Approve exact payload above', callback_data: `approve:${req.id}` },
                    { text: 'Reject', callback_data: `reject:${req.id}` },
                  ],
                ],
              },
            }
          : {}),
      });
    }

    // Resolve on button press, or fall through to DB polling (dashboard decision / expiry).
    return new Promise<ApprovalResponse>((resolve) => {
      this.pendingApprovals.set(req.id, { request: req, resolve });
      void awaitDecision(req).then((response) => {
        const pending = this.pendingApprovals.get(req.id);
        if (pending) {
          this.pendingApprovals.delete(req.id);
          pending.resolve(response);
        }
      });
    });
  }

  /** Periodic "still working" pings for long-running steps. */
  startProgressPinger(target: MessageTarget, description: () => string): () => void {
    const timer = setInterval(() => {
      void this.send(target, { body: `Still working — ${description()}` });
    }, PROGRESS_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
