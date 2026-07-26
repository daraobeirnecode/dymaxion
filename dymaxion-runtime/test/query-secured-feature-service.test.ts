import assert from 'node:assert/strict';
import test from 'node:test';
import { querySecuredFeatureServiceCapability } from '../src/capabilities/query-secured-feature-service.js';
import { resolveStepApproval } from '../src/agent/step-approval.js';
import {
  allCapabilities,
  resolveCapabilityApprovalBinding,
} from '../src/capabilities/registry.js';
import { canonicalFormBody, type ArcGisRestTransport } from '../src/capabilities/arcgis-rest.js';
import {
  createApprovalRequest,
  decideApproval,
  InMemoryApprovalStore,
} from '../src/security/approval.js';
import {
  arcGisTargetConfigDigest,
  ArcGisTargetsConfigSchema,
  InMemoryArcGisTargetRegistry,
  InMemoryArcGisTokenBroker,
  type ArcGisApprovedFeatureQueryBinding,
  type ArcGisCredentialDescriptor,
  type ArcGisTokenBroker,
} from '../src/security/arcgis-connections.js';
import type {
  ArcGisCredentialMetadataRecord,
  ArcGisCredentialSecretEnvelopeRecord,
} from '../src/security/arcgis-token-records.js';
import type { ArcGisCredentialRepository } from '../src/security/arcgis-token-repository.js';
import { PostgresArcGisTokenBroker } from '../src/security/postgres-arcgis-token-broker.js';
import { logger } from '../src/observability/logger.js';
import { runSkill, type RunSkillDependencies } from '../src/skills/executor.js';

process.env.DYMAXION_CONFIG_DIR = new URL('../../config', import.meta.url).pathname;

const RUN_ID = '00000000-0000-0000-0000-0000000000a2';
const NOW = new Date('2026-07-23T12:00:00.000Z');
const TOKEN = 'PHASE2A_TOKEN_CANARY_7d8f0e';
const TARGET_SLUG = 'test-secured-hydrants';
const CREDENTIAL_ALIAS = 'test-reader';
const CREDENTIAL_IDENTITY = 'arcgis:online:synthetic:user:reader';
const LAYER_URL = 'https://services.arcgis.com/synthorg/arcgis/rest/services/SecuredHydrants/FeatureServer/0';
const QUERY_URL = `${LAYER_URL}/query`;
const ENCRYPTED_ENVELOPE = 'bW9jay1pdi0xMjM0NTY=.bW9jay10YWctMTIzNDU2Nzg=.ZW5jcnlwdGVkLXBoYXNlMmItY2FuYXJ5LXRva2Vu';

const registry = new InMemoryArcGisTargetRegistry([
  {
    target_slug: TARGET_SLUG,
    portal_kind: 'arcgis-online',
    portal_root: 'https://synthetic.maps.arcgis.com',
    service_root: 'https://services.arcgis.com/synthorg/arcgis/rest/services',
    layer_url: LAYER_URL,
    allowed_credential_aliases: [CREDENTIAL_ALIAS],
    allowed_operations: ['query'],
  },
]);

function descriptor(overrides: Partial<ArcGisCredentialDescriptor> = {}): ArcGisCredentialDescriptor {
  return {
    credential_alias: CREDENTIAL_ALIAS,
    credential_identity: CREDENTIAL_IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    expires_at: '2026-07-23T13:00:00.000Z',
    ...overrides,
  };
}

function broker(events: string[], overrides: Partial<ArcGisTokenBroker> = {}): ArcGisTokenBroker {
  return {
    async describe(alias) {
      events.push(`describe:${alias}`);
      return descriptor();
    },
    async getAuthorization(alias, targetSlug) {
      events.push(`authorize:${alias}:${targetSlug}`);
      return `Bearer ${TOKEN}`;
    },
    ...overrides,
  };
}

function layerMetadata(): Record<string, unknown> {
  return {
    id: 0,
    name: 'Secured Hydrants',
    type: 'Feature Layer',
    geometryType: 'esriGeometryPoint',
    objectIdField: 'OBJECTID',
    capabilities: 'Query',
    maxRecordCount: 2,
    extent: { spatialReference: { wkid: 4326 } },
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false },
      { name: 'STATUS', type: 'esriFieldTypeString', nullable: true },
    ],
  };
}

