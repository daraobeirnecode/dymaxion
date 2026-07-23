// Web gateway — SSE endpoints consumed by the admin dashboard's chat UI
// (dymaxion-admin /(chat) → POST /api/chat proxies here). The runtime hosts
// a small HTTP server on :8787 (Tailscale-internal via docker network, never
// published): POST /api/message streams run events as SSE; GET /api/status
// reports runtime state; POST /api/approvals/:id records dashboard decisions.

import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type ApprovalRequest,
  type ApprovalResponse,
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
import { awaitDecision, decideApproval } from '../../security/approval.js';
import { allSkills } from '../../skills/registry.js';
import { workerAvailable, workerConfigured, workerExecutionEnabled } from '../../worker/client.js';
import { logger } from '../../observability/logger.js';
import { authenticateInternalApproval } from '../../security/internal-approval-auth.js';
import { approvalReview } from '../../security/approval-review.js';
import {
  deliverablePath,
  MAX_DELIVERABLE_BYTES,
  parseDeliverableHandle,
  readVerifiedDeliverable,
  trustedArtifactRootFromEnv,
} from '../../workflows/deliverable-storage.js';

const PORT = Number(process.env.RUNTIME_HTTP_PORT ?? 8787);
const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;
const ARTIFACT_TOKEN_TTL_SECONDS = 5 * 60;

interface ArtifactDownloadIdentity {
  handle: string;
  sha256: string;
  bytes: number;
  expiresAt: number;
}

function artifactTokenSecret(): Buffer {
  const value = process.env.RUNTIME_INTERNAL_TOKEN?.trim();
  if (!value) throw new Error('artifact download authentication is not configured');
  return Buffer.from(value, 'utf8');
}

export function encodeArtifactDownloadToken(
  attachment: OutgoingAttachment,
  nowMs = Date.now(),
): string {
  const expiresAt = Math.floor(nowMs / 1000) + ARTIFACT_TOKEN_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ h: attachment.handle, s: attachment.sha256, b: attachment.bytes, e: expiresAt }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', artifactTokenSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeArtifactDownloadToken(
  token: string,
  nowMs = Date.now(),
): ArtifactDownloadIdentity {
  const match = TOKEN_RE.exec(token);
  if (!match) throw new Error('invalid artifact token');
  const [, payload, suppliedSignature] = match;
  const expectedSignature = createHmac('sha256', artifactTokenSecret()).update(payload!).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(suppliedSignature!, 'base64url');
  } catch {
    throw new Error('invalid artifact token');
  }
  if (provided.length !== expectedSignature.length || !timingSafeEqual(provided, expectedSignature)) {
    throw new Error('invalid artifact token');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid artifact token');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('invalid artifact token');
  }
  const data = decoded as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !== 'b,e,h,s' ||
    typeof data.h !== 'string' ||
    data.h.length > 256 ||
    typeof data.s !== 'string' ||
    !SHA256_RE.test(data.s) ||
    !Number.isSafeInteger(data.b) ||
    (data.b as number) <= 0 ||
    (data.b as number) > MAX_DELIVERABLE_BYTES ||
    !Number.isSafeInteger(data.e) ||
    (data.e as number) <= Math.floor(nowMs / 1000)
  ) {
    throw new Error('invalid artifact token');
  }
  parseDeliverableHandle(data.h);
  return {
    handle: data.h,
    sha256: data.s,
    bytes: data.b as number,
    expiresAt: data.e as number,
  };
}

export function webArtifactAttachmentMetadata(
  attachment: OutgoingAttachment,
  nowMs = Date.now(),
): {
  original_name: string;
  mime: 'text/markdown' | 'image/svg+xml' | 'application/zip';
  sha256: string;
  bytes: number;
  handle: string;
  download_url: string;
} {
  const mime = attachment.mime.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'text/markdown' && mime !== 'image/svg+xml' && mime !== 'application/zip') {
    throw new Error('unsupported artifact media type');
  }
  return {
    original_name: attachment.original_name,
    mime,
    sha256: attachment.sha256,
    bytes: attachment.bytes,
    handle: attachment.handle,
    download_url: `/api/artifacts/${encodeArtifactDownloadToken(attachment, nowMs)}`,
  };
}

export function publicArtifactFileName(
  entry: 'bundle.zip' | 'change-ticket.md' | 'dependency-map.svg',
): 'evidence-bundle.zip' | 'change-ticket.md' | 'dependency-map.svg' {
  return entry === 'bundle.zip' ? 'evidence-bundle.zip' : entry;
}

/** Re-verify trusted bytes at the Web delivery handoff before minting a download URL. */
export async function verifiedWebArtifactAttachmentMetadata(
  attachment: OutgoingAttachment,
  nowMs = Date.now(),
): Promise<ReturnType<typeof webArtifactAttachmentMetadata>> {
  await readVerifiedDeliverable({
    trustedRoot: trustedArtifactRootFromEnv(),
    path: attachment.path,
    expectedSha256: attachment.sha256,
    expectedBytes: attachment.bytes,
    maxBytes: MAX_DELIVERABLE_BYTES,
  });
  return webArtifactAttachmentMetadata(attachment, nowMs);
}

