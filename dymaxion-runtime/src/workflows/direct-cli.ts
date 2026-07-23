import { loadSkills } from '../skills/registry.js';
import { getWorkflow } from './registry.js';
import type { WorkflowDefinition } from './contract.js';

/** Resolve the direct CLI workflow only after rebuilding the historical-skill registry. */
export async function loadChangeRiskPacketWorkflowForCli(): Promise<WorkflowDefinition<unknown, unknown>> {
  await loadSkills(false);
  const workflow = getWorkflow('arcgis_change_risk_packet');
  if (!workflow) throw new Error('change-risk workflow is not registered');
  return workflow;
}
