#!/usr/bin/env bun
/**
 * hodlmm-rebalance-calc — Should you rebalance your HODLMM position or hold?
 *
 * IL + gas + fees = one answer.
 *
 * Usage:
 *   bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts evaluate <pool-id> --address <stx-address>
 *   bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts gas
 *   bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts pools
 */

import { Command } from "commander";

const HODLMM_API = "https://bff.bitflowapis.finance";
const RELAY_HEALTH = "https://mainnet.stx-sponsor.com/health";
const FETCH_TIMEOUT_MS = 20_000;
const PRICE_SCALE = 1e8;

// Estimated gas cost for a rebalance (withdraw + add liquidity = 2 sponsored txs)
const REBALANCE_TX_COUNT = 2;
const ESTIMATED_GAS_PER_TX_SATS = 500;

type Verdict = "REBALANCE_NOW" | "HOLD" | "EXIT";

async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.BITFLOW_HODLMM_API_KEY ?? process.env.BITFLOW_API_KEY;
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: unknown): never {
  console.log(JSON.stringify({ error: String(message) }, null, 2));
  process.exit(1);
}

interface PoolInfo {
  pool_id: string;
  token_x: string;
  token_y: string;
  token_x_symbol?: string | null;
  token_y_symbol?: string | null;
  token_x_decimals?: number | null;
  token_y_decimals?: number | null;
  bin_step: number;
  active_bin: number;
  active: boolean;
  x_provider_fee: number;
  y_provider_fee: number;
  x_variable_fee: number;
  y_variable_fee: number;
}

interface BinData {
  bin_id: number;
  price?: string | null;
  reserve_x: string;
  reserve_y: string;
  liquidity?: string | null;
}

interface BinListResponse {
  success: boolean;
  pool_id: string;
  bins: BinData[];
  total_bins: number;
  active_bin_id?: number | null;
}

interface UserPositionBin {
  bin_id: number;
  price?: string | null;
  reserve_x?: string | null;
  reserve_y?: string | null;
  liquidity?: string | null;
  user_liquidity?: string | number | null;
}

interface UserPositionResponse {
  success: boolean;
  pool_id: string;
  bins: UserPositionBin[];
  total_bins: number;
}

interface RelayHealth {
  healthy: boolean;
  version: string;
  nonceStatus: { lastExecuted: number };
}

function binPrice(bin: { price?: string | null }, yDecimals: number): number {
  if (!bin.price) return 0;
  return parseFloat(bin.price) / Math.pow(10, yDecimals + 2);
}

function calculateIL(currentPrice: number, entryPrice: number): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const r = currentPrice / entryPrice;
  return Math.abs(2 * Math.sqrt(r) / (1 + r) - 1) * 100;
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-rebalance-calc")
  .description("Should you rebalance your HODLMM position? IL + gas + fees = one answer.")
  .version("1.0.0");

// ─── evaluate ────────────────────────────────────────────────────────────────

