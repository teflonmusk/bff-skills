#!/usr/bin/env bun
/**
 * hodlmm-dca-deployer — DCA into Bitflow HODLMM concentrated liquidity positions
 *
 * Instead of deploying all capital at once into an LP position (timing risk + IL spike),
 * split deposits across tranches. Each tranche enters at the current price, building a
 * position with a blended entry that smooths out volatility.
 *
 * Usage:
 *   bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts plan <pool-id> --amount <sats> --tranches <n> --interval <blocks>
 *   bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts execute <plan-id> [--dry-run]
 *   bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts status <plan-id>
 *   bun hodlmm-dca-deployer/hodlmm-dca-deployer.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const BFF_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.mainnet.hiro.so";
const MIN_TRANCHE_SATS = 10_000; // Minimum per tranche (Styx pool minimum)
const MAX_TRANCHES = 20;
const DEFAULT_INTERVAL_BLOCKS = 150; // ~5 min on Nakamoto
const DEFAULT_TRANCHES = 5;

// ── Types ──────────────────────────────────────────────────────────────

interface Pool {
  id: string;
  tokenX: string;
  tokenY: string;
  binStep: number;
  baseFee: number;
  variableFee: number;
  activeId: number;
  reserveX: string;
  reserveY: string;
}

interface Tranche {
  index: number;
  amountSats: number;
  status: "pending" | "executed" | "skipped" | "failed";
  targetBlock: number;
  executedAtBlock?: number;
  entryBinId?: number;
  entryPrice?: number;
  txid?: string;
  error?: string;
}

interface DcaPlan {
  id: string;
  poolId: string;
  totalSats: number;
  trancheCount: number;
  intervalBlocks: number;
  tranches: Tranche[];
  createdAtBlock: number;
  status: "active" | "completed" | "paused" | "cancelled";
  blendedEntryPrice?: number;
  executedTranches: number;
  totalDeployed: number;
}

interface PoolConditions {
  poolId: string;
  activeBinId: number;
  binPrice: number;
  reserveX: string;
  reserveY: string;
  binStep: number;
  totalFeeRate: number;
  reserveImbalance: number;
  isHealthy: boolean;
  healthReason?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.log(JSON.stringify({ status: "error", error: { code: "EXECUTION_ERROR", message } }, null, 2));
  process.exit(1);
}

function ok(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: "success", data }, null, 2));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

function generatePlanId(): string {
  return `dca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function binIdToPrice(binId: number, binStep: number): number {
  // HODLMM price from bin ID: price = (1 + binStep/10000) ^ (binId - 8388608)
  const base = 1 + binStep / 10_000;
  const exponent = binId - 8_388_608;
  return Math.pow(base, exponent);
}

// ── Pool Data ──────────────────────────────────────────────────────────

async function getPoolConditions(poolId: string): Promise<PoolConditions> {
  const pool = await fetchJson<Pool>(`${BFF_API}/hodlmm/pools/${poolId}`);

  const activeBinId = pool.activeId;
  const binStep = pool.binStep;
  const binPrice = binIdToPrice(activeBinId, binStep);
  // BFF HODLMM API returns fees as raw uint values — divide by 1e18 per Trader Joe v2 convention
  // (baseFee and variableFee are stored as 128.128 fixed-point scaled by 1e18)
  const totalFeeRate = (pool.baseFee + pool.variableFee) / 1e18;

  const reserveXNum = parseFloat(pool.reserveX);
  const reserveYNum = parseFloat(pool.reserveY);
  const totalReserves = reserveXNum + reserveYNum * binPrice;
  const reserveImbalance = totalReserves > 0
    ? Math.abs(reserveXNum - reserveYNum * binPrice) / totalReserves
    : 0;

  // Health check: skip tranches if pool is in bad shape
  let isHealthy = true;
  let healthReason: string | undefined;

  if (reserveImbalance > 0.9) {
    isHealthy = false;
    healthReason = `Reserve imbalance ${(reserveImbalance * 100).toFixed(1)}% — pool nearly single-sided`;
  }

  return {
    poolId,
    activeBinId,
    binPrice,
    reserveX: pool.reserveX,
    reserveY: pool.reserveY,
    binStep,
    totalFeeRate,
    reserveImbalance,
    isHealthy,
    healthReason,
  };
}

async function getCurrentBlock(): Promise<number> {
  // Use stacks_tip_height (Nakamoto ~2s blocks), NOT burn_block_height (Bitcoin ~10min blocks)
  const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
  return info.stacks_tip_height;
}

// ── Commands ───────────────────────────────────────────────────────────

async function plan(
  poolId: string,
  opts: { amount: string; tranches: string; interval: string }
): Promise<void> {
  const totalSats = parseInt(opts.amount, 10);
  const trancheCount = parseInt(opts.tranches, 10) || DEFAULT_TRANCHES;
  const intervalBlocks = parseInt(opts.interval, 10) || DEFAULT_INTERVAL_BLOCKS;

  // Validation
  if (!totalSats || totalSats < MIN_TRANCHE_SATS) {
    fail(`Total amount must be at least ${MIN_TRANCHE_SATS} sats`);
  }
  if (trancheCount < 2 || trancheCount > MAX_TRANCHES) {
    fail(`Tranches must be between 2 and ${MAX_TRANCHES}`);
  }

  const perTranche = Math.floor(totalSats / trancheCount);
  if (perTranche < MIN_TRANCHE_SATS) {
    fail(`Per-tranche amount (${perTranche} sats) below minimum ${MIN_TRANCHE_SATS}`);
  }

  // Get pool conditions
  const conditions = await getPoolConditions(poolId);
  const currentBlock = await getCurrentBlock();

  // Build tranches
  const tranches: Tranche[] = [];
  for (let i = 0; i < trancheCount; i++) {
    const isLast = i === trancheCount - 1;
    tranches.push({
      index: i,
      amountSats: isLast ? totalSats - perTranche * (trancheCount - 1) : perTranche,
      status: "pending",
      targetBlock: currentBlock + intervalBlocks * i,
    });
  }

  const plan: DcaPlan = {
    id: generatePlanId(),
    poolId,
    totalSats,
    trancheCount,
    intervalBlocks,
    tranches,
    createdAtBlock: currentBlock,
    status: "active",
    executedTranches: 0,
    totalDeployed: 0,
  };

  // Estimate completion
  const totalBlocks = intervalBlocks * (trancheCount - 1);
  const estimatedMinutes = Math.round(totalBlocks * 2 / 60); // ~2s per Nakamoto block

  ok({
    plan: {
      id: plan.id,
      poolId: plan.poolId,
      totalSats: plan.totalSats,
      trancheCount: plan.trancheCount,
      intervalBlocks: plan.intervalBlocks,
      perTranche,
      currentBlock,
      firstTranche: tranches[0].targetBlock,
      lastTranche: tranches[tranches.length - 1].targetBlock,
      estimatedCompletionMinutes: estimatedMinutes,
    },
    poolConditions: {
      activeBinId: conditions.activeBinId,
      currentPrice: conditions.binPrice,
      binStep: conditions.binStep,
      totalFeeRate: conditions.totalFeeRate,
      reserveImbalance: `${(conditions.reserveImbalance * 100).toFixed(1)}%`,
      isHealthy: conditions.isHealthy,
      healthReason: conditions.healthReason,
    },
    schedule: tranches.map((t) => ({
      tranche: t.index + 1,
      amount: `${t.amountSats} sats`,
      targetBlock: t.targetBlock,
      status: t.status,
    })),
    execution: {
      action: "execute",
      description:
        "To execute the next pending tranche, the parent agent should call the appropriate deposit MCP tool with the tranche amount and pool ID. DCA deployer outputs the parameters — execution requires wallet access.",
      nextTranche: {
        index: 0,
        amount: tranches[0].amountSats,
        poolId: plan.poolId,
        tool: "hodlmm_add_liquidity or styx_deposit depending on source",
        params: {
          pool_id: plan.poolId,
          amount_sats: tranches[0].amountSats,
          bin_id: conditions.activeBinId,
        },
      },
    },
  });
}

async function execute(
  poolId: string,
  opts: { amount: string; binId?: string; dryRun?: boolean }
): Promise<void> {
  const amountSats = parseInt(opts.amount, 10);
  if (!amountSats || amountSats < MIN_TRANCHE_SATS) {
    fail(`--amount must be at least ${MIN_TRANCHE_SATS} sats`);
  }

  const isDryRun = opts.dryRun ?? false;

  // Get current pool conditions for the tranche
  let conditions: PoolConditions | null = null;
  try {
    conditions = await getPoolConditions(poolId);
  } catch {
    // Pool data unavailable — proceed with user-supplied bin ID or fail
  }

  const binId = opts.binId
    ? parseInt(opts.binId, 10)
    : conditions?.activeBinId;

  if (!binId) {
    fail("Could not determine active bin ID. Provide --bin-id or ensure BFF API is reachable.");
  }

  if (conditions && !conditions.isHealthy) {
    ok({
      action: "execute_tranche",
      status: "skipped",
      reason: conditions.healthReason,
      recommendation: "Pool conditions unhealthy — wait and retry at next interval",
    });
    return;
  }

  ok({
    action: isDryRun ? "dry_run" : "execute_tranche",
    poolId,
    amountSats,
    binId,
    poolHealth: conditions ? {
      isHealthy: conditions.isHealthy,
      reserveImbalance: `${(conditions.reserveImbalance * 100).toFixed(1)}%`,
      currentPrice: conditions.binPrice,
    } : "unavailable — executing with user params",
    mcpCall: {
      tool: "hodlmm_add_liquidity",
      params: { pool_id: poolId, amount_sats: amountSats, bin_id: binId },
      description: `Deploy ${amountSats} sats into pool ${poolId} at bin ${binId}`,
      dryRun: isDryRun,
    },
    note: "Parent agent executes this MCP call with wallet access. " +
      "Run 'plan' first for optimal tranche schedule, then call 'execute' for each tranche.",
  });
}

// Note: status command removed — plan state is managed by the parent agent.
// This skill is advisory: plan generates the schedule, execute deploys individual tranches.

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  // Check Bitflow API
  try {
    await fetchJson(`${BFF_API}/hodlmm/pools`);
    checks.push({ check: "Bitflow HODLMM API", status: "ok", detail: "Reachable" });
  } catch (e) {
    checks.push({ check: "Bitflow HODLMM API", status: "error", detail: `Unreachable: ${e}` });
  }

  // Check Hiro API
  try {
    const info = await fetchJson<{ stacks_tip_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({
      check: "Stacks block height",
      status: "ok",
      detail: `Block ${info.stacks_tip_height} (Nakamoto ~2s blocks)`,
    });
  } catch (e) {
    checks.push({ check: "Stacks block height", status: "error", detail: `Unreachable: ${e}` });
  }

  // Check minimum requirements
  checks.push({
    check: "Minimum tranche size",
    status: "info",
    detail: `${MIN_TRANCHE_SATS} sats per tranche (Styx pool minimum)`,
  });
  checks.push({
    check: "Max tranches",
    status: "info",
    detail: `${MAX_TRANCHES} tranches maximum per plan`,
  });
  checks.push({
    check: "Wallet requirement",
    status: "info",
    detail: "Execution requires unlocked wallet via parent agent MCP tools",
  });

  const allOk = checks.every((c) => c.status !== "error");
  ok({
    healthy: allOk,
    checks,
    note: "DCA deployer is an advisory skill. It calculates optimal tranche schedules " +
      "and pool entry parameters. Actual deposits execute through the parent agent's " +
      "wallet-connected MCP tools (styx_deposit, hodlmm_add_liquidity).",
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("hodlmm-dca-deployer")
  .description("DCA into Bitflow HODLMM concentrated liquidity positions")
  .version("1.0.0");

program
  .command("plan <pool-id>")
  .description("Create a DCA plan — split deposits into tranches with optimal timing")
  .requiredOption("--amount <sats>", "Total amount in satoshis to deploy")
  .option("--tranches <n>", `Number of tranches (2-${MAX_TRANCHES})`, String(DEFAULT_TRANCHES))
  .option("--interval <blocks>", "Blocks between tranches", String(DEFAULT_INTERVAL_BLOCKS))
  .action(async (poolId: string, opts) => {
    try {
      await plan(poolId, opts);
    } catch (e) {
      fail(`Plan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

program
  .command("execute <pool-id>")
  .description("Execute a single tranche — deploy sats into pool at current or specified bin")
  .requiredOption("--amount <sats>", "Amount in satoshis for this tranche")
  .option("--bin-id <id>", "Target bin ID (defaults to pool active bin)")
  .option("--dry-run", "Simulate execution without depositing")
  .action(async (poolId: string, opts) => {
    try {
      await execute(poolId, opts);
    } catch (e) {
      fail(`Execute failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

program
  .command("doctor")
  .description("Check prerequisites — API access, pool availability, wallet status")
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

program.parse();