export class WebGateway implements Gateway {
  readonly name = 'web';
  private handler: IncomingHandler | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  // session_id → live SSE response
  private readonly streams = new Map<string, ServerResponse>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server!.listen(PORT, '0.0.0.0', resolve));
    logger.info({ port: PORT }, 'web gateway: runtime HTTP API listening');
  }

  async stop(): Promise<void> {
    for (const res of this.streams.values()) res.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  onMessage(handler: IncomingHandler): void {
    this.handler = handler;
  }

  private async route(req: HttpRequest, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://runtime');
      if (req.method === 'POST' && url.pathname === '/api/message') {
        await this.handleMessage(req, res);
      } else if (req.method === 'GET' && url.pathname === '/api/status') {
        this.handleStatus(res);
      } else if (req.method === 'GET' && url.pathname.startsWith('/api/artifacts/')) {
        await this.handleArtifactDownload(url.pathname.split('/')[3] ?? '', req, res);
      } else if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        await this.handleApproval(url.pathname.split('/')[3], req, res);
      } else {
        res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'web gateway request failed');
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: 'request failed' }));
    }
  }

  private async handleMessage(req: HttpRequest, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { message, session_id } = JSON.parse(body || '{}') as {
      message?: string;
      session_id?: string;
    };
    if (!message) {
      res.writeHead(400).end(JSON.stringify({ error: 'message required' }));
      return;
    }
    const sessionId = session_id ?? randomUUID();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    this.streams.set(sessionId, res);
    this.emit(sessionId, 'session', { session_id: sessionId });

    const incoming: IncomingMessage = {
      gateway: this.name,
      source_id: sessionId,
      from: { id: 'web-operator', display_name: 'operator' },
      body: message,
      attachments: [],
      received_at: new Date(),
      metadata: {},
    };
    // Run async; events stream to the open SSE response, which sendFinal closes.
    void this.handler?.(incoming).catch((err) => {
      this.emit(sessionId, 'error', { error: String(err) });
      this.closeStream(sessionId);
    });
  }

  private handleStatus(res: ServerResponse): void {
    const skills = allSkills();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        status: 'ok',
        skills_registered: skills.length,
        skills_available: skills.filter((s) => s.available).length,
        windows_worker: !workerExecutionEnabled()
          ? 'disabled-phase-0'
          : workerConfigured()
            ? workerAvailable()
              ? 'available'
              : 'unreachable'
            : 'not-configured',
      }),
    );
  }

  private async handleArtifactDownload(token: string, req: HttpRequest, res: ServerResponse): Promise<void> {
    const authenticated = authenticateInternalApproval(req.headers);
    if (authenticated.ok === false) {
      res.writeHead(authenticated.status, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: authenticated.error }),
      );
      return;
    }
    try {
      const identity = decodeArtifactDownloadToken(token);
      const trustedRoot = trustedArtifactRootFromEnv();
      const parsed = parseDeliverableHandle(identity.handle);
      const path = deliverablePath(trustedRoot, parsed);
      const bytes = await readVerifiedDeliverable({
        path,
        trustedRoot,
        expectedSha256: identity.sha256,
        expectedBytes: identity.bytes,
      });
      const mediaType =
        parsed.entry === 'bundle.zip'
          ? 'application/zip'
          : parsed.entry === 'change-ticket.md'
            ? 'text/markdown; charset=utf-8'
            : 'image/svg+xml; charset=utf-8';
      res.writeHead(200, {
        'Content-Type': mediaType,
        'Content-Length': bytes.byteLength,
        'Content-Disposition': `attachment; filename="${publicArtifactFileName(parsed.entry)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${identity.sha256}"`,
      });
      res.end(bytes);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(
        JSON.stringify({ error: 'artifact unavailable' }),
      );
    }
  }

  private async handleApproval(id: string, req: HttpRequest, res: ServerResponse): Promise<void> {
    const authenticated = authenticateInternalApproval(req.headers);
    if (authenticated.ok === false) {
      res.writeHead(authenticated.status).end(JSON.stringify({ error: authenticated.error }));
      return;
    }
    const body = JSON.parse((await readBody(req)) || '{}') as {
      decision?: 'approved' | 'rejected';
    };
    if (!id || (body.decision !== 'approved' && body.decision !== 'rejected')) {
      res.writeHead(400).end(JSON.stringify({ error: 'approved or rejected decision required' }));
      return;
    }
    const accepted = await decideApproval(id, body.decision, authenticated.approverIdentity);
    res.writeHead(accepted ? 200 : 409).end(JSON.stringify({ ok: accepted }));
  }

  private emit(sessionId: string, event: string, data: unknown): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private closeStream(sessionId: string): void {
    this.streams.get(sessionId)?.end();
    this.streams.delete(sessionId);
  }

  async send(target: MessageTarget, msg: OutgoingMessage): Promise<void> {
    this.emit(target.source_id, 'message', { body: msg.body });
  }

  async sendPlan(target: MessageTarget, plan: Plan): Promise<void> {
    this.emit(target.source_id, 'plan', plan);
  }

  async sendProgress(target: MessageTarget, step: PlanStep, result: StepResult): Promise<void> {
    this.emit(target.source_id, 'progress', {
      step: step.index + 1,
      skill: step.skill,
      ok: result.ok,
      error: result.error,
      duration_ms: result.duration_ms,
    });
  }

  async sendFinal(
    target: MessageTarget,
    narrative: string,
    attachments: OutgoingAttachment[] = [],
  ): Promise<void> {
    const verifiedAttachments = await Promise.all(
      attachments.map((attachment) => verifiedWebArtifactAttachmentMetadata(attachment)),
    );
    this.emit(target.source_id, 'final', {
      narrative,
      attachments: verifiedAttachments,
    });
    this.closeStream(target.source_id);
  }

  async requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResponse> {
    this.emit(target.source_id, 'approval_required', {
      ...approvalReview(req),
      payload: req.payload,
    });
    // Decision arrives via POST /api/approvals/:id (chat UI button or dashboard).
    return awaitDecision(req);
  }
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += String(chunk)));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
