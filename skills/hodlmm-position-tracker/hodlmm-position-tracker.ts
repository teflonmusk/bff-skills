#!/usr/bin/env bun
/**
 * hodlmm-position-tracker — Impermanent loss tracker for Bitflow HODLMM concentrated liquidity
 *
 * Know what your LP position actually costs you.
 *
 * Usage:
 *   bun hodlmm-position-tracker/hodlmm-position-tracker.ts check <pool-id> --address <stx-address>
 *   bun hodlmm-position-tracker/hodlmm-position-tracker.ts compare <pool-id> --address <stx-address>
 *   bun hodlmm-position-tracker/hodlmm-position-tracker.ts pools
 */

import { Command } from "commander";

const HODLMM_API = "https://bff.bitflowapis.finance";
const FETCH_TIMEOUT_MS = 20_000;

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

// ─── Types ───────────────────────────────────────────────────────────────────

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
  suggested?: boolean | null;
  sbtc_incentives?: boolean | null;
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

interface UserPositionBin {
  bin_id: number;
  price?: string | null;
  reserve_x?: string | null;
  reserve_y?: string | null;
  liquidity?: string | null;
  user_liquidity?: string | number | null;
}

interface BinListResponse {
  success: boolean;
  pool_id: string;
  bins: BinData[];
  total_bins: number;
  active_bin_id?: number | null;
}

