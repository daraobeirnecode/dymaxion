import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReplayStepKind,
  createReplayAfterKindValidation,
} from '../src/agent/replay-contract.js';

const WORKFLOW = 'arcgis_change_risk_packet';
const CAPABILITY = 'inspect_dataset';

test('replay requires an exact stored registry kind and never infers legacy plans', async () => {
  assert.equal(assertReplayStepKind({ skill: WORKFLOW, kind: 'workflow' }), 'workflow');
  assert.equal(assertReplayStepKind({ skill: CAPABILITY, kind: 'native-capability' }), 'native-capability');

  assert.throws(() => assertReplayStepKind({ skill: WORKFLOW }), /kind does not match/i);
  assert.throws(
    () => assertReplayStepKind({ skill: WORKFLOW, kind: 'historical-skill' }),
    /kind does not match/i,
  );
  assert.throws(
    () => assertReplayStepKind({ skill: CAPABILITY, kind: 'workflow' }),
    /kind does not match/i,
  );
  assert.throws(
    () => assertReplayStepKind({ skill: 'missing_replay_target', kind: 'historical-skill' }),
    /unavailable or ambiguous/i,
  );

  let replayRowsCreated = 0;
  await assert.rejects(
    () => createReplayAfterKindValidation(
      { steps: [{ skill: WORKFLOW, kind: 'historical-skill' }] },
      async () => { replayRowsCreated += 1; return 'created'; },
    ),
    /kind does not match/i,
  );
  assert.equal(replayRowsCreated, 0, 'altered stored plans must fail before replay-row creation');

  const created = await createReplayAfterKindValidation(
    { steps: [{ skill: WORKFLOW, kind: 'workflow' }] },
    async () => { replayRowsCreated += 1; return 'created'; },
  );
  assert.equal(created, 'created');
  assert.equal(replayRowsCreated, 1);
});
