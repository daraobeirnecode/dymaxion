import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  executeCapability,
  executeCapabilityDefinition,
  preflightCapabilityDefinition,
  registerCapabilityForTest,
} from '../src/capabilities/registry.js';
import type { CapabilityDefinition } from '../src/contracts/capability.js';
import { capabilityRequiresApproval } from '../src/contracts/capability.js';
import {
  consumeApproval,
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
  InMemoryApprovalStore,
  type ApprovalStore,
  verifyConsumedApprovalReceipt,
} from '../src/security/approval.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

const RUN_ID = 'run-copy-on-write';
const CREDENTIAL_IDENTITY = 'test:copy-on-write-operator';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const BUNDLE_HASH = 'a'.repeat(64);
const now = new Date('2026-07-20T10:00:00.000Z');
const clock = () => new Date(now);
const noAudit = async () => undefined;

const inputSchema = z
  .object({
    operation: z.enum(['preview', 'persist']),
    project_id: z.string().uuid(),
    target_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
const outputSchema = z
  .object({
    operation: z.enum(['preview', 'persist']),
    persisted: z.boolean(),
    project_id: z.string().uuid(),
  })
  .strict();

type CopyInput = z.infer<typeof inputSchema>;
type CopyOutput = z.infer<typeof outputSchema>;

function makeCopyOnWriteCapability(counter: { executes: number }): CapabilityDefinition<CopyInput, CopyOutput> {
  return {
    manifest: {
      schema_version: '1.0.0',
      slug: 'test_copy_on_write',
      name: 'Test copy-on-write capability',
      description: 'Synthetic test-only copy-on-write native capability',
      version: '1.0.0',
      classification: 'copy-on-write',
      identity: { required: true, permissions: ['test:write'], credential_kinds: ['test'] },
      allowed_hosts: [],
      allowed_sources: [],
      resource_limits: {
        max_records: 1,
        max_bytes: 1024,
        max_duration_ms: 1000,
        max_cost_usd: 0,
      },
      idempotency: { mode: 'deterministic', key_fields: ['operation', 'project_id'] },
      dry_run: { supported: true },
      cancellation: { supported: false },
      artifacts: [],
      rollback: { supported: false, strategy: 'none' },
      validation: { suite: 'test', version: '1.0.0', supported_gis_versions: [] },
      input_schema_version: '1.0.0',
      output_schema_version: '1.0.0',
    },
    inputSchema: inputSchema as z.ZodType<CopyInput>,
    outputSchema: outputSchema as z.ZodType<CopyOutput>,
    inputSummary: ['operation*', 'project_id*', 'target_bundle_sha256'],
    boundaryFields: ['project_id', 'target_bundle_sha256'],
    requiresApproval: (input) => input.operation === 'persist',
    async execute(input) {
      counter.executes += 1;
      return { operation: input.operation, persisted: input.operation === 'persist', project_id: input.project_id };
    },
  };
}

function recorder(events: string[]): RunSkillDependencies['recorder'] {
  return {
    begin: async () => {
      events.push('begin');
      return `invocation-${events.length}`;
    },
    finish: async () => undefined,
  };
}

function runDeps(events: string[], overrides: Partial<RunSkillDependencies> = {}): Partial<RunSkillDependencies> {
  return {
    recorder: recorder(events),
    audit: noAudit,
    boundaryOptions: { audit: noAudit },
    capabilityContext: {},
    ...overrides,
  };
}

class OrderingApprovalStore implements ApprovalStore {
  constructor(
    private readonly inner: InMemoryApprovalStore,
    private readonly events: string[],
  ) {}
  create(...args: Parameters<ApprovalStore['create']>) {
    return this.inner.create(...args);
  }
  get(...args: Parameters<ApprovalStore['get']>) {
    return this.inner.get(...args);
  }
  decideAtomic(...args: Parameters<ApprovalStore['decideAtomic']>) {
    return this.inner.decideAtomic(...args);
  }
  expireAtomic(...args: Parameters<ApprovalStore['expireAtomic']>) {
    return this.inner.expireAtomic(...args);
  }
  async consumeAtomic(...args: Parameters<ApprovalStore['consumeAtomic']>) {
    const record = await this.inner.consumeAtomic(...args);
    if (record) this.events.push('consume');
    return record;
  }
}

test('conditional copy-on-write helper allows preview and requires persist approval', () => {
  const counter = { executes: 0 };
  const definition = makeCopyOnWriteCapability(counter);

  assert.equal(capabilityRequiresApproval(definition, { operation: 'preview', project_id: PROJECT_ID }), false);
  assert.equal(
    capabilityRequiresApproval(definition, {
      operation: 'persist',
      project_id: PROJECT_ID,
      target_bundle_sha256: BUNDLE_HASH,
    }),
    true,
  );
  assert.throws(() => capabilityRequiresApproval(definition, { operation: 'persist' }), /required|invalid/i);
});

test('preview executes through runSkill and direct registry execution without approval', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  try {
    const events: string[] = [];
    const result = await runSkill(
      'test_copy_on_write',
      { operation: 'preview', project_id: PROJECT_ID },
      RUN_ID,
      runDeps(events),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { operation: 'preview', persisted: false, project_id: PROJECT_ID });
    assert.deepEqual(events, ['begin']);

    const direct = await executeCapability(
      'test_copy_on_write',
      { operation: 'preview', project_id: PROJECT_ID },
      { agentRunId: RUN_ID },
    );
    assert.deepEqual(direct, { operation: 'preview', persisted: false, project_id: PROJECT_ID });
    assert.equal(counter.executes, 2);
  } finally {
    unregister();
  }
});

test('preflight grants are exact-input bound, one-use, and unforgeable', async () => {
  const counter = { executes: 0 };
  const definition = makeCopyOnWriteCapability(counter) as CapabilityDefinition<unknown, unknown>;
  let preflights = 0;
  definition.preflight = async () => {
    preflights += 1;
  };
  const input = inputSchema.parse({ operation: 'preview', project_id: PROJECT_ID });
  const context = { agentRunId: RUN_ID };

  const grant = await preflightCapabilityDefinition(definition, input, context);
  assert.equal(preflights, 1);
  await executeCapabilityDefinition(definition, input, { ...context, capabilityPreflightGrant: grant });
  assert.equal(preflights, 1);
  assert.equal(counter.executes, 1);

  await assert.rejects(
    () => executeCapabilityDefinition(definition, input, { ...context, capabilityPreflightGrant: grant }),
    /invalid capability preflight grant/i,
  );
  await assert.rejects(
    () => executeCapabilityDefinition(definition, input, { ...context, capabilityPreflightGrant: {} }),
    /invalid capability preflight grant/i,
  );

  const mismatchedInputGrant = await preflightCapabilityDefinition(definition, input, context);
  await assert.rejects(
    () =>
      executeCapabilityDefinition(
        definition,
        { operation: 'preview', project_id: '22222222-2222-4222-8222-222222222222' },
        { ...context, capabilityPreflightGrant: mismatchedInputGrant },
      ),
    /invalid capability preflight grant/i,
  );

  const mismatchedRunGrant = await preflightCapabilityDefinition(definition, input, context);
  await assert.rejects(
    () =>
      executeCapabilityDefinition(definition, input, {
        agentRunId: 'run-other',
        capabilityPreflightGrant: mismatchedRunGrant,
      }),
    /invalid capability preflight grant/i,
  );
  assert.equal(counter.executes, 1);
});

test('persist rejects before recorder and execute without approval request', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  try {
    const events: string[] = [];
    const result = await runSkill(
      'test_copy_on_write',
      { operation: 'persist', project_id: PROJECT_ID, target_bundle_sha256: BUNDLE_HASH },
      RUN_ID,
      runDeps(events),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /approval.*required/i);
    assert.deepEqual(events, []);
    assert.equal(counter.executes, 0);
  } finally {
    unregister();
  }
});

