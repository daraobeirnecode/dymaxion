import assert from 'node:assert/strict';
import test from 'node:test';
import { runGisBench } from '../src/gisbench/run.js';

test('GISBench matches exactly forty committed golden tasks (5 each for Phases 0, 1A, 1B, 1C, 1D, 1E, 1F, and 1G)', async () => {
  const result = await runGisBench(false);
  assert.equal(result.tasks.length, 40);
  assert.equal(result.failed, 0, JSON.stringify(result.tasks.filter((task) => !task.ok), null, 2));
  assert.equal(result.passed, 40);
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
  const mapArtifactTasks = result.tasks.filter((task) => task.id.startsWith('map-artifact-'));
  assert.equal(mapArtifactTasks.length, 5);
  const vectorAnalysisTasks = result.tasks.filter((task) => task.id.startsWith('vector-analysis-'));
  assert.equal(vectorAnalysisTasks.length, 5);
});
