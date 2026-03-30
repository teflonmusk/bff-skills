---
name: hodlmm-pool-screener
description: "Multi-pool HODLMM screener. Scans all Bitflow HODLMM pools, computes fee APY and bin efficiency, and ranks them so agents know which pool to deploy capital into."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "hodlmm-pool-screener/hodlmm-pool-screener.ts"
  requires: ""
  tags: "hodlmm, defi, read-only, mainnet-only, sbtc, stx, bitflow, screening"
---

# hodlmm-pool-screener

## What it does

Scans all known Bitflow HODLMM concentrated liquidity pools, fetches live TVL, volume, fee rate, and bin state for each, then ranks them by a composite score (50% fee APY, 30% bin balance, 20% bin efficiency). Outputs a ranked list with DEPLOY / WATCH / AVOID recommendations so agents can make a data-driven pool selection before committing capital.

Every existing HODLMM skill in the bff-skills competition assumes you are already in the `sbtc-stx` pool. This skill answers the prior question: **which pool should you enter?**

## Why agents need it

Not all HODLMM pools perform equally. Fee APY is a function of `volume_24h × fee_rate / tvl` — the same fee rate delivers 5× the yield in a high-volume pool vs a stagnant one. Bin balance tells you whether the LP's range is currently centered on the active price or has drifted out-of-range, producing zero fees. Without screening across all pools, agents default to the most-discussed pool (sbtc-stx) regardless of whether it is currently the best opportunity.

Agents deploying capital from `styx-route-signal` (sBTC sourcing) need to know where to put it. This skill closes that gap.

## Safety notes

- Read-only — never writes to chain or moves funds.
- No wallet or funds required.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- If Bitflow API is unreachable, screener gracefully returns empty results. Recommendation is for informational use; parent agent must confirm before executing.
- TVL and volume data may lag real-time by up to 5 minutes depending on Bitflow API cache.

## Commands

### doctor

Checks Bitflow HODLMM API connectivity. Safe to run anytime.

```bash
bun run hodlmm-pool-screener/hodlmm-pool-screener.ts doctor
```

```json
{
  "result": "ready",
  "checks": {
    "bitflow_hodlmm_api": "ok",
    "mempool_space_api": "ok"
  }
}
```

### run

Scans all pools and outputs a ranked deployment recommendation.

```bash
bun run hodlmm-pool-screener/hodlmm-pool-screener.ts run
bun run hodlmm-pool-screener/hodlmm-pool-screener.ts run --min-tvl 50000 --top 3
```

Options:
- `--min-tvl <usd>` (default: `10000`) — exclude pools below this TVL threshold
- `--top <n>` (default: `5`) — number of ranked pools to return

```json
{
  "skill": "hodlmm-pool-screener",
  "timestamp": "2026-03-30T19:00:00.000Z",
  "input": { "min_tvl_usd": 10000, "top_n": 5 },
  "summary": "DEPLOY sBTC/STX (dlmm_3) — 42.1% fee APY, $2,100,000 TVL. 1 pool(s) rated DEPLOY.",
  "top_pools": [
    {
      "rank": 1,
      "pool_id": "dlmm_3",
      "pair": "sBTC/STX",
      "tvl_usd": 2100000,
      "volume_24h": 750000,
      "fee_rate_pct": 0.3,
      "fee_apy_pct": 42.1,
      "bin_efficiency": 0.72,
      "balance_score": 0.88,
      "composite_score": 0.6941,
      "bin_state": {
        "active_bin_id": 8388612,
        "total_bins": 18,
        "bin_spread": 25,
        "bins_below_active": 9,
        "bins_above_active": 9,
        "asymmetry": 0.0
      },
      "recommendation": "DEPLOY",
      "rationale": "Strong fee APY (42.1%/yr) with 88% bin balance. Active bin 8388612 centered with 9 below / 9 above. Best risk-adjusted yield in current scan."
    }
  ],
  "pools_scanned": 4,
  "pools_skipped": 2,
  "deploy_count": 1,
  "watch_count": 2,
  "avoid_count": 1
}
```

## Scoring methodology

| Component | Weight | Metric |
|---|---|---|
| Fee APY | 50% | `(volume_24h × fee_rate / tvl_usd) × 365 × 100` |
| Bin balance | 30% | `1 - abs(bins_above - bins_below) / total_bins` |
| Bin efficiency | 20% | `total_bins / (bin_spread + 1)` |

**Recommendation thresholds:**
- `DEPLOY` — fee APY ≥ 20% AND balance score ≥ 0.6
- `WATCH` — fee APY ≥ 10% OR (balance ≥ 0.7 AND fee APY ≥ 5%)
- `AVOID` — below TVL threshold, very low volume, or severely imbalanced bins

## Chaining

- Run before deploying capital sourced via `styx-route-signal`
- Use `hodlmm-inscription-signal` after pool selection for bin-management timing
- Use `fee-weather` to confirm Stacks network conditions before on-chain execution

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "skill": "hodlmm-pool-screener", "top_pools": [...], "summary": "..." }
```

**Error:**
```json
{ "skill": "hodlmm-pool-screener", "error": "descriptive message", "timestamp": "..." }
```
