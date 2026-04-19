---
name: hodlmm-liquidity-shield
description: "Stop-loss protection for Bitflow HODLMM concentrated liquidity. Monitors price drift, calculates concentrated IL in real-time, and generates withdrawal parameters when impermanent loss exceeds your max-pain threshold."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "arm <pool-id> --address <addr> --max-il <pct> | check <pool-id> --address <addr> | simulate <pool-id> --price-move <pct> | doctor"
  entry: "hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, hodlmm, risk-management, bitflow"
---

# hodlmm-liquidity-shield

**The seatbelt for concentrated liquidity.**

Stop-loss protection for Bitflow HODLMM positions. Concentrated liquidity amplifies both fee earnings and impermanent loss — a 5% price move can destroy 15%+ of position value in a tight range. This skill monitors your position in real-time and generates exit parameters before IL exceeds your threshold.

## What it does

Monitors HODLMM position health by tracking price drift from entry, calculating concentrated IL with range-width amplification, and determining risk level (safe/warning/critical/exit). When IL crosses your max-pain threshold or the position drifts out of range, the shield generates withdrawal parameters for immediate execution. The simulate command lets you stress-test positions against hypothetical price moves before they happen.

## Why agents need it

- Concentrated liquidity amplifies IL compared to standard AMMs — a 10% price move can mean 20-30% IL in a tight bin range
- No existing HODLMM skill provides automated exit triggers — agents monitor but don't protect
- Without protection, agents discover IL damage after the fact when reviewing positions
- The shield turns reactive loss-checking into proactive capital protection
- Completes the HODLMM lifecycle: enter (DCA deployer) → monitor (position tracker) → rebalance (rebalance calc) → **protect (liquidity shield)**

## Safety notes

- Check command is read-only — no wallet interaction
- Exit parameters are generated for the parent agent to execute — the shield does not withdraw directly
- Simulation uses the same IL model as live checks — results are consistent
- Default thresholds: alert at 3% IL, exit at 5% IL (configurable)
- The shield accounts for bin step in its concentration multiplier — tighter steps = higher sensitivity
- Always verify exit parameters before executing — the shield is advisory

## Commands

### arm
Set IL thresholds and capture entry price for monitoring.

```bash
bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts arm <pool-id> --address <addr> --max-il 5 --alert-il 3
```

### check
Check position health. Returns HOLD, ALERT, or EXIT_NOW with withdrawal parameters.

```bash
bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts check <pool-id> --address <addr> [--entry-bin <id>]
```

### simulate
Stress-test against hypothetical price moves.

```bash
bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts simulate <pool-id> --price-move -10
```

### doctor
Check prerequisites.

```bash
bun hodlmm-liquidity-shield/hodlmm-liquidity-shield.ts doctor
```

## Output contract

```json
{
  "status": "success | error",
  "data": {
    "shield": {
      "poolId": "string",
      "currentPrice": 1.023,
      "entryPrice": 1.000,
      "concentratedIL": -2.34,
      "riskLevel": "safe | warning | critical | exit",
      "action": "hold | alert | exit_now",
      "exitParams": { "tool": "hodlmm_remove_liquidity", "params": {} }
    },
    "metrics": {
      "priceChange": "+2.3%",
      "standardIL": "-0.013%",
      "concentratedIL": "-2.34%",
      "binDrift": "3 bins (max 10)",
      "inRange": true
    }
  }
}
```

## Technical notes

- Concentrated IL formula: standardIL * concentrationMultiplier (derived from bin step and range width)
- Standard IL: 2*sqrt(r)/(1+r) - 1, where r = currentPrice/entryPrice
- Bin price: (1 + binStep/10000) ^ (binId - 8388608)
- Range detection: position considered out-of-range when bin drift exceeds rangeWidth/binStep
- Advisory pattern: calculates risk and generates exit params, parent agent executes
- Designed for recurring checks — run on a cron for automated protection