function authenticatedTransport(events: string[]): ArcGisRestTransport {
  return {
    async get(request) {
      events.push(`GET:${request.url.href}:${request.authorization ?? 'none'}`);
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.url.href, `${LAYER_URL}?f=json`);
      return {
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify(layerMetadata()),
      };
    },
    async postForm(request) {
      events.push(`POST:${request.url.href}:${request.authorization ?? 'none'}`);
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.url.href, QUERY_URL);
      const form = new URLSearchParams(request.body);
      if (form.get('returnIdsOnly') === 'true') {
        assert.equal(request.body, canonicalFormBody({
          f: 'json',
          where: '1=1',
          returnIdsOnly: 'true',
          returnGeometry: 'false',
        }));
        return {
          status: 200,
          contentType: 'application/json',
          bodyText: JSON.stringify({ objectIdFieldName: 'OBJECTID', objectIds: [2, 1] }),
        };
      }
      return {
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          features: [
            { attributes: { OBJECTID: 2, STATUS: 'closed' } },
            { attributes: { OBJECTID: 1, STATUS: 'open' } },
          ],
        }),
      };
    },
  };
}

function dependencies(
  events: string[],
  tokenBroker: ArcGisTokenBroker,
  transport: ArcGisRestTransport = authenticatedTransport(events),
  overrides: Partial<RunSkillDependencies> = {},
): Partial<RunSkillDependencies> {
  return {
    recorder: {
      begin: async () => {
        events.push('recorder:begin');
        return 'invocation-phase2a';
      },
      finish: async () => undefined,
    },
    audit: async () => undefined,
    boundaryOptions: {
      audit: async () => undefined,
      resolveHost: async () => ['93.184.216.34'],
    },
    capabilityContext: {
      now: () => NOW,
      io: {
        arcgisTargetRegistry: registry,
        arcgisTokenBroker: tokenBroker,
        arcgisTransport: transport,
      },
    },
    ...overrides,
  };
}

const input = {
  target_slug: TARGET_SLUG,
  credential_alias: CREDENTIAL_ALIAS,
  out_fields: ['STATUS'],
};

function metadataRecord(overrides: Partial<ArcGisCredentialMetadataRecord> = {}): ArcGisCredentialMetadataRecord {
  return {
    credential_alias: CREDENTIAL_ALIAS,
    credential_identity: CREDENTIAL_IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    token_type: 'Bearer',
    expires_at: '2026-07-23T13:00:00.000Z',
    connected_at: '2026-07-23T10:00:00.000Z',
    refreshed_at: '2026-07-23T11:00:00.000Z',
    connected_by_user: 'synthetic-operator',
    ...overrides,
  };
}

function secretEnvelopeRecord(
  overrides: Partial<ArcGisCredentialSecretEnvelopeRecord> = {},
): ArcGisCredentialSecretEnvelopeRecord {
  return {
    credential_alias: CREDENTIAL_ALIAS,
    credential_identity: CREDENTIAL_IDENTITY,
    portal_kind: 'arcgis-online',
    permissions: ['feature:query'],
    encrypted_access_token_envelope: ENCRYPTED_ENVELOPE,
    token_type: 'Bearer',
    expires_at: '2026-07-23T13:00:00.000Z',
    ...overrides,
  };
}

interface ProductionBrokerHarnessOptions {
  brokerRegistry?: InMemoryArcGisTargetRegistry;
  metadata?: ArcGisCredentialMetadataRecord | null;
  secret?: ArcGisCredentialSecretEnvelopeRecord | null;
  metadataError?: Error;
  secretError?: Error;
  decryptError?: Error;
}

function productionBrokerHarness(
  events: string[],
  options: ProductionBrokerHarnessOptions = {},
): {
  broker: PostgresArcGisTokenBroker;
  metadataCalls: string[];
  secretCalls: string[];
  secretBindings: Array<{ alias: string; expectedCredentialIdentity: string }>;
  decryptCalls: string[];
} {
  const metadataCalls: string[] = [];
  const secretCalls: string[] = [];
  const secretBindings: Array<{ alias: string; expectedCredentialIdentity: string }> = [];
  const decryptCalls: string[] = [];
  const repository: ArcGisCredentialRepository = {
    async findMetadata(alias) {
      metadataCalls.push(alias);
      events.push(`repository:metadata:${alias}`);
      if (options.metadataError) throw options.metadataError;
      return options.metadata === undefined ? metadataRecord() : options.metadata;
    },
    async findSecretEnvelope(alias, expectedCredentialIdentity) {
      secretCalls.push(alias);
      secretBindings.push({ alias, expectedCredentialIdentity });
      events.push(`repository:secret:${alias}`);
      if (options.secretError) throw options.secretError;
      return options.secret === undefined ? secretEnvelopeRecord() : options.secret;
    },
  };
  return {
    broker: new PostgresArcGisTokenBroker({
      repository,
      targetRegistry: options.brokerRegistry ?? registry,
      now: () => NOW,
      decryptEnvelope(envelope) {
        decryptCalls.push(envelope);
        events.push('decrypt:token-envelope');
        if (options.decryptError) throw options.decryptError;
        return TOKEN;
      },
    }),
    metadataCalls,
    secretCalls,
    secretBindings,
    decryptCalls,
  };
}

