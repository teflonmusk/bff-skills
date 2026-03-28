#!/usr/bin/env bun
/**
 * sbtc-demand-signal — sBTC demand oracle for HODLMM bin positioning
 *
 * Reads Bitflow HODLMM pool bin reserves to detect which direction
 * sBTC/STX price has been trading. In a DLMM pool, bins above the active
 * price hold sBTC (waiting to be sold), bins below hold STX (deployed to buy
 * sBTC). Reserve imbalance reveals the net flow direction since last rebalance.
 *
 * Outputs NEUTRAL / BUY_PRESSURE / SELL_PRESSURE with a shift recommendation
 * so LPs can reposition bins ahead of continued directional movement.
 *
 * Usage: bun sbtc-demand-signal.ts doctor
 *        bun sbtc-demand-signal.ts run --pool <id> [--threshold <n>]
 */

import { Command } from "commander";

const BITFLOW_V1 = "https://api.bitflow.finance/api/v1";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BinData {
  bin_id: number;
  reserve_x: string; // sBTC (token_x)
  reserve_y: string; // STX  (token_y)
}

interface BinsResponse {
  active_bin_id?: number;
  bins: BinData[];
}

interface PoolInfo {
  active_bin: number;
  token_x: string;
  token_y: string;
  token_x_symbol?: string;
  token_y_symbol?: string;
}

type DemandSignal = "NEUTRAL" | "BUY_PRESSURE" | "SELL_PRESSURE";

