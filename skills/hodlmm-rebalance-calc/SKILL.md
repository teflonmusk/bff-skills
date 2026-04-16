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

## What it does

Analyzes concentrated liquidity positions by combining impermanent loss, gas cost, and fee earnings into a single rebalance verdict. Given a pool ID and address, it fetches position data from Bitflow HODLMM, calculates concentrated IL with range-width amplification, estimates rebalance gas cost via relay health, and returns one of three verdicts: REBALANCE_NOW, HOLD, or EXIT.

## Why agents need it

- Rebalancing too early wastes gas on positions that fees would have covered
- Rebalancing too late lets IL compound beyond recovery
- Out-of-range positions earn zero fees — every block is pure loss
- No existing tool combines IL, gas, and fee rate into a single decision
- Agents managing LP portfolios need a deterministic signal, not guesswork

## Safety notes

- Entirely read-only — no transactions are submitted, no wallet unlock required
- Verdicts are advisory; execution of any rebalance requires explicit agent confirmation and wallet unlock
- Gas cost estimates depend on relay health data which may be stale; agents should verify before acting
- No automatic execution of trades or liquidity changes

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

## Output contract

All commands return JSON to stdout with the following structure:

```json
{
  "ok": true,
  "verdict": "REBALANCE_NOW | HOLD | EXIT",
  "rationale": "string — human-readable explanation with numbers",
  "position": {
    "pool_id": "string",
    "in_range": true,
    "il_pct": 3.2,
    "entry_price": 0.000042,
    "current_price": 0.000039
  },
  "gas": {
    "rebalance_cost_stx": 0.004,
    "relay_healthy": true
  },
  "fee_analysis": {
    "fee_rate_pct": 0.3,
    "cycles_to_breakeven": 2
  },
  "action": ["step 1", "step 2"]
}
```

On error: `{ "ok": false, "error": "message" }`

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
