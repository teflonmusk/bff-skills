#!/usr/bin/env bun
/**
 * hodlmm-advisor — Composite HODLMM position action signal
 *
 * Synthesises three independent data sources into a single actionable
 * recommendation for HODLMM concentrated liquidity LPs:
 *
 *   1. Bitcoin L1 pressure  — inscription volume + mempool fee rates
 *      (source: Hiro API)
 *   2. Reserve demand signal — sBTC/STX bin imbalance direction
 *      (source: Bitflow HODLMM bins endpoint)
 *   3. Volatility regime    — bin spread as volatility proxy
 *      (source: Bitflow HODLMM bins endpoint, same call as #2)
 *
 * Output: SHIFT_UP_AGGRESSIVE / SHIFT_UP / HOLD /
 *         SHIFT_DOWN / SHIFT_DOWN_AGGRESSIVE / TIGHTEN / WIDEN
 *
 * Usage: bun hodlmm-advisor.ts doctor
 *        bun hodlmm-advisor.ts run --pool <id> [--threshold <n>]
 */

import { Command } from "commander";

const HIRO_API = "https://api.hiro.so";
const BITFLOW_V1 = "https://api.bitflow.finance/api/v1";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BinData {
  bin_id: number;
  reserve_x: string; // sBTC
  reserve_y: string; // STX
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

type DemandSignal = "BUY_PRESSURE" | "NEUTRAL" | "SELL_PRESSURE";
type VolatilityRegime = "calm" | "elevated" | "crisis";

type ActionRecommendation =
  | "SHIFT_UP_AGGRESSIVE"
  | "SHIFT_UP"
  | "HOLD"
  | "SHIFT_DOWN"
  | "SHIFT_DOWN_AGGRESSIVE"
  | "TIGHTEN"
  | "WIDEN";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Signal 1: Bitcoin L1 pressure (same logic as hodlmm-inscription-signal)
// ---------------------------------------------------------------------------

interface L1Pressure {
  inscriptions_recent: number; // count in last windowHours; 0 if ordinals API unavailable
  fee_rate_sat_vb: number;
  pressure_score: number; // 0–10
}

async function getL1Pressure(windowHours: number): Promise<L1Pressure> {
  // Note: Hiro v1 Ordinals API was deprecated 2026-03-09. We try the v2 endpoint;
  // if unavailable, inscriptions_recent defaults to 0 (score contribution zeroed).
  // Fee rate endpoint (/extended/v1/fees/mempool) is unaffected by the deprecation.
  const after = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const [inscrData, feeData] = await Promise.allSettled([
    fetchJson<{ results: unknown[]; total: number }>(
      `${HIRO_API}/ordinals/v2/inscriptions?limit=60&order=desc&after_genesis_timestamp=${encodeURIComponent(after)}`
    ),
    fetchJson<{ percentiles: number[] }>(`${HIRO_API}/extended/v1/fees/mempool`),
  ]);

  const inscriptions =
    inscrData.status === "fulfilled" ? (inscrData.value.results?.length ?? 0) : 0;

  const feeRate =
    feeData.status === "fulfilled"
      ? Math.round((feeData.value.percentiles?.[5] ?? 10) / 1000)
      : 10;

  // Score: inscriptions (0–6) + fee rate (0–4)
  const inscrScore = Math.min(6, Math.floor(inscriptions / 10));
  const feeScore = feeRate >= 50 ? 4 : feeRate >= 30 ? 3 : feeRate >= 15 ? 2 : feeRate >= 5 ? 1 : 0;
  const pressure_score = Math.min(10, inscrScore + feeScore);

  return { inscriptions_recent: inscriptions, fee_rate_sat_vb: feeRate, pressure_score };
}

// ---------------------------------------------------------------------------
// Signal 2: Reserve demand + Signal 3: Volatility regime (same API call)
// ---------------------------------------------------------------------------

interface ReserveAndVolatility {
  // Demand
  imbalance_score: number; // 0–10
  demand_signal: DemandSignal;
  sbtc_above_active: number;
  stx_below_active: number;
  // Volatility
  volatility_score: number; // 0–100
  regime: VolatilityRegime;
  bin_spread: number;
  // Pool
  active_bin_id: number;
  total_bins: number;
  token_x: string;
  token_y: string;
}

function computeReserveAndVolatility(
  poolInfo: PoolInfo,
  binsData: BinsResponse,
  demandThreshold: number
): ReserveAndVolatility {
  const activeBinId = binsData.active_bin_id ?? poolInfo.active_bin;

  if (!activeBinId) {
    throw new Error(
      `Could not determine active bin for pool — API response missing active_bin_id and pool info missing active_bin`
    );
  }

  const bins = binsData.bins;

  let sbtcAbove = 0;
  let stxBelow = 0;

  for (const bin of bins) {
    const rx = parseFloat(bin.reserve_x) || 0;
    const ry = parseFloat(bin.reserve_y) || 0;
    if (bin.bin_id > activeBinId) sbtcAbove += rx;
    else if (bin.bin_id < activeBinId) stxBelow += ry;
  }

  // Demand: bin-count imbalance score 0–10
  // Use strict inequalities so active bin is excluded from directional scoring
  const totalSbtcSide = bins.filter(
    (b) => b.bin_id > activeBinId && parseFloat(b.reserve_x) > 0
  ).length;
  const totalStxSide = bins.filter(
    (b) => b.bin_id < activeBinId && parseFloat(b.reserve_y) > 0
  ).length;
  const totalBinCount = totalSbtcSide + totalStxSide || 1;
  const imbalance_score = sbtcAbove + stxBelow > 0
    ? Math.round((totalSbtcSide / totalBinCount) * 10)
    : 5;

  const midLow = 5 - demandThreshold;
  const midHigh = 5 + demandThreshold;
  const demand_signal: DemandSignal =
    imbalance_score <= midLow ? "BUY_PRESSURE" :
    imbalance_score >= midHigh ? "SELL_PRESSURE" :
    "NEUTRAL";

  // Volatility: bin spread as proxy (same as hodlmm-risk)
  const binIds = bins.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const totalBins = bins.length;
  const bin_spread = totalBins > 1 ? (maxBin - minBin) / totalBins : 0;

  // Volatility score 0–100 (weights: spread 40%, imbalance 30%, concentration 30%)
  // Imbalance is derived from bin counts (unit-independent: avoids mixing raw sBTC and STX amounts)
  const spreadScore = Math.min(100, Math.round(bin_spread * 1000));
  // imbalance_score is 0–10 centered at 5; map distance from center to 0–100
  const imbalanceScore100 = Math.round(Math.abs(imbalance_score - 5) / 5 * 100);
  const concentrationBins = bins.filter(
    (b) => parseFloat(b.reserve_x) > 0 || parseFloat(b.reserve_y) > 0
  ).length;
  const concentrationScore = concentrationBins <= 1 ? 100 : concentrationBins <= 3 ? 60 : 20;
  const volatility_score = Math.round(
    spreadScore * 0.4 + imbalanceScore100 * 0.3 + concentrationScore * 0.3
  );

  const regime: VolatilityRegime =
    volatility_score >= 61 ? "crisis" :
    volatility_score >= 31 ? "elevated" :
    "calm";

  return {
    imbalance_score,
    demand_signal,
    sbtc_above_active: Math.round(sbtcAbove * 1e6) / 1e6,
    stx_below_active: Math.round(stxBelow),
    volatility_score,
    regime,
    bin_spread: Math.round(bin_spread * 1e4) / 1e4,
    active_bin_id: activeBinId,
    total_bins: totalBins,
    token_x: poolInfo.token_x_symbol ?? poolInfo.token_x ?? "sBTC",
    token_y: poolInfo.token_y_symbol ?? poolInfo.token_y ?? "STX",
  };
}

// ---------------------------------------------------------------------------
// Decision matrix — synthesises all three signals
// ---------------------------------------------------------------------------

interface Decision {
  action: ActionRecommendation;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

function synthesise(l1: L1Pressure, rv: ReserveAndVolatility): Decision {
  const { pressure_score } = l1;
  const { demand_signal, regime, volatility_score, active_bin_id, imbalance_score } = rv;

  // Safety override: crisis volatility always widens first
  if (regime === "crisis") {
    return {
      action: "WIDEN",
      confidence: "high",
      rationale: `Crisis volatility regime (score ${volatility_score}/100). Pool bin spread is extreme — widen range immediately to avoid concentrated IL exposure. L1 pressure ${pressure_score}/10, demand signal ${demand_signal}.`,
    };
  }

  // High L1 pressure + elevated volatility → tighten
  if (pressure_score >= 7 && regime === "elevated") {
    return {
      action: "TIGHTEN",
      confidence: "high",
      rationale: `High L1 inscription pressure (${pressure_score}/10) combined with elevated volatility regime (${volatility_score}/100). A significant L1 wave is incoming — tighten bins around the active price to capture fees at peak activity while limiting IL window.`,
    };
  }

  // Calm volatility with strong directional signal
  if (regime === "calm") {
    if (demand_signal === "BUY_PRESSURE") {
      const action: ActionRecommendation =
        pressure_score >= 6 ? "SHIFT_UP_AGGRESSIVE" : "SHIFT_UP";
      const confidence = pressure_score >= 6 ? "high" : "medium";
      return {
        action,
        confidence,
        rationale: `Calm volatility (${volatility_score}/100) with BUY_PRESSURE demand signal (imbalance score ${imbalance_score}/10) — price has been trending upward. ${pressure_score >= 6 ? `High L1 pressure (${pressure_score}/10) confirms incoming sBTC demand.` : `Moderate L1 pressure (${pressure_score}/10).`} Shift bin concentration upward to capture fees as upward momentum continues.`,
      };
    }
    if (demand_signal === "SELL_PRESSURE") {
      const action: ActionRecommendation =
        pressure_score >= 6 ? "SHIFT_DOWN_AGGRESSIVE" : "SHIFT_DOWN";
      const confidence = pressure_score >= 6 ? "high" : "medium";
      return {
        action,
        confidence,
        rationale: `Calm volatility (${volatility_score}/100) with SELL_PRESSURE demand signal (imbalance score ${imbalance_score}/10) — price has been trending downward. ${pressure_score >= 6 ? `High L1 pressure (${pressure_score}/10) may amplify selling.` : `Low L1 pressure (${pressure_score}/10).`} Shift bin concentration downward.`,
      };
    }
    // Neutral demand, calm volatility
    return {
      action: "HOLD",
      confidence: pressure_score <= 2 ? "high" : "medium",
      rationale: `Calm volatility (${volatility_score}/100), balanced reserve distribution (imbalance score ${imbalance_score}/10), L1 pressure ${pressure_score}/10. No dominant directional signal — hold current bin range and collect fees.`,
    };
  }

  // Elevated volatility with directional signal
  if (demand_signal === "BUY_PRESSURE") {
    return {
      action: "SHIFT_UP",
      confidence: "low",
      rationale: `BUY_PRESSURE demand signal (${imbalance_score}/10) but elevated volatility (${volatility_score}/100) adds execution risk. Shift upward cautiously — consider smaller position size. L1 pressure ${pressure_score}/10.`,
    };
  }
  if (demand_signal === "SELL_PRESSURE") {
    return {
      action: "SHIFT_DOWN",
      confidence: "low",
      rationale: `SELL_PRESSURE demand signal (${imbalance_score}/10) but elevated volatility (${volatility_score}/100) adds execution risk. Shift downward cautiously — consider smaller position size. L1 pressure ${pressure_score}/10.`,
    };
  }

  // Elevated volatility, neutral demand
  return {
    action: "HOLD",
    confidence: "low",
    rationale: `Elevated volatility (${volatility_score}/100) with neutral demand signal (${imbalance_score}/10). Conflicting signals — no clear direction. Hold current range; monitor for regime resolution. L1 pressure ${pressure_score}/10.`,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  const [hiroOk, bitflowOk] = await Promise.all([
    fetch(`${HIRO_API}/extended/v1/fees/mempool`).then((r) => r.ok).catch(() => false),
    fetch(`${BITFLOW_V1}/hodlmm/pools/dlmm_3`).then((r) => r.ok).catch(() => false),
  ]);

  const result = {
    result: hiroOk && bitflowOk ? "ready" : "error",
    checks: {
      hiro_api: hiroOk ? "ok" : "unreachable",
      bitflow_hodlmm_api: bitflowOk ? "ok" : "unreachable",
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!hiroOk || !bitflowOk) process.exit(1);
}

async function runAnalysis(poolId: string, demandThreshold: number): Promise<void> {
  const timestamp = new Date().toISOString();

  const [[poolInfo, binsData], l1] = await Promise.all([
    Promise.all([
      fetchJson<PoolInfo>(`${BITFLOW_V1}/hodlmm/pools/${poolId}`),
      fetchJson<BinsResponse>(`${BITFLOW_V1}/hodlmm/pools/${poolId}/bins`),
    ]),
    getL1Pressure(1),
  ]);

  const rv = computeReserveAndVolatility(poolInfo, binsData, demandThreshold);
  const decision = synthesise(l1, rv);

  const output = {
    skill: "hodlmm-advisor",
    timestamp,
    input: { pool: poolId, demand_threshold: demandThreshold },
    pool: {
      id: poolId,
      token_x: rv.token_x,
      token_y: rv.token_y,
      active_bin: rv.active_bin_id,
      total_bins: rv.total_bins,
    },
    signals: {
      l1_pressure: {
        inscriptions_recent: l1.inscriptions_recent,
        fee_rate_sat_vb: l1.fee_rate_sat_vb,
        pressure_score: l1.pressure_score,
      },
      demand: {
        imbalance_score: rv.imbalance_score,
        signal: rv.demand_signal,
        sbtc_above_active: rv.sbtc_above_active,
        stx_below_active: rv.stx_below_active,
      },
      volatility: {
        score: rv.volatility_score,
        regime: rv.regime,
        bin_spread: rv.bin_spread,
      },
    },
    action: decision.action,
    confidence: decision.confidence,
    rationale: decision.rationale,
    summary: `${decision.action} (${decision.confidence} confidence) — L1 ${l1.pressure_score}/10, demand ${rv.demand_signal}, volatility ${rv.regime} (${rv.volatility_score}/100) on pool ${poolId} (active bin ${rv.active_bin_id}).`,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("hodlmm-advisor")
    .description("Composite HODLMM action signal — synthesises L1 pressure, reserve demand, and volatility into a single LP position recommendation")
    .version("1.0.0");

  program
    .command("doctor")
    .description("Check Hiro and Bitflow HODLMM API connectivity")
    .action(async () => {
      try {
        await runDoctor();
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
    });

  program
    .command("run")
    .description("Fetch live signals and output composite action recommendation")
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
      } catch (err) {
        console.log(
          JSON.stringify({
            skill: "hodlmm-advisor",
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          })
        );
        process.exit(1);
      }
    });

  program.parse();
}

main();