interface ReserveMetrics {
  active_bin_id: number;
  total_bins: number;
  sbtc_above_active: number; // sBTC sitting above active price (supply overhang)
  stx_below_active: number;  // STX sitting below active price (buy-side depth)
  sbtc_in_active: number;
  stx_in_active: number;
  imbalance_score: number;   // 0–10: 0=all-STX-side, 5=balanced, 10=all-sBTC-side
  signal: DemandSignal;
  rationale: string;
  shift_recommendation: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

async function getPoolInfo(poolId: string): Promise<PoolInfo> {
  return fetchJson<PoolInfo>(`${BITFLOW_V1}/hodlmm/pools/${poolId}`);
}

async function getPoolBins(poolId: string): Promise<BinsResponse> {
  return fetchJson<BinsResponse>(`${BITFLOW_V1}/hodlmm/pools/${poolId}/bins`);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeMetrics(
  bins: BinData[],
  activeBinId: number,
  threshold: number
): ReserveMetrics {
  let sbtcAbove = 0;
  let stxBelow = 0;
  let sbtcActive = 0;
  let stxActive = 0;

  for (const bin of bins) {
    const rx = parseFloat(bin.reserve_x) || 0;
    const ry = parseFloat(bin.reserve_y) || 0;

    if (bin.bin_id > activeBinId) {
      // Above active: sBTC supply waiting to be sold
      sbtcAbove += rx;
    } else if (bin.bin_id < activeBinId) {
      // Below active: STX depth waiting to buy sBTC
      stxBelow += ry;
    } else {
      // Active bin: mixed
      sbtcActive += rx;
      stxActive += ry;
    }
  }

  // Imbalance score: ratio of sBTC-side weight vs total
  // Using token unit counts as proxy (both normalised to their own scale)
  const totalSbtcSide = sbtcAbove + sbtcActive;
  const totalStxSide = stxBelow + stxActive;

  // Normalise to comparable scale using a simple ratio
  // If both sides are 0, score is neutral 5
  let imbalanceScore = 5;
  if (totalSbtcSide + totalStxSide > 0) {
    // We can't convert directly without price, so use bin count weighting:
    // count bins that are sBTC-dominated vs STX-dominated
    const sbtcBins = bins.filter(
      (b) => b.bin_id >= activeBinId && parseFloat(b.reserve_x) > 0
    ).length;
    const stxBins = bins.filter(
      (b) => b.bin_id <= activeBinId && parseFloat(b.reserve_y) > 0
    ).length;
    const total = sbtcBins + stxBins || 1;
    imbalanceScore = Math.round((sbtcBins / total) * 10);
  }

  const signal = deriveSignal(imbalanceScore, threshold);
  const rationale = buildRationale(signal, imbalanceScore, sbtcAbove, stxBelow, activeBinId);
  const shift = buildShiftRec(signal);

  return {
    active_bin_id: activeBinId,
    total_bins: bins.length,
    sbtc_above_active: Math.round(sbtcAbove * 1e6) / 1e6,
    stx_below_active: Math.round(stxBelow),
    sbtc_in_active: Math.round(sbtcActive * 1e6) / 1e6,
    stx_in_active: Math.round(stxActive),
    imbalance_score: imbalanceScore,
    signal,
    rationale,
    shift_recommendation: shift,
  };
}

function deriveSignal(score: number, threshold: number): DemandSignal {
  // score 0–4: STX-heavy → price trended up → BUY_PRESSURE continues
  // score 6–10: sBTC-heavy → price trended down → SELL_PRESSURE continues
  const midLow = 5 - threshold;
  const midHigh = 5 + threshold;
  if (score <= midLow) return "BUY_PRESSURE";
  if (score >= midHigh) return "SELL_PRESSURE";
  return "NEUTRAL";
}

function buildRationale(
  signal: DemandSignal,
  score: number,
  sbtcAbove: number,
  stxBelow: number,
  activeBin: number
): string {
  switch (signal) {
    case "BUY_PRESSURE":
      return `Pool is STX-heavy (imbalance score ${score}/10). More bins below active bin ${activeBin} hold STX depth than sBTC supply sits above — price has been trending up as buyers consume sBTC. Upward momentum may continue.`;
    case "SELL_PRESSURE":
      return `Pool is sBTC-heavy (imbalance score ${score}/10). More sBTC supply is stacked above active bin ${activeBin} than STX depth sits below — price has been trending down as sellers offload sBTC. Downward momentum may continue.`;
    case "NEUTRAL":
      return `Pool reserves are balanced (imbalance score ${score}/10). sBTC supply above and STX depth below active bin ${activeBin} are roughly symmetric — no dominant directional momentum detected.`;
  }
}

function buildShiftRec(signal: DemandSignal): string {
  switch (signal) {
    case "BUY_PRESSURE":
      return "Consider shifting bin range upward — concentrate liquidity above current price to capture fees as upward momentum continues.";
    case "SELL_PRESSURE":
      return "Consider shifting bin range downward — concentrate liquidity below current price to capture fees as selling pressure continues.";
    case "NEUTRAL":
      return "Hold current bin range — symmetric reserve depth suggests price is near equilibrium.";
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  const bitflowOk = await fetch(`${BITFLOW_V1}/hodlmm/pools/dlmm_3`)
    .then((r) => r.ok)
    .catch(() => false);

  const result = {
    result: bitflowOk ? "ready" : "error",
    checks: {
      bitflow_hodlmm_api: bitflowOk ? "ok" : "unreachable",
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!bitflowOk) process.exit(1);
}

async function runAnalysis(poolId: string, threshold: number): Promise<void> {
  const timestamp = new Date().toISOString();

  const [poolInfo, binsData] = await Promise.all([
    getPoolInfo(poolId),
    getPoolBins(poolId),
  ]);

  const activeBinId =
    binsData.active_bin_id ?? poolInfo.active_bin;

  const metrics = computeMetrics(binsData.bins, activeBinId, threshold);

  const output = {
    skill: "sbtc-demand-signal",
    timestamp,
    input: { pool: poolId, threshold },
    pool: {
      id: poolId,
      token_x: poolInfo.token_x_symbol ?? poolInfo.token_x ?? "sBTC",
      token_y: poolInfo.token_y_symbol ?? poolInfo.token_y ?? "STX",
      active_bin: activeBinId,
      total_bins: metrics.total_bins,
    },
    reserves: {
      sbtc_above_active: metrics.sbtc_above_active,
      stx_below_active: metrics.stx_below_active,
      sbtc_in_active_bin: metrics.sbtc_in_active,
      stx_in_active_bin: metrics.stx_in_active,
    },
    imbalance_score: metrics.imbalance_score,
    signal: metrics.signal,
    rationale: metrics.rationale,
    shift_recommendation: metrics.shift_recommendation,
    summary: `${metrics.signal} — imbalance score ${metrics.imbalance_score}/10 on pool ${poolId} (active bin ${activeBinId}, ${metrics.total_bins} total bins).`,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("sbtc-demand-signal")
    .description("sBTC demand oracle — reads HODLMM bin reserves to detect price momentum direction")
    .version("1.0.0");

  program
    .command("doctor")
    .description("Check Bitflow HODLMM API connectivity")
    .action(async () => {
      try {
        await runDoctor();
      } catch (err: any) {
        console.log(JSON.stringify({ error: err.message }));
        process.exit(1);
      }
    });

  program
    .command("run")
    .description("Analyse reserve imbalance and output demand signal")
    .option("--pool <id>", "HODLMM pool ID (e.g. dlmm_3)", "dlmm_3")
    .option(
      "--threshold <n>",
      "Imbalance score distance from 5 to trigger directional signal (1–4)",
      "2"
    )
    .action(async (opts) => {
      const poolId = opts.pool as string;
      const threshold = Math.max(1, Math.min(4, parseInt(opts.threshold, 10)));
      try {
        await runAnalysis(poolId, threshold);
      } catch (err: any) {
        console.log(
          JSON.stringify({
            skill: "sbtc-demand-signal",
            error: err.message,
            timestamp: new Date().toISOString(),
          })
        );
        process.exit(1);
      }
    });

  program.parse();
}

main();
