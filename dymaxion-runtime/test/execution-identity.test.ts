import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExecutionCredentialIdentity } from '../src/security/execution-identity.js';

test('destructive execution identity comes only from trusted runtime configuration', () => {
  const previous = process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
  try {
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = JSON.stringify({
      edit_feature_service: 'arcgis:prod-org:user-123',
    });
    assert.equal(
      resolveExecutionCredentialIdentity('edit_feature_service'),
      'arcgis:prod-org:user-123',
    );
    assert.throws(
      () => resolveExecutionCredentialIdentity('model_invented_skill'),
      /no trusted execution identity configured/,
    );
  } finally {
    if (previous === undefined) delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
    else process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = previous;
  }
});

test('destructive execution fails closed for absent or malformed identity configuration', () => {
  const previous = process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
  try {
    delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
    assert.throws(() => resolveExecutionCredentialIdentity('delete_file'), /no trusted execution identity/);
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = '[]';
    assert.throws(() => resolveExecutionCredentialIdentity('delete_file'), /JSON object keyed by skill slug/);
    process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = '{broken';
    assert.throws(() => resolveExecutionCredentialIdentity('delete_file'), /valid JSON/);
  } finally {
    if (previous === undefined) delete process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON;
    else process.env.DYMAXION_CREDENTIAL_IDENTITIES_JSON = previous;
  }
});
