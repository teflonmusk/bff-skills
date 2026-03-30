#!/usr/bin/env bun
/**
 * hodlmm-inscription-signal — Bitcoin L1 inscription pressure oracle for HODLMM bin management
 * Monitors BTC inscription activity, mempool fee rates, and HODLMM bin state to recommend
 * when HODLMM LPs should tighten, widen, or hold their concentrated liquidity bins.
 * Usage: bun hodlmm-inscription-signal/hodlmm-inscription-signal.ts doctor | run [options]
 */

import { Command } from "commander";

const MEMPOOL_API = "https://mempool.space/api";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_V1 = "https://api.bitflow.finance/api/v1";

type BinRecommendation = "HOLD" | "TIGHTEN_BINS" | "WIDEN_BINS";

interface MempoolPressure {
  fastest_fee_sat_vb: number;
  hour_fee_sat_vb: number;
  mempool_tx_count: number;
  mempool_vsize_mb: number;
  inscriptions_last_hour: number;
  pressure_score: number;
}

interface BinData {
  bin_id: number;
  reserve_x: string; // sBTC
  reserve_y: string; // STX
}

interface HODLMMBinState {
  active_bin_id: number;
  total_bins: number;
  bin_spread: number;
  bins_above_active: number;
  bins_below_active: number;
}

async function getRecentInscriptions(hours: number = 1): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - hours * 3600;

  const res = await fetch(
    `${HIRO_API}/ordinals/v1/inscriptions?order_by=genesis_timestamp&order=desc&limit=60`
  ).catch(() => null);

  if (!res?.ok) return 0;

  const data = await res.json().catch(() => null);
  if (!data?.results) return 0;

  return data.results.filter((i: any) => {
    const ts = Math.floor(new Date(i.genesis_timestamp).getTime() / 1000);
    return ts >= since;
  }).length;
}

async function getMempoolPressure(hours: number = 1): Promise<MempoolPressure> {
  const [feesRes, mempoolRes, inscriptions] = await Promise.all([
    fetch(`${MEMPOOL_API}/v1/fees/recommended`).catch(() => null),
    fetch(`${MEMPOOL_API}/mempool`).catch(() => null),
    getRecentInscriptions(hours),
  ]);

  const fees = feesRes?.ok ? await feesRes.json().catch(() => null) : null;
  const mempool = mempoolRes?.ok ? await mempoolRes.json().catch(() => null) : null;

  const fastest_fee_sat_vb = fees?.fastestFee ?? 2;
  const hour_fee_sat_vb = fees?.hourFee ?? 1;
  const mempool_tx_count = mempool?.count ?? 0;
  const mempool_vsize_mb = mempool?.vsize ? mempool.vsize / 1_000_000 : 0;

  const pressure_score = scorePressure(fastest_fee_sat_vb, mempool_tx_count, inscriptions);

  return { fastest_fee_sat_vb, hour_fee_sat_vb, mempool_tx_count, mempool_vsize_mb, inscriptions_last_hour: inscriptions, pressure_score };
}

