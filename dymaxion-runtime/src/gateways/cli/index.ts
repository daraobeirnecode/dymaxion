// CLI gateway — interactive REPL over stdin/stdout, invoked as
// `docker exec -it dymaxion-runtime dymaxion`. Also serves batch mode
// (`dymaxion run --skill <slug> --input <json>`), `dymaxion project switch`,
// and `dymaxion status` (see src/cli.ts for arg parsing).

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
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
import { formatApprovalReview } from '../../security/approval-review.js';
import { readVerifiedDeliverable, trustedArtifactRootFromEnv } from '../../workflows/deliverable-storage.js';

export class CliGateway implements Gateway {
  readonly name = 'cli';
  private handler: IncomingHandler | null = null;
  private readonly sessionId = randomUUID();
  private rl: ReturnType<typeof createInterface> | null = null;

  async start(): Promise<void> {
    // The daemon's CLI gateway is passive: interactive sessions attach via
    // the `dymaxion` bin (docker exec), which drives runREPL() directly.
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  onMessage(handler: IncomingHandler): void {
    this.handler = handler;
  }

  async send(_target: MessageTarget, msg: OutgoingMessage): Promise<void> {
    process.stdout.write(`${msg.body}\n`);
  }

  async sendPlan(_target: MessageTarget, plan: Plan): Promise<void> {
    process.stdout.write(`\nPlan: ${plan.summary}\n`);
    for (const s of plan.steps) {
      process.stdout.write(
        `  ${s.index + 1}. ${s.description}${s.destructive ? ' (requires approval)' : ''}\n`,
      );
    }
  }

  async sendProgress(_target: MessageTarget, step: PlanStep, result: StepResult): Promise<void> {
    const status = result.ok ? 'ok' : `FAILED — ${result.error}`;
    process.stdout.write(`  [${step.index + 1}] ${step.skill}: ${status} (${Math.round(result.duration_ms / 1000)}s)\n`);
  }

  async sendFinal(
    _target: MessageTarget,
    narrative: string,
    attachments: OutgoingAttachment[] = [],
  ): Promise<void> {
    process.stdout.write(`\n${narrative}\n`);
    if (!attachments.length) return;

    const trustedRoot = trustedArtifactRootFromEnv();
    process.stdout.write('\nVerified deliverables:\n');
    for (const attachment of attachments) {
      await readVerifiedDeliverable({
        trustedRoot,
        path: attachment.path,
        expectedSha256: attachment.sha256,
        expectedBytes: attachment.bytes,
      });
      process.stdout.write(
        `  ${attachment.original_name} | ${attachment.bytes} bytes | sha256 ${attachment.sha256} | handle ${attachment.handle}\n`,
      );
    }
  }

  async requestApproval(_target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResponse> {
    process.stdout.write(`\n${formatApprovalReview(req)}\nApprove this exact payload? [y/N] `);
    const answer = await this.readLine();
    const approved = /^y(es)?$/i.test(answer.trim());
    const decision = approved ? 'approved' : 'rejected';
    const accepted = await decideApproval(req.id, decision, 'cli-operator');
    if (!accepted) return awaitDecision(req);
    return { approval_id: req.id, approved, decision, decided_by: 'cli-operator' };
  }

  private readLine(): Promise<string> {
    return new Promise((resolve) => {
      const rl = this.rl ?? createInterface({ input: process.stdin, output: process.stdout });
      rl.once('line', (line) => resolve(line));
    });
  }

  /** Interactive REPL driver, used by the `dymaxion` bin. */
  async runREPL(): Promise<void> {
    process.stdout.write('dymaxion — GIS agent REPL. Ctrl-D to exit.\n> ');
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of this.rl) {
      const body = line.trim();
      if (!body) {
        process.stdout.write('> ');
        continue;
      }
      const incoming: IncomingMessage = {
        gateway: this.name,
        source_id: this.sessionId,
        from: { id: 'cli-operator', display_name: 'operator' },
        body,
        attachments: [],
        received_at: new Date(),
        metadata: { tty: process.stdout.isTTY ?? false },
      };
      await this.handler?.(incoming);
      process.stdout.write('> ');
    }
  }

  /** One-shot message (batch mode / piped stdin). */
  async runOnce(body: string): Promise<void> {
    const incoming: IncomingMessage = {
      gateway: this.name,
      source_id: this.sessionId,
      from: { id: 'cli-operator', display_name: 'operator' },
      body,
      attachments: [],
      received_at: new Date(),
      metadata: { batch: true },
    };
    await this.handler?.(incoming);
  }
}
