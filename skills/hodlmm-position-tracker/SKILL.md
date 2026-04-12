---
name: hodlmm-position-tracker
description: "Impermanent loss tracker for Bitflow HODLMM concentrated liquidity. Calculates standard and concentrated IL, compares LP vs HODL value, tracks range drift and reserve imbalance."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "check <pool-id> --address <addr> | compare <pool-id> --address <addr> | pools"
  entry: "hodlmm-position-tracker/hodlmm-position-tracker.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# hodlmm-position-tracker

**Know what your LP position actually costs you.**

Impermanent loss tracker for Bitflow HODLMM concentrated liquidity positions. Every LP knows fees are good — but is the IL eating more than you earn? This tool answers that.

## Why it matters

- Concentrated liquidity amplifies IL compared to standard AMMs
- HODLMM bins create tighter ranges that multiply price divergence losses
- No existing AIBTC tool calculates IL for HODLMM positions
- Agents deploying sBTC into LP pools need real-time IL visibility before rebalancing

## Commands

### check
Current IL estimate for a position — range status, drift, concentration multiplier.

```bash
bun hodlmm-position-tracker/hodlmm-position-tracker.ts check <pool-id> --address <stx-address>
```

Output includes:
- Standard IL vs concentrated IL (with amplification multiplier)
- Position range and whether price is in/out of range
- Drift from position center in bins
- Reserve imbalance (X/Y split percentage)
- Risk level (low/medium/high)

### compare
LP position value vs simply holding — the real cost of providing liquidity.

```bash
bun hodlmm-position-tracker/hodlmm-position-tracker.ts compare <pool-id> --address <stx-address>
```

Output includes:
- Current LP value in quote token
- Equivalent HODL value at current prices
- Absolute and percentage IL
- Fee context: pool fee rate and breakeven estimate
- Verdict: whether fees are likely covering the IL

### pools
List active HODLMM pools with bin step and fee data.

```bash
bun hodlmm-position-tracker/hodlmm-position-tracker.ts pools [--sbtc-only]
```

## Technical notes

- Bitflow HODLMM API (`bff.bitflowapis.finance`) for pool, bin, and position data
- Concentrated IL formula accounts for range width amplification
- Entry price estimated from position bin midpoint (no historical data needed)
- All read-only — no wallet unlock needed
- Fee breakeven calculation uses pool provider + variable fee rates