async function getHODLMMPool(poolId: string) {
  try {
    const res = await fetch(`${BITFLOW_V1}/hodlmm/pools/${poolId}`).catch(() => null);
    if (!res?.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (!data) return null;
    return {
      id: poolId,
      token_x: data.token_x_symbol ?? data.token_x ?? "sBTC",
      token_y: data.token_y_symbol ?? data.token_y ?? "STX",
      tvl_usd: data.tvl_usd ?? data.tvl ?? 0,
      volume_24h: data.volume_24h ?? 0,
    };
  } catch {
    return null;
  }
}

async function getHODLMMBinState(poolId: string): Promise<HODLMMBinState | null> {
  try {
    const res = await fetch(`${BITFLOW_V1}/hodlmm/pools/${poolId}/bins`).catch(() => null);
    if (!res?.ok) return null;

    const data: { active_bin_id?: number; bins?: BinData[] } = await res.json().catch(() => null);
    if (!data) return null;

    const bins: BinData[] = data.bins ?? [];
    const activeBinId = data.active_bin_id ?? 0;

    const activeBins = bins.filter(
      (b) => parseFloat(b.reserve_x) > 0 || parseFloat(b.reserve_y) > 0
    );

    const binIds = activeBins.map((b) => b.bin_id);
    const minBin = binIds.length ? Math.min(...binIds) : activeBinId;
    const maxBin = binIds.length ? Math.max(...binIds) : activeBinId;

    return {
      active_bin_id: activeBinId,
      total_bins: activeBins.length,
      bin_spread: maxBin - minBin,
      bins_above_active: activeBins.filter((b) => b.bin_id > activeBinId).length,
      bins_below_active: activeBins.filter((b) => b.bin_id < activeBinId).length,
    };
  } catch {
    return null;
  }
}

function scorePressure(feeRate: number, mempoolCount: number, inscriptions: number): number {
  // Fee pressure: 0-4 points
  let score = 0;
  if (feeRate > 100) score += 4;
  else if (feeRate > 50) score += 3;
  else if (feeRate > 20) score += 2;
  else if (feeRate > 10) score += 1;

  // Mempool congestion: 0-3 points
  if (mempoolCount > 100_000) score += 3;
  else if (mempoolCount > 50_000) score += 2;
  else if (mempoolCount > 20_000) score += 1;

  // Inscription activity: 0-3 points
  if (inscriptions > 50) score += 3;
  else if (inscriptions > 20) score += 2;
  else if (inscriptions > 5) score += 1;

  return Math.min(10, score);
}

function recommendBins(pressure: number, threshold: number): BinRecommendation {
  if (pressure >= threshold + 3) return "WIDEN_BINS";
  if (pressure >= threshold) return "TIGHTEN_BINS";
  return "HOLD";
}

function describeRationale(rec: BinRecommendation, p: MempoolPressure): string {
  const score = p.pressure_score;
  switch (rec) {
    case "WIDEN_BINS":
      return `Extreme L1 pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB, ${p.inscriptions_last_hour} inscriptions/hr). High inscription activity drives sBTC demand volatility — widen bins to reduce IL risk.`;
    case "TIGHTEN_BINS":
      return `Moderate L1 pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB, ${p.inscriptions_last_hour} inscriptions/hr). Elevated inscription activity with manageable fees — tighten bins to capture more fees ahead of potential volatility.`;
    case "HOLD":
      return `Low L1 pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB, ${p.inscriptions_last_hour} inscriptions/hr). Inscription activity and fees are calm — current bin configuration is optimal. Hold and collect fees.`;
  }
}

const program = new Command();
program
  .name("hodlmm-inscription-signal")
  .description("Bitcoin L1 inscription pressure oracle for HODLMM bin management")
  .version("1.1.0");

program
  .command("doctor")
  .description("Check API connectivity and environment readiness")
  .action(async () => {
    const [mempoolOk, hiroOk, bitflowOk] = await Promise.all([
      fetch(`${MEMPOOL_API}/v1/fees/recommended`).then((r) => r.ok).catch(() => false),
      fetch(`${HIRO_API}/ordinals/v1/inscriptions?limit=1`).then((r) => r.ok).catch(() => false),
      fetch(`${BITFLOW_V1}/hodlmm/pools/dlmm_3`).then((r) => r.ok).catch(() => false),
    ]);
    const ready = mempoolOk && hiroOk;
    console.log(JSON.stringify({
      result: ready ? "ready" : "error",
      checks: {
        mempool_space_api: mempoolOk ? "ok" : "unreachable",
        hiro_ordinals_api: hiroOk ? "ok" : "unreachable",
        bitflow_hodlmm_api: bitflowOk ? "ok" : "unreachable (bin state optional)",
      },
    }));
    if (!ready) process.exit(1);
  });

program
  .command("run")
  .description("Fetch live inscription pressure + HODLMM bin state, output bin recommendation")
  .option("--pool <id>", "HODLMM pool ID (e.g. dlmm_3)", "dlmm_3")
  .option("--threshold <n>", "Pressure score threshold for TIGHTEN_BINS (0-10)", "3")
  .option("--window <hours>", "Hours of inscription history to analyze", "1")
  .action(async (opts) => {
    const poolId = opts.pool as string;
    const threshold = parseInt(opts.threshold, 10);
    const window = parseInt(opts.window, 10);
    const timestamp = new Date().toISOString();
    try {
      const [pressure, pool, binState] = await Promise.all([
        getMempoolPressure(window),
        getHODLMMPool(poolId),
        getHODLMMBinState(poolId),
      ]);
      const recommendation = recommendBins(pressure.pressure_score, threshold);
      const rationale = describeRationale(recommendation, pressure);
      console.log(JSON.stringify({
        skill: "hodlmm-inscription-signal",
        timestamp,
        input: { pool: poolId, threshold, window_hours: window },
        bitcoin_l1: {
          fastest_fee_sat_vb: pressure.fastest_fee_sat_vb,
          hour_fee_sat_vb: pressure.hour_fee_sat_vb,
          mempool_tx_count: pressure.mempool_tx_count,
          mempool_vsize_mb: parseFloat(pressure.mempool_vsize_mb.toFixed(2)),
          inscriptions_last_hour: pressure.inscriptions_last_hour,
          pressure_score: pressure.pressure_score,
        },
        pool: pool
          ? {
              id: pool.id,
              pair: `${pool.token_x}/${pool.token_y}`,
              tvl_usd: pool.tvl_usd,
              volume_24h: pool.volume_24h,
              bin_state: binState
                ? {
                    active_bin_id: binState.active_bin_id,
                    total_bins: binState.total_bins,
                    bin_spread: binState.bin_spread,
                    bins_above_active: binState.bins_above_active,
                    bins_below_active: binState.bins_below_active,
                  }
                : null,
            }
          : null,
        recommendation,
        rationale,
        summary: `${recommendation} — L1 pressure score ${pressure.pressure_score}/10. ${pressure.inscriptions_last_hour} inscriptions/hr, ${pressure.fastest_fee_sat_vb} sat/vB.${binState ? ` Active bin ${binState.active_bin_id}, ${binState.total_bins} bins (${binState.bins_below_active} below / ${binState.bins_above_active} above).` : ""}`,
      }, null, 2));
    } catch (err: any) {
      console.log(JSON.stringify({ skill: "hodlmm-inscription-signal", error: err.message, timestamp }));
      process.exit(1);
    }
  });

program.parse();
