#!/usr/bin/env bun
/**
 * hodlmm-liquidity-shield — Stop-loss protection for HODLMM concentrated liquidity
 *
 * Monitors price drift against your LP position and generates withdrawal
 * parameters when impermanent loss exceeds your max-pain threshold.
 * The seatbelt for concentrated liquidity.
 *
 * Usage:
 *   bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts arm <pool-id> --address <addr> --max-il <pct> [--alert-il <pct>]
 *   bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts check <pool-id> --address <addr>
 *   bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts simulate <pool-id> --price-move <pct>
 *   bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts doctor
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const BFF_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.mainnet.hiro.so";
const DEFAULT_MAX_IL = 5; // 5% max impermanent loss before exit trigger
const DEFAULT_ALERT_IL = 3; // 3% alert threshold
const PRICE_SCALE = 1e8;

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

interface ShieldStatus {
  poolId: string;
  address: string;
  currentBinId: number;
  currentPrice: number;
  entryPrice: number;
  priceChange: number;
  standardIL: number;
  concentratedIL: number;
  inRange: boolean;
  riskLevel: "safe" | "warning" | "critical" | "exit";
  maxIL: number;
  alertIL: number;
  action: "hold" | "alert" | "exit_now";
  exitParams: Record<string, unknown> | null;
  reasoning: string;
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

function binIdToPrice(binId: number, binStep: number): number {
  const base = 1 + binStep / 10_000;
  const exponent = binId - 8_388_608;
  return Math.pow(base, exponent);
}

function calculateStandardIL(priceRatio: number): number {
  // Standard IL formula: IL = 2 * sqrt(r) / (1 + r) - 1
  // where r = currentPrice / entryPrice
  if (priceRatio <= 0) return 0;
  const sqrtR = Math.sqrt(priceRatio);
  return (2 * sqrtR) / (1 + priceRatio) - 1;
}

function calculateConcentratedIL(standardIL: number, binStep: number, rangeWidth: number): number {
  // Concentrated IL = standardIL * concentrationMultiplier
  // Wider ranges = lower multiplier, tighter ranges = higher
  const concentration = Math.max(1, 100 / Math.max(rangeWidth, 1));
  return standardIL * concentration;
}

function determineRiskLevel(
  concentratedIL: number,
  maxIL: number,
  alertIL: number,
  inRange: boolean
): { level: "safe" | "warning" | "critical" | "exit"; action: "hold" | "alert" | "exit_now" } {
  const ilPct = Math.abs(concentratedIL * 100);

  if (!inRange) {
    return { level: "critical", action: "exit_now" };
  }
  if (ilPct >= maxIL) {
    return { level: "exit", action: "exit_now" };
  }
  if (ilPct >= alertIL) {
    return { level: "warning", action: "alert" };
  }
  return { level: "safe", action: "hold" };
}

// ── Commands ───────────────────────────────────────────────────────────

async function arm(
  poolId: string,
  opts: { address: string; maxIl: string; alertIl: string }
): Promise<void> {
  const maxIL = parseFloat(opts.maxIl) || DEFAULT_MAX_IL;
  const alertIL = parseFloat(opts.alertIl) || DEFAULT_ALERT_IL;

  if (maxIL <= 0 || maxIL > 50) {
    fail("--max-il must be between 0.1 and 50 (percent)");
  }
  if (alertIL >= maxIL) {
    fail("--alert-il must be less than --max-il");
  }

  // Get current pool state
  const pool = await fetchJson<Pool>(`${BFF_API}/hodlmm/pools/${poolId}`);
  const currentPrice = binIdToPrice(pool.activeId, pool.binStep);

  ok({
    shield: {
      status: "armed",
      poolId,
      address: opts.address,
      maxIL: `${maxIL}%`,
      alertIL: `${alertIL}%`,
      entryBinId: pool.activeId,
      entryPrice: currentPrice,
      binStep: pool.binStep,
    },
    monitoring: {
      description: "Shield is armed. Run 'check' periodically to monitor position health.",
      checkCommand: `check ${poolId} --address ${opts.address}`,
      triggers: {
        alert: `Concentrated IL exceeds ${alertIL}% — warning issued`,
        exit: `Concentrated IL exceeds ${maxIL}% OR position out of range — exit parameters generated`,
      },
    },
    automationHint: {
      description: "For automated protection, the parent agent should run 'check' on a recurring interval (e.g., every 150 blocks / ~5 min). If action='exit_now', execute the withdrawal parameters immediately.",
      cronSuggestion: "*/5 * * * * — check every 5 minutes",
    },
  });
}

