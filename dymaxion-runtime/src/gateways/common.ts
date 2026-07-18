// Common gateway contract. Every channel (telegram, teams, email, slack,
// cli, web, arcgis-portal, sms) implements Gateway; the runtime is
// channel-agnostic beyond this file.

export interface Attachment {
  path: string;
  mime?: string;
  original_name?: string;
  url?: string;
}

export interface MessageTarget {
  gateway: string;
  source_id: string;
}

export interface IncomingMessage {
  gateway: string;
  source_id: string; // chat_id, thread_id, email address, terminal session, ...
  from: { id: string; display_name: string };
  body: string;
  attachments: Attachment[]; // downloaded to local path
  received_at: Date;
  metadata: Record<string, unknown>; // gateway-specific extras
}

export interface OutgoingMessage {
  body: string;
  attachments?: Attachment[];
}

export interface PlanStep {
  index: number;
  skill: string;
  description: string;
  input: Record<string, unknown>;
  destructive: boolean;
  optional?: boolean;
  timeout_seconds?: number;
}

export type Complexity = 'trivial' | 'simple' | 'complex';

export interface Plan {
  summary: string;
  complexity: Complexity;
  steps: PlanStep[];
}

export interface StepResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  cost_usd: number;
  duration_ms: number;
}

export interface ApprovalRequest {
  id: string;
  agent_run_id: string;
  step_description: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  target: string;
  credential_identity: string;
  requested_at: string;
  expires_at: string;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'expired';

export interface ApprovalResponse {
  approval_id: string;
  approved: boolean;
  decision: ApprovalDecision;
  decided_by: string;
}

export type IncomingHandler = (msg: IncomingMessage) => Promise<void>;

export interface Gateway {
  name: string;
  start(): Promise<void>; // begin polling or listening
  stop(): Promise<void>; // graceful shutdown
  send(target: MessageTarget, msg: OutgoingMessage): Promise<void>;
  sendPlan(target: MessageTarget, plan: Plan): Promise<void>;
  sendProgress(target: MessageTarget, step: PlanStep, result: StepResult): Promise<void>;
  sendFinal(target: MessageTarget, narrative: string, attachments?: Attachment[]): Promise<void>;
  requestApproval(target: MessageTarget, req: ApprovalRequest): Promise<ApprovalResponse>;
  onMessage(handler: IncomingHandler): void;
}

/**
 * Base for Sprint 2+ gateways: importable and registrable so the runtime
 * wiring never changes, but refuses to start until implemented.
 */
export abstract class StubGateway implements Gateway {
  constructor(public readonly name: string) {}

  async start(): Promise<void> {
    throw new Error(
      `Gateway '${this.name}' is not implemented — enable in config/gateways.yaml when ready (later sprint).`,
    );
  }
  async stop(): Promise<void> {
    /* nothing to stop */
  }
  async send(): Promise<void> {
    throw new Error(`Gateway '${this.name}' is not implemented.`);
  }
  async sendPlan(): Promise<void> {
    throw new Error(`Gateway '${this.name}' is not implemented.`);
  }
  async sendProgress(): Promise<void> {
    throw new Error(`Gateway '${this.name}' is not implemented.`);
  }
  async sendFinal(): Promise<void> {
    throw new Error(`Gateway '${this.name}' is not implemented.`);
  }
  async requestApproval(): Promise<ApprovalResponse> {
    throw new Error(`Gateway '${this.name}' is not implemented.`);
  }
  onMessage(_handler: IncomingHandler): void {
    /* stub gateways never emit */
  }
}
