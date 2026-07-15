// Telegram gateway — Sprint 1 default. Long-polling (no public ingress),
// admin-chat-ID gate, voice memos via whisper, photo/document download to
// /workspace/data/attachments/, inline-keyboard approvals, 20s progress
// pings during long steps, markdown replies.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type Attachment,
  type Gateway,
  type IncomingHandler,
  type IncomingMessage,
  type MessageTarget,
  type OutgoingMessage,
  type Plan,
  type PlanStep,
  type StepResult,
} from '../common.js';
import { decideApproval, awaitDecision } from '../../security/approval.js';
import { logger } from '../../observability/logger.js';

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
const PROGRESS_INTERVAL_MS = 20_000;

export class TelegramGateway implements Gateway {
  readonly name = 'telegram';
  private handler: IncomingHandler | null = null;
  private running = false;
  private offset = 0;
  private readonly pendingApprovals = new Map<string, (r: ApprovalResponse) => void>();

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
      const decision = action === 'approve' ? 'approved' : 'rejected';
      await decideApproval(approvalId, decision, cb.from.first_name ?? String(cb.from.id));
      this.pendingApprovals.get(approvalId)?.({
        approved: decision === 'approved',
        decision,
        decided_by: cb.from.first_name ?? String(cb.from.id),
      });
      this.pendingApprovals.delete(approvalId);
      await this.call('answerCallbackQuery', { callback_query_id: cb.id, text: decision });
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
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const path = join(ATTACHMENTS_DIR, `${hash}-${name}`);
    writeFileSync(path, buf);
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

  async sendFinal(target: MessageTarget, narrative: string): Promise<void> {
    await this.send(target, { body: narrative });
  }

  async requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResponse> {
    await this.call('sendMessage', {
      chat_id: target.source_id,
      text: `*Approval required*\n${req.step_description}\n\nExpires in ${req.timeout_minutes} min.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${req.id}` },
            { text: 'Reject', callback_data: `reject:${req.id}` },
          ],
        ],
      },
    });

    // Resolve on button press, or fall through to DB polling (dashboard decision / expiry).
    return new Promise<ApprovalResponse>((resolve) => {
      this.pendingApprovals.set(req.id, resolve);
      void awaitDecision(req).then((r) => {
        if (this.pendingApprovals.delete(req.id)) resolve(r);
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
