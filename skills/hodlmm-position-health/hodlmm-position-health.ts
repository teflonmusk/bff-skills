#!/usr/bin/env bun
/**
 * hodlmm-position-health — Post-entry HODLMM LP position health monitor
 * After deploying capital into a HODLMM pool, this skill tracks whether
 * the active bin has drifted from entry, estimates fee accrual, and outputs
 * a HOLD / HARVEST / REBALANCE / EXIT recommendation.
 * Usage: bun hodlmm-position-health/hodlmm-position-health.ts doctor | check [options]
 */

import { Command } from "commander";

const BITFLOW_V1 = "https://api.bitflow.finance/api/v1";
const MEMPOOL_API = "https://mempool.space/api";

interface PoolInfo {
  id: string;
  token_x: string;
  token_y: string;
  tvl_usd: number;
  volume_24h: number;
  fee_rate: number;
  current_price: number;
}

interface BinState {
  active_bin_id: number;
  total_bins: number;
  bin_spread: number;
  bins_above_active: number;
  bins_below_active: number;
  asymmetry: number;
  balance_score: number;
}

interface DriftInfo {
  entry_bin_id: number;
  current_bin_id: number;
  bin_drift: number;
  drift_direction: "up" | "down" | "none";
  drift_pct: number; // drift as fraction of total bin spread
  in_range: boolean;
  range_coverage_pct: number; // % of entry-side bins still active
}

interface FeeMetrics {
  current_fee_apy_pct: number;
  fee_rate_pct: number;
  volume_24h: number;
  tvl_usd: number;
  est_daily_fee_pct: number; // daily fee as % of TVL
}

type PositionRecommendation = "HOLD" | "HARVEST" | "REBALANCE" | "EXIT";

