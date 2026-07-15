// Skill registry — scans skills/active/ at startup, validates each folder
// (SKILL.md + manifest.yaml), verifies declared tools are available, and
// registers into memory + dymaxion.skill_registry. A skill that fails
// validation is logged and NOT registered; startup continues.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { parse } from 'yaml';
import { db, schema } from '../db/client.js';
import { mcpAvailable } from '../mcp/manager.js';
import { workerConfigured, workerAvailable } from '../worker/client.js';
import { logger } from '../observability/logger.js';

export interface SkillManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  skill_class: string;
  llm_override?: string;
  tools: string[];
  executor: { type: 'python' | 'node' | 'shell'; entrypoint: string; runtime: string };
  budget: { max_cost_usd: number; max_duration_seconds: number };
  inputs: Array<{ name: string; type: string; required: boolean; validation?: string }>;
  outputs: Array<{ name: string; type: string }>;
  destructive: boolean;
  requires_approval: boolean;
  authored_by: string;
  approved_at: string;
}

export interface RegisteredSkill {
  manifest: SkillManifest;
  category: string;
  dir: string;
  skillMd: string;
  available: boolean; // false when a required tool/MCP/worker is down
  unavailableReason?: string;
}

const registry = new Map<string, RegisteredSkill>();

// Tools that are always present inside the runtime container.
const BUILTIN_TOOLS = new Set([
  'gdal-bin',
  'cli-anything-qgis',
  'duckdb',
  'pystac-client',
  'osmium',
  'pyspark',
  'sedona',
  'wherobots-cli',
  'http',
  'npm',
  'docker',
  'none',
]);

function toolAvailable(tool: string): { ok: boolean; reason?: string } {
  if (tool.endsWith('-mcp')) {
    const name = tool.replace(/-mcp$/, '');
    return mcpAvailable(name)
      ? { ok: true }
      : { ok: false, reason: `MCP server '${name}' not running` };
  }
  if (tool === 'windows-worker') {
    if (!workerConfigured()) return { ok: false, reason: 'Windows Worker not configured' };
    return workerAvailable() ? { ok: true } : { ok: false, reason: 'Windows Worker unreachable' };
  }
  if (BUILTIN_TOOLS.has(tool)) return { ok: true };
  // Unknown tool names don't block registration in Sprint 1 — they degrade.
  return { ok: true };
}

export function validateManifest(raw: unknown, dir: string): SkillManifest {
  const m = raw as Partial<SkillManifest>;
  const required: Array<keyof SkillManifest> = [
    'slug',
    'name',
    'version',
    'description',
    'skill_class',
    'tools',
    'executor',
    'budget',
    'destructive',
    'requires_approval',
    'authored_by',
  ];
  for (const field of required) {
    if (m[field] === undefined || m[field] === null) {
      throw new Error(`manifest.yaml missing '${String(field)}' in ${dir}`);
    }
  }
  if (m.slug !== basename(dir)) {
    throw new Error(`manifest slug '${m.slug}' does not match folder name '${basename(dir)}'`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(m.version!)) {
    throw new Error(`manifest version '${m.version}' is not semver in ${dir}`);
  }
  if (!existsSync(join(dir, m.executor!.entrypoint))) {
    throw new Error(`executor entrypoint '${m.executor!.entrypoint}' missing in ${dir}`);
  }
  if (m.destructive && !m.requires_approval) {
    throw new Error(`destructive skill '${m.slug}' must set requires_approval: true`);
  }
  return m as SkillManifest;
}

function skillsRoot(): string {
  return process.env.SKILLS_DIR ?? '/workspace/skills';
}

/** Scan skills/active/<category>/<slug>/ and (re)build the registry. */
export async function loadSkills(persist = true): Promise<RegisteredSkill[]> {
  registry.clear();
  const activeDir = join(skillsRoot(), 'active');
  if (!existsSync(activeDir)) {
    logger.warn({ activeDir }, 'skills/active not found — empty registry');
    return [];
  }
  for (const category of readdirSync(activeDir)) {
    const categoryDir = join(activeDir, category);
    if (!statSync(categoryDir).isDirectory()) continue;
    for (const slug of readdirSync(categoryDir)) {
      const dir = join(categoryDir, slug);
      if (!statSync(dir).isDirectory()) continue;
      try {
        const manifestPath = join(dir, 'manifest.yaml');
        const skillMdPath = join(dir, 'SKILL.md');
        if (!existsSync(manifestPath) || !existsSync(skillMdPath)) {
          throw new Error('missing SKILL.md or manifest.yaml');
        }
        const manifest = validateManifest(parse(readFileSync(manifestPath, 'utf8')), dir);
        const skillMd = readFileSync(skillMdPath, 'utf8');

        let available = true;
        let unavailableReason: string | undefined;
        for (const tool of manifest.tools ?? []) {
          const check = toolAvailable(tool);
          if (!check.ok) {
            available = false;
            unavailableReason = check.reason;
            break;
          }
        }
        if (manifest.executor.runtime === 'windows-worker' && !workerAvailable()) {
          available = false;
          unavailableReason = workerConfigured()
            ? 'Windows Worker unreachable'
            : 'Windows Worker not configured';
        }

        registry.set(manifest.slug, { manifest, category, dir, skillMd, available, unavailableReason });
      } catch (err) {
        logger.error({ err: String(err), dir }, 'skill failed validation — not registered');
      }
    }
  }

  if (persist) {
    for (const skill of registry.values()) {
      await db
        .insert(schema.skillRegistry)
        .values({
          slug: skill.manifest.slug,
          name: skill.manifest.name,
          version: skill.manifest.version,
          category: skill.category,
          skillClass: skill.manifest.skill_class,
          destructive: skill.manifest.destructive,
          requiresApproval: skill.manifest.requires_approval,
          authoredBy: skill.manifest.authored_by,
          manifest: skill.manifest as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: schema.skillRegistry.slug,
          set: {
            name: skill.manifest.name,
            version: skill.manifest.version,
            category: skill.category,
            skillClass: skill.manifest.skill_class,
            destructive: skill.manifest.destructive,
            requiresApproval: skill.manifest.requires_approval,
            manifest: skill.manifest as unknown as Record<string, unknown>,
            status: 'active',
          },
        });
    }
  }
  logger.info({ count: registry.size }, 'skill registry loaded');
  return [...registry.values()];
}

export function getSkill(slug: string): RegisteredSkill | undefined {
  return registry.get(slug);
}

export function allSkills(): RegisteredSkill[] {
  return [...registry.values()];
}

/** Skills plausibly applicable to a classified intent domain. */
export function applicableSkills(domain: string): RegisteredSkill[] {
  const byCategory: Record<string, string[]> = {
    esri: ['esri'],
    oss: ['oss'],
    'web-mobile': ['web-mobile'],
    architecture: ['architecture'],
    meta: ['meta'],
  };
  const categories = byCategory[domain];
  if (!categories) return allSkills();
  return allSkills().filter((s) => categories.includes(s.category));
}

/** Refresh worker/MCP-dependent availability without a full rescan. */
export function refreshAvailability(): void {
  for (const skill of registry.values()) {
    if (
      skill.manifest.executor.runtime === 'windows-worker' ||
      skill.manifest.tools.includes('windows-worker')
    ) {
      skill.available = workerAvailable();
      skill.unavailableReason = skill.available ? undefined : 'Windows Worker unreachable';
    }
  }
}
