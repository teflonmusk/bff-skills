---
name: sbtc-demand-signal
description: "sBTC demand oracle for HODLMM bin positioning. Reads Bitflow HODLMM pool bin reserves to detect price momentum direction and recommend bin range shifts."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "sbtc-demand-signal/sbtc-demand-signal.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only, hodlmm, bitflow, sbtc, stacks"
---

# sbtc-demand-signal

## What it does
Reads Bitflow HODLMM pool bin reserve distribution to detect which direction sBTC/STX price has been trading. In a DLMM pool, bins above the active price hold sBTC supply (waiting to be sold); bins below hold STX depth (deployed to buy sBTC). Reserve imbalance reveals the net flow direction since the last rebalance — giving LPs a directional signal to shift bin concentration ahead of continued momentum.

## Why agents need it
`hodlmm-inscription-signal` tells you whether L1 pressure is *about to* move the price. `sbtc-demand-signal` tells you which direction the price *has already been* moving, based on how pool reserves are distributed. Together they give a complete pre/post picture for bin management decisions. Use both before any bin adjustment.

## Safety notes
- Read-only — never writes to chain or moves funds.
- No wallet or funds required.
- Mainnet only — Bitflow HODLMM APIs are mainnet-only.
- Output is advisory only — parent agent must confirm before executing any bin shift.

## Commands

### doctor
Checks that Bitflow HODLMM API is reachable.
```bash
bun run sbtc-demand-signal/sbtc-demand-signal.ts doctor
```

Output:
```json
{
  "result": "ready",
  "checks": { "bitflow_hodlmm_api": "ok" }
}
```

### run
Fetches live bin reserve distribution, computes imbalance score, and outputs directional demand signal.
```bash
bun run sbtc-demand-signal/sbtc-demand-signal.ts run --pool dlmm_3
bun run sbtc-demand-signal/sbtc-demand-signal.ts run --pool dlmm_3 --threshold 3
```

Options:
- `--pool` (default: `dlmm_3`) — HODLMM pool ID to analyse
- `--threshold` (default: `2`) — Imbalance score distance from 5 to trigger directional signal (1–4)

Output:
```json
{
  "skill": "sbtc-demand-signal",
  "timestamp": "2026-03-28T20:00:00.000Z",
  "input": { "pool": "dlmm_3", "threshold": 2 },
  "pool": {
    "id": "dlmm_3",
    "token_x": "sBTC",
    "token_y": "STX",
    "active_bin": 447,
    "total_bins": 69
  },
  "reserves": {
    "sbtc_above_active": 0.042,
    "stx_below_active": 18400,
    "sbtc_in_active_bin": 0.009,
    "stx_in_active_bin": 3100
  },
  "imbalance_score": 3,
  "signal": "BUY_PRESSURE",
  "rationale": "Pool is STX-heavy (imbalance score 3/10). More bins below active bin 447 hold STX depth than sBTC supply sits above — price has been trending up as buyers consume sBTC. Upward momentum may continue.",
  "shift_recommendation": "Consider shifting bin range upward — concentrate liquidity above current price to capture fees as upward momentum continues.",
  "summary": "BUY_PRESSURE — imbalance score 3/10 on pool dlmm_3 (active bin 447, 69 total bins)."
}
```

## Signal logic

| Imbalance score | Signal | Meaning | Action |
|---|---|---|---|
| ≤ (5 − threshold) | `BUY_PRESSURE` | STX-heavy — price trending up | Shift bins upward |
| ≥ (5 + threshold) | `SELL_PRESSURE` | sBTC-heavy — price trending down | Shift bins downward |
| Between | `NEUTRAL` | Balanced reserves | Hold current range |

## How it complements the HODLMM skill stack

| Skill | Data source | Question answered |
|---|---|---|
| `hodlmm-inscription-signal` | Bitcoin L1 mempool | Will price move soon? |
| `sbtc-demand-signal` | HODLMM bin reserves | Which direction has it been moving? |
| `hodlmm-risk` | HODLMM bin spread | How volatile is the pool right now? |

Run all three before adjusting a HODLMM position.

## Output contract
All outputs are JSON to stdout.

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints
- Mainnet only — Bitflow HODLMM APIs do not exist on testnet.
- No wallet required — all operations are read-only.
- Imbalance score uses bin count weighting (bins dominated by sBTC vs STX) rather than raw reserve value, to avoid requiring a live sBTC/STX price conversion.
- All-zero reserves are treated as NEUTRAL with a note in rationale.
