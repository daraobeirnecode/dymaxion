import { readFile, stat } from 'node:fs/promises';
import type { CapabilityDefinition, CapabilityExecutionContext } from '../contracts/capability.js';
import { inspectDatasetCapability } from './inspect-dataset.js';

const capabilities = new Map<string, CapabilityDefinition<unknown, unknown>>([
  [inspectDatasetCapability.manifest.slug, inspectDatasetCapability as CapabilityDefinition<unknown, unknown>],
]);

export function getCapability(slug: string): CapabilityDefinition<unknown, unknown> | undefined {
  return capabilities.get(slug);
}

export function allCapabilities(): Array<CapabilityDefinition<unknown, unknown>> {
  return [...capabilities.values()];
}

export async function executeCapability(
  slug: string,
  rawInput: unknown,
  supplied: CapabilityExecutionContext = {},
): Promise<unknown> {
  const capability = getCapability(slug);
  if (!capability) throw new Error(`unknown native capability: ${slug}`);
  const input = capability.inputSchema.parse(rawInput);
  const context: CapabilityExecutionContext = {
    ...supplied,
    io: supplied.io ?? { stat, readFile },
  };
  const output = await capability.execute(input, context);
  return capability.outputSchema.parse(output);
}
