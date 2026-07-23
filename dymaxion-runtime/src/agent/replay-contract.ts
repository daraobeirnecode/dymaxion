import { getCapability } from '../capabilities/registry.js';
import { getSkill } from '../skills/registry.js';
import { getWorkflow } from '../workflows/registry.js';

export type ReplayStepKind = 'historical-skill' | 'native-capability' | 'workflow';

export interface ReplayStepIdentity {
  skill: string;
  kind?: unknown;
}

/**
 * Fail closed when a stored plan's immutable kind no longer agrees with the
 * current registry. Missing legacy kinds are deliberately not inferred.
 */
export function assertReplayStepKind(step: ReplayStepIdentity): ReplayStepKind {
  const workflow = getWorkflow(step.skill);
  const capability = getCapability(step.skill);
  const historicalSkill = getSkill(step.skill);
  const registrations = Number(Boolean(workflow)) + Number(Boolean(capability)) + Number(Boolean(historicalSkill));
  if (registrations !== 1) throw new Error('replay step registry identity is unavailable or ambiguous');

  const expected: ReplayStepKind = workflow
    ? 'workflow'
    : capability
      ? 'native-capability'
      : 'historical-skill';
  if (step.kind !== expected) throw new Error('replay step kind does not match its stored registry identity');
  return expected;
}

/** Validate all immutable step identities before invoking the replay-row sink. */
export async function createReplayAfterKindValidation<T>(
  plan: { steps: ReplayStepIdentity[] },
  createReplay: () => Promise<T>,
): Promise<T> {
  for (const step of plan.steps) assertReplayStepKind(step);
  return await createReplay();
}