async function approvedRequestFor(
  deps: Partial<RunSkillDependencies>,
): Promise<{ request: Awaited<ReturnType<typeof createApprovalRequest>>; store: InMemoryApprovalStore }> {
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);
  return { request, store };
}

function assertSurfaceHasNoCanaries(label: string, value: unknown, canaries: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    assert.equal(serialized.includes(canary), false, `${label} leaked ${canary}`);
  }
}

test('secured query is a strict approval-required read capability with no URL or credential material', () => {
  assert.equal(querySecuredFeatureServiceCapability.manifest.slug, 'query_secured_feature_service');
  assert.equal(querySecuredFeatureServiceCapability.manifest.classification, 'read');
  assert.equal(querySecuredFeatureServiceCapability.requiresApproval?.(input), true);
  assert.equal(allCapabilities().length, 9);
  assert.ok(allCapabilities().some((capability) => capability.manifest.slug === 'query_secured_feature_service'));

  assert.doesNotThrow(() => querySecuredFeatureServiceCapability.inputSchema.parse(input));
  for (const extra of [
    { layer_url: LAYER_URL },
    { token: TOKEN },
    { access_token: TOKEN },
    { authorization: `Bearer ${TOKEN}` },
  ]) {
    assert.throws(() => querySecuredFeatureServiceCapability.inputSchema.parse({ ...input, ...extra }), /unrecognized/i);
  }
  assert.throws(
    () => querySecuredFeatureServiceCapability.inputSchema.parse({ ...input, where: `STATUS='token=${TOKEN}'` }),
    /credential material/i,
  );
});

test('versioned ArcGIS target config is strict and supports exact servicesN ArcGIS Online shards', () => {
  const shardTarget = {
    ...registry.resolve(TARGET_SLUG),
    target_slug: 'test-services1',
    service_root: 'https://services1.arcgis.com/synthorg/arcgis/rest/services',
    layer_url: 'https://services1.arcgis.com/synthorg/arcgis/rest/services/Hydrants/FeatureServer/0',
  };
  assert.doesNotThrow(() => ArcGisTargetsConfigSchema.parse({
    schema_version: '1.0.0',
    targets: [shardTarget],
  }));
  assert.throws(
    () => ArcGisTargetsConfigSchema.parse({ schema_version: '2.0.0', targets: [] }),
    /invalid literal/i,
  );
  assert.throws(
    () => ArcGisTargetsConfigSchema.parse({ schema_version: '1.0.0', targets: [], unexpected: true }),
    /unrecognized/i,
  );
  for (const hostname of ['services01.arcgis.com', 'evilservices1.arcgis.com']) {
    assert.throws(
      () => ArcGisTargetsConfigSchema.parse({
        schema_version: '1.0.0',
        targets: [{
          ...shardTarget,
          service_root: `https://${hostname}/synthorg/arcgis/rest/services`,
          layer_url: `https://${hostname}/synthorg/arcgis/rest/services/Hydrants/FeatureServer/0`,
        }],
      }),
      /servicesN\.arcgis\.com/i,
    );
  }
});

test('shared normal/replay resolver requires approval for a non-destructive secured-read step', async () => {
  const events: string[] = [];
  const approval = await resolveStepApproval(
    {
      skill: 'query_secured_feature_service',
      input,
      destructive: false,
    },
    dependencies(events, broker(events)).capabilityContext!,
  );
  assert.ok(approval);
  assert.equal(approval.payload.target_slug, TARGET_SLUG);
  assert.match(
    approval.target,
    /^arcgis-target:test-secured-hydrants\|config-sha256:[a-f0-9]{64}\|operation:feature-query$/,
  );
  assert.equal(approval.credentialIdentity, CREDENTIAL_IDENTITY);
  assert.deepEqual(events, [`describe:${CREDENTIAL_ALIAS}`]);
});

test('in-memory token broker keeps authorization behind a late supplier and rejects duplicate aliases', async () => {
  let materializations = 0;
  const tokenBroker = new InMemoryArcGisTokenBroker([
    {
      descriptor: descriptor(),
      authorizationForTarget: async (targetSlug) => {
        materializations += 1;
        assert.equal(targetSlug, TARGET_SLUG);
        return `Bearer ${TOKEN}`;
      },
    },
  ]);

  assert.deepEqual(await tokenBroker.describe(CREDENTIAL_ALIAS), descriptor());
  assert.equal(materializations, 0);
  assert.equal(
    await tokenBroker.getAuthorization(CREDENTIAL_ALIAS, TARGET_SLUG),
    `Bearer ${TOKEN}`,
  );
  assert.equal(materializations, 1);
  assert.throws(
    () => new InMemoryArcGisTokenBroker([
      { descriptor: descriptor(), authorizationForTarget: () => `Bearer ${TOKEN}` },
      { descriptor: descriptor(), authorizationForTarget: () => `Bearer ${TOKEN}` },
    ]),
    /duplicate ArcGIS credential alias/,
  );
});

