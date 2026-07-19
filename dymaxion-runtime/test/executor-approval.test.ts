import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';
import { loadSkills } from '../src/skills/registry.js';

const repoRoot = resolve(import.meta.dirname, '../..');
process.env.SKILLS_DIR = join(repoRoot, 'skills');
process.env.DYMAXION_CONFIG_DIR = join(repoRoot, 'config');
process.env.DYMAXION_WORKSPACE_ROOT = repoRoot;

function dependencies(onBegin: () => void): RunSkillDependencies {
  const audit = async () => undefined;
  return {
    recorder: {
      begin: async () => {
        onBegin();
        throw new Error('invocation persistence reached before approval enforcement');
      },
      finish: async () => undefined,
    },
    audit,
    boundaryOptions: { audit },
    capabilityContext: {},
  };
}

test('shared dispatcher rejects direct destructive skill execution without approval', async () => {
  await loadSkills(false);
  let invocationBegins = 0;

  const result = await runSkill(
    'qgis-project-editor',
    {
      project_path: join(repoRoot, 'gisbench', 'fixtures', 'review-only.qgz'),
      edits: [],
    },
    '00000000-0000-0000-0000-000000000099',
    dependencies(() => {
      invocationBegins += 1;
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /approval.*required|requires.*approval/i);
  assert.equal(invocationBegins, 0);
});
