#!/usr/bin/env bun
/**
 * hodlmm-pool-screener — Multi-pool HODLMM screener for AIBTC agents
 * Scans all known Bitflow HODLMM pools, computes fee APY and bin efficiency,
 * and ranks them so agents know exactly which pool to deploy capital into.
 * Usage: bun hodlmm-pool-screener/hodlmm-pool-screener.ts doctor | run [options]
 */

import { Command } from "commander";

const BITFLOW_V1 = "https://api.bitflow.finance/api/v1";
const MEMPOOL_API = "https://mempool.space/api";

// Known HODLMM pool IDs — screener tries list endpoint first, falls back here
const KNOWN_POOL_IDS = [
  "dlmm_1",
  "dlmm_2",
  "dlmm_3",
  "dlmm_4",
  "dlmm_5",
  "dlmm_6",
];

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
  asymmetry: number; // abs(above - below) / total — 0 = balanced, 1 = fully skewed
}

interface PoolScore {
  pool: PoolInfo;
  bins: BinState | null;
  fee_apy_pct: number;       // annualized fee yield on TVL
  bin_efficiency: number;    // active_bin ratio — higher = more capital-efficient range
  balance_score: number;     // 1 = perfectly balanced bins, 0 = fully one-sided
  composite_score: number;   // weighted rank
  rank: number;
  recommendation: "DEPLOY" | "WATCH" | "AVOID";
  rationale: string;
}

async function fetchPoolList(): Promise<string[]> {
  try {
    const res = await fetch(`${BITFLOW_V1}/hodlmm/pools`).catch(() => null);
    if (!res?.ok) return [];
    const data: any = await res.json().catch(() => null);
    if (Array.isArray(data)) return data.map((p: any) => p.id ?? p.pool_id).filter(Boolean);
    if (Array.isArray(data?.pools)) return data.pools.map((p: any) => p.id ?? p.pool_id).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}

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

    return {
      active_bin_id: activeBinId,
      total_bins: total,
      bin_spread: spread,
      bins_above_active: above,
      bins_below_active: below,
      asymmetry: parseFloat(asymmetry.toFixed(3)),
    };
  } catch {
    return null;
  }
}

function computeFeeApy(pool: PoolInfo): number {
  if (!pool.tvl_usd || pool.tvl_usd === 0) return 0;
  // Annualized: (daily_fees / tvl) * 365 * 100
  const daily_fees = pool.volume_24h * pool.fee_rate;
  return parseFloat(((daily_fees / pool.tvl_usd) * 365 * 100).toFixed(2));
}

function computeBinEfficiency(bins: BinState | null): number {
  if (!bins || bins.bin_spread === 0) return 0;
  // Ratio of active bins to total range — tighter = more efficient
  const efficiency = bins.total_bins / (bins.bin_spread + 1);
  return parseFloat(Math.min(1, efficiency).toFixed(3));
}

function computeBalanceScore(bins: BinState | null): number {
  if (!bins) return 0;
  return parseFloat((1 - bins.asymmetry).toFixed(3));
}

function scorePool(
  pool: PoolInfo,
  bins: BinState | null,
  minTvl: number
): PoolScore {
  const fee_apy_pct = computeFeeApy(pool);
  const bin_efficiency = computeBinEfficiency(bins);
  const balance_score = computeBalanceScore(bins);

  // Composite: 50% fee APY (normalized), 30% balance, 20% bin efficiency
  // Normalize APY against 100% as reference ceiling
  const apy_norm = Math.min(1, fee_apy_pct / 100);
  const composite_score = parseFloat(
    (apy_norm * 0.5 + balance_score * 0.3 + bin_efficiency * 0.2).toFixed(4)
  );

  let recommendation: PoolScore["recommendation"] = "AVOID";
  let rationale = "";

  if (pool.tvl_usd < minTvl) {
    recommendation = "AVOID";
    rationale = `TVL $${pool.tvl_usd.toLocaleString()} below minimum threshold ($${minTvl.toLocaleString()}). Insufficient depth for meaningful LP position.`;
  } else if (fee_apy_pct >= 20 && balance_score >= 0.6) {
    recommendation = "DEPLOY";
    rationale = `Strong fee APY (${fee_apy_pct}%/yr) with ${(balance_score * 100).toFixed(0)}% bin balance. ${bins ? `Active bin ${bins.active_bin_id} centered with ${bins.bins_below_active} below / ${bins.bins_above_active} above.` : ""} Best risk-adjusted yield in current scan.`;
  } else if (fee_apy_pct >= 10 || (balance_score >= 0.7 && fee_apy_pct >= 5)) {
    recommendation = "WATCH";
    rationale = `Moderate fee APY (${fee_apy_pct}%/yr). ${balance_score < 0.6 ? `Bins skewed (asymmetry ${bins?.asymmetry}) — price may have shifted away from active range. ` : ""}Monitor for volume pick-up before deploying.`;
  } else {
    recommendation = "AVOID";
    rationale = `Low fee APY (${fee_apy_pct}%/yr). ${pool.volume_24h < 1000 ? "Volume too low to generate meaningful LP returns. " : ""}${balance_score < 0.4 ? "Severely imbalanced bins suggest LP is out-of-range." : ""}`;
  }

  return {
    pool,
    bins,
    fee_apy_pct,
    bin_efficiency,
    balance_score,
    composite_score,
    rank: 0, // assigned after sort
    recommendation,
    rationale,
  };
}

