import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runArcpy,
  runProCli,
  workerAvailable,
  workerExecutionEnabled,
} from '../src/worker/client.js';

test('Phase 0 Windows Worker cannot dispatch prompt-supplied execution', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    assert.equal(workerExecutionEnabled(), false);
    assert.equal(workerAvailable(), false);
    await assert.rejects(
      runArcpy({ script: 'print("must-not-run")', inputs: { target: 'C:\\outside' } }),
      /disabled in Phase 0/i,
    );
    await assert.rejects(
      runProCli({ operation: 'arbitrary-operation', input_path: 'C:\\outside' }),
      /disabled in Phase 0/i,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