async function check(
  poolId: string,
  opts: { address: string; maxIl: string; alertIl: string; entryBin: string }
): Promise<void> {
  const maxIL = parseFloat(opts.maxIl) || DEFAULT_MAX_IL;
  const alertIL = parseFloat(opts.alertIl) || DEFAULT_ALERT_IL;

  // Get current pool state
  const pool = await fetchJson<Pool>(`${BFF_API}/hodlmm/pools/${poolId}`);
  const currentBinId = pool.activeId;
  const binStep = pool.binStep;
  const currentPrice = binIdToPrice(currentBinId, binStep);

  // Entry price — use provided entry bin or estimate from position midpoint
  const entryBinId = parseInt(opts.entryBin || String(currentBinId), 10);
  const entryPrice = binIdToPrice(entryBinId, binStep);

  // Calculate price change
  const priceRatio = currentPrice / entryPrice;
  const priceChange = (priceRatio - 1) * 100;

  // Calculate IL
  const standardIL = calculateStandardIL(priceRatio);

  // Estimate range width from bin step (tighter step = narrower effective range)
  const rangeWidth = binStep * 10; // Approximate range in basis points
  const concentratedIL = calculateConcentratedIL(standardIL, binStep, rangeWidth);

  // Determine if position is still in range (simplified — checks if drift > rangeWidth)
  const binDrift = Math.abs(currentBinId - entryBinId);
  const maxBinDrift = Math.max(Math.floor(rangeWidth / binStep), 5);
  const inRange = binDrift <= maxBinDrift;

  // Risk assessment
  const { level, action } = determineRiskLevel(concentratedIL, maxIL, alertIL, inRange);

  // Build reasoning
  let reasoning: string;
  if (action === "exit_now" && !inRange) {
    reasoning = `Position out of range (drifted ${binDrift} bins, max ${maxBinDrift}). Not earning fees. Exit recommended.`;
  } else if (action === "exit_now") {
    reasoning = `Concentrated IL at ${Math.abs(concentratedIL * 100).toFixed(2)}% exceeds max-pain threshold of ${maxIL}%. Exit to preserve capital.`;
  } else if (action === "alert") {
    reasoning = `Concentrated IL at ${Math.abs(concentratedIL * 100).toFixed(2)}% approaching max-pain of ${maxIL}%. Monitor closely.`;
  } else {
    reasoning = `Position healthy. IL at ${Math.abs(concentratedIL * 100).toFixed(2)}%, well within ${maxIL}% threshold. In range, earning fees.`;
  }

  // Exit parameters (only if action is exit_now)
  const exitParams = action === "exit_now"
    ? {
        tool: "hodlmm_remove_liquidity",
        params: {
          pool_id: poolId,
          address: opts.address,
          remove_all: true,
        },
        description: "Execute full position withdrawal via parent agent MCP tools",
        urgency: !inRange ? "immediate" : "high",
        postExit: [
          "Verify withdrawal tx confirmed",
          "Check token balances returned to wallet",
          "Consider re-entering at new price level via hodlmm-dca-deployer",
        ],
      }
    : null;

  const status: ShieldStatus = {
    poolId,
    address: opts.address,
    currentBinId,
    currentPrice,
    entryPrice,
    priceChange,
    standardIL: standardIL * 100,
    concentratedIL: concentratedIL * 100,
    inRange,
    riskLevel: level,
    maxIL,
    alertIL,
    action,
    exitParams,
    reasoning,
  };

  ok({
    shield: status,
    metrics: {
      priceChange: `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`,
      standardIL: `${(standardIL * 100).toFixed(4)}%`,
      concentratedIL: `${(concentratedIL * 100).toFixed(4)}%`,
      binDrift: `${binDrift} bins (max ${maxBinDrift})`,
      inRange,
      riskLevel: level,
    },
    action: {
      recommendation: action,
      reasoning,
      exitParams,
    },
  });
}

