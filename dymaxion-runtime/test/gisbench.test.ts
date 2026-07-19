import assert from 'node:assert/strict';
import test from 'node:test';
import { runGisBench } from '../src/gisbench/run.js';

test('GISBench matches exactly fifteen committed golden tasks (5 Phase 0 + 5 Phase 1A + 5 Phase 1B)', async () => {
  const result = await runGisBench(false);
  assert.equal(result.tasks.length, 15);
  assert.equal(result.failed, 0, JSON.stringify(result.tasks.filter((task) => !task.ok), null, 2));
  assert.equal(result.passed, 15);
  for (const task of result.tasks) {
    assert.equal(task.ok, true);
    assert.ok(task.operations.includes('boundary_preflight'));
  }
  const arcgisTasks = result.tasks.filter((task) => task.id.startsWith('arcgis-'));
  assert.equal(arcgisTasks.length, 10);
  const dependencyTasks = result.tasks.filter((task) => task.id.startsWith('arcgis-dependency-'));
  assert.equal(dependencyTasks.length, 5);
});
