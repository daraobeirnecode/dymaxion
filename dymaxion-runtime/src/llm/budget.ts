// Per-tier monthly USD budgets, enforced PRE-CALL (middleware step 2) and
// accrued POST-CALL (step 5). Ledger lives in dymaxion.budget_ledger so caps
// survive restarts. A cap hit freezes the tier and requires a manual reset
// (admin dashboard → Settings) — matching the "runaway skill blocks itself"
// non-negotiable.

import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { loadConfig } from '../config/loader.js';
import { auditEvent } from '../security/audit.js';

export class BudgetExceeded extends Error {
  constructor(
    public readonly tier: string,
    public readonly spent: number,
    public readonly cap: number,
  ) {
    super(`Budget cap hit for tier '${tier}': $${spent.toFixed(2)} of $${cap.toFixed(2)}/month`);
    this.name = 'BudgetExceeded';
  }
}

export function tierForSkillClass(skillClass: string): string {
  const { budgets } = loadConfig();
  return budgets.tier_by_skill_class[skillClass] ?? budgets.default_tier;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export interface BudgetStatus {
  tier: string;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  frozen: boolean;
}

export async function budgetStatus(tier: string): Promise<BudgetStatus> {
  const tierCfg = loadConfig().budgets.budgets[tier];
  if (!tierCfg) throw new Error(`Unknown budget tier '${tier}'`);
  const [row] = await db
    .select()
    .from(schema.budgetLedger)
    .where(and(eq(schema.budgetLedger.tier, tier), eq(schema.budgetLedger.month, currentMonth())));
  const spent = row ? Number(row.spentUsd) : 0;
  return {
    tier,
    capUsd: tierCfg.max_usd_per_month,
    spentUsd: spent,
    remainingUsd: Math.max(0, tierCfg.max_usd_per_month - spent),
    frozen: row?.frozen ?? false,
  };
}

/** Middleware step 2 — throws BudgetExceeded when the tier is frozen or over cap. */
export async function checkBudget(tier: string, model: string, provider: string): Promise<void> {
  const tierCfg = loadConfig().budgets.budgets[tier];
  if (!tierCfg) throw new Error(`Unknown budget tier '${tier}'`);
  if (!tierCfg.allowed_providers.includes(provider)) {
    throw new Error(`Provider '${provider}' not allowed for budget tier '${tier}'`);
  }
  const bareModel = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  if (!tierCfg.allowed_models.includes(bareModel)) {
    throw new Error(`Model '${bareModel}' not allowed for budget tier '${tier}'`);
  }
  const status = await budgetStatus(tier);
  if (status.frozen || status.remainingUsd <= 0) {
    await auditEvent('budget_block', { tier, spent: status.spentUsd, cap: status.capUsd });
    throw new BudgetExceeded(tier, status.spentUsd, status.capUsd);
  }
}

/** Middleware step 5 — accrue actual cost; freeze the tier when it crosses the cap. */
export async function accrueCost(tier: string, costUsd: number): Promise<BudgetStatus> {
  const month = currentMonth();
  await db
    .insert(schema.budgetLedger)
    .values({ tier, month, spentUsd: costUsd.toFixed(4) })
    .onConflictDoUpdate({
      target: [schema.budgetLedger.tier, schema.budgetLedger.month],
      set: {
        spentUsd: dsql`${schema.budgetLedger.spentUsd} + ${costUsd.toFixed(4)}`,
        updatedAt: new Date(),
      },
    });
  const status = await budgetStatus(tier);
  if (status.remainingUsd <= 0 && !status.frozen) {
    await db
      .update(schema.budgetLedger)
      .set({ frozen: true })
      .where(and(eq(schema.budgetLedger.tier, tier), eq(schema.budgetLedger.month, month)));
    await auditEvent('budget_block', { tier, event: 'frozen', spent: status.spentUsd });
  }
  return status;
}

/** Manual reset from the admin dashboard. */
export async function unfreezeTier(tier: string): Promise<void> {
  await db
    .update(schema.budgetLedger)
    .set({ frozen: false })
    .where(and(eq(schema.budgetLedger.tier, tier), eq(schema.budgetLedger.month, currentMonth())));
}
