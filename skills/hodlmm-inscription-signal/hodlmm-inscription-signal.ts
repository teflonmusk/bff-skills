#!/usr/bin/env bun
/**
 * hodlmm-inscription-signal — Bitcoin L1 mempool pressure oracle for HODLMM bin management
 * Monitors BTC mempool congestion and fee rates to recommend
 * when HODLMM LPs should tighten, widen, or hold their concentrated liquidity bins.
 * Usage: bun hodlmm-inscription-signal/hodlmm-inscription-signal.ts doctor | run [options]
 */

import { Command } from "commander";

const MEMPOOL_API = "https://mempool.space/api";
const BITFLOW_API = "https://api.bitflow.finance";

type BinRecommendation = "HOLD" | "TIGHTEN_BINS" | "WIDEN_BINS";

interface MempoolPressure {
  fastest_fee_sat_vb: number;
  hour_fee_sat_vb: number;
  mempool_tx_count: number;
  mempool_vsize_mb: number;
  pressure_score: number;
}

async function getMempoolPressure(): Promise<MempoolPressure> {
  const [feesRes, mempoolRes] = await Promise.all([
    fetch(`${MEMPOOL_API}/v1/fees/recommended`).catch(() => null),
    fetch(`${MEMPOOL_API}/mempool`).catch(() => null),
  ]);

  const fees = feesRes?.ok ? await feesRes.json().catch(() => null) : null;
  const mempool = mempoolRes?.ok ? await mempoolRes.json().catch(() => null) : null;

  const fastest_fee_sat_vb = fees?.fastestFee ?? 2;
  const hour_fee_sat_vb = fees?.hourFee ?? 1;
  const mempool_tx_count = mempool?.count ?? 0;
  const mempool_vsize_mb = mempool?.vsize ? mempool.vsize / 1_000_000 : 0;

  const pressure_score = scorePressure(fastest_fee_sat_vb, mempool_tx_count);

  return { fastest_fee_sat_vb, hour_fee_sat_vb, mempool_tx_count, mempool_vsize_mb, pressure_score };
}

async function getHODLMMPool(poolId: string) {
  const res = await fetch(`${BITFLOW_API}/pools`).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  const pools: any[] = Array.isArray(data) ? data : data?.pools ?? [];
  const match = pools.find(
    (p: any) =>
      p.id?.toLowerCase().includes(poolId.toLowerCase()) ||
      (p.token_x?.toLowerCase().includes("sbtc") && p.token_y?.toLowerCase().includes("stx"))
  );
  if (!match) return null;
  return {
    id: match.id ?? poolId,
    token_x: match.token_x ?? "sBTC",
    token_y: match.token_y ?? "STX",
    tvl_usd: match.tvl_usd ?? match.tvl ?? 0,
    volume_24h: match.volume_24h ?? 0,
  };
}

function scorePressure(feeRate: number, mempoolCount: number): number {
  // Fee pressure: 0-6 points
  let score = 0;
  if (feeRate > 100) score += 6;
  else if (feeRate > 50) score += 4;
  else if (feeRate > 20) score += 3;
  else if (feeRate > 10) score += 2;
  else if (feeRate > 5) score += 1;

  // Mempool congestion: 0-4 points
  if (mempoolCount > 100_000) score += 4;
  else if (mempoolCount > 50_000) score += 3;
  else if (mempoolCount > 20_000) score += 2;
  else if (mempoolCount > 5_000) score += 1;

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
      return `Extreme BTC mempool pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB, ${p.mempool_tx_count.toLocaleString()} pending txs). L1 volatility is high — widening bins reduces IL risk from sBTC price swings driven by on-chain demand spikes.`;
    case "TIGHTEN_BINS":
      return `Moderate mempool pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB). Fee activity is elevated — tightening bins captures more fees while staying ahead of minor volatility.`;
    case "HOLD":
      return `Low BTC mempool pressure (score ${score}/10, ${p.fastest_fee_sat_vb} sat/vB, ${p.mempool_tx_count.toLocaleString()} pending txs). L1 is calm — current bin configuration is optimal. Hold and collect fees.`;
  }
}

const program = new Command();
program
  .name("hodlmm-inscription-signal")
  .description("Bitcoin L1 mempool pressure oracle for HODLMM bin management")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check API connectivity and environment readiness")
  .action(async () => {
    const mempoolOk = await fetch(`${MEMPOOL_API}/v1/fees/recommended`)
      .then((r) => r.ok).catch(() => false);
    const bitflowOk = await fetch(`${BITFLOW_API}/pools`)
      .then((r) => r.ok).catch(() => false);
    const ready = mempoolOk;
    console.log(JSON.stringify({
      result: ready ? "ready" : "error",
      checks: {
        mempool_space_api: mempoolOk ? "ok" : "unreachable",
        bitflow_api: bitflowOk ? "ok" : "unreachable (pool data optional)",
      },
    }));
    if (!ready) process.exit(1);
  });

program
  .command("run")
  .description("Fetch live BTC mempool pressure data and output bin recommendation")
  .option("--pool <id>", "HODLMM pool to analyze", "sbtc-stx")
  .option("--threshold <n>", "Pressure score threshold for TIGHTEN_BINS (0-10)", "3")
  .action(async (opts) => {
    const poolId = opts.pool as string;
    const threshold = parseInt(opts.threshold, 10);
    const timestamp = new Date().toISOString();
    try {
      const [pressure, pool] = await Promise.all([
        getMempoolPressure(),
        getHODLMMPool(poolId),
      ]);
      const recommendation = recommendBins(pressure.pressure_score, threshold);
      const rationale = describeRationale(recommendation, pressure);
      console.log(JSON.stringify({
        skill: "hodlmm-inscription-signal",
        timestamp,
        input: { pool: poolId, threshold },
        bitcoin_l1: {
          fastest_fee_sat_vb: pressure.fastest_fee_sat_vb,
          hour_fee_sat_vb: pressure.hour_fee_sat_vb,
          mempool_tx_count: pressure.mempool_tx_count,
          mempool_vsize_mb: parseFloat(pressure.mempool_vsize_mb.toFixed(2)),
          pressure_score: pressure.pressure_score,
        },
        pool: pool
          ? { id: pool.id, pair: `${pool.token_x}/${pool.token_y}`, tvl_usd: pool.tvl_usd, volume_24h: pool.volume_24h }
          : null,
        recommendation,
        rationale,
        summary: `${recommendation} — L1 pressure score ${pressure.pressure_score}/10. ${pressure.fastest_fee_sat_vb} sat/vB fastest fee. ${pressure.mempool_tx_count.toLocaleString()} pending txs.${pool ? ` Pool ${pool.id}: $${pool.tvl_usd.toLocaleString()} TVL.` : ""}`,
      }, null, 2));
    } catch (err: any) {
      console.log(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
  });

program.parse();
