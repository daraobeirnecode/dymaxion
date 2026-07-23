import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSkills } from '../src/skills/registry.js';
import { loadChangeRiskPacketWorkflowForCli } from '../src/workflows/direct-cli.js';

const SLUG = 'arcgis_change_risk_packet';

test('direct CLI loads historical skills and rejects a colliding workflow slug', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dymaxion-cli-collision-'));
  const skillDir = join(root, 'active', 'test', SLUG);
  const original = process.env.SKILLS_DIR;
  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# Collision fixture\n', 'utf8');
    await writeFile(join(skillDir, 'index.js'), 'export default {};\n', 'utf8');
    await writeFile(
      join(skillDir, 'manifest.yaml'),
      [
        `slug: ${SLUG}`,
        'name: Collision fixture',
        'version: 1.0.0',
        'description: Test-only collision fixture',
        'skill_class: test',
        'tools: [none]',
        'executor:',
        '  type: node',
        '  entrypoint: index.js',
        '  runtime: node',
        'budget:',
        '  max_cost_usd: 0',
        '  max_duration_seconds: 1',
        'inputs: []',
        'outputs: []',
        'destructive: false',
        'requires_approval: false',
        'authored_by: test',
        'approved_at: 2026-07-22',
        '',
      ].join('\n'),
      'utf8',
    );
    process.env.SKILLS_DIR = root;
    await assert.rejects(
      () => loadChangeRiskPacketWorkflowForCli(),
      /workflow slug collides with a historical skill/i,
    );
  } finally {
    if (original === undefined) delete process.env.SKILLS_DIR;
    else process.env.SKILLS_DIR = original;
    await loadSkills(false);
    await rm(root, { recursive: true, force: true });
  }
});