test('missing approval fails before token materialization, transport, recorder, and output persistence', async () => {
  const events: string[] = [];
  const result = await runSkill(
    'query_secured_feature_service',
    input,
    RUN_ID,
    dependencies(events, broker(events)),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /approval required/i);
  assert.deepEqual(events, [`describe:${CREDENTIAL_ALIAS}`]);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('approval binding includes resolved layer target and broker-owned credential identity', async () => {
  const events: string[] = [];
  const context = dependencies(events, broker(events)).capabilityContext!;
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    context,
  );
  assert.match(
    binding.target,
    /^arcgis-target:test-secured-hydrants\|config-sha256:[a-f0-9]{64}\|operation:feature-query$/,
  );
  assert.equal(binding.target.includes(LAYER_URL), false);
  assert.equal(binding.credentialIdentity, CREDENTIAL_IDENTITY);
  assert.deepEqual(events, [`describe:${CREDENTIAL_ALIAS}`]);
});

test('approved secured query consumes once, then materializes authorization and emits token-free deterministic evidence', async () => {
  const events: string[] = [];
  const boundaryAudits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const tokenBroker = broker(events);
  const deps = dependencies(events, tokenBroker);
  deps.boundaryOptions = {
    audit: async (eventType, payload) => {
      boundaryAudits.push({ eventType, payload });
    },
    resolveHost: async () => ['93.184.216.34'],
  };
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

  events.length = 0;
  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });
  assert.equal(result.ok, true, result.error);
  const output = result.output as Record<string, any>;
  assert.equal(output.access.target_slug, TARGET_SLUG);
  assert.equal(output.access.portal_kind, 'arcgis-online');
  assert.equal(output.access.permission, 'feature:query');
  assert.equal(output.report.service.url, `arcgis-target://${TARGET_SLUG}`);
  assert.deepEqual(output.report.features.map((feature: any) => feature.object_id), [1, 2]);
  assert.ok(output.report.caveats.some((caveat: string) => caveat.includes('approved authenticated identity')));
  assert.equal(output.evidence.execution.capability, 'query_secured_feature_service');
  assert.ok(output.evidence.bundle_id.startsWith('query_secured_feature_service:'));
  assert.equal(output.evidence.approvals.length, 0);
  assert.ok(events.indexOf(`authorize:${CREDENTIAL_ALIAS}:${TARGET_SLUG}`) > events.indexOf('recorder:begin'));
  assert.equal(events.filter((event) => event.startsWith('authorize:')).length, 1);
  assert.equal(events.filter((event) => event.includes(`Bearer ${TOKEN}`)).length, 3);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(CREDENTIAL_IDENTITY), false);
  assert.equal(serialized.includes('services.arcgis.com'), false);
  assert.equal(boundaryAudits.length, 3);
  assert.ok(boundaryAudits.every(({ eventType }) => eventType === 'data_query'));
  const serializedAudits = JSON.stringify(boundaryAudits);
  assert.match(serializedAudits, /arcgis-target:\/\/test-secured-hydrants\/request\//);
  for (const canary of [TOKEN, CREDENTIAL_IDENTITY, LAYER_URL, 'services.arcgis.com']) {
    assert.equal(serializedAudits.includes(canary), false, `allowed audit leaked ${canary}`);
  }

  const replay = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });
  assert.equal(replay.ok, false);
  assert.match(replay.error ?? '', /already consumed|not consumable/i);
});

