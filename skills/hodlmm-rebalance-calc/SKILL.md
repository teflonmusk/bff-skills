---
name: hodlmm-rebalance-calc
description: "HODLMM rebalance decision engine. Compares impermanent loss cost vs gas cost vs fee earnings to recommend REBALANCE_NOW, HOLD, or EXIT for concentrated liquidity positions."
metadata:
  author: "teflonmusk"
  author_agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "evaluate <pool-id> --address <addr> | gas | pools"
  entry: "hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# hodlmm-rebalance-calc

**IL + gas + fees = one answer.**

Every HODLMM LP asks: "Should I rebalance?" This skill calculates the answer. It compares your current impermanent loss against the gas cost of rebalancing and the fee rate of the new position to produce a clear verdict: REBALANCE_NOW, HOLD, or EXIT.

## Why it matters

- Rebalancing too early wastes gas on positions that fees would have covered
- Rebalancing too late lets IL compound beyond recovery
- Out-of-range positions earn zero fees — every block is pure loss
- No existing tool combines IL, gas, and fee rate into a single decision

## Commands

### evaluate
Full rebalance analysis for a specific position. Returns verdict with rationale.

```bash
bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts evaluate <pool-id> --address <stx-address>
```

Output includes:
- **Verdict**: REBALANCE_NOW, HOLD, or EXIT
- **Rationale**: why, with specific numbers
- Concentrated IL with amplification multiplier
- Rebalance gas cost (2 sponsored txs)
- Fee rate and cycles-to-breakeven estimate
- Step-by-step action plan if rebalancing

### gas
Current rebalance cost estimate — relay health and fee data.

```bash
bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts gas
```

### pools
List HODLMM pools with fee rates for cost comparison.

```bash
bun hodlmm-rebalance-calc/hodlmm-rebalance-calc.ts pools
```

## Decision logic

| Condition | Verdict | Rationale |
|-----------|---------|-----------|
| Out of range + IL > 8% | EXIT | Not earning, IL growing, cut losses |
| Out of range + IL ≤ 8% | REBALANCE_NOW | Not earning fees, re-center on active bin |
| In range + IL > 5% + quick breakeven | REBALANCE_NOW | Fees recover rebalance cost in ≤3 cycles |
| In range + IL > 5% + slow breakeven | HOLD | Rebalance cost not justified yet |
| In range + IL 2-5% | HOLD | Fees likely covering IL |
| In range + IL < 2% | HOLD | Position is healthy |

## Technical notes

- Bitflow HODLMM API for pool, bin, and position data
- Relay health endpoint for gas cost estimation
- Concentrated IL formula with range width amplification
- Entry price estimated from position bin midpoint
- Breakeven calculation: (gas cost + IL friction) / fee earnings per cycle
- All read-only — verdict is advisory, execution requires agent confirmation
