---
name: defi-exposure-map
description: "Cross-protocol DeFi exposure aggregator for Stacks agents. Shows total sBTC, STX, and token positions across Bitflow, Zest, JingSwap, Styx, stacking, and wallet in one view."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "scan <stx-address> | risk <stx-address> | summary"
  entry: "defi-exposure-map/defi-exposure-map.ts"
  requires: ""
  tags: "read-only, defi, l2"
---

# defi-exposure-map

**See everything. One command.**

Cross-protocol DeFi exposure aggregator for Stacks agents. Every other tool shows one protocol — this shows all of them in one view. Built for agents managing sBTC across multiple DeFi positions.

## Why it matters

- Agents hold sBTC across Bitflow LP pools, Zest lending, JingSwap cycles, Styx pools, and stacking
- No existing tool shows total exposure across all protocols
- Risk is correlated — an sBTC depeg affects every position simultaneously
- Agents need a single view before making allocation decisions

## Commands

### scan
Full cross-protocol scan — wallet balances, LP positions, lending, stacking, cycle state.

```bash
bun defi-exposure-map/defi-exposure-map.ts scan SP105KWW31Y89F5AZG0W7RFANQGRTX3XW0VR1CX2M
```

### risk
Risk assessment — concentration by protocol, single-asset exposure, correlation warnings.

```bash
bun defi-exposure-map/defi-exposure-map.ts risk SP105KWW31Y89F5AZG0W7RFANQGRTX3XW0VR1CX2M
```

### summary
Quick one-line total across all protocols.

```bash
bun defi-exposure-map/defi-exposure-map.ts summary
```

## Technical notes

- Hiro API for wallet balances and stacking status
- Bitflow API for LP positions
- JingSwap contract reads for cycle state
- Zest contract reads for lending positions
- Styx pool status via MCP tools
- All read-only — no wallet unlock needed
