import assert from 'node:assert/strict';
import test from 'node:test';
import { runGisBench } from '../src/gisbench/run.js';

test('GISBench matches exactly twenty-five committed golden tasks (5 Phase 0 + 5 Phase 1A + 5 Phase 1B + 5 Phase 1C + 5 Phase 1D)', async () => {
  const result = await runGisBench(false);
  assert.equal(result.tasks.length, 25);
  assert.equal(result.failed, 0, JSON.stringify(result.tasks.filter((task) => !task.ok), null, 2));
  assert.equal(result.passed, 25);
  for (const task of result.tasks) {
    assert.equal(task.ok, true);
    assert.ok(task.operations.includes('boundary_preflight'));
  }
  const arcgisTasks = result.tasks.filter((task) => task.id.startsWith('arcgis-'));
  assert.equal(arcgisTasks.length, 15);
  const dependencyTasks = result.tasks.filter((task) => task.id.startsWith('arcgis-dependency-'));
  assert.equal(dependencyTasks.length, 5);
  const queryTasks = result.tasks.filter((task) => task.id.startsWith('arcgis-query-'));
  assert.equal(queryTasks.length, 5);
  const validateTasks = result.tasks.filter((task) => task.id.startsWith('validate-'));
  assert.equal(validateTasks.length, 5);
});
