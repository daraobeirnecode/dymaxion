import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Canonical } from '../src/contracts/canonical.js';
import {
  InMemoryApprovalStore,
  claimConsumedApprovalReceipt,
  consumeApproval,
  consumeApprovalExecutionGrant,
  createApprovalRequest,
  decideApproval,
  deriveApprovalTarget,
  verifyConsumedApprovalExecutionGrant,
} from '../src/security/approval.js';

const now = new Date('2026-07-18T12:00:00.000Z');
const clock = () => new Date(now);
const noAudit = async () => undefined;

function dependencies(store: InMemoryApprovalStore) {
  return { store, now: clock, audit: noAudit };
}

const payload = {
  service_url: 'https://example.maps.arcgis.com/arcgis/rest/services/test/FeatureServer/0',
  edits: [{ id: 1, value: 'approved' }],
  credential_identity: 'arcgis:user-123',
};
const target = deriveApprovalTarget('edit_feature_service', payload);
const credentialIdentity = 'arcgis:user-123';

test('destructive approvals fail closed when no exact target is declared', () => {
  assert.throws(
    () => deriveApprovalTarget('destructive_without_target', { edits: [{ id: 1 }] }),
    /exact target/i,
  );
});

test('approval is bound to canonical payload, exact target, identity, and expiry', async () => {
  const store = new InMemoryApprovalStore();
  const req = await createApprovalRequest(
    'run-1',
    'Apply one edit',
    payload,
    { timeoutMinutes: 30, target, credentialIdentity },
    dependencies(store),
  );

  assert.match(req.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(req.target, target);
  assert.equal(req.credential_identity, 'arcgis:user-123');
  assert.equal(req.expires_at, '2026-07-18T12:30:00.000Z');
  assert.equal(await decideApproval(req.id, 'approved', 'operator-a', dependencies(store)), true);

  await assert.rejects(
    () =>
      consumeApproval(
        req,
        { ...payload, edits: [{ id: 1, value: 'mutated' }] },
        target,
        credentialIdentity,
        dependencies(store),
      ),
    /binding mismatch/i,
  );
  await assert.rejects(
    () => consumeApproval(req, payload, `${target}:swapped`, credentialIdentity, dependencies(store)),
    /binding mismatch/i,
  );
  await assert.rejects(
    () => consumeApproval(req, payload, target, 'arcgis:other-user', dependencies(store)),
    /binding mismatch/i,
  );
  const forgedPayload = { ...payload, edits: [{ id: 99 }] };
  const forgedRequest = {
    ...req,
    payload_hash: sha256Canonical(forgedPayload),
  };
  await assert.rejects(
    () =>
      consumeApproval(
        forgedRequest,
        forgedPayload,
        forgedRequest.target,
        forgedRequest.credential_identity,
        dependencies(store),
      ),
    /not consumable/i,
  );

  const forgedRunRequest = {
    ...req,
    agent_run_id: 'run-other',
  };
  await assert.rejects(
    () => consumeApproval(forgedRunRequest, payload, target, credentialIdentity, dependencies(store)),
    /not consumable/i,
  );

  const consumed = await consumeApproval(
    req,
    payload,
    target,
    credentialIdentity,
    dependencies(store),
  );
  assert.equal(consumed.snapshot.decision, 'approved');
  assert.equal(consumed.snapshot.approval_id, req.id);
  await assert.rejects(
    () => consumeApproval(req, payload, target, credentialIdentity, dependencies(store)),
    /already consumed|not consumable/i,
  );
});

test('execution grants consume once, verify repeatedly at sinks, and source receipts claim once', async () => {
  const store = new InMemoryApprovalStore();
  const req = await createApprovalRequest(
    'run-grant',
    'One-shot execution grant',
    payload,
    { timeoutMinutes: 30, target, credentialIdentity },
    dependencies(store),
  );
  assert.equal(await decideApproval(req.id, 'approved', 'operator-a', dependencies(store)), true);
  const receipt = await consumeApproval(req, payload, target, credentialIdentity, dependencies(store));
  const binding = {
    agentRunId: 'run-grant',
    skill: 'edit_feature_service',
    payload,
    credentialIdentity,
  };
  const grant = claimConsumedApprovalReceipt(receipt, binding);
  assert.throws(
    () => verifyConsumedApprovalExecutionGrant(grant, binding),
    /invalid consumed approval execution grant/i,
  );
  assert.equal(consumeApprovalExecutionGrant(grant, binding).approval_id, req.id);
  assert.equal(verifyConsumedApprovalExecutionGrant(grant, binding).approval_id, req.id);
  assert.equal(verifyConsumedApprovalExecutionGrant(grant, binding).approval_id, req.id);
  assert.throws(
    () => consumeApprovalExecutionGrant(grant, binding),
    /already used/i,
  );
  assert.throws(
    () => claimConsumedApprovalReceipt(receipt, binding),
    /already claimed/i,
  );
});

test('decision and consumption are one-time atomic operations under concurrency', async () => {
  const store = new InMemoryApprovalStore();
  const req = await createApprovalRequest(
    'run-2',
    'Atomic edit',
    payload,
    { timeoutMinutes: 30, target, credentialIdentity },
    dependencies(store),
  );

  const decisions = await Promise.all([
    decideApproval(req.id, 'approved', 'operator-a', dependencies(store)),
    decideApproval(req.id, 'rejected', 'operator-b', dependencies(store)),
  ]);
  assert.equal(decisions.filter(Boolean).length, 1);

  const record = await store.get(req.id);
  assert.ok(record?.decision);
  if (record.decision === 'approved') {
    const results = await Promise.allSettled([
      consumeApproval(req, payload, target, credentialIdentity, dependencies(store)),
      consumeApproval(req, payload, target, credentialIdentity, dependencies(store)),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  }
});

test('rejected approvals and replayed consumption fail closed', async () => {
  const store = new InMemoryApprovalStore();
  const req = await createApprovalRequest(
    'run-rejected',
    'Rejected edit',
    payload,
    { timeoutMinutes: 30, target, credentialIdentity },
    dependencies(store),
  );
  assert.equal(await decideApproval(req.id, 'rejected', 'operator-a', dependencies(store)), true);
  assert.equal(await decideApproval(req.id, 'approved', 'operator-b', dependencies(store)), false);
  await assert.rejects(
    () => consumeApproval(req, payload, target, credentialIdentity, dependencies(store)),
    /not consumable/i,
  );
});

test('expired approvals cannot be decided or consumed', async () => {
  const store = new InMemoryApprovalStore();
  const req = await createApprovalRequest(
    'run-3',
    'Expiring edit',
    payload,
    { timeoutMinutes: 1, target, credentialIdentity },
    dependencies(store),
  );

  now.setMinutes(now.getMinutes() + 2);
  try {
    assert.equal(await decideApproval(req.id, 'approved', 'late-operator', dependencies(store)), false);
    await assert.rejects(
      () => consumeApproval(req, payload, target, credentialIdentity, dependencies(store)),
      /expired|not consumable/i,
    );
    assert.equal((await store.get(req.id))?.decision, 'expired');
  } finally {
    now.setTime(Date.parse('2026-07-18T12:00:00.000Z'));
  }
});