const program = new Command();
program
  .name("hodlmm-pool-screener")
  .description("Multi-pool HODLMM screener — ranks Bitflow HODLMM pools for LP deployment")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check API connectivity")
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
          ? "Bitflow HODLMM API reachable — pool data available"
          : "Bitflow HODLMM API unreachable — run on a node with internet access to api.bitflow.finance",
      })
    );
    if (!ready) process.exit(1);
  });

program
  .command("run")
  .description("Scan HODLMM pools and rank by fee APY and bin efficiency")
  .option("--min-tvl <usd>", "Minimum TVL in USD to include pool", "10000")
  .option("--top <n>", "Number of top pools to show", "5")
  .action(async (opts) => {
    const minTvl = parseFloat(opts.minTvl);
    const topN = parseInt(opts.top, 10);
    const timestamp = new Date().toISOString();

    try {
      // Try list endpoint first; fall back to known IDs
      let poolIds = await fetchPoolList();
      if (poolIds.length === 0) poolIds = KNOWN_POOL_IDS;

      // Fetch all pools + bin states in parallel
      const results = await Promise.all(
        poolIds.map(async (id) => {
          const [pool, bins] = await Promise.all([fetchPool(id), fetchBinState(id)]);
          return { id, pool, bins };
        })
      );

      const validPools = results.filter((r) => r.pool !== null);

      if (validPools.length === 0) {
        console.log(
          JSON.stringify({
            skill: "hodlmm-pool-screener",
            error: "No pools returned from Bitflow API — check connectivity",
            timestamp,
          })
        );
        process.exit(1);
      }

      // Score and sort
      const scored = validPools
        .map((r) => scorePool(r.pool!, r.bins, minTvl))
        .sort((a, b) => b.composite_score - a.composite_score)
        .map((s, i) => ({ ...s, rank: i + 1 }));

      const top = scored.slice(0, topN);
      const deployPools = scored.filter((s) => s.recommendation === "DEPLOY");
      const bestPool = deployPools[0] ?? scored[0];

      const output = {
        skill: "hodlmm-pool-screener",
        timestamp,
        input: { min_tvl_usd: minTvl, top_n: topN },
        summary: bestPool
          ? `${bestPool.recommendation} ${bestPool.pool.token_x}/${bestPool.pool.token_y} (${bestPool.pool.id}) — ${bestPool.fee_apy_pct}% fee APY, $${bestPool.pool.tvl_usd.toLocaleString()} TVL. ${deployPools.length} pool(s) rated DEPLOY.`
          : "No pools rated DEPLOY — check TVL thresholds or widen min-tvl.",
        top_pools: top.map((s) => ({
          rank: s.rank,
          pool_id: s.pool.id,
          pair: `${s.pool.token_x}/${s.pool.token_y}`,
          tvl_usd: s.pool.tvl_usd,
          volume_24h: s.pool.volume_24h,
          fee_rate_pct: parseFloat((s.pool.fee_rate * 100).toFixed(3)),
          fee_apy_pct: s.fee_apy_pct,
          bin_efficiency: s.bin_efficiency,
          balance_score: s.balance_score,
          composite_score: s.composite_score,
          bin_state: s.bins
            ? {
                active_bin_id: s.bins.active_bin_id,
                total_bins: s.bins.total_bins,
                bin_spread: s.bins.bin_spread,
                bins_below_active: s.bins.bins_below_active,
                bins_above_active: s.bins.bins_above_active,
                asymmetry: s.bins.asymmetry,
              }
            : null,
          recommendation: s.recommendation,
          rationale: s.rationale,
        })),
        pools_scanned: validPools.length,
        pools_skipped: poolIds.length - validPools.length,
        deploy_count: deployPools.length,
        watch_count: scored.filter((s) => s.recommendation === "WATCH").length,
        avoid_count: scored.filter((s) => s.recommendation === "AVOID").length,
      };

      console.log(JSON.stringify(output, null, 2));
    } catch (err: any) {
      console.log(
        JSON.stringify({
          skill: "hodlmm-pool-screener",
          error: err.message,
          timestamp,
        })
      );
      process.exit(1);
    }
  });

program.parse();