test('production-shaped broker keeps secret lookup and decrypt after approval consumption and all persisted surfaces token-free', async (t) => {
  const events: string[] = [];
  const recorderSurface: unknown[] = [];
  const auditSurface: unknown[] = [];
  const boundarySurface: unknown[] = [];
  const loggerSurface: unknown[] = [];
  t.mock.method(logger, 'error', (context: unknown, message?: string) => {
    loggerSurface.push({ context, message });
  });

  const harness = productionBrokerHarness(events);
  const deps = dependencies(events, harness.broker, authenticatedTransport(events), {
    recorder: {
      async begin(invocation) {
        events.push('recorder:begin');
        recorderSurface.push({ phase: 'begin', invocation });
        return 'invocation-production-broker';
      },
      async finish(invocationId, result) {
        recorderSurface.push({ phase: 'finish', invocationId, result });
      },
    },
    audit: async (eventType, payload, agentRunId) => {
      auditSurface.push({ eventType, payload, agentRunId });
    },
    boundaryOptions: {
      audit: async (eventType, payload, agentRunId) => {
        boundarySurface.push({ eventType, payload, agentRunId });
      },
      resolveHost: async () => ['93.184.216.34'],
    },
  });
  const { request, store } = await approvedRequestFor(deps);

  assert.ok(harness.metadataCalls.length >= 1);
  assert.deepEqual(harness.secretCalls, []);
  assert.deepEqual(harness.decryptCalls, []);
  assert.equal(events.some((event) => event.startsWith('GET:') || event.startsWith('POST:')), false);

  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(harness.secretCalls, [CREDENTIAL_ALIAS]);
  assert.deepEqual(harness.secretBindings, [{
    alias: CREDENTIAL_ALIAS,
    expectedCredentialIdentity: CREDENTIAL_IDENTITY,
  }]);
  assert.deepEqual(harness.decryptCalls, [ENCRYPTED_ENVELOPE]);
  assert.ok(events.indexOf(`repository:secret:${CREDENTIAL_ALIAS}`) > events.indexOf('recorder:begin'));
  assert.ok(events.indexOf('decrypt:token-envelope') > events.indexOf(`repository:secret:${CREDENTIAL_ALIAS}`));
  assert.equal(events.filter((event) => event.startsWith('GET:') || event.startsWith('POST:')).length, 3);
  assert.equal(loggerSurface.length, 0);

  const canaries = [TOKEN, ENCRYPTED_ENVELOPE, CREDENTIAL_IDENTITY, LAYER_URL, 'services.arcgis.com'];
  assertSurfaceHasNoCanaries('result/evidence', result, canaries);
  assertSurfaceHasNoCanaries('recorder', recorderSurface, canaries);
  assertSurfaceHasNoCanaries('audit', auditSurface, canaries);
  assertSurfaceHasNoCanaries('boundary audit', boundarySurface, canaries);
  assertSurfaceHasNoCanaries('structured logger', loggerSurface, canaries);
});

test('production-shaped broker fails closed on drift, expiry, repository, and decryptor errors without canary serialization', async (t) => {
  const loggerSurface: unknown[] = [];
  t.mock.method(logger, 'error', (context: unknown, message?: string) => {
    loggerSurface.push({ context, message });
  });

  const driftedRegistry = new InMemoryArcGisTargetRegistry([{
    ...registry.resolve(TARGET_SLUG),
    service_root: 'https://services1.arcgis.com/synthorg/arcgis/rest/services',
    layer_url: 'https://services1.arcgis.com/synthorg/arcgis/rest/services/SecuredHydrants/FeatureServer/0',
  }]);
  const driftedIdentity = 'arcgis:online:synthetic:user:drift-canary';
  const repositoryCanary = 'REPOSITORY_FAILURE_CANARY_TOKEN_URL_IDENTITY';
  const decryptorCanary = 'DECRYPTOR_FAILURE_CANARY_OAUTH_TOKEN_ENCRYPTION_KEY';
  const cases: Array<{
    name: string;
    options: ProductionBrokerHarnessOptions;
    expectedSecretCalls: number;
    expectedDecryptCalls: number;
  }> = [
    {
      name: 'target-config-drift',
      options: { brokerRegistry: driftedRegistry },
      expectedSecretCalls: 0,
      expectedDecryptCalls: 0,
    },
    {
      name: 'identity-drift',
      options: { secret: secretEnvelopeRecord({ credential_identity: driftedIdentity }) },
      expectedSecretCalls: 1,
      expectedDecryptCalls: 0,
    },
    {
      name: 'exact-expiry-margin',
      options: { secret: secretEnvelopeRecord({ expires_at: '2026-07-23T12:01:00.000Z' }) },
      expectedSecretCalls: 1,
      expectedDecryptCalls: 0,
    },
    {
      name: 'repository-failure',
      options: { secretError: new Error(`${repositoryCanary} ${TOKEN} ${LAYER_URL}`) },
      expectedSecretCalls: 1,
      expectedDecryptCalls: 0,
    },
    {
      name: 'decryptor-failure',
      options: { decryptError: new Error(`${decryptorCanary} ${TOKEN} ${ENCRYPTED_ENVELOPE}`) },
      expectedSecretCalls: 1,
      expectedDecryptCalls: 1,
    },
  ];

  for (const testCase of cases) {
    const events: string[] = [];
    const recorderSurface: unknown[] = [];
    const auditSurface: unknown[] = [];
    const boundarySurface: unknown[] = [];
    let transportCalls = 0;
    const unreachableTransport: ArcGisRestTransport = {
      async get() {
        transportCalls += 1;
        throw new Error('transport must not run');
      },
      async postForm() {
        transportCalls += 1;
        throw new Error('transport must not run');
      },
    };
    const harness = productionBrokerHarness(events, testCase.options);
    const deps = dependencies(events, harness.broker, unreachableTransport, {
      recorder: {
        async begin(invocation) {
          events.push('recorder:begin');
          recorderSurface.push({ phase: 'begin', invocation });
          return `invocation-${testCase.name}`;
        },
        async finish(invocationId, result) {
          recorderSurface.push({ phase: 'finish', invocationId, result });
        },
      },
      audit: async (eventType, payload, agentRunId) => {
        auditSurface.push({ eventType, payload, agentRunId });
      },
      boundaryOptions: {
        audit: async (eventType, payload, agentRunId) => {
          boundarySurface.push({ eventType, payload, agentRunId });
        },
        resolveHost: async () => ['93.184.216.34'],
      },
    });
    const { request, store } = await approvedRequestFor(deps);
    const loggerCountBeforeRun = loggerSurface.length;

    assert.deepEqual(harness.secretCalls, [], testCase.name);
    assert.deepEqual(harness.decryptCalls, [], testCase.name);
    const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
      ...deps,
      approvalRequest: request,
      approvalDependencies: { store, now: () => NOW },
    });

    assert.equal(result.ok, false, testCase.name);
    assert.equal(result.error, 'ArcGIS authorization materialization failed', testCase.name);
    assert.equal(harness.secretCalls.length, testCase.expectedSecretCalls, testCase.name);
    assert.equal(harness.decryptCalls.length, testCase.expectedDecryptCalls, testCase.name);
    assert.equal(transportCalls, 0, testCase.name);
    assert.equal(loggerSurface.length, loggerCountBeforeRun + 1, testCase.name);
    assert.ok(events.indexOf('recorder:begin') >= 0, testCase.name);
    if (testCase.expectedSecretCalls === 1) {
      assert.ok(events.indexOf(`repository:secret:${CREDENTIAL_ALIAS}`) > events.indexOf('recorder:begin'), testCase.name);
    }

    const canaries = [
      TOKEN,
      ENCRYPTED_ENVELOPE,
      CREDENTIAL_IDENTITY,
      driftedIdentity,
      LAYER_URL,
      'services.arcgis.com',
      'services1.arcgis.com',
      repositoryCanary,
      decryptorCanary,
      'OAUTH_TOKEN_ENCRYPTION_KEY',
    ];
    assertSurfaceHasNoCanaries(`${testCase.name} result/error`, result, canaries);
    assertSurfaceHasNoCanaries(`${testCase.name} recorder`, recorderSurface, canaries);
    assertSurfaceHasNoCanaries(`${testCase.name} audit`, auditSurface, canaries);
    assertSurfaceHasNoCanaries(`${testCase.name} boundary audit`, boundarySurface, canaries);
    assertSurfaceHasNoCanaries(`${testCase.name} structured logger`, loggerSurface.slice(loggerCountBeforeRun), canaries);
  }
});