test('persist rejects direct registry execution with missing or forged receipt', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  try {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({ test_copy_on_write: CREDENTIAL_IDENTITY });
    const persistInput = { operation: 'persist', project_id: PROJECT_ID, target_bundle_sha256: BUNDLE_HASH };
    await assert.rejects(
      () => executeCapability('test_copy_on_write', persistInput, { agentRunId: RUN_ID }),
      /approval receipt/i,
    );
    await assert.rejects(
      () =>
        executeCapability('test_copy_on_write', persistInput, {
          agentRunId: RUN_ID,
          approvalReceipt: { snapshot: { approval_id: 'fake' } } as never,
        }),
      /approval receipt/i,
    );
    assert.equal(counter.executes, 0);
  } finally {
    unregister();
  }
});

test('consumed approval receipt is unforgeable, immutable, and binding checked', async () => {
  const store = new InMemoryApprovalStore();
  const payload = { operation: 'persist', project_id: PROJECT_ID, target_bundle_sha256: BUNDLE_HASH };
  const req = await createApprovalRequest(
    RUN_ID,
    'Persist bundle',
    payload,
    { timeoutMinutes: 30, target: deriveApprovalTarget('test_copy_on_write', payload), credentialIdentity: CREDENTIAL_IDENTITY },
    { store, now: clock },
  );
  assert.equal(await decideApproval(req.id, 'approved', 'operator-a', { store, now: clock }), true);
  const receipt = await consumeApproval(req, payload, req.target, CREDENTIAL_IDENTITY, { store, now: clock });

  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.snapshot), true);
  const snapshot = verifyConsumedApprovalReceipt(receipt, {
    agentRunId: RUN_ID,
    skill: 'test_copy_on_write',
    payload,
    credentialIdentity: CREDENTIAL_IDENTITY,
  });
  assert.equal(snapshot.approval_id, req.id);
  assert.equal(snapshot.decision, 'approved');
  assert.equal(snapshot.decided_by, 'operator-a');
  assert.equal(snapshot.target, req.target);

  assert.deepEqual(
    verifyConsumedApprovalReceipt(receipt, { agentRunId: RUN_ID, skill: 'test_copy_on_write', payload, credentialIdentity: CREDENTIAL_IDENTITY }),
    snapshot,
  );
  assert.throws(() => verifyConsumedApprovalReceipt({ ...receipt } as never, { agentRunId: RUN_ID, skill: 'test_copy_on_write', payload, credentialIdentity: CREDENTIAL_IDENTITY }), /approval receipt/i);
  assert.throws(
    () => verifyConsumedApprovalReceipt(structuredClone(receipt) as never, { agentRunId: RUN_ID, skill: 'test_copy_on_write', payload, credentialIdentity: CREDENTIAL_IDENTITY }),
    /approval receipt/i,
  );
  assert.throws(
    () =>
      verifyConsumedApprovalReceipt(JSON.parse(JSON.stringify(receipt)) as never, {
        agentRunId: RUN_ID,
        skill: 'test_copy_on_write',
        payload,
        credentialIdentity: CREDENTIAL_IDENTITY,
      }),
    /approval receipt/i,
  );
  assert.throws(
    () => verifyConsumedApprovalReceipt(receipt, {
      agentRunId: 'other-run',
      skill: 'test_copy_on_write',
      payload,
      credentialIdentity: CREDENTIAL_IDENTITY,
    }),
    /binding mismatch/i,
  );
  assert.throws(
    () =>
      verifyConsumedApprovalReceipt(receipt, {
        agentRunId: RUN_ID,
        skill: 'test_copy_on_write',
        payload: { ...payload, target_bundle_sha256: 'b'.repeat(64) },
        credentialIdentity: CREDENTIAL_IDENTITY,
      }),
    /binding mismatch/i,
  );
  assert.throws(
    () => verifyConsumedApprovalReceipt(receipt, {
      agentRunId: RUN_ID,
      skill: 'other_copy_on_write',
      payload,
      credentialIdentity: CREDENTIAL_IDENTITY,
    }),
    /binding mismatch|exact target/i,
  );
  assert.throws(
    () => verifyConsumedApprovalReceipt(receipt, {
      agentRunId: RUN_ID,
      skill: 'test_copy_on_write',
      payload,
      credentialIdentity: 'runtime:wrong-identity',
    }),
    /binding mismatch/i,
  );
});

