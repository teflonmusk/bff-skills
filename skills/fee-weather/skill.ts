#!/usr/bin/env bun
/**
 * fee-weather — Stacks fee & network conditions oracle
 * Returns current fee estimates, mempool state, and timing recommendations.
 * Usage: bun skill.ts [--format=json]
 */

const STACKS_API = "https://api.hiro.so";
const MARKET_API = "https://x402.biwas.xyz";

async function getNetworkFees() {
  const res = await fetch(`${STACKS_API}/v2/fees/transfer`);
  if (!res.ok) throw new Error(`fees: ${res.status}`);
  return res.json();
}

async function getMempoolStats() {
  const res = await fetch(`${STACKS_API}/extended/v1/tx/mempool/stats`);
  if (!res.ok) throw new Error(`mempool: ${res.status}`);
  return res.json();
}

async function getMarketNetflow() {
  const res = await fetch(`${MARKET_API}/api/market/netflow`);
  if (!res.ok) throw new Error(`netflow: ${res.status}`);
  return res.json();
}

async function getMarketStats() {
  const res = await fetch(`${MARKET_API}/api/market/stats`);
  if (!res.ok) throw new Error(`market: ${res.status}`);
  return res.json();
}

function classifyConditions(mempoolTxs: number, feeMicrostacks: number) {
  if (mempoolTxs > 5000 || feeMicrostacks > 2000) {
    return { label: "CONGESTED", action: "WAIT", urgency: "low" };
  }
  if (mempoolTxs > 2000 || feeMicrostacks > 1000) {
    return { label: "MODERATE", action: "TRANSACT_WITH_CAUTION", urgency: "medium" };
  }
  return { label: "CLEAR", action: "TRANSACT_NOW", urgency: "high" };
}

async function main() {
  try {
    const [fees, mempool, netflow, market] = await Promise.all([
      getNetworkFees(),
      getMempoolStats(),
      getMarketNetflow().catch(() => null),
      getMarketStats().catch(() => null),
    ]);

    const feeMicrostacks = fees?.estimated_cost_scalar ?? fees ?? 400;
    const mempoolTxCount = mempool?.tx_type_counts
      ? Object.values(mempool.tx_type_counts as Record<string, number>).reduce((a, b) => a + b, 0)
      : 0;
    const conditions = classifyConditions(mempoolTxCount, Number(feeMicrostacks));

    const output = {
      skill: "fee-weather",
      timestamp: new Date().toISOString(),
      network: {
        fee_microstacks: feeMicrostacks,
        fee_stx: (Number(feeMicrostacks) / 1_000_000).toFixed(6),
        mempool_tx_count: mempoolTxCount,
      },
      conditions: conditions.label,
      recommendation: conditions.action,
      market: market
        ? {
            total_volume_24h: market.total_volume_24h ?? null,
            active_pairs: market.active_pairs ?? null,
          }
        : null,
      netflow: netflow
        ? {
            net_flow_usd: netflow.net_flow_usd ?? null,
            direction: netflow.direction ?? null,
          }
        : null,
      summary: `Network is ${conditions.label}. Fee: ${(Number(feeMicrostacks) / 1_000_000).toFixed(6)} STX. Mempool: ${mempoolTxCount} pending txs. Recommendation: ${conditions.action}.`,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ skill: "fee-weather", error: err.message, timestamp: new Date().toISOString() }));
    process.exit(1);
  }
}

main();