test('approved secured query passes broker the immutable approval-bound before facts', async () => {
  const events: string[] = [];
  const capturedBindings: ArcGisApprovedFeatureQueryBinding[] = [];
  const tokenBroker = broker(events, {
    async getAuthorization(alias, targetSlug, approvedBinding) {
      events.push(`authorize:${alias}:${targetSlug}`);
      capturedBindings.push(approvedBinding);
      return `Bearer ${TOKEN}`;
    },
  });
  const deps = dependencies(events, tokenBroker);
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const beforeTarget = registry.resolve(TARGET_SLUG);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

  events.length = 0;
  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(capturedBindings, [{
    credential_identity: CREDENTIAL_IDENTITY,
    target_config_sha256: arcGisTargetConfigDigest(beforeTarget),
    portal_kind: 'arcgis-online',
    permission: 'feature:query',
  }]);
  assert.equal(Object.keys(capturedBindings[0] ?? {}).sort().join(','), 'credential_identity,permission,portal_kind,target_config_sha256');
  assert.equal(Object.isFrozen(capturedBindings[0]), true);
  assert.equal(JSON.stringify(capturedBindings).includes(LAYER_URL), false);
  assert.equal(JSON.stringify(capturedBindings).includes(TOKEN), false);
});

test('identity or target drift after approval consumption fails before authorization materialization', async () => {
  const cases: Array<{
    name: string;
    registry?: { resolve(targetSlug: string): any };
    tokenBroker: ArcGisTokenBroker;
  }> = [];

  {
    let describes = 0;
    const events: string[] = [];
    cases.push({
      name: 'identity-drift',
      tokenBroker: broker(events, {
        async describe(alias) {
          describes += 1;
          events.push(`describe:${alias}`);
          return describes >= 6
            ? descriptor({ credential_identity: 'arcgis:online:synthetic:user:rotated' })
            : descriptor();
        },
        async getAuthorization() {
          events.push('authorize:unexpected');
          throw new Error('authorization must not run');
        },
      }),
    });
  }

  {
    let resolves = 0;
    const events: string[] = [];
    const driftedTarget = {
      ...registry.resolve(TARGET_SLUG),
      service_root: 'https://services1.arcgis.com/synthorg/arcgis/rest/services',
      layer_url: 'https://services1.arcgis.com/synthorg/arcgis/rest/services/SecuredHydrants/FeatureServer/0',
    };
    cases.push({
      name: 'target-drift',
      registry: {
        resolve(targetSlug: string) {
          resolves += 1;
          assert.equal(targetSlug, TARGET_SLUG);
          return resolves >= 6 ? driftedTarget : registry.resolve(TARGET_SLUG);
        },
      },
      tokenBroker: broker(events, {
        async getAuthorization() {
          events.push('authorize:unexpected');
          throw new Error('authorization must not run');
        },
      }),
    });
  }

  for (const testCase of cases) {
    const events: string[] = [];
    const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
    const deps = dependencies(events, testCase.tokenBroker);
    deps.capabilityContext = {
      now: () => NOW,
      io: {
        arcgisTargetRegistry: testCase.registry ?? registry,
        arcgisTokenBroker: testCase.tokenBroker,
        arcgisTransport: authenticatedTransport(events),
      },
    };
    const binding = await resolveCapabilityApprovalBinding(
      querySecuredFeatureServiceCapability,
      parsed,
      deps.capabilityContext,
    );
    const store = new InMemoryApprovalStore();
    const request = await createApprovalRequest(
      RUN_ID,
      'Query approved secured ArcGIS layer',
      parsed,
      { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
      { store, now: () => NOW },
    );
    assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

    const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
      ...deps,
      approvalRequest: request,
      approvalDependencies: { store, now: () => NOW },
    });
    assert.equal(result.ok, false, testCase.name);
    assert.match(result.error ?? '', /changed after approval consumption/i, testCase.name);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, testCase.name);
  }
});