program
  .command("evaluate <pool-id>")
  .description("Full rebalance analysis — IL cost vs gas cost vs fee earnings. Returns REBALANCE_NOW, HOLD, or EXIT.")
  .requiredOption("--address <stx-address>", "Stacks address of the LP provider")
  .action(async (poolId: string, opts: { address: string }) => {
    try {
      const [poolInfo, poolBins, userPosition] = await Promise.all([
        fetchJson<PoolInfo>(`${HODLMM_API}/api/app/v1/pools/${poolId}`),
        fetchJson<BinListResponse>(`${HODLMM_API}/api/quotes/v1/bins/${poolId}`),
        fetchJson<UserPositionResponse>(
          `${HODLMM_API}/api/app/v1/users/${opts.address}/positions/${poolId}/bins?fresh=true`
        ),
      ]);

      if (!userPosition.bins || userPosition.bins.length === 0) {
        out({
          skill: "hodlmm-rebalance-calc",
          command: "evaluate",
          pool_id: poolId,
          address: opts.address,
          has_position: false,
          note: "No active position found in this pool.",
        });
        return;
      }

      const yDecimals = poolInfo.token_y_decimals ?? 6;
      const xDecimals = poolInfo.token_x_decimals ?? 8;
      const activeBinId = poolBins.active_bin_id ?? poolInfo.active_bin;

      // Current price
      const activeBin = poolBins.bins.find((b) => b.bin_id === activeBinId);
      const currentPrice = activeBin ? binPrice(activeBin, yDecimals) : 0;

      // Position range
      const userBinIds = userPosition.bins.map((b) => b.bin_id).sort((a, b) => a - b);
      const minBinId = userBinIds[0];
      const maxBinId = userBinIds[userBinIds.length - 1];
      const midBinId = Math.round((minBinId + maxBinId) / 2);

      // Entry price estimate
      const midBin = poolBins.bins.find((b) => b.bin_id === midBinId) ??
        poolBins.bins.find((b) => b.bin_id === minBinId);
      const entryPrice = midBin ? binPrice(midBin, yDecimals) : currentPrice;

      // In range?
      const inRange = activeBinId >= minBinId && activeBinId <= maxBinId;

      // Drift
      const drift = Math.abs(activeBinId - midBinId);

      // IL calculation
      const ilPct = calculateIL(currentPrice, entryPrice);

      // Concentration multiplier
      const rangeWidth = maxBinId - minBinId + 1;
      const concentrationMultiplier = Math.max(1, Math.sqrt(rangeWidth > 1 ? 100 / rangeWidth : 100));
      const concentratedIlPct = Math.min(ilPct * concentrationMultiplier, 100);

      // Position value
      let totalX = 0;
      let totalY = 0;
      for (const bin of userPosition.bins) {
        totalX += parseInt(bin.reserve_x ?? "0", 10);
        totalY += parseInt(bin.reserve_y ?? "0", 10);
      }
      const xHuman = totalX / Math.pow(10, xDecimals);
      const yHuman = totalY / Math.pow(10, yDecimals);
      const positionValueY = xHuman * currentPrice + yHuman;

      // IL cost in quote token
      const ilCostY = positionValueY * (concentratedIlPct / 100);

      // Gas cost for rebalance (2 txs: withdraw + add)
      const gasCostSats = REBALANCE_TX_COUNT * ESTIMATED_GAS_PER_TX_SATS;

      // Fee rate
      const feeRateX = (poolInfo.x_provider_fee + poolInfo.x_variable_fee) / 1e4;
      const feeRateY = (poolInfo.y_provider_fee + poolInfo.y_variable_fee) / 1e4;
      const avgFeeRate = (feeRateX + feeRateY) / 2;

      // Fee earnings estimate per cycle (rough: position value * fee rate)
      const feePerCycleY = positionValueY * avgFeeRate;

      // Breakeven: cycles to recover rebalance cost from new position fees
      // Rebalance cost = gas + new IL exposure (reset to 0 after rebalance)
      // Benefit = stop accumulating current IL
      const rebalanceCostY = gasCostSats / Math.pow(10, yDecimals); // approximate
      const cyclesToBreakeven = feePerCycleY > 0
        ? Math.ceil((rebalanceCostY + ilCostY * 0.1) / feePerCycleY) // 10% of current IL as friction
        : Infinity;

      // Verdict logic
      let verdict: Verdict;
      let rationale: string;

      if (!inRange) {
        if (concentratedIlPct > 8) {
          verdict = "EXIT";
          rationale = `Position is OUT OF RANGE with ${concentratedIlPct.toFixed(1)}% concentrated IL. Not earning fees. IL is growing. Exit and redeploy at current price.`;
        } else {
          verdict = "REBALANCE_NOW";
          rationale = `Position is OUT OF RANGE — not earning fees. IL is ${concentratedIlPct.toFixed(1)}%. Rebalance to re-center on active bin ${activeBinId}. Gas cost: ~${gasCostSats} sats.`;
        }
      } else if (concentratedIlPct > 5) {
        if (cyclesToBreakeven <= 3) {
          verdict = "REBALANCE_NOW";
          rationale = `IL at ${concentratedIlPct.toFixed(1)}% but fees recover rebalance cost in ~${cyclesToBreakeven} cycles. Rebalance resets IL to 0.`;
        } else {
          verdict = "HOLD";
          rationale = `IL at ${concentratedIlPct.toFixed(1)}% but rebalance breakeven takes ${cyclesToBreakeven}+ cycles. Hold and let fees accumulate unless IL accelerates.`;
        }
      } else if (concentratedIlPct > 2) {
        verdict = "HOLD";
        rationale = `Moderate IL at ${concentratedIlPct.toFixed(1)}%. Position in range and earning fees. Fee rate (${(avgFeeRate * 100).toFixed(3)}%) likely covers IL. Monitor.`;
      } else {
        verdict = "HOLD";
        rationale = `Low IL at ${concentratedIlPct.toFixed(1)}%. Position in range, centered, earning fees. No action needed.`;
      }

      out({
        skill: "hodlmm-rebalance-calc",
        command: "evaluate",
        pool_id: poolId,
        pair: `${poolInfo.token_x_symbol ?? "X"}-${poolInfo.token_y_symbol ?? "Y"}`,
        address: opts.address,
        verdict,
        rationale,
        position: {
          bins: userBinIds.length,
          range: `bin ${minBinId} → ${maxBinId}`,
          in_range: inRange,
          drift_bins: drift,
          active_bin: activeBinId,
        },
        impermanent_loss: {
          standard_pct: `${ilPct.toFixed(3)}%`,
          concentrated_pct: `${concentratedIlPct.toFixed(3)}%`,
          multiplier: `${concentrationMultiplier.toFixed(1)}x`,
          cost_in_quote: `${ilCostY.toFixed(6)} ${poolInfo.token_y_symbol ?? "Y"}`,
        },
        rebalance_cost: {
          gas_sats: gasCostSats,
          transactions: REBALANCE_TX_COUNT,
          note: "Withdraw current position + add liquidity at new range = 2 sponsored txs",
        },
        fee_analysis: {
          pool_fee_rate: `${(avgFeeRate * 100).toFixed(3)}%`,
          est_fee_per_cycle: `${feePerCycleY.toFixed(6)} ${poolInfo.token_y_symbol ?? "Y"}`,
          cycles_to_breakeven: cyclesToBreakeven === Infinity ? "n/a" : cyclesToBreakeven,
        },
        action: verdict === "REBALANCE_NOW" ? {
          step_1: "Withdraw current position via withdraw-liquidity-simple",
          step_2: `Add liquidity centered on bin ${activeBinId} via add-liquidity-simple`,
          estimated_gas: `${gasCostSats} sats (${REBALANCE_TX_COUNT} txs)`,
        } : verdict === "EXIT" ? {
          step_1: "Withdraw all liquidity via withdraw-liquidity-simple",
          step_2: "Do not re-enter at current IL level — wait for price to stabilize",
        } : {
          note: "No action needed. Continue earning fees.",
        },
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── gas ─────────────────────────────────────────────────────────────────────

program
  .command("gas")
  .description("Current rebalance gas cost estimate — relay health + fee data.")
  .action(async () => {
    try {
      let relayHealthy = false;
      let relayVersion = "unknown";
      let relayNonce = 0;

      try {
        const health = await fetchJson<RelayHealth>(RELAY_HEALTH);
        relayHealthy = health.healthy;
        relayVersion = health.version;
        relayNonce = health.nonceStatus?.lastExecuted ?? 0;
      } catch {
        // Relay unreachable
      }

      out({
        skill: "hodlmm-rebalance-calc",
        command: "gas",
        relay: {
          healthy: relayHealthy,
          version: relayVersion,
          nonce: relayNonce,
        },
        rebalance_cost: {
          transactions: REBALANCE_TX_COUNT,
          estimated_gas_per_tx: ESTIMATED_GAS_PER_TX_SATS,
          total_estimated_gas: REBALANCE_TX_COUNT * ESTIMATED_GAS_PER_TX_SATS,
          unit: "sats",
          note: "Sponsored transactions — gas is paid by the relay, not the agent. Cost estimate is for economic comparison only.",
        },
        tip: relayHealthy
          ? "Relay is healthy — rebalance transactions will process normally."
          : "Relay may be degraded — rebalance could be delayed. Check relay health before executing.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── pools ───────────────────────────────────────────────────────────────────

program
  .command("pools")
  .description("List HODLMM pools with fee rates for rebalance cost estimation.")
  .action(async () => {
    try {
      const pools = await fetchJson<PoolInfo[]>(
        `${HODLMM_API}/api/quotes/v1/pools?limit=50`
      );

      const active = pools.filter((p) => p.active).map((p) => {
        const feeX = (p.x_provider_fee + p.x_variable_fee) / 1e4;
        const feeY = (p.y_provider_fee + p.y_variable_fee) / 1e4;
        return {
          pool_id: p.pool_id,
          pair: `${p.token_x_symbol ?? "?"}-${p.token_y_symbol ?? "?"}`,
          bin_step: p.bin_step,
          active_bin: p.active_bin,
          fee_rate_x: `${(feeX * 100).toFixed(3)}%`,
          fee_rate_y: `${(feeY * 100).toFixed(3)}%`,
          avg_fee_rate: `${(((feeX + feeY) / 2) * 100).toFixed(3)}%`,
        };
      });

      out({
        skill: "hodlmm-rebalance-calc",
        command: "pools",
        active_pools: active.length,
        pools: active,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

program.parse(process.argv);
