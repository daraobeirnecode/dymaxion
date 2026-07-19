import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProposedSkillSlug } from '../src/skills/author.js';

test('model-authored skill slugs cannot become filesystem paths', () => {
  assert.equal(validateProposedSkillSlug('safe-skill-1'), 'safe-skill-1');
  for (const value of ['../escape', 'nested/path', '/absolute', '.', '..', 'MixedCase', 'a'.repeat(65)]) {
    assert.throws(() => validateProposedSkillSlug(value), /generated skill slug/);
  }
});
