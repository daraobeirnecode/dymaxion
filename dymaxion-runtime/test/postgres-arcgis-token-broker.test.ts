import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { arcgisCredentials } from '../src/db/schema.js';
import {
  ArcGisCredentialMetadataRecordSchema,
  ArcGisCredentialSecretEnvelopeRecordSchema,
  parseArcGisCredentialMetadataRecord,
  parseArcGisCredentialSecretEnvelopeRecord,
} from '../src/security/arcgis-token-records.js';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const MIGRATION = join(REPO_ROOT, 'migrations/005_arcgis_credentials.sql');
const TOKEN_RECORDS_SOURCE = join(REPO_ROOT, 'dymaxion-runtime/src/security/arcgis-token-records.ts');
const TOKEN_REPOSITORY_SOURCE = join(REPO_ROOT, 'dymaxion-runtime/src/security/arcgis-token-repository.ts');
const ALIAS = 'phase2b-reader';
const IDENTITY = 'arcgis:online:synthetic:user:reader';
const EXPIRES_AT = '2026-07-25T13:00:00.000Z';
const CONNECTED_AT = '2026-07-25T12:00:00.000Z';
const REFRESHED_AT = '2026-07-25T12:05:00.000Z';
const ENCRYPTED_ENVELOPE = 'bW9jay1pdi0xMjM0NTY=.bW9jay10YWctMTIzNDU2Nzg=.ZW5jcnlwdGVkLXBoYXNlMmItY2FuYXJ5LXRva2Vu';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function assertSqlContains(sql: string, expected: string): void {
  assert.ok(
    normalizeSql(sql).includes(normalizeSql(expected)),
    `expected migration SQL to include: ${normalizeSql(expected)}`,
  );
}

function assertTimestampColumnIsExplicit(sql: string, column: 'connected_at' | 'refreshed_at'): void {
  const definition = new RegExp(`^\\s*${column}\\s+TIMESTAMPTZ\\s+NOT\\s+NULL\\s*,\\s*$`, 'im');
  const forbiddenDefaultNow = new RegExp(`^\\s*${column}\\b[^,\\n]*\\bDEFAULT\\s+now\\s*\\(\\s*\\)`, 'im');

  assert.match(sql, definition);
  assert.doesNotMatch(sql, forbiddenDefaultNow);
}

function assertDrizzleColumnHasNoDefault(column: unknown, label: string): void {
  const candidate = column as { default?: unknown; defaultFn?: unknown; hasDefault?: boolean; notNull?: boolean };

  assert.equal(candidate.notNull, true, `${label} must remain notNull in Drizzle`);
  assert.equal(candidate.hasDefault, false, `${label} must not expose Drizzle hasDefault behavior`);
  assert.equal(candidate.default, undefined, `${label} must not expose a Drizzle default`);
  assert.equal(candidate.defaultFn, undefined, `${label} must not expose a Drizzle defaultFn`);
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credential_alias: ALIAS,
    credential_identity: IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    token_type: 'Bearer',
    expires_at: EXPIRES_AT,
    connected_at: CONNECTED_AT,
    refreshed_at: REFRESHED_AT,
    connected_by_user: 'synthetic-operator',
    ...overrides,
  };
}

function secretEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credential_alias: ALIAS,
    credential_identity: IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    encrypted_access_token_envelope: ENCRYPTED_ENVELOPE,
    token_type: 'Bearer',
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

function assertMetadataExpiresAtIssue(raw: Record<string, unknown>): void {
  const result = ArcGisCredentialMetadataRecordSchema.safeParse(raw);

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.ok(
    result.error.issues.some((issue) => issue.path.join('.') === 'expires_at'),
    `expected expires_at issue path, got ${JSON.stringify(result.error.issues)}`,
  );
}

function assertMetadataTimestampFieldIssue(
  field: 'expires_at' | 'connected_at' | 'refreshed_at',
  value: string,
): void {
  const result = ArcGisCredentialMetadataRecordSchema.safeParse(metadata({ [field]: value }));

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.ok(
    result.error.issues.some((issue) => issue.path.join('.') === field),
    `expected ${field} issue path, got ${JSON.stringify(result.error.issues)}`,
  );
}

