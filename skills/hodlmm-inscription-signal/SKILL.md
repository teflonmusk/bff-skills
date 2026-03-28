---
name: "hodlmm-inscription-signal"
version: "1.0.0"
description: "Bitcoin L1 inscription pressure oracle for HODLMM bin management. Monitors inscription volume and mempool fee rates to recommend HOLD, TIGHTEN_BINS, or WIDEN_BINS."
author: "Dual Cougar"
category: "defi"
tags: "hodlmm", "bitflow", "bitcoin", "inscriptions", "ordinals", "liquidity", "bins", "mempool", "sbtc"
chain: "stacks"
cost: "free"
output: "json"
command: "bun skills/hodlmm-inscription-signal/skill.ts --pool=sbtc-stx"
user-invocable: "false"
---

# hodlmm-inscription-signal

A real-time inscription pressure oracle that helps HODLMM liquidity providers know when to tighten, widen, or hold their concentrated liquidity bins. Monitors Bitcoin L1 inscription activity and mempool fee rates, cross-references live HODLMM pool state, and outputs an actionable bin management signal.

## Why it matters

HODLMM concentrated liquidity bins are most efficient when positioned around current price. But Bitcoin L1 activity — inscription waves, Runes mints, fee spikes — causes sBTC demand surges that shift the sBTC/STX price. Reacting too slow means fees collected outside your bin. This skill gives LPs a structured, data-driven signal before volatility moves.

## Usage

```bash
# Default: sbtc-stx pool, threshold 3, 1-hour window
bun skills/hodlmm-inscription-signal/skill.ts

# Custom pool and sensitivity
bun skills/hodlmm-inscription-signal/skill.ts --pool=sbtc-stx --threshold=5 --window=2
```

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `--pool` | string | `sbtc-stx` | HODLMM pool ID to analyze |
| `--threshold` | number | `3` | Pressure score (0–10) to trigger TIGHTEN_BINS |
| `--window` | number | `1` | Hours of inscription history to analyze |

## Output

```json
{
  "skill": "hodlmm-inscription-signal",
  "timestamp": "2026-03-28T15:00:00.000Z",
  "input": { "pool": "sbtc-stx", "threshold": 3, "window_hours": 1 },
  "bitcoin_l1": {
    "inscriptions_last_hour": 42,
    "fee_rate_sat_vb": 28,
    "pressure_score": 5
  },
  "pool": {
    "id": "sbtc-stx",
    "pair": "sBTC/STX",
    "tvl_usd": 1200000,
    "volume_24h": 85000,
    "fee_rate": 0.003,
    "current_price": 94200
  },
  "recommendation": "TIGHTEN_BINS",
  "rationale": "Moderate pressure detected (score 5/10). Inscription activity is elevated — tightening bins captures more fees while staying ahead of volatility.",
  "summary": "TIGHTEN_BINS — Inscription pressure score 5/10. 42 inscriptions in last 1h at ~28 sat/vB. Pool sbtc-stx: $1,200,000 TVL."
}
```

## Recommendation logic

| Pressure score | Recommendation | Action |
|---|---|---|
| < threshold | `HOLD` | Bins optimally positioned — collect fees |
| ≥ threshold | `TIGHTEN_BINS` | Moderate L1 activity — concentrate range |
| ≥ threshold + 3 | `WIDEN_BINS` | Extreme volatility risk — widen to avoid IL |

## Chaining

- Run before adjusting HODLMM position — treat as pre-flight check
- Feed `recommendation` into bin adjustment execution when automation is available
- Combine with `fee-weather` for full Stacks + Bitcoin network picture
