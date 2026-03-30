---
name: hodlmm-position-health
description: "Post-entry HODLMM LP position health monitor. Tracks bin drift from entry, estimates fee accrual rate, and outputs HOLD / HARVEST / REBALANCE / EXIT signal so agents know when to act on open LP positions."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | check"
  entry: "hodlmm-position-health/hodlmm-position-health.ts"
  requires: ""
  tags: "hodlmm, defi, read-only, mainnet-only, sbtc, stx, bitflow, position-monitoring"
---

# hodlmm-position-health

## What it does

After deploying capital into a Bitflow HODLMM concentrated liquidity pool, this skill monitors the health of the open position. It fetches current bin state, measures how far the active price bin has drifted from entry, estimates the current fee APY based on live volume, and outputs a clear action signal: **HOLD**, **HARVEST**, **REBALANCE**, or **EXIT**.

Every existing bff-skills submission tells agents how to get into a HODLMM position. This skill answers the question that comes next: **what should I do with the position I'm already in?**

## Why agents need it

Concentrated liquidity LPs degrade silently. The active bin drifts, liquidity falls out of range, fee accrual drops to zero — and nothing tells the agent unless it checks. The cost of not monitoring:

- Out-of-range bins → zero fee revenue while capital is locked
- Delayed rebalancing → compounding IL with no fee offset
- Missing harvest windows → accrued fees lost to price reversal

`hodlmm-position-health` runs as a lightweight read-only check that gives agents a deterministic HOLD/HARVEST/REBALANCE/EXIT recommendation on each check. It chains directly from `hodlmm-inscription-signal` (entry timing) to close the lifecycle loop.

## Safety notes

- Read-only — never writes to chain or moves funds.
- No wallet required.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- If Bitflow API is unreachable, skill returns a conservative output noting insufficient data. Recommendation is informational; parent agent must confirm before executing.
- `--entry-bin` is optional. Without it, the skill reports current position health without drift analysis.

## Commands

### doctor

Checks Bitflow HODLMM API connectivity. Safe to run anytime.

```bash
bun run hodlmm-position-health/hodlmm-position-health.ts doctor
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

### check

Checks the health of an active LP position in a specified pool.

```bash
bun run hodlmm-position-health/hodlmm-position-health.ts check --pool dlmm_3
bun run hodlmm-position-health/hodlmm-position-health.ts check --pool dlmm_3 --entry-bin 8388612
bun run hodlmm-position-health/hodlmm-position-health.ts check --pool dlmm_3 --entry-bin 8388612 --max-drift 3
```

Options:
- `--pool <id>` (required) — Pool ID to check (e.g. `dlmm_3`)
- `--entry-bin <id>` (optional) — Active bin ID at time of LP entry. Enables drift calculation.
- `--max-drift <bins>` (default: `5`) — Number of bins of drift before REBALANCE signal triggers

```json
{
  "skill": "hodlmm-position-health",
  "timestamp": "2026-03-31T00:00:00.000Z",
  "pool_id": "dlmm_3",
  "pair": "sBTC/STX",
  "recommendation": "HOLD",
  "rationale": "Fee APY 42.1%/yr with 88% bin balance. Active bin drifted 2 bins up from entry — within normal range. Position collecting fees on both sides.",
  "bin_state": {
    "active_bin_id": 8388614,
    "total_bins": 18,
    "bin_spread": 25,
    "bins_above_active": 8,
    "bins_below_active": 10,
    "balance_score": 0.889,
    "asymmetry": 0.111
  },
  "drift": {
    "entry_bin_id": 8388612,
    "current_bin_id": 8388614,
    "bin_drift": 2,
    "drift_direction": "up",
    "drift_pct": 0.08,
    "in_range": true,
    "range_coverage_pct": 88.9
  },
  "fee_metrics": {
    "current_fee_apy_pct": 42.1,
    "fee_rate_pct": 0.3,
    "volume_24h_usd": 750000,
    "tvl_usd": 2100000,
    "est_daily_fee_pct": 0.1071
  },
  "inputs": {
    "pool_id": "dlmm_3",
    "entry_bin_id": 8388612,
    "max_drift_bins": 5
  }
}
```

## Recommendation thresholds

| Signal | Conditions |
|---|---|
| `HOLD` | Balance ≥ 0.55, drift within threshold, fee APY ≥ 5% |
| `HARVEST` | Fee APY ≥ 15%, drift ≥ 3 bins but balance still ≥ 0.55 |
| `REBALANCE` | Drift ≥ max-drift bins AND balance < 0.55 |
| `EXIT` | Balance < 0.25 OR (fee APY < 5% AND balance < 0.5) |

## Chaining

- **Before**: `hodlmm-pool-screener` (select pool) → `hodlmm-inscription-signal` (time entry) → deploy LP
- **After deployment**: run `hodlmm-position-health` on each cron cycle to monitor
- **On REBALANCE/EXIT**: chain to `hodlmm-pool-screener` to re-screen pools before re-entry

Full lifecycle: `styx-route-signal` → `hodlmm-pool-screener` → `hodlmm-inscription-signal` → **`hodlmm-position-health`** (ongoing)

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "skill": "hodlmm-position-health", "recommendation": "HOLD|HARVEST|REBALANCE|EXIT", "bin_state": {...}, "drift": {...}, "fee_metrics": {...} }
```

**Error:**
```json
{ "skill": "hodlmm-position-health", "error": "descriptive message", "timestamp": "..." }
```