test('pure ArcGIS token record schemas do not import broad connection runtime', () => {
  const source = readFileSync(TOKEN_RECORDS_SOURCE, 'utf8');

  assert.doesNotMatch(source, /from\s+['"]\.\/arcgis-connections\.js['"]/);
});

test('ArcGIS credential repository stays read-only and avoids eager global database imports', () => {
  const source = readFileSync(TOKEN_REPOSITORY_SOURCE, 'utf8');

  assert.doesNotMatch(source, /from\s+['"]\.\.\/db\/client\.js['"]/);
  assert.doesNotMatch(source, /\.(?:insert|update|delete)\s*\(/);
  assert.match(source, /\.where\(eq\(arcgisCredentials\.credentialAlias, alias\)\)/);
  assert.match(source, /\.limit\(1\)/);
});

test('migration creates a dedicated locked ArcGIS credential table without provisioning or URL fields', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS dymaxion\.arcgis_credentials/i);
  assert.match(sql, /credential_alias\s+TEXT\s+PRIMARY KEY/i);
  assert.match(sql, /credential_identity\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /portal_kind\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /permissions\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /encrypted_access_token_envelope\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /token_type\s+TEXT\s+NOT NULL\s+DEFAULT\s+'Bearer'/i);
  assert.match(sql, /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i);
  assert.match(sql, /connected_at\s+TIMESTAMPTZ\s+NOT NULL/i);
  assert.match(sql, /refreshed_at\s+TIMESTAMPTZ\s+NOT NULL/i);
  assertTimestampColumnIsExplicit(sql, 'connected_at');
  assertTimestampColumnIsExplicit(sql, 'refreshed_at');
  assert.match(sql, /connected_by_user\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /CHECK/i);
  assert.match(sql, /portal_kind\s+IN\s+\('arcgis-online',\s*'arcgis-enterprise'\)/i);
  assert.match(sql, /permissions\s*=\s+'\["feature:query"\]'::jsonb/i);
  assert.match(sql, /token_type\s*=\s+'Bearer'/i);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_alias_format
      CHECK (credential_alias ~ '^[a-z][a-z0-9-]{0,63}$')
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_identity_format
      CHECK (credential_identity ~ '^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$')
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_envelope_bounds
      CHECK (
        length(encrypted_access_token_envelope) BETWEEN 48 AND 8192
        AND encrypted_access_token_envelope ~ '^[A-Za-z0-9+/=]{16,64}\\.[A-Za-z0-9+/=]{16,64}\\.[A-Za-z0-9+/=]{16,8064}$'
      )
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_timestamp_millisecond_precision
      CHECK (
        expires_at = date_trunc('milliseconds', expires_at)
        AND connected_at = date_trunc('milliseconds', connected_at)
        AND refreshed_at = date_trunc('milliseconds', refreshed_at)
      )
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_expiry_after_connection
      CHECK (expires_at > connected_at)
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_refreshed_not_before_connected
      CHECK (refreshed_at >= connected_at)
  `);
  assertSqlContains(sql, `
    CONSTRAINT arcgis_credentials_connected_by_user_bounds
      CHECK (length(connected_by_user) BETWEEN 1 AND 256 AND connected_by_user !~ '[\\r\\n\\x00]')
  `);

  for (const forbidden of [
    /\bportal_(?:root|url)\b/i,
    /\bservice_(?:root|url)\b/i,
    /\blayer_url\b/i,
    /\bclient_id\b/i,
    /\bclient_secret\b/i,
    /\brefresh_token\b/i,
    /\baccess_token\s+TEXT\b/i,
    /\bprovision/i,
  ]) {
    assert.doesNotMatch(sql, forbidden);
  }
});

test('Drizzle exposes only the dedicated ArcGIS credential storage columns', () => {
  assert.ok(arcgisCredentials);
  const columns = Object.keys(arcgisCredentials).filter((key) => key !== 'enableRLS').sort();
  assert.deepEqual(columns, [
    'connectedAt',
    'connectedByUser',
    'credentialAlias',
    'credentialIdentity',
    'encryptedAccessTokenEnvelope',
    'expiresAt',
    'permissions',
    'portalKind',
    'refreshedAt',
    'tokenType',
  ].sort());
  for (const forbidden of ['portalRoot', 'portalUrl', 'serviceRoot', 'serviceUrl', 'layerUrl', 'refreshToken', 'clientId', 'clientSecret']) {
    assert.equal(forbidden in arcgisCredentials, false);
  }
});

test('Drizzle ArcGIS credential timestamps require explicit ingestion timestamps', () => {
  assertDrizzleColumnHasNoDefault(arcgisCredentials.connectedAt, 'connectedAt');
  assertDrizzleColumnHasNoDefault(arcgisCredentials.refreshedAt, 'refreshedAt');
});

test('metadata records are strict, bounded, token-free and immutable', () => {
  const parsed = parseArcGisCredentialMetadataRecord(metadata());

  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.permissions), true);
  assert.deepEqual(parsed.permissions, ['feature:query']);
  assert.equal('encrypted_access_token_envelope' in parsed, false);

  for (const invalid of [
    metadata({ encrypted_access_token_envelope: ENCRYPTED_ENVELOPE }),
    metadata({ portal_root: 'https://synthetic.maps.arcgis.com' }),
    metadata({ credential_alias: 'UPPERCASE' }),
    metadata({ credential_identity: 'x' }),
    metadata({ portal_kind: 'arcgis-server' }),
    metadata({ permissions: ['feature:edit'] }),
    metadata({ permissions: ['feature:query', 'feature:query'] }),
    metadata({ token_type: 'bearer' }),
    metadata({ expires_at: '2026-07-25T13:00:00.000' }),
    metadata({ connected_at: '2026-07-25T12:00:00.000' }),
    metadata({ connected_by_user: '' }),
  ]) {
    assert.equal(ArcGisCredentialMetadataRecordSchema.safeParse(invalid).success, false);
  }
});

test('metadata timestamp fields require offset-aware ISO datetimes with exact millisecond precision', () => {
  assert.equal(ArcGisCredentialMetadataRecordSchema.safeParse(metadata({
    expires_at: '2026-07-25T12:00:00.001Z',
    connected_at: '2026-07-25T12:00:00.000Z',
    refreshed_at: '2026-07-25T12:00:00.000Z',
  })).success, true);

  for (const field of ['expires_at', 'connected_at', 'refreshed_at'] as const) {
    assertMetadataTimestampFieldIssue(field, '2026-07-25T12:00:00.0004Z');
  }
});

test('secret-envelope timestamp fields require offset-aware ISO datetimes with exact millisecond precision', () => {
  assert.equal(ArcGisCredentialSecretEnvelopeRecordSchema.safeParse(secretEnvelope({
    expires_at: '2026-07-25T13:00:00.000Z',
  })).success, true);

  const result = ArcGisCredentialSecretEnvelopeRecordSchema.safeParse(secretEnvelope({
    expires_at: '2026-07-25T13:00:00.0004Z',
  }));

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.ok(
    result.error.issues.some((issue) => issue.path.join('.') === 'expires_at'),
    `expected expires_at issue path, got ${JSON.stringify(result.error.issues)}`,
  );
});

test('metadata rejects records refreshed before the original connection timestamp', () => {
  const result = ArcGisCredentialMetadataRecordSchema.safeParse(metadata({
    refreshed_at: '2026-07-25T11:59:59.000Z',
  }));

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'refreshed_at'));
});

test('metadata rejects records expiring at the original connection timestamp', () => {
  assertMetadataExpiresAtIssue(metadata({
    expires_at: CONNECTED_AT,
  }));
});

test('metadata rejects records expiring before the original connection timestamp', () => {
  assertMetadataExpiresAtIssue(metadata({
    expires_at: '2026-07-25T11:59:59.000Z',
  }));
});

test('metadata accepts records expiring after the original connection timestamp', () => {
  const result = ArcGisCredentialMetadataRecordSchema.safeParse(metadata({
    expires_at: '2026-07-25T12:00:00.001Z',
  }));

  assert.equal(result.success, true);
});

test('secret-envelope records carry only late authorization binding fields and opaque encrypted material', () => {
  const parsed = parseArcGisCredentialSecretEnvelopeRecord(secretEnvelope());

  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.permissions), true);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'credential_alias',
    'credential_identity',
    'encrypted_access_token_envelope',
    'expires_at',
    'permissions',
    'portal_kind',
    'token_type',
  ].sort());
  assert.equal(parsed.token_type, 'Bearer');

  for (const invalid of [
    secretEnvelope({ connected_at: CONNECTED_AT }),
    secretEnvelope({ service_root: 'https://services.arcgis.com/synthorg/arcgis/rest/services' }),
    secretEnvelope({ encrypted_access_token_envelope: `Bearer PHASE2B_TOKEN_CANARY` }),
    secretEnvelope({ encrypted_access_token_envelope: `${'a'.repeat(9000)}.${'b'.repeat(24)}.${'c'.repeat(24)}` }),
    secretEnvelope({ token_type: 'Basic' }),
    secretEnvelope({ expires_at: 'not-a-date' }),
  ]) {
    assert.equal(ArcGisCredentialSecretEnvelopeRecordSchema.safeParse(invalid).success, false);
  }
});

const SYNTHETIC_HEX_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function withSyntheticTokenKey<T>(key: string | undefined, callback: () => T): T {
  const original = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  try {
    if (key === undefined) {
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = key;
    }
    return callback();
  } finally {
    if (original === undefined) {
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = original;
    }
  }
}

function assertNoLeak(error: unknown, canaries: readonly string[]): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const canary of canaries) {
    assert.equal(message.includes(canary), false, `error leaked canary ${canary}`);
  }
}

function tamperEnvelope(envelope: string): string {
  const [iv, tag, ciphertext] = envelope.split('.');
  const tagBytes = Buffer.from(tag, 'base64');
  tagBytes[0] ^= 0xff;
  return `${iv}.${tagBytes.toString('base64')}.${ciphertext}`;
}

function dateBackedMetadataRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return metadata({
    expires_at: new Date(EXPIRES_AT),
    connected_at: new Date(CONNECTED_AT),
    refreshed_at: new Date(REFRESHED_AT),
    ...overrides,
  });
}

function dateBackedSecretRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return secretEnvelope({
    expires_at: new Date(EXPIRES_AT),
    ...overrides,
  });
}

function collectStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry, seen));
  }

  const strings: string[] = [];
  for (const nested of Object.values(value as Record<string, unknown>)) {
    strings.push(...collectStrings(nested, seen));
  }
  return strings;
}

class CapturingArcGisCredentialDatabase {
  readonly calls: Array<{
    projection: Record<string, unknown>;
    table?: unknown;
    condition?: unknown;
    limitCount?: number;
  }> = [];

  private readonly responses: unknown[][];

  constructor(responses: readonly unknown[][]) {
    this.responses = responses.map((rows) => [...rows]);
  }

  select(projection: Record<string, unknown>) {
    const call: CapturingArcGisCredentialDatabase['calls'][number] = { projection };
    this.calls.push(call);

    return {
      from: (table: unknown) => {
        call.table = table;
        return {
          where: (condition: unknown) => {
            call.condition = condition;
            return {
              limit: async (count: number) => {
                call.limitCount = count;
                return this.responses.shift() ?? [];
              },
            };
          },
        };
      },
    };
  }
}

test('pure token envelope crypto round-trips using the existing iv.tag.ciphertext base64 format', async () => {
  const { encrypt, decrypt } = await import('../src/security/token-envelope.js');
  const plaintext = 'PHASE2B_SYNTHETIC_ACCESS_TOKEN_ROUNDTRIP';

  withSyntheticTokenKey(SYNTHETIC_HEX_KEY, () => {
    const envelope = encrypt(plaintext);

    assert.match(envelope, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    assert.equal(envelope.includes(plaintext), false);
    assert.equal(decrypt(envelope), plaintext);

    const emptyEnvelope = encrypt('');
    assert.match(emptyEnvelope, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.$/);
    assert.equal(decrypt(emptyEnvelope), '');
  });
});

test('token envelope rejects invalid keys and malformed or tampered envelopes generically', async () => {
  const { encrypt, decrypt } = await import('../src/security/token-envelope.js');
  const plaintextCanary = 'PHASE2B_SYNTHETIC_TOKEN_CANARY';
  const invalidHexCanary = `${'f'.repeat(63)}g`;
  let validEnvelope = '';
  withSyntheticTokenKey(SYNTHETIC_HEX_KEY, () => {
    validEnvelope = encrypt(plaintextCanary);
  });

  for (const invalidKey of [undefined, 'a'.repeat(63), invalidHexCanary]) {
    let encryptThrown: unknown;
    let decryptThrown: unknown;
    withSyntheticTokenKey(invalidKey, () => {
      try {
        encrypt(plaintextCanary);
      } catch (error) {
        encryptThrown = error;
      }
      try {
        decrypt(validEnvelope);
      } catch (error) {
        decryptThrown = error;
      }
    });

    assert.ok(encryptThrown instanceof Error);
    assert.ok(decryptThrown instanceof Error);
    assert.match(encryptThrown.message, /^Token envelope crypto configuration is invalid$/);
    assert.match(decryptThrown.message, /^Token envelope crypto configuration is invalid$/);
    assertNoLeak(encryptThrown, [plaintextCanary, invalidHexCanary, 'OAUTH_TOKEN_ENCRYPTION_KEY']);
    assertNoLeak(decryptThrown, [plaintextCanary, invalidHexCanary, 'OAUTH_TOKEN_ENCRYPTION_KEY']);
  }

  withSyntheticTokenKey(SYNTHETIC_HEX_KEY, () => {
    const envelope = encrypt(plaintextCanary);
    for (const invalidEnvelope of ['not-an-envelope', 'short.tag.data', tamperEnvelope(envelope)]) {
      assert.throws(
        () => decrypt(invalidEnvelope),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /^Token envelope decryption failed$/);
          assertNoLeak(error, [plaintextCanary, invalidEnvelope]);
          return true;
        },
      );
    }
  });
});

test('LLM token-store re-exports compatible token envelope encrypt and decrypt functions', async () => {
  const envelopeCrypto = await import('../src/security/token-envelope.js');
  const tokenStore = await import('../src/llm/token-store.js');

  assert.equal(tokenStore.encrypt, envelopeCrypto.encrypt);
  assert.equal(tokenStore.decrypt, envelopeCrypto.decrypt);
});

test('ArcGIS credential repository metadata query uses an explicit token-free projection and alias limit', async () => {
  const { createDrizzleArcGisCredentialRepository } = await import('../src/security/arcgis-token-repository.js');
  const database = new CapturingArcGisCredentialDatabase([[dateBackedMetadataRow()]]);
  const repository = createDrizzleArcGisCredentialRepository(database);

  const record = await repository.findMetadata(ALIAS);

  assert.deepEqual(record, parseArcGisCredentialMetadataRecord(metadata()));
  assert.equal(Object.isFrozen(record), true);
  assert.equal(database.calls.length, 1);
  const [call] = database.calls;
  assert.equal(call.table, arcgisCredentials);
  assert.equal(call.limitCount, 1);
  assert.ok(collectStrings(call.condition).includes(ALIAS));
  assert.deepEqual(Object.keys(call.projection).sort(), [
    'connected_at',
    'connected_by_user',
    'credential_alias',
    'credential_identity',
    'expires_at',
    'permissions',
    'portal_kind',
    'refreshed_at',
    'token_type',
  ].sort());
  assert.equal('encrypted_access_token_envelope' in call.projection, false);
  assert.equal(Object.values(call.projection).includes(arcgisCredentials.encryptedAccessTokenEnvelope), false);
});

test('ArcGIS credential repository secret query uses only the late-secret projection with alias and identity binding', async () => {
  const { createDrizzleArcGisCredentialRepository } = await import('../src/security/arcgis-token-repository.js');
  const database = new CapturingArcGisCredentialDatabase([[dateBackedSecretRow()]]);
  const repository = createDrizzleArcGisCredentialRepository(database);

  const record = await repository.findSecretEnvelope(ALIAS, IDENTITY);

  assert.deepEqual(record, parseArcGisCredentialSecretEnvelopeRecord(secretEnvelope()));
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record?.permissions), true);
  assert.equal(database.calls.length, 1);
  const [call] = database.calls;
  assert.equal(call.table, arcgisCredentials);
  assert.equal(call.limitCount, 1);
  const conditionStrings = collectStrings(call.condition);
  assert.ok(conditionStrings.includes(ALIAS));
  assert.ok(conditionStrings.includes(IDENTITY));
  assert.deepEqual(Object.keys(call.projection).sort(), [
    'credential_alias',
    'credential_identity',
    'encrypted_access_token_envelope',
    'expires_at',
    'permissions',
    'portal_kind',
    'token_type',
  ].sort());
  assert.equal('connected_at' in call.projection, false);
  assert.equal('connected_by_user' in call.projection, false);
  assert.equal('refreshed_at' in call.projection, false);
});

test('ArcGIS credential repository returns null rows as null and rejects strict invalid rows', async () => {
  const { createDrizzleArcGisCredentialRepository } = await import('../src/security/arcgis-token-repository.js');
  const nullDatabase = new CapturingArcGisCredentialDatabase([[], []]);
  const nullRepository = createDrizzleArcGisCredentialRepository(nullDatabase);

  assert.equal(await nullRepository.findMetadata(ALIAS), null);
  assert.equal(await nullRepository.findSecretEnvelope(ALIAS, IDENTITY), null);

  const invalidDatabase = new CapturingArcGisCredentialDatabase([
    [dateBackedMetadataRow({ encrypted_access_token_envelope: ENCRYPTED_ENVELOPE })],
    [dateBackedSecretRow({ connected_at: CONNECTED_AT })],
  ]);
  const invalidRepository = createDrizzleArcGisCredentialRepository(invalidDatabase);

  assert.throws(() => ArcGisCredentialMetadataRecordSchema.parse(metadata({ encrypted_access_token_envelope: ENCRYPTED_ENVELOPE })));
  await assert.rejects(() => invalidRepository.findMetadata(ALIAS));
  await assert.rejects(() => invalidRepository.findSecretEnvelope(ALIAS, IDENTITY));
});

const AUTH_TOKEN = 'PHASE2B_AUTH_TOKEN_CANARY_13f9';
const PRIVATE_LAYER_URL = 'https://services.arcgis.com/synthorg/arcgis/rest/services/PrivateHydrants/FeatureServer/0';

type FakeRepositoryOptions = {
  metadataRow?: unknown;
  secretRow?: unknown;
  metadataError?: Error;
  secretError?: Error;
};

class FakeArcGisCredentialRepository {
  metadataCalls: string[] = [];
  secretCalls: string[] = [];
  secretBindings: Array<{ alias: string; expectedCredentialIdentity: string }> = [];
  metadataRow: unknown;
  secretRow: unknown;
  metadataError?: Error;
  secretError?: Error;

  constructor(options: FakeRepositoryOptions = {}) {
    this.metadataRow = options.metadataRow !== undefined
      ? options.metadataRow
      : metadata({ expires_at: '2026-07-25T12:01:00.001Z' });
    this.secretRow = options.secretRow !== undefined
      ? options.secretRow
      : secretEnvelope({ expires_at: '2026-07-25T12:01:00.001Z' });
    this.metadataError = options.metadataError;
    this.secretError = options.secretError;
  }

  async findMetadata(alias: string): Promise<any> {
    this.metadataCalls.push(alias);
    if (this.metadataError) throw this.metadataError;
    return this.metadataRow;
  }

  async findSecretEnvelope(alias: string, expectedCredentialIdentity: string): Promise<any> {
    this.secretCalls.push(alias);
    this.secretBindings.push({ alias, expectedCredentialIdentity });
    if (this.secretError) throw this.secretError;
    return this.secretRow;
  }
}

function phase2bTarget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_slug: 'phase2b-private-target',
    portal_kind: 'arcgis-online',
    portal_root: 'https://synthetic.maps.arcgis.com',
    service_root: 'https://services.arcgis.com/synthorg/arcgis/rest/services',
    layer_url: PRIVATE_LAYER_URL,
    allowed_credential_aliases: [ALIAS],
    allowed_operations: ['query'],
    ...overrides,
  };
}

function fakeRegistry(targetOrError: unknown = phase2bTarget()): { resolveCalls: string[]; resolve(targetSlug: string): any } {
  return {
    resolveCalls: [],
    resolve(targetSlug: string): any {
      this.resolveCalls.push(targetSlug);
      if (targetOrError instanceof Error) throw targetOrError;
      return targetOrError;
    },
  };
}

function fakeDecrypt(options: { token?: string; error?: Error } = {}): { calls: string[]; decrypt(envelope: string): string } {
  return {
    calls: [],
    decrypt(envelope: string): string {
      this.calls.push(envelope);
      if (options.error) throw options.error;
      return options.token ?? AUTH_TOKEN;
    },
  };
}

function expiresAfter(offsetMs: number): string {
  return new Date(Date.parse('2026-07-25T12:00:00.000Z') + offsetMs).toISOString();
}

async function postgresBrokerFixtures(overrides: {
  target?: unknown;
  metadataRow?: unknown;
  secretRow?: unknown;
  metadataError?: Error;
  secretError?: Error;
  decryptError?: Error;
  decryptToken?: string;
} = {}) {
  const {
    PostgresArcGisTokenBroker,
  } = await import('../src/security/postgres-arcgis-token-broker.js');
  const repository = new FakeArcGisCredentialRepository({
    metadataRow: overrides.metadataRow,
    secretRow: overrides.secretRow,
    metadataError: overrides.metadataError,
    secretError: overrides.secretError,
  });
  const registry = fakeRegistry(overrides.target ?? phase2bTarget());
  const decryptor = fakeDecrypt({ token: overrides.decryptToken, error: overrides.decryptError });
  const broker = new PostgresArcGisTokenBroker({
    repository,
    targetRegistry: registry,
    decryptEnvelope: decryptor.decrypt.bind(decryptor),
    now: () => new Date('2026-07-25T12:00:00.000Z'),
  });
  return { broker, repository, registry, decryptor };
}

async function approvedBinding(target: unknown = phase2bTarget(), overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { arcGisTargetConfigDigest } = await import('../src/security/arcgis-connections.js');
  return {
    credential_identity: IDENTITY,
    target_config_sha256: arcGisTargetConfigDigest(target as any),
    portal_kind: 'arcgis-online',
    permission: 'feature:query',
    ...overrides,
  };
}

async function assertAuthorizationRejectsWithoutSecret(
  name: string,
  target: unknown,
  bindingOverrides: Record<string, unknown> = {},
): Promise<void> {
  const { broker, repository, decryptor } = await postgresBrokerFixtures({ target });
  const binding = await approvedBinding(phase2bTarget(), bindingOverrides);
  await assert.rejects(
    () => broker.getAuthorization(ALIAS, 'phase2b-private-target', binding),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.equal(error.message, 'ArcGIS authorization materialization failed', name);
      assertNoLeak(error, [ALIAS, IDENTITY, PRIVATE_LAYER_URL, ENCRYPTED_ENVELOPE, AUTH_TOKEN, 'services.arcgis.com']);
      return true;
    },
  );
  assert.deepEqual(repository.secretCalls, [], name);
  assert.deepEqual(decryptor.calls, [], name);
}

test('Postgres ArcGIS broker source is injected and avoids eager global database or config loading', () => {
  const source = readFileSync(join(REPO_ROOT, 'dymaxion-runtime/src/security/postgres-arcgis-token-broker.ts'), 'utf8');

  assert.doesNotMatch(source, /from\s+['"]\.\.\/db\/client\.js['"]/);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/config\/loader\.js['"]/);
  assert.doesNotMatch(source, /createDrizzleArcGisCredentialRepository\s*\(/);
});

test('Postgres ArcGIS broker describe uses metadata only and rejects missing or near-expiry descriptors generically', async () => {
  const { ARCGIS_TOKEN_EXPIRY_MARGIN_MS } = await import('../src/security/arcgis-connections.js');
  const { broker, repository, decryptor } = await postgresBrokerFixtures({
    metadataRow: metadata({ expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS + 1) }),
  });

  const descriptor = await broker.describe(ALIAS);

  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.permissions), true);
  assert.deepEqual(descriptor, {
    credential_alias: ALIAS,
    credential_identity: IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS + 1),
  });
  assert.equal('connected_by_user' in descriptor, false);
  assert.deepEqual(repository.metadataCalls, [ALIAS]);
  assert.deepEqual(repository.secretCalls, []);
  assert.deepEqual(decryptor.calls, []);

  for (const [label, metadataRow] of [
    ['missing', null],
    ['inside-margin', metadata({ expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS - 1) })],
    ['exact-margin', metadata({ expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS) })],
    ['repo-error', new Error(`metadata ${ALIAS} ${IDENTITY} ${PRIVATE_LAYER_URL}`)],
  ] as const) {
    const fixtures = await postgresBrokerFixtures(
      metadataRow instanceof Error ? { metadataError: metadataRow } : { metadataRow },
    );
    await assert.rejects(
      () => fixtures.broker.describe(ALIAS),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.equal(error.message, 'ArcGIS credential description failed', label);
        assertNoLeak(error, [ALIAS, IDENTITY, PRIVATE_LAYER_URL, 'services.arcgis.com']);
        return true;
      },
    );
    assert.deepEqual(fixtures.repository.secretCalls, [], label);
    assert.deepEqual(fixtures.decryptor.calls, [], label);
  }
});

test('Postgres ArcGIS broker materializes approved Bearer authorization once after strict late binding checks', async () => {
  const { broker, repository, registry, decryptor } = await postgresBrokerFixtures();
  const authorization = await broker.getAuthorization(
    ALIAS,
    'phase2b-private-target',
    await approvedBinding(),
  );

  assert.equal(authorization, `Bearer ${AUTH_TOKEN}`);
  assert.deepEqual(repository.metadataCalls, []);
  assert.deepEqual(repository.secretCalls, [ALIAS]);
  assert.deepEqual(repository.secretBindings, [{ alias: ALIAS, expectedCredentialIdentity: IDENTITY }]);
  assert.deepEqual(registry.resolveCalls, ['phase2b-private-target']);
  assert.deepEqual(decryptor.calls, [ENCRYPTED_ENVELOPE]);
});

test('Postgres ArcGIS broker independently revalidates concurrent late authorization requests', async () => {
  const { broker, repository, registry, decryptor } = await postgresBrokerFixtures();
  const binding = await approvedBinding();

  const authorizations = await Promise.all([
    broker.getAuthorization(ALIAS, 'phase2b-private-target', binding),
    broker.getAuthorization(ALIAS, 'phase2b-private-target', binding),
  ]);

  assert.deepEqual(authorizations, [`Bearer ${AUTH_TOKEN}`, `Bearer ${AUTH_TOKEN}`]);
  assert.deepEqual(repository.secretCalls, [ALIAS, ALIAS]);
  assert.deepEqual(registry.resolveCalls, ['phase2b-private-target', 'phase2b-private-target']);
  assert.deepEqual(decryptor.calls, [ENCRYPTED_ENVELOPE, ENCRYPTED_ENVELOPE]);
});

test('Postgres ArcGIS broker rejects target and approval drift before secret lookup or decrypt', async () => {
  const currentTarget = phase2bTarget();
  const driftedTarget = phase2bTarget({
    service_root: 'https://services1.arcgis.com/synthorg/arcgis/rest/services',
    layer_url: 'https://services1.arcgis.com/synthorg/arcgis/rest/services/PrivateHydrants/FeatureServer/0',
  });

  await assertAuthorizationRejectsWithoutSecret('unknown-target', new Error(`unknown ${PRIVATE_LAYER_URL} ${IDENTITY}`));
  await assertAuthorizationRejectsWithoutSecret('returned-slug-mismatch', phase2bTarget({ target_slug: 'phase2b-other-target' }));
  await assertAuthorizationRejectsWithoutSecret('disallowed-alias', phase2bTarget({ allowed_credential_aliases: ['other-reader'] }));
  await assertAuthorizationRejectsWithoutSecret('digest-drift', driftedTarget);
  await assertAuthorizationRejectsWithoutSecret('portal-drift', currentTarget, { portal_kind: 'arcgis-enterprise' });
  await assertAuthorizationRejectsWithoutSecret('malformed-binding', currentTarget, { target_config_sha256: 'not-a-sha' });
});

test('Postgres ArcGIS broker rejects secret binding drift or expiry before decrypt', async () => {
  const { ARCGIS_TOKEN_EXPIRY_MARGIN_MS } = await import('../src/security/arcgis-connections.js');
  const cases: Array<{ name: string; secretRow: unknown }> = [
    { name: 'missing-secret', secretRow: null },
    { name: 'alias-drift', secretRow: secretEnvelope({ credential_alias: 'other-reader' }) },
    { name: 'identity-drift', secretRow: secretEnvelope({ credential_identity: 'arcgis:online:synthetic:user:other' }) },
    { name: 'portal-drift', secretRow: secretEnvelope({ portal_kind: 'arcgis-enterprise' }) },
    { name: 'permission-drift', secretRow: secretEnvelope({ permissions: ['feature:edit'] }) },
    { name: 'token-type-drift', secretRow: secretEnvelope({ token_type: 'Basic' }) },
    { name: 'expired', secretRow: secretEnvelope({ expires_at: expiresAfter(-1) }) },
    { name: 'inside-margin', secretRow: secretEnvelope({ expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS - 1) }) },
    { name: 'exact-margin', secretRow: secretEnvelope({ expires_at: expiresAfter(ARCGIS_TOKEN_EXPIRY_MARGIN_MS) }) },
  ];

  for (const testCase of cases) {
    const { broker, repository, decryptor } = await postgresBrokerFixtures({ secretRow: testCase.secretRow });
    const binding = await approvedBinding();
    await assert.rejects(
      () => broker.getAuthorization(ALIAS, 'phase2b-private-target', binding),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.equal(error.message, 'ArcGIS authorization materialization failed', testCase.name);
        assertNoLeak(error, [ALIAS, IDENTITY, PRIVATE_LAYER_URL, ENCRYPTED_ENVELOPE, AUTH_TOKEN, 'services.arcgis.com']);
        return true;
      },
    );
    assert.deepEqual(repository.secretCalls, [ALIAS], testCase.name);
    assert.deepEqual(decryptor.calls, [], testCase.name);
  }
});

test('Postgres ArcGIS broker authorization errors are generic and non-leaking across repo and decrypt failures', async () => {
  for (const fixtures of [
    await postgresBrokerFixtures({ secretError: new Error(`repo ${ALIAS} ${IDENTITY} ${PRIVATE_LAYER_URL} ${ENCRYPTED_ENVELOPE}`) }),
    await postgresBrokerFixtures({ decryptError: new Error(`decrypt ${AUTH_TOKEN} ${ENCRYPTED_ENVELOPE} OAUTH_TOKEN_ENCRYPTION_KEY`) }),
    await postgresBrokerFixtures({ decryptToken: 'bad token with spaces' }),
  ]) {
    const binding = await approvedBinding();
    await assert.rejects(
      () => fixtures.broker.getAuthorization(ALIAS, 'phase2b-private-target', binding),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.equal(error.message, 'ArcGIS authorization materialization failed');
        assertNoLeak(error, [ALIAS, IDENTITY, PRIVATE_LAYER_URL, ENCRYPTED_ENVELOPE, AUTH_TOKEN, 'services.arcgis.com', 'OAUTH_TOKEN_ENCRYPTION_KEY']);
        assert.ok(error.message.length < 128);
        return true;
      },
    );
  }
});

async function withArcGisBrokerSelector<T>(value: string | undefined, callback: () => Promise<T>): Promise<T> {
  const original = process.env.DYMAXION_ARCGIS_TOKEN_BROKER;
  try {
    if (value === undefined) {
      delete process.env.DYMAXION_ARCGIS_TOKEN_BROKER;
    } else {
      process.env.DYMAXION_ARCGIS_TOKEN_BROKER = value;
    }
    return await callback();
  } finally {
    if (original === undefined) {
      delete process.env.DYMAXION_ARCGIS_TOKEN_BROKER;
    } else {
      process.env.DYMAXION_ARCGIS_TOKEN_BROKER = original;
    }
  }
}

function selectorDescriptor(): Record<string, unknown> {
  return {
    credential_alias: ALIAS,
    credential_identity: IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    expires_at: '2026-07-25T13:00:00.000Z',
  };
}

test('ArcGIS token broker selector absent returns unavailable broker without factory or registry access', async () => {
  const { selectArcGisTokenBroker } = await import('../src/security/arcgis-token-broker-selector.js');
  let factoryCalls = 0;
  let registryCalls = 0;
  const selected = selectArcGisTokenBroker(undefined, {
    targetRegistryResolver: () => {
      registryCalls += 1;
      return fakeRegistry() as any;
    },
    brokerFactory: async () => {
      factoryCalls += 1;
      throw new Error('factory must not run');
    },
  });

  assert.equal(factoryCalls, 0);
  assert.equal(registryCalls, 0);
  await assert.rejects(() => selected.describe(ALIAS), /^Error: no trusted ArcGIS token broker is configured$/);
  await assert.rejects(
    async () => selected.getAuthorization(ALIAS, 'phase2b-private-target', await approvedBinding()),
    /^Error: no trusted ArcGIS token broker is configured$/,
  );
  assert.equal(factoryCalls, 0);
  assert.equal(registryCalls, 0);
});

test('ArcGIS token broker selector exact postgres returns a lazy proxy and caches concurrent construction once', async () => {
  const { selectArcGisTokenBroker } = await import('../src/security/arcgis-token-broker-selector.js');
  let factoryCalls = 0;
  let registryCalls = 0;
  let describeCalls = 0;
  let authorizationCalls = 0;
  const selected = selectArcGisTokenBroker('postgres', {
    targetRegistryResolver: () => {
      registryCalls += 1;
      return fakeRegistry() as any;
    },
    brokerFactory: async ({ targetRegistryResolver }) => {
      factoryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        async describe(alias: string) {
          describeCalls += 1;
          assert.equal(alias, ALIAS);
          return selectorDescriptor() as any;
        },
        async getAuthorization(alias: string, targetSlug: string) {
          authorizationCalls += 1;
          assert.equal(alias, ALIAS);
          targetRegistryResolver().resolve(targetSlug);
          return `Bearer ${AUTH_TOKEN}`;
        },
      };
    },
  });

  assert.equal(factoryCalls, 0);
  assert.equal(registryCalls, 0);

  const binding = await approvedBinding();
  const [first, second, authorization] = await Promise.all([
    selected.describe(ALIAS),
    selected.describe(ALIAS),
    selected.getAuthorization(ALIAS, 'phase2b-private-target', binding),
  ]);

  assert.deepEqual(first, selectorDescriptor() as any);
  assert.deepEqual(second, selectorDescriptor() as any);
  assert.equal(authorization, `Bearer ${AUTH_TOKEN}`);
  assert.equal(factoryCalls, 1);
  assert.equal(registryCalls, 1);
  assert.equal(describeCalls, 2);
  assert.equal(authorizationCalls, 1);

  await selected.describe(ALIAS);
  assert.equal(factoryCalls, 1);
  assert.equal(describeCalls, 3);
});

test('ArcGIS token broker selector rejects empty whitespace case variants and unknown values synchronously', async () => {
  const { selectArcGisTokenBroker, validateArcGisTokenBrokerSelector } = await import('../src/security/arcgis-token-broker-selector.js');
  for (const value of ['', ' ', '\t', ' postgres', 'postgres ', 'Postgres', 'POSTGRES', 'unknown']) {
    let factoryCalls = 0;
    let registryCalls = 0;
    assert.throws(
      () => selectArcGisTokenBroker(value, {
        targetRegistryResolver: () => {
          registryCalls += 1;
          return fakeRegistry() as any;
        },
        brokerFactory: async () => {
          factoryCalls += 1;
          throw new Error('factory must not run');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'ArcGIS token broker configuration is invalid');
        if (value.trim().length > 0) {
          assert.equal(error.message.includes(value), false);
        }
        assert.ok(error.message.length < 128);
        return true;
      },
      `selector ${JSON.stringify(value)} must reject`,
    );
    assert.throws(() => validateArcGisTokenBrokerSelector(value), /ArcGIS token broker configuration is invalid/);
    assert.equal(factoryCalls, 0, value);
    assert.equal(registryCalls, 0, value);
  }
});

test('ArcGIS token broker lazy factory failures are wrapped by descriptor and authorization categories without canaries', async () => {
  const { selectArcGisTokenBroker } = await import('../src/security/arcgis-token-broker-selector.js');
  const canaries = [ALIAS, IDENTITY, PRIVATE_LAYER_URL, AUTH_TOKEN, ENCRYPTED_ENVELOPE, 'OAUTH_TOKEN_ENCRYPTION_KEY'];
  const selected = selectArcGisTokenBroker('postgres', {
    brokerFactory: async () => {
      throw new Error(`loader failed ${canaries.join(' ')}`);
    },
  });

  await assert.rejects(
    () => selected.describe(ALIAS),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'ArcGIS credential description failed');
      assertNoLeak(error, canaries);
      return true;
    },
  );
  await assert.rejects(
    async () => selected.getAuthorization(ALIAS, 'phase2b-private-target', await approvedBinding()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'ArcGIS authorization materialization failed');
      assertNoLeak(error, canaries);
      return true;
    },
  );
});

test('ArcGIS token broker caches a synchronous factory failure once and redacts it per method', async () => {
  const { selectArcGisTokenBroker } = await import('../src/security/arcgis-token-broker-selector.js');
  let factoryCalls = 0;
  const selected = selectArcGisTokenBroker('postgres', {
    brokerFactory: () => {
      factoryCalls += 1;
      throw new Error(`synchronous loader failure ${PRIVATE_LAYER_URL} ${AUTH_TOKEN}`);
    },
  });

  await assert.rejects(
    () => selected.describe(ALIAS),
    /^Error: ArcGIS credential description failed$/,
  );
  await assert.rejects(
    async () => selected.getAuthorization(ALIAS, 'phase2b-private-target', await approvedBinding()),
    /^Error: ArcGIS authorization materialization failed$/,
  );
  assert.equal(factoryCalls, 1);
});

test('ArcGIS token broker selector source uses only type-only connection imports and lazy production imports', () => {
  const selectorSource = readFileSync(join(REPO_ROOT, 'dymaxion-runtime/src/security/arcgis-token-broker-selector.ts'), 'utf8');
  const mainSource = readFileSync(join(REPO_ROOT, 'dymaxion-runtime/src/main.ts'), 'utf8');
  const mainStart = mainSource.indexOf('async function main(): Promise<void>');
  const validation = mainSource.indexOf('validateArcGisTokenBrokerSelector(process.env.DYMAXION_ARCGIS_TOKEN_BROKER)', mainStart);
  const commandSwitch = mainSource.indexOf('switch (command)', mainStart);
  const daemonCall = mainSource.indexOf('await daemon()', mainStart);

  assert.match(selectorSource, /import\s+type\s+\{[\s\S]*\}\s+from\s+['"]\.\/arcgis-connections\.js['"]/);
  assert.doesNotMatch(selectorSource, /import\s+\{[\s\S]*\}\s+from\s+['"]\.\/arcgis-connections\.js['"]/);
  assert.doesNotMatch(selectorSource, /from\s+['"]\.\.\/db\/client\.js['"]/);
  assert.doesNotMatch(selectorSource, /from\s+['"]\.\/arcgis-token-repository\.js['"]/);
  assert.doesNotMatch(selectorSource, /from\s+['"]\.\/postgres-arcgis-token-broker\.js['"]/);
  assert.doesNotMatch(mainSource, /^import\s+.*from\s+['"]\.\/db\/client\.js['"];?$/m);
  assert.ok(validation > mainStart, 'main must validate the selector at startup');
  assert.ok(validation < commandSwitch, 'selector validation must run before command dispatch');
  assert.ok(validation < daemonCall, 'selector validation must run before daemon work');
});

function runSelectorSmokeProcess(selector: string | undefined, configDir: string): ReturnType<typeof spawnSync> {
  const runtimeDir = join(REPO_ROOT, 'dymaxion-runtime');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'not-a-postgres-url',
    DYMAXION_CONFIG_DIR: configDir,
  };
  if (selector === undefined) {
    delete env.DYMAXION_ARCGIS_TOKEN_BROKER;
  } else {
    env.DYMAXION_ARCGIS_TOKEN_BROKER = selector;
  }
  return spawnSync(
    process.execPath,
    [join(runtimeDir, 'node_modules/tsx/dist/cli.mjs'), join(runtimeDir, 'src/main.ts'), 'smoke-test'],
    { cwd: runtimeDir, env, encoding: 'utf8' },
  );
}

test('invalid ArcGIS broker selector rejects before malformed database URL parsing or config loading', () => {
  const result = runSelectorSmokeProcess(' POSTGRES ', '/definitely/not/read/task3-config');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1);
  assert.match(output, /ArcGIS token broker configuration is invalid/);
  assert.doesNotMatch(output, /Invalid URL|Missing config file|not-a-postgres-url/);
  assert.doesNotMatch(output, /config: .* providers|smoke test: OK/);
});

test('smoke mode with unavailable or exact postgres selector never parses a malformed database URL', () => {
  const configDir = join(REPO_ROOT, 'config');
  for (const selector of [undefined, 'postgres'] as const) {
    const result = runSelectorSmokeProcess(selector, configDir);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /smoke test: OK/);
    assert.doesNotMatch(output, /Invalid URL|not-a-postgres-url|ArcGIS credential description failed/);
  }
});

test('resolveArcGisTokenBroker keeps injected and configured priority before selector fallback', async () => {
  const connections = await import('../src/security/arcgis-connections.js');
  const contextBroker = { describe: async () => selectorDescriptor() as any, getAuthorization: async () => 'Bearer context' };
  const configuredBroker = { describe: async () => selectorDescriptor() as any, getAuthorization: async () => 'Bearer configured' };
  try {
    await withArcGisBrokerSelector('POSTGRES', async () => {
      assert.equal(connections.resolveArcGisTokenBroker({ io: { arcgisTokenBroker: contextBroker } } as any), contextBroker);
      connections.resetArcGisTargetRegistryForTest();
      connections.configureArcGisConnections({ tokenBroker: configuredBroker });
      assert.equal(connections.resolveArcGisTokenBroker({ io: {} } as any), configuredBroker);
    });
  } finally {
    connections.resetArcGisTargetRegistryForTest();
  }

  await withArcGisBrokerSelector('postgres', async () => {
    let factoryCalls = 0;
    const selected = connections.resolveArcGisTokenBroker({ io: { arcgisTargetRegistry: fakeRegistry() } } as any, {
      brokerFactory: async () => {
        factoryCalls += 1;
        return { describe: async () => selectorDescriptor() as any, getAuthorization: async () => `Bearer ${AUTH_TOKEN}` };
      },
    });
    assert.equal(factoryCalls, 0);
    assert.deepEqual(await selected.describe(ALIAS), selectorDescriptor() as any);
    assert.equal(factoryCalls, 1);
  });
});
