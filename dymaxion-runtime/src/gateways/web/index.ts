// Web gateway — SSE endpoints consumed by the admin dashboard's chat UI
// (dymaxion-admin /(chat) → POST /api/chat proxies here). The runtime hosts
// a small HTTP server on :8787 (Tailscale-internal via docker network, never
// published): POST /api/message streams run events as SSE; GET /api/status
// reports runtime state; POST /api/approvals/:id records dashboard decisions.

import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type Gateway,
  type IncomingHandler,
  type IncomingMessage,
  type MessageTarget,
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

const PORT = Number(process.env.RUNTIME_HTTP_PORT ?? 8787);

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
      } else if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        await this.handleApproval(url.pathname.split('/')[3], req, res);
      } else {
        res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'web gateway request failed');
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
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

  private async handleApproval(id: string, req: HttpRequest, res: ServerResponse): Promise<void> {
    const authenticated = authenticateInternalApproval(req.headers);
    if (!authenticated.ok) {
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

  async sendFinal(target: MessageTarget, narrative: string): Promise<void> {
    this.emit(target.source_id, 'final', { narrative });
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
