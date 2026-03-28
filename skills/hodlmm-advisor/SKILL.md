---
name: hodlmm-advisor
description: "Composite HODLMM position advisor. Synthesises Bitcoin L1 inscription pressure, sBTC/STX reserve demand signal, and pool volatility regime into a single LP action recommendation: SHIFT_UP_AGGRESSIVE / SHIFT_UP / HOLD / SHIFT_DOWN / SHIFT_DOWN_AGGRESSIVE / TIGHTEN / WIDEN."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "hodlmm-advisor/hodlmm-advisor.ts"
  requires: ""
  tags: "l1, l2, defi, read-only, mainnet-only, hodlmm, bitflow, sbtc, stacks"
---

# hodlmm-advisor

## What it does
Fetches three independent data sources in parallel and synthesises them into a single actionable LP position recommendation:

| Signal | Source | Question answered |
|---|---|---|
| L1 pressure (0–10) | Bitcoin mempool + inscription count (Hiro API) | Is a price-moving event incoming? |
| Demand signal | HODLMM bin reserve distribution (Bitflow) | Which direction has price been trending? |
| Volatility regime | HODLMM bin spread (Bitflow) | How unstable is the pool right now? |

The decision matrix handles all signal combinations, including contradictions — e.g. BUY_PRESSURE demand against an elevated volatility regime produces a cautious SHIFT_UP with low confidence, rather than a false-confident aggressive shift.

## Why agents need it
Running `hodlmm-inscription-signal`, `sbtc-demand-signal`, and `hodlmm-risk` separately gives raw data — but interpreting three separate outputs under time pressure creates logic errors. `hodlmm-advisor` internalises the decision matrix so the parent agent receives one clear `action` field with a confidence level and rationale. No more manual reconciliation.

## Safety notes
- Read-only — never writes to chain or moves funds.
- No wallet or funds required.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- Output is advisory only — parent agent must confirm before executing any bin adjustment.
- Crisis volatility always overrides directional signals (WIDEN fires unconditionally at crisis regime).

## Commands

### doctor
Checks Hiro API and Bitflow HODLMM API connectivity.
```bash
bun run hodlmm-advisor/hodlmm-advisor.ts doctor
```

Output:
```json
{
  "result": "ready",
  "checks": {
    "hiro_api": "ok",
    "bitflow_hodlmm_api": "ok"
  }
}
```

### run
Fetches all three signals in parallel and outputs composite action recommendation.
```bash
bun run hodlmm-advisor/hodlmm-advisor.ts run --pool dlmm_3
bun run hodlmm-advisor/hodlmm-advisor.ts run --pool dlmm_3 --threshold 3
```

Options:
- `--pool` (default: `dlmm_3`) — HODLMM pool ID to analyse
- `--threshold` (default: `2`) — Imbalance score distance from 5 to trigger directional demand signal (1–4)

Output:
```json
{
  "skill": "hodlmm-advisor",
  "timestamp": "2026-03-28T20:00:00.000Z",
  "input": { "pool": "dlmm_3", "demand_threshold": 2 },
  "pool": {
    "id": "dlmm_3",
    "token_x": "sBTC",
    "token_y": "STX",
    "active_bin": 447,
    "total_bins": 69
  },
  "signals": {
    "l1_pressure": {
      "inscriptions_last_hour": 45,
      "fee_rate_sat_vb": 22,
      "pressure_score": 6
    },
    "demand": {
      "imbalance_score": 3,
      "signal": "BUY_PRESSURE",
      "sbtc_above_active": 0.042,
      "stx_below_active": 18400
    },
    "volatility": {
      "score": 18,
      "regime": "calm",
      "bin_spread": 0.021
    }
  },
  "action": "SHIFT_UP_AGGRESSIVE",
  "confidence": "high",
  "rationale": "Calm volatility (18/100) with BUY_PRESSURE demand signal (imbalance score 3/10) — price has been trending upward. High L1 pressure (6/10) confirms incoming sBTC demand. Shift bin concentration upward to capture fees as upward momentum continues.",
  "summary": "SHIFT_UP_AGGRESSIVE (high confidence) — L1 6/10, demand BUY_PRESSURE, volatility calm (18/100) on pool dlmm_3 (active bin 447)."
}
```

## Decision matrix

| Volatility regime | L1 pressure | Demand signal | Action |
|---|---|---|---|
| crisis (any) | any | any | `WIDEN` (safety override) |
| elevated | ≥7 | any | `TIGHTEN` |
| calm | any | BUY_PRESSURE | `SHIFT_UP_AGGRESSIVE` (if L1 ≥6) or `SHIFT_UP` |
| calm | any | SELL_PRESSURE | `SHIFT_DOWN_AGGRESSIVE` (if L1 ≥6) or `SHIFT_DOWN` |
| calm | ≤2 | NEUTRAL | `HOLD` (high confidence) |
| elevated | any | BUY_PRESSURE | `SHIFT_UP` (low confidence) |
| elevated | any | SELL_PRESSURE | `SHIFT_DOWN` (low confidence) |
| elevated | any | NEUTRAL | `HOLD` (low confidence) |

## Output contract
All outputs are JSON to stdout.

**Success:** see `run` output above.

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- Mainnet only — Bitflow HODLMM APIs do not exist on testnet.
- No wallet required — all operations are read-only.
- All three signals are fetched in parallel — total latency is max(API response times), not sum.
- L1 inscription count uses the last ~60 inscriptions from Hiro Ordinals API as a proxy for hourly rate.
- Volatility score uses the same bin-spread algorithm as `hodlmm-risk` (spread 40%, reserve imbalance 30%, concentration 30%).
- Demand imbalance uses bin-count weighting rather than raw reserve values to avoid requiring a live price conversion.
- Crisis volatility always overrides directional signals. Do not override WIDEN in crisis regime without manual confirmation.