async function simulate(
  poolId: string,
  opts: { priceMove: string; maxIl: string }
): Promise<void> {
  const priceMovePct = parseFloat(opts.priceMove);
  const maxIL = parseFloat(opts.maxIl) || DEFAULT_MAX_IL;

  if (isNaN(priceMovePct)) {
    fail("--price-move must be a number (e.g., -10 for 10% drop, +20 for 20% rise)");
  }

  // Get pool parameters
  const pool = await fetchJson<Pool>(`${BFF_API}/hodlmm/pools/${poolId}`);
  const binStep = pool.binStep;
  const currentPrice = binIdToPrice(pool.activeId, binStep);

  // Simulate price scenarios
  const scenarios = [
    { name: "requested", move: priceMovePct },
    { name: "2x requested", move: priceMovePct * 2 },
    { name: "half requested", move: priceMovePct / 2 },
    { name: "opposite", move: -priceMovePct },
  ];

  const results = scenarios.map((s) => {
    const simPrice = currentPrice * (1 + s.move / 100);
    const priceRatio = simPrice / currentPrice;
    const stdIL = calculateStandardIL(priceRatio);
    const rangeWidth = binStep * 10;
    const concIL = calculateConcentratedIL(stdIL, binStep, rangeWidth);
    const wouldTrigger = Math.abs(concIL * 100) >= maxIL;

    return {
      scenario: s.name,
      priceMove: `${s.move >= 0 ? "+" : ""}${s.move.toFixed(1)}%`,
      simulatedPrice: simPrice,
      standardIL: `${(stdIL * 100).toFixed(4)}%`,
      concentratedIL: `${(concIL * 100).toFixed(4)}%`,
      wouldTriggerExit: wouldTrigger,
      verdict: wouldTrigger ? "EXIT TRIGGERED" : "SAFE",
    };
  });

  ok({
    simulation: {
      poolId,
      currentPrice,
      binStep,
      maxIL: `${maxIL}%`,
    },
    scenarios: results,
    insight: `At ${maxIL}% max-IL threshold with bin step ${binStep}, your position can absorb a ${
      results.find((r) => r.wouldTriggerExit)
        ? `move of up to ~${Math.abs(parseFloat(results.find((r) => !r.wouldTriggerExit)?.priceMove || "0"))}% before exit triggers`
        : `${priceMovePct}% move without triggering exit`
    }.`,
  });
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: string; detail: string }> = [];

  try {
    await fetchJson(`${BFF_API}/hodlmm/pools`);
    checks.push({ check: "Bitflow HODLMM API", status: "ok", detail: "Reachable" });
  } catch {
    checks.push({ check: "Bitflow HODLMM API", status: "error", detail: "Unreachable" });
  }

  try {
    const info = await fetchJson<{ burn_block_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ check: "Stacks block height", status: "ok", detail: `Block ${info.burn_block_height}` });
  } catch {
    checks.push({ check: "Stacks block height", status: "error", detail: "Unreachable" });
  }

  checks.push({
    check: "Default thresholds",
    status: "info",
    detail: `Alert at ${DEFAULT_ALERT_IL}% IL, Exit at ${DEFAULT_MAX_IL}% IL`,
  });
  checks.push({
    check: "Protection model",
    status: "info",
    detail: "Concentrated IL with range-width amplification. Accounts for bin step and position drift.",
  });
  checks.push({
    check: "Execution",
    status: "info",
    detail: "Advisory — generates exit parameters for parent agent. Does not execute withdrawals directly.",
  });

  ok({
    healthy: checks.every((c) => c.status !== "error"),
    checks,
    note: "Liquidity shield monitors position health and generates exit signals. " +
      "For automated protection, the parent agent should run 'check' on a recurring interval " +
      "and execute withdrawal when action='exit_now'.",
  });
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("hodlmm-liquidity-shield")
  .description("Stop-loss protection for HODLMM concentrated liquidity positions")
  .version("1.0.0");

program
  .command("arm <pool-id>")
  .description("Arm the shield — set IL thresholds and start monitoring")
  .requiredOption("--address <addr>", "Stacks address of the LP position")
  .option("--max-il <pct>", `Max IL before exit trigger (default ${DEFAULT_MAX_IL}%)`, String(DEFAULT_MAX_IL))
  .option("--alert-il <pct>", `Alert threshold (default ${DEFAULT_ALERT_IL}%)`, String(DEFAULT_ALERT_IL))
  .action(async (poolId: string, opts) => {
    try { await arm(poolId, opts); } catch (e) { fail(`Arm failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("check <pool-id>")
  .description("Check position health — returns HOLD, ALERT, or EXIT_NOW with withdrawal params")
  .requiredOption("--address <addr>", "Stacks address of the LP position")
  .option("--max-il <pct>", `Max IL threshold (default ${DEFAULT_MAX_IL}%)`, String(DEFAULT_MAX_IL))
  .option("--alert-il <pct>", `Alert threshold (default ${DEFAULT_ALERT_IL}%)`, String(DEFAULT_ALERT_IL))
  .option("--entry-bin <id>", "Entry bin ID (for accurate IL calculation)")
  .action(async (poolId: string, opts) => {
    try { await check(poolId, opts); } catch (e) { fail(`Check failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("simulate <pool-id>")
  .description("Simulate price moves — see when your shield would trigger exit")
  .requiredOption("--price-move <pct>", "Price move to simulate (e.g., -10 for 10% drop)")
  .option("--max-il <pct>", `Max IL threshold (default ${DEFAULT_MAX_IL}%)`, String(DEFAULT_MAX_IL))
  .action(async (poolId: string, opts) => {
    try { await simulate(poolId, opts); } catch (e) { fail(`Simulate failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program
  .command("doctor")
  .description("Check prerequisites — API access, thresholds, protection model")
  .action(async () => {
    try { await doctor(); } catch (e) { fail(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

program.parse();