test('credential descriptor failures do not echo broker error material', async () => {
  const events: string[] = [];
  const tokenBroker = broker(events, {
    describe: async () => {
      throw new Error(`descriptor failed ${TOKEN} ${LAYER_URL} ${CREDENTIAL_IDENTITY}`);
    },
  });
  const result = await runSkill(
    'query_secured_feature_service',
    input,
    RUN_ID,
    dependencies(events, tokenBroker),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ArcGIS credential description failed');
  const serialized = JSON.stringify(result);
  for (const canary of [TOKEN, LAYER_URL, CREDENTIAL_IDENTITY]) {
    assert.equal(serialized.includes(canary), false, `descriptor failure leaked ${canary}`);
  }
});

test('blocked secured requests write logical-only boundary audits and never reach transport', async () => {
  const events: string[] = [];
  const boundaryAudits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const tokenBroker = broker(events);
  let transportCalls = 0;
  const unreachableTransport: ArcGisRestTransport = {
    async get() {
      transportCalls += 1;
      throw new Error('transport must not run');
    },
    async postForm() {
      transportCalls += 1;
      throw new Error('transport must not run');
    },
  };
  const deps = dependencies(events, tokenBroker, unreachableTransport);
  deps.boundaryOptions = {
    audit: async (eventType, payload) => {
      boundaryAudits.push({ eventType, payload });
    },
    resolveHost: async () => ['10.0.0.7'],
  };
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });
  assert.equal(result.ok, false);
  assert.equal(transportCalls, 0);
  assert.equal(boundaryAudits.length, 1);
  assert.equal(boundaryAudits[0]?.eventType, 'boundary_block');
  const serializedAudits = JSON.stringify(boundaryAudits);
  assert.match(serializedAudits, /arcgis-target:\/\/test-secured-hydrants\/request\/layer_metadata/);
  for (const canary of [TOKEN, CREDENTIAL_IDENTITY, LAYER_URL, 'services.arcgis.com', '10.0.0.7']) {
    assert.equal(serializedAudits.includes(canary), false, `blocked audit leaked ${canary}`);
  }
  const serializedResult = JSON.stringify(result);
  for (const canary of [TOKEN, CREDENTIAL_IDENTITY, LAYER_URL, 'services.arcgis.com']) {
    assert.equal(serializedResult.includes(canary), false, `blocked result leaked ${canary}`);
  }
});

test('post-approval transport failures redact authorization, credential identity, and configured URLs', async () => {
  const events: string[] = [];
  const tokenBroker = broker(events);
  const leakingTransport: ArcGisRestTransport = {
    async get(request) {
      throw new Error(
        `transport failed ${request.authorization} ${TOKEN} ${LAYER_URL} ${CREDENTIAL_IDENTITY}`,
      );
    },
    async postForm(request) {
      throw new Error(
        `transport failed ${request.authorization} ${TOKEN} ${LAYER_URL} ${CREDENTIAL_IDENTITY}`,
      );
    },
  };
  const deps = dependencies(events, tokenBroker, leakingTransport);
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  for (const canary of [TOKEN, LAYER_URL, CREDENTIAL_IDENTITY, 'services.arcgis.com']) {
    assert.equal(serialized.includes(canary), false, `transport failure leaked ${canary}`);
  }
  assert.match(result.error ?? '', /arcgis-target:\/\/test-secured-hydrants|authenticated ArcGIS query failed/);
});