test('direct native execution rejects a genuine receipt for the wrong credential identity', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  const wrongIdentity = 'runtime:wrong-identity';
  try {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({
      test_copy_on_write: CREDENTIAL_IDENTITY,
    });
    const store = new InMemoryApprovalStore();
    const payload = {
      operation: 'persist',
      project_id: PROJECT_ID,
      target_bundle_sha256: BUNDLE_HASH,
    };
    const request = await createApprovalRequest(
      RUN_ID,
      'Persist bundle with wrong identity',
      payload,
      {
        timeoutMinutes: 30,
        target: deriveApprovalTarget('test_copy_on_write', payload),
        credentialIdentity: wrongIdentity,
      },
      { store, now: clock },
    );
    assert.equal(await decideApproval(request.id, 'approved', 'operator-a', { store, now: clock }), true);
    const receipt = await consumeApproval(request, payload, request.target, wrongIdentity, { store, now: clock });

    await assert.rejects(
      () => executeCapability('test_copy_on_write', payload, { agentRunId: RUN_ID, approvalReceipt: receipt }),
      /binding mismatch/i,
    );
    assert.equal(counter.executes, 0);
  } finally {
    unregister();
  }
});

test('valid approved request consumes once, executes once, and recorder begins only after consumption', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  try {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({ test_copy_on_write: CREDENTIAL_IDENTITY });
    const innerStore = new InMemoryApprovalStore();
    const events: string[] = [];
    const store = new OrderingApprovalStore(innerStore, events);
    const payload = { operation: 'persist', project_id: PROJECT_ID, target_bundle_sha256: BUNDLE_HASH };
    const req = await createApprovalRequest(
      RUN_ID,
      'Persist bundle',
      payload,
      { timeoutMinutes: 30, target: deriveApprovalTarget('test_copy_on_write', payload), credentialIdentity: CREDENTIAL_IDENTITY },
      { store, now: clock },
    );
    assert.equal(await decideApproval(req.id, 'approved', 'operator-a', { store, now: clock }), true);

    const result = await runSkill('test_copy_on_write', payload, RUN_ID, {
      ...runDeps(events),
      approvalRequest: req,
      approvalDependencies: { store, now: clock },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { operation: 'persist', persisted: true, project_id: PROJECT_ID });
    assert.deepEqual(events, ['consume', 'begin']);
    assert.equal(counter.executes, 1);

    const replay = await runSkill('test_copy_on_write', payload, RUN_ID, {
      ...runDeps(events),
      approvalRequest: req,
      approvalDependencies: { store, now: clock },
    });
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? '', /already consumed|not consumable/i);
    assert.equal(counter.executes, 1);
  } finally {
    unregister();
  }
});

test('runSkill ignores caller-supplied forged capabilityContext approval receipt', async () => {
  const counter = { executes: 0 };
  const unregister = registerCapabilityForTest(makeCopyOnWriteCapability(counter));
  try {
    const events: string[] = [];
    const result = await runSkill(
      'test_copy_on_write',
      { operation: 'persist', project_id: PROJECT_ID, target_bundle_sha256: BUNDLE_HASH },
      RUN_ID,
      runDeps(events, { capabilityContext: { approvalReceipt: { snapshot: { approval_id: 'fake' } } as never } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /approval.*required/i);
    assert.deepEqual(events, []);
    assert.equal(counter.executes, 0);
  } finally {
    unregister();
  }
});
