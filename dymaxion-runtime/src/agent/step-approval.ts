import type { CapabilityExecutionContext } from '../contracts/capability.js';
import { capabilityRequiresApproval } from '../contracts/capability.js';
import { getCapability, resolveCapabilityApprovalBinding } from '../capabilities/registry.js';
import { deriveApprovalTarget } from '../security/approval.js';
import { resolveExecutionCredentialIdentity } from '../security/execution-identity.js';

export interface ApprovalAwareStep {
  skill: string;
  input: Record<string, unknown>;
  destructive: boolean;
}

export interface StepApprovalResolution {
  payload: Record<string, unknown>;
  target: string;
  credentialIdentity: string;
}

/** Parse one plan step through the native capability contract and resolve the
 * exact approval binding used by both first execution and replay. */
export async function resolveStepApproval(
  step: ApprovalAwareStep,
  context: CapabilityExecutionContext = {},
): Promise<StepApprovalResolution | undefined> {
  const capability = getCapability(step.skill);
  if (!capability) {
    if (!step.destructive) return undefined;
    return {
      payload: step.input,
      target: deriveApprovalTarget(step.skill, step.input),
      credentialIdentity: resolveExecutionCredentialIdentity(step.skill),
    };
  }

  const parsed = capability.inputSchema.parse(step.input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native capability ${step.skill} approval payload must be an object`);
  }
  const payload = parsed as Record<string, unknown>;
  if (
    !capabilityRequiresApproval(capability, {
      alreadyParsed: true,
      parsedInput: payload,
    })
  ) {
    return undefined;
  }

  const binding = await resolveCapabilityApprovalBinding(capability, payload, context);
  return {
    payload,
    target: binding.target,
    credentialIdentity: binding.credentialIdentity,
  };
}