interface UserPositionResponse {
  success: boolean;
  pool_id: string;
  bins: UserPositionBin[];
  total_bins: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// HODLMM API returns raw bin prices scaled by 10^(yDecimals + 2).
// The extra +2 is an API convention — price = rawPrice / 10^(decimals + 2).
function binPrice(bin: { price?: string | null }, yDecimals: number): number {
  if (!bin.price) return 0;
  return parseFloat(bin.price) / Math.pow(10, yDecimals + 2);
}

function calculateIL(
  currentPrice: number,
  entryPrice: number
): { ilPercent: number; priceRatio: number } {
  if (entryPrice <= 0 || currentPrice <= 0) return { ilPercent: 0, priceRatio: 1 };
  const r = currentPrice / entryPrice;
  // Standard IL formula for 50/50: IL = 2*sqrt(r)/(1+r) - 1
  const il = 2 * Math.sqrt(r) / (1 + r) - 1;
  return { ilPercent: Math.abs(il) * 100, priceRatio: r };
}

function calculateConcentratedIL(
  currentPrice: number,
  entryPrice: number,
  lowerBound: number,
  upperBound: number
): { ilPercent: number; multiplier: number; inRange: boolean } {
  if (entryPrice <= 0 || currentPrice <= 0 || lowerBound <= 0 || upperBound <= lowerBound) {
    return { ilPercent: 0, multiplier: 1, inRange: true };
  }

  const inRange = currentPrice >= lowerBound && currentPrice <= upperBound;

  // Standard concentrated liquidity IL amplification (Uniswap v3 derivation):
  // multiplier = sqrt(P_upper / P_lower) / (sqrt(P_upper / P_lower) - 1)
  const sqrtRange = Math.sqrt(upperBound / lowerBound);
  const multiplier = sqrtRange > 1 ? sqrtRange / (sqrtRange - 1) : 1;

  const baseIL = calculateIL(currentPrice, entryPrice);
  const concentratedIL = Math.min(baseIL.ilPercent * multiplier, 100);

  return { ilPercent: concentratedIL, multiplier, inRange };
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-position-tracker")
  .description("Impermanent loss tracker for Bitflow HODLMM concentrated liquidity positions.")
  .version("1.0.0");

// ─── pools ───────────────────────────────────────────────────────────────────

program
  .command("pools")
  .description("List active HODLMM pools with current bin and fee data.")
  .option("--sbtc-only", "Only show sBTC incentive pools")
  .action(async (opts: { sbtcOnly?: boolean }) => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (opts.sbtcOnly) params.set("sbtc_incentives", "true");

      const pools = await fetchJson<PoolInfo[]>(
        `${HODLMM_API}/api/quotes/v1/pools?${params}`
      );

      const active = pools.filter((p) => p.active);
      const summary = active.map((p) => ({
        pool_id: p.pool_id,
        pair: `${p.token_x_symbol ?? "?"}-${p.token_y_symbol ?? "?"}`,
        active_bin: p.active_bin,
        bin_step: p.bin_step,
        provider_fee_x: p.x_provider_fee,
        provider_fee_y: p.y_provider_fee,
        sbtc_incentives: p.sbtc_incentives ?? false,
      }));

      out({
        skill: "hodlmm-position-tracker",
        command: "pools",
        active_pools: active.length,
        pools: summary,
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── check ───────────────────────────────────────────────────────────────────

program
  .command("check <pool-id>")
  .description("Check impermanent loss for a position — current IL estimate, range status, drift.")
  .requiredOption("--address <stx-address>", "Stacks address of the LP provider")
  .action(async (poolId: string, opts: { address: string }) => {
    try {
      // Fetch pool info, pool bins, and user position in parallel
      const [poolInfo, poolBins, userPosition] = await Promise.all([
        fetchJson<PoolInfo>(`${HODLMM_API}/api/app/v1/pools/${poolId}`),
        fetchJson<BinListResponse>(`${HODLMM_API}/api/quotes/v1/bins/${poolId}`),
        fetchJson<UserPositionResponse>(
          `${HODLMM_API}/api/app/v1/users/${opts.address}/positions/${poolId}/bins?fresh=true`
        ),
      ]);

      if (!userPosition.bins || userPosition.bins.length === 0) {
        out({
          skill: "hodlmm-position-tracker",
          command: "check",
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

      // Current price from active bin
      const activeBin = poolBins.bins.find((b) => b.bin_id === activeBinId);
      const currentPrice = activeBin ? binPrice(activeBin, yDecimals) : 0;

      // User's position range
      const userBinIds = userPosition.bins.map((b) => b.bin_id).sort((a, b) => a - b);
      const minBinId = userBinIds[0];
      const maxBinId = userBinIds[userBinIds.length - 1];

      // Position entry price estimate (midpoint of position range)
      const midBinId = Math.round((minBinId + maxBinId) / 2);
      const midBin = poolBins.bins.find((b) => b.bin_id === midBinId) ??
        poolBins.bins.find((b) => b.bin_id === minBinId);
      const entryPriceEstimate = midBin ? binPrice(midBin, yDecimals) : currentPrice;

      // Range bounds
      const lowerBin = poolBins.bins.find((b) => b.bin_id === minBinId);
      const upperBin = poolBins.bins.find((b) => b.bin_id === maxBinId);
      const lowerPrice = lowerBin ? binPrice(lowerBin, yDecimals) : 0;
      const upperPrice = upperBin ? binPrice(upperBin, yDecimals) : 0;

      // Calculate IL
      const baseIL = calculateIL(currentPrice, entryPriceEstimate);
      const concentratedIL = calculateConcentratedIL(
        currentPrice, entryPriceEstimate, lowerPrice, upperPrice
      );

      // Position reserves
      let totalX = 0;
      let totalY = 0;
      for (const bin of userPosition.bins) {
        totalX += parseInt(bin.reserve_x ?? "0", 10);
        totalY += parseInt(bin.reserve_y ?? "0", 10);
      }

      // Drift: how far is active bin from position center
      const drift = activeBinId - midBinId;
      const driftDirection = drift > 0 ? "above" : drift < 0 ? "below" : "centered";

      // Reserve imbalance
      const xNormalized = totalX / Math.pow(10, xDecimals);
      const yNormalized = totalY / Math.pow(10, yDecimals);
      const totalValue = xNormalized * currentPrice + yNormalized;
      const xShare = totalValue > 0 ? (xNormalized * currentPrice / totalValue) * 100 : 50;

      out({
        skill: "hodlmm-position-tracker",
        command: "check",
        pool_id: poolId,
        pair: `${poolInfo.token_x_symbol ?? "X"}-${poolInfo.token_y_symbol ?? "Y"}`,
        address: opts.address,
        has_position: true,
        current_price: currentPrice,
        entry_price_estimate: entryPriceEstimate,
        price_change_pct: baseIL.priceRatio !== 1
          ? `${((baseIL.priceRatio - 1) * 100).toFixed(2)}%`
          : "0%",
        position: {
          bins: userBinIds.length,
          range: `bin ${minBinId} → ${maxBinId}`,
          lower_price: lowerPrice,
          upper_price: upperPrice,
          in_range: concentratedIL.inRange,
          drift_bins: Math.abs(drift),
          drift_direction: driftDirection,
        },
        reserves: {
          token_x: totalX,
          token_y: totalY,
          x_share_pct: `${Math.round(xShare)}%`,
          y_share_pct: `${Math.round(100 - xShare)}%`,
        },
        impermanent_loss: {
          standard_il_pct: `${baseIL.ilPercent.toFixed(3)}%`,
          concentrated_il_pct: `${concentratedIL.ilPercent.toFixed(3)}%`,
          concentration_multiplier: `${concentratedIL.multiplier.toFixed(1)}x`,
          note: concentratedIL.inRange
            ? "Position in range. IL is amplified by concentration."
            : "Position OUT OF RANGE. Not earning fees. Consider rebalancing.",
        },
        risk_level: concentratedIL.ilPercent > 5
          ? "high"
          : concentratedIL.ilPercent > 2
            ? "medium"
            : "low",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── compare ─────────────────────────────────────────────────────────────────

program
  .command("compare <pool-id>")
  .description("Compare LP position value vs simply holding — the real cost of providing liquidity.")
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
          skill: "hodlmm-position-tracker",
          command: "compare",
          pool_id: poolId,
          address: opts.address,
          has_position: false,
          note: "No active position found.",
        });
        return;
      }

      const yDecimals = poolInfo.token_y_decimals ?? 6;
      const xDecimals = poolInfo.token_x_decimals ?? 8;
      const activeBinId = poolBins.active_bin_id ?? poolInfo.active_bin;
      const activeBin = poolBins.bins.find((b) => b.bin_id === activeBinId);
      const currentPrice = activeBin ? binPrice(activeBin, yDecimals) : 0;

      // Current position value
      let totalX = 0;
      let totalY = 0;
      for (const bin of userPosition.bins) {
        totalX += parseInt(bin.reserve_x ?? "0", 10);
        totalY += parseInt(bin.reserve_y ?? "0", 10);
      }

      const xHuman = totalX / Math.pow(10, xDecimals);
      const yHuman = totalY / Math.pow(10, yDecimals);
      const lpValueInY = xHuman * currentPrice + yHuman;

      // Estimate entry price from position midpoint bin
      const userBinIds = userPosition.bins.map((b) => b.bin_id).sort((a, b) => a - b);
      const midBinId = Math.round((userBinIds[0] + userBinIds[userBinIds.length - 1]) / 2);
      const midBin = poolBins.bins.find((b) => b.bin_id === midBinId);
      const entryPrice = midBin ? binPrice(midBin, yDecimals) : currentPrice;

      // Reconstruct initial deposit using entry price (breaks circularity).
      // At entry, a 50/50 LP deposit at entryPrice means:
      //   initialX = totalValue / (2 * entryPrice)
      //   initialY = totalValue / 2
      // We derive totalValue at entry from current reserves valued at entry price:
      const initialValueInY = xHuman * entryPrice + yHuman;
      const initialX = (initialValueInY / 2) / entryPrice;
      const initialY = initialValueInY / 2;

      // HODL value: what those initial assets would be worth at current price
      const hodlValueInY = initialX * currentPrice + initialY;

      // IL = difference between HODL and LP
      const ilAbsolute = hodlValueInY - lpValueInY;
      const ilPercent = hodlValueInY > 0 ? (ilAbsolute / hodlValueInY) * 100 : 0;

      // Fee estimation from pool fee rates
      const feeRateX = (poolInfo.x_provider_fee + poolInfo.x_variable_fee) / 1e4;
      const feeRateY = (poolInfo.y_provider_fee + poolInfo.y_variable_fee) / 1e4;
      const avgFeeRate = (feeRateX + feeRateY) / 2;

      const tokenYSymbol = poolInfo.token_y_symbol ?? "Y";
      const tokenXSymbol = poolInfo.token_x_symbol ?? "X";

      out({
        skill: "hodlmm-position-tracker",
        command: "compare",
        pool_id: poolId,
        pair: `${tokenXSymbol}-${tokenYSymbol}`,
        address: opts.address,
        current_price: currentPrice,
        entry_price_estimate: entryPrice,
        lp_position: {
          token_x: `${xHuman.toFixed(8)} ${tokenXSymbol}`,
          token_y: `${yHuman.toFixed(6)} ${tokenYSymbol}`,
          total_value: `${lpValueInY.toFixed(6)} ${tokenYSymbol}`,
        },
        hodl_equivalent: {
          token_x: `${initialX.toFixed(8)} ${tokenXSymbol}`,
          token_y: `${initialY.toFixed(6)} ${tokenYSymbol}`,
          total_value: `${hodlValueInY.toFixed(6)} ${tokenYSymbol}`,
        },
        impermanent_loss: {
          absolute: `${ilAbsolute.toFixed(6)} ${tokenYSymbol}`,
          percent: `${ilPercent.toFixed(3)}%`,
          direction: ilAbsolute > 0 ? "LP underperforming HODL" : "LP outperforming HODL",
        },
        fee_context: {
          pool_fee_rate: `${(avgFeeRate * 100).toFixed(3)}%`,
          note: `Fees earned offset IL. If cumulative fees > ${ilAbsolute.toFixed(6)} ${tokenYSymbol}, your LP is net positive vs HODL.`,
          breakeven_hint: ilAbsolute > 0 && avgFeeRate > 0
            ? `Need ~${Math.ceil(ilPercent / (avgFeeRate * 100))} full-volume cycles to break even on IL from fees alone.`
            : "Position is currently net positive vs HODL.",
        },
        verdict: ilPercent > 5
          ? "HIGH IL — consider rebalancing or exiting"
          : ilPercent > 2
            ? "MODERATE IL — monitor closely, fees may not cover"
            : ilPercent > 0
              ? "LOW IL — fees likely covering the loss"
              : "NO IL — LP is outperforming HODL",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

program.parse(process.argv);
