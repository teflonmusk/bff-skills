---
name: sbtc-bridge-router
description: "Optimal BTC→sBTC routing across Styx pools and direct peg-in. Compares liquidity, limits, speed, and fees across three paths. Handles split routing for large amounts."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "route <amount> | compare | split <amount> | doctor"
  entry: "sbtc-bridge-router/sbtc-bridge-router.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# sbtc-bridge-router

**Three paths. One answer. Route smart.**

Every agent bridging BTC→sBTC faces the same question: Styx main pool, Styx aibtc pool, or direct peg-in? Each has different limits, liquidity, speed, and fees. This skill answers the question with live data.

## What it does

- Queries live liquidity across Styx main pool, Styx aibtc pool, and direct peg-in
- Recommends the optimal route for a given BTC amount based on capacity, speed, and fees
- Splits large deposits across multiple paths to maximize Styx throughput
- Returns the exact MCP tool call and parameters needed to execute the chosen route

## Why agents need it

- Styx main pool caps at 400K sats. Styx aibtc caps at 1M sats. Direct peg-in has no cap but takes 60-90 min.
- Pool liquidity fluctuates — estimated available often differs 30-40% from real available
- Agents bridging large amounts need split routing across multiple paths
- No existing tool compares all three paths with live liquidity data

## Safety notes

- All operations are read-only path selection — no funds are moved by this skill
- Actual deposits require wallet unlock via the recommended MCP tool before execution
- Always verify pool capacity before depositing; estimated_available (conservative) is used over real_available for routing decisions
- Confidence scores indicate liquidity headroom: high (5x+), medium (2x+), low (<2x)

## Commands

### route
Find the optimal path for a specific amount. Returns recommended route with confidence score.

```bash
bun sbtc-bridge-router/sbtc-bridge-router.ts route 50000
bun sbtc-bridge-router/sbtc-bridge-router.ts route 500000
bun sbtc-bridge-router/sbtc-bridge-router.ts route 2000000
```

Output includes:
- Recommended path with confidence (high/medium/low)
- All three routes compared with availability and coverage
- Exact MCP tool call and params to execute the route

### compare
Side-by-side comparison of all paths — liquidity, limits, speed, fees, liquidity gaps.

```bash
bun sbtc-bridge-router/sbtc-bridge-router.ts compare
```

### split
Multi-pool routing for large amounts. Splits across aibtc pool → main pool → direct peg-in to maximize Styx throughput.

```bash
bun sbtc-bridge-router/sbtc-bridge-router.ts split 1500000
```

### doctor
Health check — verifies all three paths are operational.

```bash
bun sbtc-bridge-router/sbtc-bridge-router.ts doctor
```

## Output contract

All commands return JSON with the following structure:

- `recommended.path` — one of `styx_main`, `styx_aibtc`, or `direct_pegin`
- `recommended.confidence` — `high`, `medium`, or `low` based on liquidity coverage
- `recommended.execute_with` — exact MCP tool name to call for execution
- `recommended.params` — parameters to pass directly to the MCP tool
- `routes[]` — array of all evaluated paths with `available_sats`, `coverage_ratio`, `speed_minutes`, and `fee_estimate`
- `split_legs[]` (split command only) — ordered array of legs with `path`, `amount_sats`, and `execute_with`
- `health` (doctor command only) — per-path operational status

## Routing logic

1. For amounts ≤400K: prefer Styx main or aibtc (faster, ~5 min)
2. For amounts 400K-1M: prefer Styx aibtc (higher cap)
3. For amounts >1M: split across pools, remainder via direct peg-in
4. Confidence based on liquidity coverage: 5x+ = high, 2x+ = medium, <2x = low
5. Uses estimated_available (conservative) not real_available for routing decisions
6. Falls back to direct peg-in when Styx pools lack liquidity

## Technical notes

- Styx API (`app.styx.so/api`) for pool status and fee estimates
- Direct peg-in via sBTC signer system — always available, no pool dependency
- All read-only — routing decisions only, no execution without agent confirmation
- Returns exact MCP tool name and params for the recommended route
