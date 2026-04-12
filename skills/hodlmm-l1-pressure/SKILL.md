---
name: hodlmm-l1-pressure
description: "Bitcoin L1 pressure oracle for HODLMM bin management. Combines mempool fee rates, inscription volume, and congestion data to recommend HOLD, TIGHTEN_BINS, or WIDEN_BINS for HODLMM liquidity providers."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "hodlmm-l1-pressure/hodlmm-l1-pressure.ts"
  requires: ""
  tags: "l1, l2, defi, read-only, mainnet-only, infrastructure"
---

# hodlmm-l1-pressure

## What it does
Monitors Bitcoin L1 inscription activity and mempool fee rates, cross-references live Bitflow HODLMM pool state, and outputs a pressure score (0–10) with an actionable bin management signal: HOLD, TIGHTEN_BINS, or WIDEN_BINS.

## Why agents need it
HODLMM concentrated liquidity bins are most efficient when positioned around current price. Bitcoin L1 inscription waves and fee spikes cause sBTC demand surges that shift the sBTC/STX price. Agents managing HODLMM positions need a structured pre-flight signal before volatility moves — this skill provides it.

## Safety notes
- Read-only — never writes to chain or moves funds.
- No wallet or funds required.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- Output is advisory only — parent agent must confirm before executing any bin adjustment.

## Commands

### doctor
Checks that Hiro and Bitflow APIs are reachable. Safe to run anytime.
```bash
bun run hodlmm-l1-pressure/hodlmm-l1-pressure.ts doctor
```

Output:
```json
{
  "result": "ready",
  "checks": { "hiro_api": "ok", "bitflow_api": "ok" }
}
```

### run
Fetches live inscription count, mempool fee rate, and HODLMM pool state. Computes pressure score and outputs bin recommendation.
```bash
bun run hodlmm-l1-pressure/hodlmm-l1-pressure.ts run --pool sbtc-stx
bun run hodlmm-l1-pressure/hodlmm-l1-pressure.ts run --pool sbtc-stx --threshold 5 --window 2
```

Options:
- `--pool` (default: `sbtc-stx`) — HODLMM pool ID to analyze
- `--threshold` (default: `3`) — Pressure score to trigger TIGHTEN_BINS (0–10)
- `--window` (default: `1`) — Hours of inscription history to analyze

Output:
```json
{
  "skill": "hodlmm-l1-pressure",
  "timestamp": "2026-03-28T15:16:01.048Z",
  "input": { "pool": "sbtc-stx", "threshold": 3, "window_hours": 1 },
  "bitcoin_l1": {
    "inscriptions_last_hour": 0,
    "fee_rate_sat_vb": 10,
    "pressure_score": 0
  },
  "pool": null,
  "recommendation": "HOLD",
  "rationale": "Low inscription and fee pressure (score 0/10). L1 is calm — current bin configuration is optimal. Hold and collect fees.",
  "summary": "HOLD — Inscription pressure score 0/10. 0 inscriptions in last 1h at ~10 sat/vB."
}
```

## Recommendation logic

| Pressure score | Recommendation | When to act |
|---|---|---|
| < threshold | `HOLD` | Bins optimally positioned — collect fees |
| ≥ threshold | `TIGHTEN_BINS` | Moderate L1 activity — concentrate range |
| ≥ threshold + 3 | `WIDEN_BINS` | Extreme volatility risk — widen to avoid IL |

## Output contract
All outputs are JSON to stdout.

**Success:**
```json
{ "result": "ready" }
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- Mainnet only — Bitflow pool APIs do not exist on testnet.
- Bitflow pool fetch failure is handled gracefully — recommendation still valid from L1 signals alone.
- Pressure score is a current-state proxy, not historical realized volatility.
- No wallet required — all operations are read-only.
