import { readFile, stat } from 'node:fs/promises';
import type { CapabilityDefinition, CapabilityExecutionContext } from '../contracts/capability.js';
import { capabilityRequiresApproval } from '../contracts/capability.js';
import { sha256Canonical } from '../contracts/canonical.js';
import { claimConsumedApprovalReceipt } from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';
import { generateMapArtifactCapability } from './generate-map-artifact.js';
import { exportEvidenceBundleCapability } from './export-evidence-bundle.js';
import { inspectArcgisOrgCapability } from './inspect-arcgis-org.js';
import { inspectDatasetCapability } from './inspect-dataset.js';
import { queryFeatureServiceCapability } from './query-feature-service.js';
import { runVectorAnalysisCapability } from './run-vector-analysis.js';
import { traceArcgisDependenciesCapability } from './trace-arcgis-dependencies.js';
import { validateSpatialDataCapability } from './validate-spatial-data.js';

const capabilities = new Map<string, CapabilityDefinition<unknown, unknown>>([
  [inspectDatasetCapability.manifest.slug, inspectDatasetCapability as CapabilityDefinition<unknown, unknown>],
  [
    inspectArcgisOrgCapability.manifest.slug,
    inspectArcgisOrgCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    traceArcgisDependenciesCapability.manifest.slug,
    traceArcgisDependenciesCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    queryFeatureServiceCapability.manifest.slug,
    queryFeatureServiceCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    validateSpatialDataCapability.manifest.slug,
    validateSpatialDataCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    generateMapArtifactCapability.manifest.slug,
    generateMapArtifactCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    runVectorAnalysisCapability.manifest.slug,
    runVectorAnalysisCapability as CapabilityDefinition<unknown, unknown>,
  ],
  [
    exportEvidenceBundleCapability.manifest.slug,
    exportEvidenceBundleCapability as CapabilityDefinition<unknown, unknown>,
  ],
]);

export function getCapability(slug: string): CapabilityDefinition<unknown, unknown> | undefined {
  return capabilities.get(slug);
}

export function allCapabilities(): Array<CapabilityDefinition<unknown, unknown>> {
  return [...capabilities.values()];
}

export function registerCapabilityForTest(definition: CapabilityDefinition<unknown, unknown>): () => void {
  const slug = definition.manifest.slug;
  if (capabilities.has(slug)) throw new Error(`native capability already registered: ${slug}`);
  capabilities.set(slug, definition);
  return () => {
    if (capabilities.get(slug) === definition) capabilities.delete(slug);
  };
}

interface CapabilityPreflightGrantRecord {
  slug: string;
  inputSha256: string;
  agentRunId?: string;
}

const capabilityPreflightGrants = new WeakMap<object, CapabilityPreflightGrantRecord>();

/** Run a native capability's pure preflight and mint one-use proof for the
 * exact canonical input. This lets runSkill keep preflight before persistence
 * while the direct registry still fails closed when no genuine proof exists. */
export async function preflightCapabilityDefinition(
  capability: CapabilityDefinition<unknown, unknown>,
  parsedInput: unknown,
  context: CapabilityExecutionContext,
): Promise<object> {
  if (capability.preflight) await capability.preflight(parsedInput, context);
  const grant = Object.freeze({});
  capabilityPreflightGrants.set(grant, {
    slug: capability.manifest.slug,
    inputSha256: sha256Canonical(parsedInput),
    agentRunId: context.agentRunId,
  });
  return grant;
}

function consumeCapabilityPreflightGrant(
  grant: unknown,
  capability: CapabilityDefinition<unknown, unknown>,
  parsedInput: unknown,
  context: CapabilityExecutionContext,
): boolean {
  if (grant === undefined) return false;
  if (!grant || typeof grant !== 'object') throw new Error('invalid capability preflight grant');
  const record = capabilityPreflightGrants.get(grant);
  capabilityPreflightGrants.delete(grant);
  if (
    !record ||
    record.slug !== capability.manifest.slug ||
    record.inputSha256 !== sha256Canonical(parsedInput) ||
    record.agentRunId !== context.agentRunId
  ) {
    throw new Error('invalid capability preflight grant');
  }
  return true;
}

export async function executeCapabilityDefinition(
  capability: CapabilityDefinition<unknown, unknown>,
  rawInput: unknown,
  supplied: CapabilityExecutionContext = {},
): Promise<unknown> {
  const input = capability.inputSchema.parse(rawInput);
  let context: CapabilityExecutionContext = {
    ...supplied,
    io: supplied.io ?? { stat, readFile },
  };
  // runSkill supplies one-use proof when it already ran this exact input's pure
  // preflight before recorder creation. Direct callers have no proof and must
  // run preflight here; forged or replayed proof fails closed.
  if (!consumeCapabilityPreflightGrant(context.capabilityPreflightGrant, capability, input, context)) {
    if (capability.preflight) await capability.preflight(input, context);
  }
  if (capabilityRequiresApproval(capability, { alreadyParsed: true, parsedInput: input })) {
    if (!context.agentRunId) throw new Error('consumed approval receipt binding mismatch');
    const approvalExecutionGrant = claimConsumedApprovalReceipt(context.approvalReceipt, {
      agentRunId: context.agentRunId,
      skill: capability.manifest.slug,
      payload: input as Record<string, unknown>,
      credentialIdentity: resolveExecutionCredentialIdentity(capability.manifest.slug),
    });
    context = { ...context, approvalExecutionGrant };
  }
  const output = await capability.execute(input, context);
  return capability.outputSchema.parse(output);
}

export async function executeCapability(
  slug: string,
  rawInput: unknown,
  supplied: CapabilityExecutionContext = {},
): Promise<unknown> {
  const capability = getCapability(slug);
  if (!capability) throw new Error(`unknown native capability: ${slug}`);
  return executeCapabilityDefinition(capability, rawInput, supplied);
}
