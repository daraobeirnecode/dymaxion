// Deterministic-workflow registry — deliberately separate from the native
// capability registry (which stays at exactly eight entries) and from the
// historical skill catalog. Registration fails closed if a workflow collides
// with a capability slug or references an unregistered capability.

import { getCapability } from '../capabilities/registry.js';
import { getSkill } from '../skills/registry.js';
import { WorkflowManifestSchema, type WorkflowDefinition } from './contract.js';
import { arcgisChangeRiskPacketWorkflow } from './arcgis-change-risk-packet.js';

function validateWorkflowDefinition(definition: WorkflowDefinition<unknown, unknown>): void {
  const manifest = WorkflowManifestSchema.parse(definition.manifest);
  if (getCapability(manifest.slug)) {
    throw new Error(`workflow slug collides with a native capability: ${manifest.slug}`);
  }
  for (const capabilitySlug of manifest.capabilities_used) {
    if (!getCapability(capabilitySlug)) {
      throw new Error(`workflow '${manifest.slug}' references unregistered capability: ${capabilitySlug}`);
    }
  }
}

const workflows = new Map<string, WorkflowDefinition<unknown, unknown>>();

function register(definition: WorkflowDefinition<unknown, unknown>): void {
  validateWorkflowDefinition(definition);
  if (workflows.has(definition.manifest.slug)) {
    throw new Error(`workflow already registered: ${definition.manifest.slug}`);
  }
  workflows.set(definition.manifest.slug, definition);
}

register(arcgisChangeRiskPacketWorkflow as WorkflowDefinition<unknown, unknown>);

export function assertWorkflowSkillSlugAvailable(
  slug: string,
  lookup: (candidate: string) => unknown = getSkill,
): void {
  if (lookup(slug)) {
    throw new Error(`workflow slug collides with a historical skill: ${slug}`);
  }
}

export function getWorkflow(slug: string): WorkflowDefinition<unknown, unknown> | undefined {
  const workflow = workflows.get(slug);
  if (workflow) assertWorkflowSkillSlugAvailable(slug);
  return workflow;
}

export function allWorkflows(): Array<WorkflowDefinition<unknown, unknown>> {
  const registered = [...workflows.values()];
  for (const workflow of registered) assertWorkflowSkillSlugAvailable(workflow.manifest.slug);
  return registered;
}