test('successful remote payloads that echo connection material fail closed without leaking it', async () => {
  const events: string[] = [];
  const tokenBroker = broker(events);
  const ordinaryTransport = authenticatedTransport(events);
  const echoingTransport: ArcGisRestTransport = {
    async get(request) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
      return {
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({ ...layerMetadata(), name: TOKEN }),
      };
    },
    postForm: ordinaryTransport.postForm,
  };
  const deps = dependencies(events, tokenBroker, echoingTransport);
  const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
  const binding = await resolveCapabilityApprovalBinding(
    querySecuredFeatureServiceCapability,
    parsed,
    deps.capabilityContext!,
  );
  const store = new InMemoryApprovalStore();
  const request = await createApprovalRequest(
    RUN_ID,
    'Query approved secured ArcGIS layer',
    parsed,
    { timeoutMinutes: 30, target: binding.target, credentialIdentity: binding.credentialIdentity },
    { store, now: () => NOW },
  );
  assert.equal(await decideApproval(request.id, 'approved', 'operator-test', { store, now: () => NOW }), true);

  const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
    ...deps,
    approvalRequest: request,
    approvalDependencies: { store, now: () => NOW },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'authenticated ArcGIS response contained sensitive connection material');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('target, alias, permission, portal-kind, and expiry mismatches fail before token materialization', async () => {
  const cases: Array<{ name: string; registry?: InMemoryArcGisTargetRegistry; descriptor?: ArcGisCredentialDescriptor; pattern: RegExp }> = [
    {
      name: 'unknown target',
      registry: new InMemoryArcGisTargetRegistry([]),
      pattern: /unknown ArcGIS target/i,
    },
    {
      name: 'wrong alias',
      registry: new InMemoryArcGisTargetRegistry([
        { ...registry.resolve(TARGET_SLUG), allowed_credential_aliases: ['other-reader'] },
      ]),
      pattern: /credential alias is not allowed/i,
    },
    {
      name: 'missing permission',
      descriptor: descriptor({ permissions: [] }),
      pattern: /feature:query permission/i,
    },
    {
      name: 'portal mismatch',
      descriptor: descriptor({ portal_kind: 'arcgis-enterprise' }),
      pattern: /portal kind mismatch/i,
    },
    {
      name: 'expired',
      descriptor: descriptor({ expires_at: '2026-07-23T11:59:59.000Z' }),
      pattern: /expired/i,
    },
  ];

  for (const testCase of cases) {
    const events: string[] = [];
    const tokenBroker = broker(events, {
      describe: async (alias) => {
        events.push(`describe:${alias}`);
        return testCase.descriptor ?? descriptor();
      },
    });
    const result = await runSkill('query_secured_feature_service', input, RUN_ID, {
      ...dependencies(events, tokenBroker),
      capabilityContext: {
        now: () => NOW,
        io: {
          arcgisTargetRegistry: testCase.registry ?? registry,
          arcgisTokenBroker: tokenBroker,
          arcgisTransport: authenticatedTransport(events),
        },
      },
    });
    assert.equal(result.ok, false, testCase.name);
    assert.match(result.error ?? '', testCase.pattern, testCase.name);
    assert.ok(!events.some((event) => event.startsWith('authorize:')), testCase.name);
    assert.ok(!events.some((event) => event.startsWith('GET:') || event.startsWith('POST:')), testCase.name);
  }
});

test('invalid ArcGIS token broker selector fails approval binding before recorder or transport', async () => {
  const original = process.env.DYMAXION_ARCGIS_TOKEN_BROKER;
  const { resetArcGisTargetRegistryForTest } = await import('../src/security/arcgis-connections.js');
  let transportCalls = 0;
  const unreachableTransport: ArcGisRestTransport = {
    async get() {
      transportCalls += 1;
      throw new Error('transport must not run');
    },
    async postForm() {
      transportCalls += 1;
      throw new Error('transport must not run');
    },
  };
  try {
    process.env.DYMAXION_ARCGIS_TOKEN_BROKER = ' Postgres ';
    resetArcGisTargetRegistryForTest();
    const parsed = querySecuredFeatureServiceCapability.inputSchema.parse(input);
    await assert.rejects(
      () => resolveCapabilityApprovalBinding(
        querySecuredFeatureServiceCapability,
        parsed,
        {
          now: () => NOW,
          io: {
            arcgisTargetRegistry: registry,
            arcgisTransport: unreachableTransport,
          },
        },
      ),
      /ArcGIS token broker configuration is invalid/,
    );
    assert.equal(transportCalls, 0);
  } finally {
    if (original === undefined) {
      delete process.env.DYMAXION_ARCGIS_TOKEN_BROKER;
    } else {
      process.env.DYMAXION_ARCGIS_TOKEN_BROKER = original;
    }
    resetArcGisTargetRegistryForTest();
  }
});
