import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Canonical, sha256Text } from '../src/contracts/canonical.js';
import { assertValidationSourceHashes, normalizeResult } from '../src/gisbench/run.js';

function validResult() {
  const passport = {
    source_uri: 'file:///tmp/fixtures/a.geojson',
    source_handle: '/tmp/fixtures/a.geojson',
    file_sha256: 'a'.repeat(64),
  };
  const canonicalParameters = '{"source_uri":"/tmp/fixtures/a.geojson"}';
  return {
    ok: true,
    costUsd: 0,
    output: {
      passport,
      evidence: {
        source: {
          uri: passport.source_uri,
          identity: { value: passport.source_handle },
          version: { modified_at: '2026-07-18T12:00:00.000Z' },
          sha256: passport.file_sha256,
        },
        parameters: {
          canonical_json: canonicalParameters,
          sha256: sha256Text(canonicalParameters),
        },
        outputs: [{ name: 'dataset_passport', sha256: sha256Canonical(passport) }],
      },
    },
  };
}

test('GISBench changes only normalization fields declared by the task', () => {
  const normalized = normalizeResult(
    validResult(),
    ['$.output.passport.source_uri'],
    '/tmp',
    '/tmp/fixtures',
  ) as { output: { passport: { source_uri: string; source_handle: string } } };
  assert.equal(normalized.output.passport.source_uri, '<FIXTURE_URI>');
  assert.equal(normalized.output.passport.source_handle, '/tmp/fixtures/a.geojson');
  assert.throws(
    () => normalizeResult(validResult(), ['$.output.not_a_contract_field'], '/tmp', '/tmp/fixtures'),
    /unsupported declared normalization field/,
  );
});

test('GISBench validates evidence hashes before normalization can hide them', () => {
  const result = validResult();
  result.output.evidence.outputs[0]!.sha256 = '0'.repeat(64);
  assert.throws(
    () =>
      normalizeResult(
        result,
        ['$.output.evidence.outputs[0].sha256'],
        '/tmp',
        '/tmp/fixtures',
      ),
    /output hash must validate before normalization/,
  );
});

test('GISBench rejects jointly forged validation report/evidence source hashes before normalization', () => {
  const rawBytes = Buffer.from('{"type":"FeatureCollection","features":[]}');
  const truthful = sha256Text(rawBytes);
  const forged = 'b'.repeat(64);
  assert.notEqual(forged, truthful);
  // report and evidence agree with each other but both differ from the raw
  // fixture bytes — the recomputation must fail closed.
  assert.throws(
    () =>
      assertValidationSourceHashes(
        { report: { file_sha256: forged }, evidence: { source: { sha256: forged } } },
        rawBytes,
      ),
    /recomputed raw fixture hash/,
  );
  assert.doesNotThrow(() =>
    assertValidationSourceHashes(
      { report: { file_sha256: truthful }, evidence: { source: { sha256: truthful } } },
      rawBytes,
    ),
  );
});