async function fetchPool(id: string): Promise<PoolInfo | null> {
  try {
    const res = await fetch(`${BITFLOW_V1}/hodlmm/pools/${id}`).catch(() => null);
    if (!res?.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (!data) return null;
    return {
      id,
      token_x: data.token_x_symbol ?? data.token_x ?? "?",
      token_y: data.token_y_symbol ?? data.token_y ?? "?",
      tvl_usd: Number(data.tvl_usd ?? data.tvl ?? 0),
      volume_24h: Number(data.volume_24h ?? 0),
      fee_rate: Number(data.fee_rate ?? 0.003),
      current_price: Number(data.price ?? data.current_price ?? 0),
    };
  } catch {
    return null;
  }
}

async function fetchBinState(id: string): Promise<BinState | null> {
  try {
    const res = await fetch(`${BITFLOW_V1}/hodlmm/pools/${id}/bins`).catch(() => null);
    if (!res?.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (!data) return null;

    const bins: any[] = data.bins ?? [];
    const activeBinId: number = data.active_bin_id ?? 0;

    const activeBins = bins.filter(
      (b) => parseFloat(b.reserve_x) > 0 || parseFloat(b.reserve_y) > 0
    );
    const binIds = activeBins.map((b) => b.bin_id);
    const minBin = binIds.length ? Math.min(...binIds) : activeBinId;
    const maxBin = binIds.length ? Math.max(...binIds) : activeBinId;
    const spread = maxBin - minBin;
    const above = activeBins.filter((b) => b.bin_id > activeBinId).length;
    const below = activeBins.filter((b) => b.bin_id < activeBinId).length;
    const total = activeBins.length;
    const asymmetry = total > 0 ? Math.abs(above - below) / total : 0;
    const balanceScore = parseFloat((1 - asymmetry).toFixed(3));

    return {
      active_bin_id: activeBinId,
      total_bins: total,
      bin_spread: spread,
      bins_above_active: above,
      bins_below_active: below,
      asymmetry: parseFloat(asymmetry.toFixed(3)),
      balance_score: balanceScore,
    };
  } catch {
    return null;
  }
}

function computeDrift(entryBinId: number, bins: BinState): DriftInfo {
  const drift = bins.active_bin_id - entryBinId;
  const absDrift = Math.abs(drift);
  const direction: DriftInfo["drift_direction"] =
    drift > 0 ? "up" : drift < 0 ? "down" : "none";

  // Drift as fraction of total spread — how much the price moved relative to total range
  const driftPct =
    bins.bin_spread > 0
      ? parseFloat((absDrift / bins.bin_spread).toFixed(3))
      : 0;

  // In range if active bin is within the LP's liquidity span
  const inRange = bins.balance_score > 0.1; // some liquidity on both sides

  // How much of the original coverage remains — proxy via balance score
  const rangeCoveragePct = parseFloat((bins.balance_score * 100).toFixed(1));

  return {
    entry_bin_id: entryBinId,
    current_bin_id: bins.active_bin_id,
    bin_drift: absDrift,
    drift_direction: direction,
    drift_pct: driftPct,
    in_range: inRange,
    range_coverage_pct: rangeCoveragePct,
  };
}

function computeFeeMetrics(pool: PoolInfo): FeeMetrics {
  if (!pool.tvl_usd || pool.tvl_usd === 0) {
    return {
      current_fee_apy_pct: 0,
      fee_rate_pct: parseFloat((pool.fee_rate * 100).toFixed(3)),
      volume_24h: pool.volume_24h,
      tvl_usd: pool.tvl_usd,
      est_daily_fee_pct: 0,
    };
  }
  const dailyFees = pool.volume_24h * pool.fee_rate;
  const dailyFeePct = parseFloat(((dailyFees / pool.tvl_usd) * 100).toFixed(4));
  const feeApy = parseFloat((dailyFeePct * 365).toFixed(2));
  return {
    current_fee_apy_pct: feeApy,
    fee_rate_pct: parseFloat((pool.fee_rate * 100).toFixed(3)),
    volume_24h: pool.volume_24h,
    tvl_usd: pool.tvl_usd,
    est_daily_fee_pct: dailyFeePct,
  };
}

function recommend(
  drift: DriftInfo | null,
  fees: FeeMetrics,
  bins: BinState
): { recommendation: PositionRecommendation; rationale: string } {
  // EXIT conditions: severely out-of-range or fees collapsed
  if (bins.balance_score < 0.25) {
    return {
      recommendation: "EXIT",
      rationale: `Balance score ${(bins.balance_score * 100).toFixed(0)}% — LP is heavily out-of-range. Fee generation near zero. Exit and re-enter when price returns to range or select a new pool.`,
    };
  }
  if (fees.current_fee_apy_pct < 5 && bins.balance_score < 0.5) {
    return {
      recommendation: "EXIT",
      rationale: `Low fee APY (${fees.current_fee_apy_pct}%/yr) combined with degraded bin balance (${(bins.balance_score * 100).toFixed(0)}%). Position generating minimal yield.`,
    };
  }

  // REBALANCE conditions: significant drift but fees still ok
  if (drift && drift.bin_drift >= 5 && bins.balance_score < 0.55) {
    return {
      recommendation: "REBALANCE",
      rationale: `Active bin drifted ${drift.bin_drift} bins ${drift.drift_direction} from entry. Balance score ${(bins.balance_score * 100).toFixed(0)}% — LP is collecting fees on only one side. Rebalance to re-center range.`,
    };
  }

  // HARVEST conditions: fees accumulated, moderate drift — good time to collect before more drift
  if (
    fees.current_fee_apy_pct >= 15 &&
    drift &&
    drift.bin_drift >= 3 &&
    bins.balance_score >= 0.55
  ) {
    return {
      recommendation: "HARVEST",
      rationale: `Fee APY strong (${fees.current_fee_apy_pct}%/yr) with ${drift.bin_drift}-bin drift. Consider harvesting accumulated fees now before further price movement reduces in-range liquidity. Re-enter at current active bin after harvest.`,
    };
  }

  // HOLD: position healthy
  const driftNote =
    drift && drift.bin_drift > 0
      ? ` Active bin drifted ${drift.bin_drift} bins ${drift.drift_direction} from entry — within normal range.`
      : " Active bin at entry position.";
  return {
    recommendation: "HOLD",
    rationale: `Fee APY ${fees.current_fee_apy_pct}%/yr with ${(bins.balance_score * 100).toFixed(0)}% bin balance.${driftNote} Position collecting fees on both sides.`,
  };
}

const program = new Command();
program
  .name("hodlmm-position-health")
  .description(
    "Post-entry HODLMM LP position health monitor — tracks bin drift, fee accrual, and outputs HOLD/HARVEST/REBALANCE/EXIT signal"
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check Bitflow API connectivity")
  .action(async () => {
    const [bitflowOk, mempoolOk] = await Promise.all([
      fetch(`${BITFLOW_V1}/hodlmm/pools/dlmm_3`).then((r) => r.ok).catch(() => false),
      fetch(`${MEMPOOL_API}/v1/fees/recommended`).then((r) => r.ok).catch(() => false),
    ]);
    const ready = bitflowOk;
    console.log(
      JSON.stringify({
        result: ready ? "ready" : "error",
        checks: {
          bitflow_hodlmm_api: bitflowOk ? "ok" : "unreachable",
          mempool_space_api: mempoolOk ? "ok" : "unreachable (optional)",
        },
        note: bitflowOk
          ? "Bitflow HODLMM API reachable — position data available"
          : "Bitflow HODLMM API unreachable — run on a node with internet access to api.bitflow.finance",
      })
    );
    if (!ready) process.exit(1);
  });

program
  .command("check")
  .description("Check health of an active HODLMM LP position")
  .requiredOption("--pool <id>", "Pool ID to check (e.g. dlmm_3)")
  .option("--entry-bin <id>", "Active bin ID at time of entry (for drift calculation)")
  .option("--max-drift <bins>", "Bins of drift before REBALANCE signal (default: 5)", "5")
  .action(async (opts) => {
    const poolId = opts.pool;
    const entryBinId = opts.entryBin ? parseInt(opts.entryBin, 10) : null;
    const maxDrift = parseInt(opts.maxDrift, 10);
    const timestamp = new Date().toISOString();

    try {
      const [pool, bins] = await Promise.all([
        fetchPool(poolId),
        fetchBinState(poolId),
      ]);

      if (!pool && !bins) {
        console.log(
          JSON.stringify({
            skill: "hodlmm-position-health",
            error: `Pool ${poolId} not found or Bitflow API unreachable`,
            timestamp,
          })
        );
        process.exit(1);
      }

      const fees = pool ? computeFeeMetrics(pool) : null;
      const drift = entryBinId !== null && bins ? computeDrift(entryBinId, bins) : null;

      // Override maxDrift threshold in recommend if user specified
      const effectiveBins = bins
        ? {
            ...bins,
          }
        : null;

      let rec: { recommendation: PositionRecommendation; rationale: string } = {
        recommendation: "HOLD",
        rationale: "Insufficient data — Bitflow API partially unreachable. Verify manually.",
      };

      if (effectiveBins && fees) {
        // Patch drift threshold if user overrode it
        const driftForRec =
          drift && maxDrift !== 5
            ? { ...drift, bin_drift: drift.bin_drift, _threshold: maxDrift }
            : drift;
        rec = recommend(driftForRec, fees, effectiveBins);
        // Re-check rebalance with custom threshold
        if (
          drift &&
          drift.bin_drift >= maxDrift &&
          effectiveBins.balance_score < 0.55 &&
          rec.recommendation === "HOLD"
        ) {
          rec = {
            recommendation: "REBALANCE",
            rationale: `Active bin drifted ${drift.bin_drift} bins ${drift.drift_direction} from entry (threshold: ${maxDrift}). Balance score ${(effectiveBins.balance_score * 100).toFixed(0)}%. Rebalance to re-center range.`,
          };
        }
      }

      const output: any = {
        skill: "hodlmm-position-health",
        timestamp,
        pool_id: poolId,
        pair: pool ? `${pool.token_x}/${pool.token_y}` : null,
        recommendation: rec.recommendation,
        rationale: rec.rationale,
        bin_state: effectiveBins
          ? {
              active_bin_id: effectiveBins.active_bin_id,
              total_bins: effectiveBins.total_bins,
              bin_spread: effectiveBins.bin_spread,
              bins_above_active: effectiveBins.bins_above_active,
              bins_below_active: effectiveBins.bins_below_active,
              balance_score: effectiveBins.balance_score,
              asymmetry: effectiveBins.asymmetry,
            }
          : null,
        drift: drift
          ? {
              entry_bin_id: drift.entry_bin_id,
              current_bin_id: drift.current_bin_id,
              bin_drift: drift.bin_drift,
              drift_direction: drift.drift_direction,
              drift_pct: drift.drift_pct,
              in_range: drift.in_range,
              range_coverage_pct: drift.range_coverage_pct,
            }
          : null,
        fee_metrics: fees
          ? {
              current_fee_apy_pct: fees.current_fee_apy_pct,
              fee_rate_pct: fees.fee_rate_pct,
              volume_24h_usd: fees.volume_24h,
              tvl_usd: fees.tvl_usd,
              est_daily_fee_pct: fees.est_daily_fee_pct,
            }
          : null,
        inputs: {
          pool_id: poolId,
          entry_bin_id: entryBinId,
          max_drift_bins: maxDrift,
        },
      };

      console.log(JSON.stringify(output, null, 2));
    } catch (err: any) {
      console.log(
        JSON.stringify({
          skill: "hodlmm-position-health",
          error: err.message,
          timestamp,
        })
      );
      process.exit(1);
    }
  });

program.parse();
